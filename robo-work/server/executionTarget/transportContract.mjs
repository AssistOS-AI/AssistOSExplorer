import crypto from 'node:crypto';
import {
    CHANNEL_KINDS, deepFreeze, digestOf, failure, isDigest, isId, isOpaqueIdentity, isOperationId, isPositiveU64Text,
    parseCanonicalTargetJson, success, validateChannelManifest, validateDescriptorManifest, validateInputManifest,
    validateTargetBinding, validateTargetReceipt
} from './contract.mjs';
import { TARGET_LIMITS_V1 } from './limits.mjs';

// Ticket, frame, descriptor and channel validation for the future target helper transport (T0 base §8; A1.7). These are
// semantic validators only: there is no listener, dial, socket transport or minter here. Synthetic keys only in tests.
//
// Validators never take ownership of descriptors: a refusal is exactly {ok: false, error: {code}} and carries no handle,
// and the (future) transport closes every descriptor it received with a refused frame. A success value carries metadata
// only.

export const TRANSPORT_ERROR_CODES = Object.freeze([
    'invalid_request', 'unsupported_version', 'noncanonical_encoding', 'capacity_exceeded', 'ticket_format', 'ticket_algorithm',
    'ticket_signature', 'ticket_purpose', 'ticket_binding', 'ticket_lifetime', 'ticket_replayed', 'channel_epoch_conflict',
    'lease_retired', 'frame_layout', 'frame_authentication', 'frame_binding', 'frame_sequence', 'descriptor_count',
    'descriptor_role', 'descriptor_identity', 'native_config_mutable', 'required_input_missing', 'input_manifest_mismatch',
    'binding_mismatch', 'channel_not_admitted', 'relay_port', 'unsupported_endpoint', 'not_a_running_service',
    'connect_refused', 'connect_timeout', 'outcome_unknown'
]);

const TICKET_TYPE = 'ploinky-target-helper+jwt';
const TICKET_PURPOSE = 'ploinky.target-helper.v1';
const TICKET_ISSUER = 'ploinky-router';
const TICKET_AUDIENCE_PREFIX = 'ploinky:target-helper:';
const TICKET_PERMISSIONS = Object.freeze(['commit', 'connect', 'input', 'lookup', 'prepare', 'release', 'renew', 'stop']);
const MAX_TICKET_LIFETIME_SECONDS = 30;
const MAX_FUTURE_SKEW_MS = 2000;
const CHALLENGE_TIMEOUT_MS = 5000;
const REPLAY_MARGIN_MS = 2000;
const FRAME_MAC_PREFIX = Buffer.from('ploinky-target-frame-v1\u0000', 'ascii');
const FRAME_MESSAGE_KINDS = Object.freeze([
    'prepare', 'prepared', 'commit', 'receipt', 'lookup', 'lookup-result', 'open', 'open-ok', 'open-refused', 'data', 'ack',
    'half-close', 'close', 'renew-challenge', 'renew', 'stop', 'release', 'failure'
]);
const FRAME_DIRECTIONS = Object.freeze(['worker-to-target', 'target-to-worker']);

const MAX_TOKEN_LENGTH = 65536;
const NATIVE_CONFIG_MAX_BYTES = 1024 * 1024;
const NATIVE_CONFIG_MAX_FILES = 128;
const CLAIM_KEYS = Object.freeze([
    'version', 'iss', 'sub', 'purpose', 'aud', 'binding', 'reservationId', 'leaseId', 'operationId', 'requestDigest', 'helperNonce', 'jti',
    'iat', 'exp', 'channelEpoch', 'previousChannelEpoch', 'permissions', 'limitsDigest'
]);
const HEADER_KEYS = Object.freeze([
    'version', 'direction', 'workspaceId', 'boxIdentity', 'boxGeneration', 'workerGeneration', 'executionId', 'attemptId', 'leaseId',
    'reservationId', 'targetBindingDigest', 'operationId', 'requestDigest', 'channelEpoch', 'sequence', 'messageKind', 'channelId',
    'connectionId', 'processId', 'bodyBytes', 'bodyDigest', 'descriptors'
]);

class Refusal {
    constructor(code) { this.code = code; }
}

function refuse(code) {
    throw new Refusal(code);
}

function need(condition, code = 'invalid_request') {
    if (!condition) refuse(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function run(check) {
    try {
        return success(check());
    } catch (error) {
        return failure(error instanceof Refusal ? error.code : 'invalid_request');
    }
}

function exactKeys(value, keys) {
    return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function unwrap(result) {
    if (!result.ok) refuse(result.error.code);
    return result.value;
}

function isNonce(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32
        && Buffer.from(value, 'base64url').toString('base64url') === value;
}

// The target identity the helper audience names: LiveScope target and Box fields only.
function targetIdentityDigest(scope) {
    return digestOf({
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration,
        agentPrincipal: scope.agentPrincipal, containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId,
        enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    });
}

function decodeSegment(segment) {
    need(typeof segment === 'string' && /^[A-Za-z0-9_-]+$/.test(segment), 'ticket_format');
    const bytes = Buffer.from(segment, 'base64url');
    need(bytes.toString('base64url') === segment, 'ticket_format');
    return bytes;
}

function sweep(replay, nowMs) {
    for (const [key, retainUntil] of replay) {
        if (retainUntil <= nowMs) replay.delete(key);
    }
}

// Validates a bootstrap/reattach ticket (compact HS256 JWS) and consumes its JTI and challenge exactly once.
// Order (after coordinatorAuth.mjs): strict decode; header `alg`, `typ` (purpose domain), exact keys, `kid`; HMAC in
// constant time; canonical claims, version and exact keys; issuer and purpose; lifetime (30 s, no expiry extension,
// 2 s future skew, challenge 5 s monotonic); audience and binding; channel epoch CAS; replay (last, only after every
// other check passed). A11: the claims carry the lease (`leaseId`), and a channel epoch is accepted when it is strictly
// greater than the epoch currently held for that lease (any positive epoch on first use). `options`:
//   secret        per-helper-incarnation key (Buffer, at least 32 bytes; synthetic in tests)
//   kid           the expected key ID
//   binding       the TargetBinding the helper already holds
//   expected      {reservationId, leaseId, operationId, requestDigest, helperNonce}
//   channel       {currentEpoch: null (first bootstrap) | U64Text, leaseState: 'active' | 'retired'}
//   challenge     {id, issuedMonoMs}; nowMonoMs; nowMs; clockUncertaintyMs (default 0)
//   replay        Map of replay-key digest -> retain-until ms (durable records hold only digests and expiry)
//   replayCapacity  default TARGET_LIMITS_V1.ticketReplayEntries; live entries are never evicted
export function validateHelperTicketClaims(token, options = {}) {
    return run(() => {
        need(isPlainObject(options) && Buffer.isBuffer(options.secret) && options.secret.length >= 32 && isOpaqueIdentity(options.kid));
        const binding = unwrap(validateTargetBinding(options.binding));
        const expected = options.expected;
        need(isPlainObject(expected));
        need(options.replay instanceof Map && Number.isSafeInteger(options.nowMs) && Number.isSafeInteger(options.nowMonoMs));
        need(typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH, 'ticket_format');
        const parts = token.split('.');
        need(parts.length === 3, 'ticket_format');
        const headerBytes = decodeSegment(parts[0]);
        const header = parseCanonicalTargetJson(headerBytes);
        need(header.ok, header.ok ? 'ticket_format' : header.error.code === 'noncanonical_encoding' ? 'noncanonical_encoding' : 'ticket_format');
        need(isPlainObject(header.value), 'ticket_format');
        need(header.value.alg === 'HS256', 'ticket_algorithm');
        // Domain separation before anything else: another token type is never a helper ticket.
        need(header.value.typ === TICKET_TYPE, 'ticket_purpose');
        need(exactKeys(header.value, ['alg', 'typ', 'kid']), 'ticket_format');
        need(header.value.kid === options.kid, 'ticket_signature');
        const signature = decodeSegment(parts[2]);
        const mac = crypto.createHmac('sha256', options.secret).update(`${parts[0]}.${parts[1]}`).digest();
        need(signature.length === mac.length && crypto.timingSafeEqual(signature, mac), 'ticket_signature');
        const parsed = parseCanonicalTargetJson(decodeSegment(parts[1]));
        need(parsed.ok, parsed.ok ? 'ticket_format' : parsed.error.code === 'noncanonical_encoding' ? 'noncanonical_encoding' : 'ticket_format');
        const claims = parsed.value;
        need(isPlainObject(claims), 'ticket_format');
        need(Object.hasOwn(claims, 'version') && claims.version === 1, 'unsupported_version');
        need(exactKeys(claims, CLAIM_KEYS), 'ticket_format');
        need(claims.iss === TICKET_ISSUER && claims.purpose === TICKET_PURPOSE, 'ticket_purpose');
        need(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp), 'ticket_lifetime');
        need(claims.exp > claims.iat && claims.exp - claims.iat <= MAX_TICKET_LIFETIME_SECONDS, 'ticket_lifetime');
        const uncertainty = options.clockUncertaintyMs ?? 0;
        need(Number.isSafeInteger(uncertainty) && uncertainty >= 0 && uncertainty <= MAX_FUTURE_SKEW_MS, 'ticket_lifetime');
        need(claims.iat * 1000 <= options.nowMs + MAX_FUTURE_SKEW_MS, 'ticket_lifetime');
        need(options.nowMs < claims.exp * 1000, 'ticket_lifetime');
        const challenge = options.challenge;
        need(isPlainObject(challenge) && typeof challenge.id === 'string' && challenge.id.length > 0 && Number.isSafeInteger(challenge.issuedMonoMs));
        need(options.nowMonoMs - challenge.issuedMonoMs < CHALLENGE_TIMEOUT_MS && options.nowMonoMs >= challenge.issuedMonoMs, 'ticket_lifetime');
        need(isNonce(claims.jti) && isNonce(claims.helperNonce) && isId(claims.leaseId), 'ticket_format');
        need(Array.isArray(claims.permissions) && claims.permissions.length > 0
            && claims.permissions.every((entry, index) => TICKET_PERMISSIONS.includes(entry) && (index === 0 || claims.permissions[index - 1] < entry)), 'ticket_format');
        need(claims.aud === `${TICKET_AUDIENCE_PREFIX}${targetIdentityDigest(binding.scope)}`, 'ticket_binding');
        need(digestOf(claims.binding) === digestOf(binding), 'ticket_binding');
        need(claims.sub === binding.scope.workerPrincipal && claims.limitsDigest === binding.limitsDigest, 'ticket_binding');
        need(claims.reservationId === expected.reservationId && claims.leaseId === expected.leaseId && claims.operationId === expected.operationId
            && claims.requestDigest === expected.requestDigest && claims.helperNonce === expected.helperNonce, 'ticket_binding');
        const channel = options.channel;
        need(isPlainObject(channel), 'invalid_request');
        // A stopped or expired lease cannot be reopened by any ticket.
        need(channel.leaseState === 'active', 'lease_retired');
        need(isPositiveU64Text(claims.channelEpoch) && (claims.previousChannelEpoch === null || isPositiveU64Text(claims.previousChannelEpoch)), 'ticket_format');
        // A11.2: strictly greater than the epoch held for this lease (a lost `accepted` or a worker crash costs one epoch
        // number, never recovery); `previousChannelEpoch`, when present, is below the new epoch.
        need(claims.previousChannelEpoch === null || BigInt(claims.previousChannelEpoch) < BigInt(claims.channelEpoch), 'channel_epoch_conflict');
        if (channel.currentEpoch !== null) {
            need(isPositiveU64Text(channel.currentEpoch), 'invalid_request');
            need(BigInt(claims.channelEpoch) > BigInt(channel.currentEpoch), 'channel_epoch_conflict');
        }
        const jtiKey = `jti:${crypto.createHash('sha256').update(claims.jti).digest('hex')}`;
        const challengeKey = `challenge:${crypto.createHash('sha256').update(challenge.id).digest('hex')}`;
        for (const key of [jtiKey, challengeKey]) {
            const until = options.replay.get(key);
            need(until === undefined || until <= options.nowMs, 'ticket_replayed');
        }
        const capacity = options.replayCapacity ?? TARGET_LIMITS_V1.ticketReplayEntries;
        if (options.replay.size + 2 > capacity) sweep(options.replay, options.nowMs);
        need(options.replay.size + 2 <= capacity, 'capacity_exceeded');
        const retainUntil = claims.exp * 1000 + REPLAY_MARGIN_MS;
        options.replay.set(jtiKey, retainUntil);
        options.replay.set(challengeKey, retainUntil);
        return deepFreeze(JSON.parse(JSON.stringify(claims)));
    });
}

// HKDF-SHA256 direction key: salt SHA256(canonical ticket claims), info exactly the direction.
function frameDirectionKey(sessionKey, claimsCanonical, direction) {
    const salt = crypto.createHash('sha256').update(claimsCanonical).digest();
    return Buffer.from(crypto.hkdfSync('sha256', sessionKey, salt, Buffer.from(direction, 'ascii'), 32));
}

function frameMac(key, prefix, header, body) {
    return crypto.createHmac('sha256', key).update(FRAME_MAC_PREFIX).update(prefix).update(header).update(body).digest();
}

// Validates one received frame. `state`:
//   direction        the direction this receiver accepts
//   sessionKey       32-byte session key; claimsCanonical: the canonical claim bytes of the accepted ticket
//   binding          the TargetBinding held by the receiver; expected {leaseId, reservationId, operationId, requestDigest}
//   channelEpoch, nextSequence (U64Text), leaseState ('active' | 'retired')
//   ancillary        {count, truncated, wellFormed, onFirstByte}: SCM_RIGHTS facts of this frame's recvmsg calls
//   channelManifest  optional: an `open` frame naming a channel must name an enabled one
//   limits           optional lower bounds (defaults TARGET_LIMITS_V1)
// Success: {header, bodyOffset, bodyLength, nextSequence}; the caller holds the bytes.
export function validateTargetFrame(bytes, state = {}) {
    return run(() => {
        need(bytes instanceof Uint8Array && isPlainObject(state));
        const limits = { ...TARGET_LIMITS_V1, ...(state.limits ?? {}) };
        need(Buffer.isBuffer(state.sessionKey) && state.sessionKey.length === 32 && typeof state.claimsCanonical === 'string');
        need(FRAME_DIRECTIONS.includes(state.direction));
        const binding = unwrap(validateTargetBinding(state.binding));
        const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        need(frame.length <= limits.frameBytes, 'capacity_exceeded');
        need(frame.length >= 8 + 32, 'frame_layout');
        need(frame.readUInt32BE(0) === frame.length - 4, 'frame_layout');
        const headerLength = frame.readUInt32BE(4);
        need(headerLength <= limits.headerBytes, 'capacity_exceeded');
        need(8 + headerLength + 32 <= frame.length, 'frame_layout');
        const ancillary = state.ancillary;
        need(isPlainObject(ancillary) && Number.isSafeInteger(ancillary.count) && ancillary.count >= 0, 'descriptor_count');
        // MSG_CTRUNC, malformed rights or rights anywhere but the first byte of the frame.
        need(ancillary.truncated === false && ancillary.wellFormed === true && (ancillary.count === 0 || ancillary.onFirstByte === true), 'descriptor_count');
        const headerBytes = frame.subarray(8, 8 + headerLength);
        const body = frame.subarray(8 + headerLength, frame.length - 32);
        const key = frameDirectionKey(state.sessionKey, state.claimsCanonical, state.direction);
        const mac = frameMac(key, frame.subarray(0, 8), headerBytes, body);
        need(crypto.timingSafeEqual(mac, frame.subarray(frame.length - 32)), 'frame_authentication');
        const parsed = parseCanonicalTargetJson(headerBytes, { maxBytes: limits.headerBytes });
        if (!parsed.ok) refuse(parsed.error.code);
        const header = parsed.value;
        need(isPlainObject(header));
        need(Object.hasOwn(header, 'version') && header.version === 1, 'unsupported_version');
        need(exactKeys(header, HEADER_KEYS));
        need(state.leaseState === 'active', 'lease_retired');
        const expected = state.expected;
        need(isPlainObject(expected));
        const scope = binding.scope;
        need(header.direction === state.direction, 'frame_binding');
        need(header.workspaceId === scope.workspaceId && header.boxIdentity === scope.boxIdentity && header.boxGeneration === scope.boxGeneration
            && header.workerGeneration === scope.workerGeneration && header.executionId === binding.executionId
            && header.attemptId === binding.attemptId, 'frame_binding');
        need(header.leaseId === expected.leaseId && header.reservationId === expected.reservationId
            && header.operationId === expected.operationId && header.requestDigest === expected.requestDigest, 'frame_binding');
        // The binding digest authorizes nothing by itself: it must equal the digest of the binding already held.
        need(header.targetBindingDigest === digestOf(binding), 'frame_binding');
        need(isPositiveU64Text(header.channelEpoch) && header.channelEpoch === state.channelEpoch, 'frame_binding');
        need(isPositiveU64Text(header.sequence) && header.sequence === state.nextSequence, 'frame_sequence');
        need(FRAME_MESSAGE_KINDS.includes(header.messageKind));
        need(header.channelId === null || CHANNEL_KINDS.includes(header.channelId));
        need(header.connectionId === null || isId(header.connectionId));
        need(header.processId === null || isPositiveU64Text(header.processId));
        need(isId(header.leaseId) && isId(header.reservationId) && isOperationId(header.operationId) && isDigest(header.requestDigest));
        need(Number.isSafeInteger(header.bodyBytes) && header.bodyBytes === body.length, 'frame_layout');
        need(isDigest(header.bodyDigest) && header.bodyDigest === crypto.createHash('sha256').update(body).digest('hex'), 'frame_layout');
        if (header.messageKind === 'data') {
            need(body.length <= limits.dataBytesPerFrame, 'capacity_exceeded');
            need(header.descriptors.length === 0 && ancillary.count === 0, 'descriptor_count');
        }
        need(Array.isArray(header.descriptors), 'invalid_request');
        need(header.descriptors.length <= limits.descriptorsPerFrame, 'capacity_exceeded');
        unwrap(validateDescriptorManifest(header.descriptors));
        need(header.descriptors.length === ancillary.count, 'descriptor_count');
        if (header.messageKind === 'open' && header.channelId !== null) {
            const manifest = unwrap(validateChannelManifest(state.channelManifest));
            need(manifest.channels.some((channel) => channel.channelId === header.channelId && channel.enabled), 'channel_not_admitted');
        }
        return {
            header, bodyOffset: 8 + headerLength, bodyLength: body.length,
            nextSequence: String(BigInt(header.sequence) + 1n)
        };
    });
}

function sameFsIdentity(left, right) {
    return isPlainObject(left) && isPlainObject(right) && ['filesystemId', 'mountId', 'device', 'inode', 'fileType']
        .every((key) => left[key] === right[key]);
}

function manifestSlots(manifest) {
    const slots = new Map();
    slots.set(manifest.home.descriptorId, { role: 'home', ...manifest.home });
    for (const grant of manifest.grants) slots.set(grant.descriptorId, { role: 'grant-root', ...grant });
    slots.set(manifest.skillOverlay.descriptorId, { role: 'skill-overlay', ...manifest.skillOverlay });
    slots.set(manifest.nativeConfigView.descriptorId, { role: 'native-config-view', ...manifest.nativeConfigView });
    return slots;
}

// Semantic check of one descriptor batch against the admitted input manifest (purpose 'input') or the admitted
// connections (purpose 'stream'). `input`:
//   purpose, origin ('worker' only), descriptors (frame header entries), received {count, truncated, wellFormed}
//   inputManifest, admitted {skillSelectionDigest, nativeConfigProjectionDigest, configRevision}
//   observed {[descriptorId]: {identity, parentChainVerified, rootLease, backing?, bytes?, files?}}
//   skillRoots {[grantId]: {identity, rootLease}}, availableSelectionIds
//   imported (descriptor IDs imported by earlier batches), phase ('import' | 'commit')
//   held {execution, target}: descriptors already held; streams {[descriptorId]: {socketCookie, connectionId}}
export function validateDescriptorTransfer(input = {}) {
    return run(() => {
        need(isPlainObject(input));
        const received = input.received;
        need(isPlainObject(received) && received.truncated === false && received.wellFormed === true, 'descriptor_count');
        need(Array.isArray(input.descriptors) && received.count === input.descriptors.length, 'descriptor_count');
        const descriptors = unwrap(validateDescriptorManifest(input.descriptors));
        const held = input.held ?? { execution: 0, target: 0 };
        need(isPlainObject(held) && Number.isSafeInteger(held.execution) && Number.isSafeInteger(held.target));
        need(held.execution + descriptors.length <= TARGET_LIMITS_V1.descriptorsPerExecution
            && held.target + descriptors.length <= TARGET_LIMITS_V1.descriptorsPerTarget, 'capacity_exceeded');
        // Handles originating from ALA (or anything but the worker) are never accepted.
        need(input.origin === 'worker', 'descriptor_role');
        const imported = new Set(Array.isArray(input.imported) ? input.imported : []);
        for (const entry of descriptors) need(!imported.has(entry.descriptorId), 'descriptor_count');
        if (input.purpose === 'stream') {
            const streams = isPlainObject(input.streams) ? input.streams : {};
            for (const entry of descriptors) {
                need(entry.role === 'connected-stream', 'descriptor_role');
                const stream = streams[entry.descriptorId];
                need(isPlainObject(stream), 'descriptor_role');
                need(stream.socketCookie === entry.identity.socketCookie, 'descriptor_identity');
            }
            return { purpose: 'stream', imported: descriptors.map((entry) => entry.descriptorId) };
        }
        need(input.purpose === 'input');
        const manifest = unwrap(validateInputManifest(input.inputManifest));
        const admitted = input.admitted;
        need(isPlainObject(admitted));
        // A changed selection or projection is not the admitted manifest: refuse, never re-resolve.
        need(manifest.skillOverlay.selectionDigest === admitted.skillSelectionDigest
            && manifest.nativeConfigView.projectionDigest === admitted.nativeConfigProjectionDigest
            && manifest.configRevision === admitted.configRevision, 'input_manifest_mismatch');
        const slots = manifestSlots(manifest);
        const observed = isPlainObject(input.observed) ? input.observed : {};
        for (const entry of descriptors) {
            const slot = slots.get(entry.descriptorId);
            // Not an admitted input (another HOME, a store parent, a namespace or listener handle) or a swapped role.
            need(slot !== undefined && slot.role === entry.role, 'descriptor_role');
            need(slot.destination === entry.destination && slot.access === entry.access, 'descriptor_role');
            need(sameFsIdentity(entry.identity, slot.identity), 'descriptor_identity');
            const facts = observed[entry.descriptorId];
            need(isPlainObject(facts) && sameFsIdentity(facts.identity, slot.identity) && facts.parentChainVerified === true
                && facts.rootLease === 'held', 'descriptor_identity');
            if (entry.role === 'native-config-view') {
                // The read-only view must be backed by immutable bytes; a read-only bind of mutable backing refuses.
                need(facts.backing === 'immutable', 'native_config_mutable');
                need(Number.isSafeInteger(facts.bytes) && facts.bytes >= 0 && Number.isSafeInteger(facts.files) && facts.files >= 0, 'native_config_mutable');
                need(facts.bytes <= NATIVE_CONFIG_MAX_BYTES && facts.files <= NATIVE_CONFIG_MAX_FILES, 'capacity_exceeded');
                need(facts.files === manifest.nativeConfigView.entries.length, 'input_manifest_mismatch');
            }
            if (entry.role === 'skill-overlay') {
                // Live-source semantics: the anchored roots must still be the admitted ones; their file bytes are not
                // snapshotted and may change.
                const roots = isPlainObject(input.skillRoots) ? input.skillRoots : {};
                for (const root of manifest.skillOverlay.roots) {
                    const live = roots[root.grantId];
                    if (live === undefined && !root.required) continue;
                    need(live !== undefined, 'required_input_missing');
                    need(isPlainObject(live) && sameFsIdentity(live.identity, root.identity) && live.rootLease === 'held', 'descriptor_identity');
                }
            }
        }
        const all = new Set([...imported, ...descriptors.map((entry) => entry.descriptorId)]);
        if (input.phase === 'commit') {
            for (const descriptorId of slots.keys()) need(all.has(descriptorId), 'required_input_missing');
            const available = new Set(Array.isArray(input.availableSelectionIds) ? input.availableSelectionIds : []);
            need(manifest.skillOverlay.requiredSelectionIds.every((selection) => available.has(selection)), 'required_input_missing');
        } else {
            need(input.phase === 'import');
        }
        return { purpose: 'input', imported: [...all].sort() };
    });
}

// The service-connect barrier. `input`:
//   binding, receipt (the current TargetReceipt), channelManifest, lease {leaseId, channelEpoch}
//   processId, connectionId, endpoint, services [{processId, state, processClass}], relayPorts [port]
//   ack: absent (request may be sent), or what the transport observed for this exact open:
//        {kind: 'open-ok', authenticated, targetBindingDigest, leaseId, processId, connectionId, channelEpoch}
//        {kind: 'open-refused'} | {kind: 'timeout'} | {kind: 'unknown'}
// Only an authenticated open-ok for the exact binding, lease, process, connection and epoch yields deliverHandle: true.
// Before it, every error, timeout or unknown outcome is a refusal with no handle; the paused local proxy is closed.
export function evaluateServiceConnect(input = {}) {
    return run(() => {
        need(isPlainObject(input));
        const binding = unwrap(validateTargetBinding(input.binding));
        const receipt = unwrap(validateTargetReceipt(input.receipt));
        need(receipt.targetBindingDigest === digestOf(binding), 'binding_mismatch');
        need(receipt.state === 'running', 'lease_retired');
        const manifest = unwrap(validateChannelManifest(input.channelManifest));
        need(manifest.executionId === binding.executionId && manifest.attemptId === binding.attemptId
            && digestOf(manifest) === binding.channelManifestDigest, 'binding_mismatch');
        const lease = input.lease;
        need(isPlainObject(lease) && lease.leaseId === receipt.leaseId && isPositiveU64Text(lease.channelEpoch), 'lease_retired');
        need(isId(input.connectionId));
        const endpoint = input.endpoint;
        need(isPlainObject(endpoint) && typeof endpoint.kind === 'string', 'channel_not_admitted');
        let processId = null;
        if (endpoint.kind === 'unix-socket') {
            refuse('unsupported_endpoint');
        } else if (endpoint.kind === 'loopback-port') {
            need(exactKeys(endpoint, ['kind', 'host', 'port']), 'channel_not_admitted');
            need(endpoint.host === '127.0.0.1', 'unsupported_endpoint');
            need(Number.isSafeInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535);
            need(isPositiveU64Text(input.processId));
            processId = input.processId;
            const services = Array.isArray(input.services) ? input.services : [];
            const service = services.find((entry) => isPlainObject(entry) && entry.processId === processId);
            need(service !== undefined && service.state === 'running' && service.processClass === 'service', 'not_a_running_service');
            // Every workload-channel relay port is denied, even when the service advertises it.
            const mcp = manifest.channels.find((channel) => channel.kind === 'mcp');
            const relays = new Set(Array.isArray(input.relayPorts) ? input.relayPorts : []);
            if (mcp.enabled) relays.add(mcp.endpoint.port);
            need(!relays.has(endpoint.port), 'relay_port');
        } else if (endpoint.kind === 'channel') {
            // A caller-supplied destination is never part of a channel open.
            need(exactKeys(endpoint, ['kind', 'channelId']), 'channel_not_admitted');
            need(manifest.channels.some((channel) => channel.channelId === endpoint.channelId && channel.enabled), 'channel_not_admitted');
        } else {
            refuse('channel_not_admitted');
        }
        const ack = input.ack;
        if (ack === undefined || ack === null) return { decision: 'open-requested', deliverHandle: false };
        need(isPlainObject(ack), 'outcome_unknown');
        if (ack.kind === 'open-refused') refuse('connect_refused');
        if (ack.kind === 'timeout') refuse('connect_timeout');
        need(ack.kind === 'open-ok', 'outcome_unknown');
        need(ack.authenticated === true, 'frame_authentication');
        need(ack.targetBindingDigest === receipt.targetBindingDigest && ack.leaseId === lease.leaseId && ack.processId === processId
            && ack.connectionId === input.connectionId && ack.channelEpoch === lease.channelEpoch, 'frame_binding');
        return { decision: 'deliver', deliverHandle: true };
    });
}
