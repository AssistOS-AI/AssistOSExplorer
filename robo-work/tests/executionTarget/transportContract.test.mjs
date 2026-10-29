// SYNTHETIC ticket, frame, descriptor and connect-barrier tests (transportContract.mjs). Keys are random synthetic test
// keys; there is no minter, listener, helper or target here. The connect harness uses a local Unix socket pair inside a
// temporary directory, standing in for the paused local proxy; it reaches no network.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { targetDigest } from '../../server/executionTarget/contract.mjs';
import {
    TRANSPORT_ERROR_CODES, evaluateServiceConnect, validateDescriptorTransfer, validateHelperTicketClaims, validateTargetFrame
} from '../../server/executionTarget/transportContract.mjs';
import { makeTempDir } from '../helpers/synthetic.mjs';

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);
const nonce = (label) => crypto.createHash('sha256').update(`synthetic-nonce:${label}`).digest().toString('base64url');
const SECRET = crypto.randomBytes(32);
const SESSION_KEY = crypto.randomBytes(32);
const NOW = 1_800_000_000_000;
const HANDLERS = { model: 'model-adapter', broker: 'execution-broker', mcp: 'execution-mcp', 'human-input': 'execution-human-input', 'task-failure': 'execution-task-failure' };

// Independent canonical encoder (recursive key sort over JSON.stringify).
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}

function refused(result, code, label) {
    assert.deepEqual(result, { ok: false, error: { code } }, label);
    assert.ok(TRANSPORT_ERROR_CODES.includes(code), `${code} enumerated`);
}

const fsId = (label, overrides = {}) => ({ filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: String(9000 + label.length * 17 + label.charCodeAt(0)), fileType: 'directory', ...overrides });

function binding(overrides = {}) {
    return {
        version: 1,
        scope: {
            workspaceId: 'ws-synthetic', boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: 'agent:SyntheticIDE/roboWork',
            workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'worker-enable-1', workerGeneration: sid('worker-gen'),
            agentPrincipal: 'agent:SyntheticRepo/target', containerId: 'c'.repeat(64), runtimeInstanceId: 'target-instance-1',
            enableGeneration: 'target-enable-1', helperIncarnation: sid('helper-1'), ...(overrides.scope ?? {})
        },
        source: {
            repositorySourceMode: 'prod', sourceRepositoryIdentity: 'https://example.invalid/synthetic/target.git',
            sourceRevision: { algorithm: 'git-sha1', value: 'a'.repeat(40) }, sourceProtectionEpoch: 3, sourceSelectionDigest: sdg('selection'),
            sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-synthetic-1'
        },
        targetImageDigest: `sha256:${sdg('image')}`, helperExecutableDigest: sdg('helper'), contractVersion: 1, contractDigest: sdg('contract'),
        inventoryDigest: sdg('inventory'), profileDigest: sdg('profile'), limitsDigest: sdg('limits'), qualificationRecordDigest: sdg('qualification'),
        effectiveSecurityDigest: sdg('security'), journalStoreIdentity: sid('journal'), robotId: sid('robot'), executionId: sid('exec'),
        attemptId: sid('attempt'), configRevision: 2, grantPolicyDigest: sdg('grants'), inputManifestDigest: sdg('input'),
        skillViewManifestDigest: sdg('skills'), nativeConfigProjectionDigest: sdg('native'),
        channelManifestDigest: sha(canonical(channelManifest())), homeCompatibilityDigest: sdg('home'),
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'scope'))
    };
}

function targetIdentity(scope) {
    return sha(canonical({
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration, agentPrincipal: scope.agentPrincipal,
        containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId, enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    }));
}

const EXPECTED = { reservationId: sid('reservation'), operationId: sid('op-start'), requestDigest: sdg('request'), helperNonce: nonce('helper') };

function claims(overrides = {}) {
    const b = binding();
    return {
        version: 1, iss: 'ploinky-router', sub: b.scope.workerPrincipal, purpose: 'ploinky.target-helper.v1',
        aud: `ploinky:target-helper:${targetIdentity(b.scope)}`, binding: b, reservationId: EXPECTED.reservationId, operationId: EXPECTED.operationId,
        requestDigest: EXPECTED.requestDigest, helperNonce: EXPECTED.helperNonce, jti: nonce(`jti-${Math.random()}`), iat: NOW / 1000 - 1,
        exp: NOW / 1000 + 20, channelEpoch: '1', previousChannelEpoch: null, permissions: ['commit', 'lookup', 'prepare'], limitsDigest: b.limitsDigest,
        ...overrides
    };
}

function sign(payload, { header = { alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: 'helper-key-1' }, secret = SECRET, payloadText, headerText } = {}) {
    const h = Buffer.from(headerText ?? canonical(header)).toString('base64url');
    const p = Buffer.from(payloadText ?? canonical(payload)).toString('base64url');
    const s = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${s}`;
}

function ticketOptions(overrides = {}) {
    return {
        secret: SECRET, kid: 'helper-key-1', binding: binding(), expected: { ...EXPECTED }, channel: { currentEpoch: null, leaseState: 'active' },
        challenge: { id: `challenge-${Math.random()}`, issuedMonoMs: 100 }, nowMonoMs: 200, nowMs: NOW, replay: new Map(), ...overrides
    };
}

test('a helper ticket validates once, binds every claim and records only digests for replay', () => {
    const options = ticketOptions();
    const result = validateHelperTicketClaims(sign(claims()), options);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.binding));
    assert.equal(options.replay.size, 2);
    for (const [entryKey, until] of options.replay) {
        assert.match(entryKey, /^(jti|challenge):[0-9a-f]{64}$/);
        assert.equal(until, (NOW / 1000 + 20) * 1000 + 2000);
    }
    assert.ok(Object.isFrozen(TRANSPORT_ERROR_CODES));
});

test('TKT-01 coordinator, user, broker, terminal and agentExec tokens are ticket_purpose', () => {
    const coordinatorStyle = sign({ typ: 'router-request', iss: 'ploinky-router', aud: 'agent:SyntheticRepo/target', tool: '__coordinator_admission__', iat: NOW / 1000, exp: NOW / 1000 + 20, jti: 'x' },
        { header: { alg: 'HS256', typ: 'JWT' }, secret: crypto.randomBytes(32) });
    const options = ticketOptions();
    refused(validateHelperTicketClaims(coordinatorStyle, options), 'ticket_purpose', 'coordinator router-request header');
    for (const purpose of ['ploinky.coordinator.v1', 'ploinky.user.v1', 'ploinky.broker.v1', 'ploinky.terminal.v1', 'ploinky.agent-exec.v1', 'execution:owner']) {
        refused(validateHelperTicketClaims(sign(claims({ purpose })), options), 'ticket_purpose', purpose);
    }
    refused(validateHelperTicketClaims(sign(claims({ iss: 'ploinky-agent' })), options), 'ticket_purpose', 'issuer');
    for (const typ of ['JWT', 'router-request', 'ploinky-broker+jwt', 'ploinky-agent-exec+jwt']) {
        refused(validateHelperTicketClaims(sign(claims(), { header: { alg: 'HS256', typ, kid: 'helper-key-1' } }), options), 'ticket_purpose', typ);
    }
    assert.equal(options.replay.size, 0, 'refused tickets consume nothing');
});

test('ticket decoding: algorithm, key, signature, canonical bytes, exact claims and version', () => {
    const options = ticketOptions();
    refused(validateHelperTicketClaims(sign(claims(), { header: { alg: 'none', typ: 'ploinky-target-helper+jwt', kid: 'helper-key-1' } }), options), 'ticket_algorithm', 'none');
    refused(validateHelperTicketClaims(sign(claims(), { header: { alg: 'HS512', typ: 'ploinky-target-helper+jwt', kid: 'helper-key-1' } }), options), 'ticket_algorithm', 'HS512');
    refused(validateHelperTicketClaims(sign(claims(), { header: { alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: 'other-key' } }), options), 'ticket_signature', 'kid');
    refused(validateHelperTicketClaims(sign(claims(), { secret: crypto.randomBytes(32) }), options), 'ticket_signature', 'wrong key');
    const token = sign(claims());
    refused(validateHelperTicketClaims(`${token.slice(0, -2)}${token.endsWith('AA') ? 'BA' : 'AA'}`, options), 'ticket_signature', 'tampered signature');
    refused(validateHelperTicketClaims(sign(claims(), { payloadText: JSON.stringify(claims(), null, 1) }), options), 'noncanonical_encoding', 'whitespace in signed claims');
    refused(validateHelperTicketClaims(sign(claims(), { payloadText: canonical(claims()).replace('{', '{"version":1,') }), options), 'noncanonical_encoding', 'duplicate claim key');
    refused(validateHelperTicketClaims(sign(claims(), { headerText: '{"typ":"ploinky-target-helper+jwt","alg":"HS256","kid":"helper-key-1"}' }), options), 'noncanonical_encoding', 'unsorted header');
    refused(validateHelperTicketClaims(sign(claims(), { header: { alg: 'HS256', typ: 'ploinky-target-helper+jwt', kid: 'helper-key-1', jku: 'https://example.invalid' } }), options), 'ticket_format', 'extra header key');
    refused(validateHelperTicketClaims(sign({ ...claims(), tool: 'x' }), options), 'ticket_format', 'extra claim');
    refused(validateHelperTicketClaims(sign(claims({ version: 2 })), options), 'unsupported_version', 'version');
    refused(validateHelperTicketClaims(`${token}=`, options), 'ticket_format', 'padding');
    refused(validateHelperTicketClaims('a.b', options), 'ticket_format', 'two segments');
    refused(validateHelperTicketClaims(sign(claims({ jti: 'short' })), options), 'ticket_format', 'jti not 32 random bytes');
    refused(validateHelperTicketClaims(sign(claims({ permissions: ['prepare', 'commit'] })), options), 'ticket_format', 'unsorted permissions');
    refused(validateHelperTicketClaims(sign(claims({ permissions: ['exec'] })), options), 'ticket_format', 'unknown permission');
    assert.equal(options.replay.size, 0);
});

test('TKT-02 wrong audience, helper nonce, incarnation, request digest or binding is ticket_binding', () => {
    const options = ticketOptions();
    const otherIncarnation = binding({ scope: { helperIncarnation: sid('helper-2') } });
    const cases = [
        ['audience', claims({ aud: `ploinky:target-helper:${sdg('other')}` })],
        ['audience of another helper incarnation', claims({ aud: `ploinky:target-helper:${targetIdentity(otherIncarnation.scope)}`, binding: otherIncarnation })],
        ['helper nonce', claims({ helperNonce: nonce('other') })],
        ['request digest', claims({ requestDigest: sdg('other-request') })],
        ['reservation', claims({ reservationId: sid('other-res') })],
        ['operation', claims({ operationId: sid('other-op') })],
        ['subject', claims({ sub: 'agent:SyntheticIDE/other' })],
        ['limits digest', claims({ limitsDigest: sdg('other-limits') })],
        ['binding body', claims({ binding: binding({ configRevision: 3 }) })]
    ];
    for (const [label, payload] of cases) refused(validateHelperTicketClaims(sign(payload), options), 'ticket_binding', label);
    refused(validateHelperTicketClaims(sign(claims()), ticketOptions({ binding: otherIncarnation })), 'ticket_binding', 'helper recreated: old ticket');
    assert.equal(options.replay.size, 0);
});

test('TKT-03 31-second lifetime, expiry at the boundary, excessive future issuance and stale challenges are ticket_lifetime', () => {
    const at = (overrides, optionOverrides = {}) => validateHelperTicketClaims(sign(claims(overrides)), ticketOptions(optionOverrides));
    refused(at({ iat: NOW / 1000, exp: NOW / 1000 + 31 }), 'ticket_lifetime', '31 s');
    assert.equal(at({ iat: NOW / 1000, exp: NOW / 1000 + 30 }).ok, true, '30 s');
    refused(at({ iat: NOW / 1000, exp: NOW / 1000 }), 'ticket_lifetime', 'zero lifetime');
    refused(at({ iat: NOW / 1000 - 20, exp: NOW / 1000 }), 'ticket_lifetime', 'expired exactly at now (no extension)');
    assert.equal(at({ iat: NOW / 1000 - 20, exp: NOW / 1000 + 1 }, { nowMs: NOW + 999 }).ok, true, 'one millisecond before expiry');
    refused(at({ iat: NOW / 1000 + 3, exp: NOW / 1000 + 20 }, { nowMs: NOW + 999 }), 'ticket_lifetime', 'issued 2001 ms in the future');
    assert.equal(at({ iat: NOW / 1000 + 2, exp: NOW / 1000 + 20 }).ok, true, 'issued 2000 ms in the future');
    refused(at({}, { clockUncertaintyMs: 2001 }), 'ticket_lifetime', 'clock uncertainty above 2 s refuses bootstrap');
    refused(at({}, { nowMonoMs: 100 + 5000 }), 'ticket_lifetime', 'challenge 5 s old (monotonic)');
    assert.equal(at({}, { nowMonoMs: 100 + 4999 }).ok, true, 'challenge 4999 ms old');
    refused(at({ iat: 1.5 }), 'ticket_format', 'a fractional iat is not canonical JSON');
});

test('TKT-04 replayed JTI or challenge and stale reattach CAS refuse; a retired lease is never reopened', () => {
    const replay = new Map();
    const token = sign(claims());
    assert.equal(validateHelperTicketClaims(token, ticketOptions({ replay })).ok, true);
    refused(validateHelperTicketClaims(token, ticketOptions({ replay })), 'ticket_replayed', 'same JTI');
    const challenge = { id: 'challenge-fixed', issuedMonoMs: 100 };
    assert.equal(validateHelperTicketClaims(sign(claims()), ticketOptions({ replay, challenge })).ok, true);
    refused(validateHelperTicketClaims(sign(claims()), ticketOptions({ replay, challenge })), 'ticket_replayed', 'same challenge');
    assert.equal(replay.size, 4);
    const reattach = (current, channelEpoch, previousChannelEpoch) => validateHelperTicketClaims(sign(claims({ channelEpoch, previousChannelEpoch })), ticketOptions({ channel: { currentEpoch: current, leaseState: 'active' } }));
    assert.equal(reattach('1', '2', '1').ok, true, 'reattach advances the epoch');
    assert.equal(reattach('18446744073709551614', '18446744073709551615', '18446744073709551614').ok, true, 'U64 epoch arithmetic');
    refused(reattach('2', '2', '1'), 'channel_epoch_conflict', 'stale reattach CAS');
    refused(reattach('1', '3', '1'), 'channel_epoch_conflict', 'skipped epoch');
    refused(reattach('2', '1', null), 'channel_epoch_conflict', 'first bootstrap on an existing channel');
    refused(reattach(null, '2', '1'), 'channel_epoch_conflict', 'reattach without a channel');
    refused(validateHelperTicketClaims(sign(claims()), ticketOptions({ channel: { currentEpoch: null, leaseState: 'retired' } })), 'lease_retired', 'stopped or expired lease');
});

test('CAP-01 ticket replay store: no live eviction, expired entries swept', () => {
    const replay = new Map();
    assert.equal(validateHelperTicketClaims(sign(claims()), ticketOptions({ replay, replayCapacity: 2 })).ok, true);
    refused(validateHelperTicketClaims(sign(claims()), ticketOptions({ replay, replayCapacity: 2 })), 'capacity_exceeded', 'full of live entries');
    assert.equal(replay.size, 2, 'live entries kept');
    const later = NOW + 22_000;
    const fresh = claims({ iat: later / 1000 - 1, exp: later / 1000 + 20 });
    assert.equal(validateHelperTicketClaims(sign(fresh), ticketOptions({ replay, replayCapacity: 2, nowMs: later })).ok, true, 'after expiry + 2 s');
});

// ---- Frames ------------------------------------------------------------------------------------------------------

const CLAIMS_CANONICAL = canonical(claims({ jti: nonce('fixed-jti') }));

function directionKey(direction) {
    return Buffer.from(crypto.hkdfSync('sha256', SESSION_KEY, crypto.createHash('sha256').update(CLAIMS_CANONICAL).digest(), Buffer.from(direction), 32));
}

function header(overrides = {}) {
    const b = binding();
    return {
        version: 1, direction: 'worker-to-target', workspaceId: b.scope.workspaceId, boxIdentity: b.scope.boxIdentity, boxGeneration: b.scope.boxGeneration,
        workerGeneration: b.scope.workerGeneration, executionId: b.executionId, attemptId: b.attemptId, leaseId: sid('lease'),
        reservationId: EXPECTED.reservationId, targetBindingDigest: sha(canonical(b)), operationId: EXPECTED.operationId, requestDigest: EXPECTED.requestDigest,
        channelEpoch: '1', sequence: '1', messageKind: 'data', channelId: null, connectionId: sid('conn-1'), processId: '1', bodyBytes: 0,
        bodyDigest: sha(Buffer.alloc(0)), descriptors: [], ...overrides
    };
}

function frame({ head = header(), body = Buffer.alloc(0), direction = 'worker-to-target', headerText, fixBody = true } = {}) {
    const fullHeader = fixBody ? { ...head, bodyBytes: body.length, bodyDigest: sha(body) } : head;
    const headerBytes = Buffer.from(headerText ?? canonical(fullHeader));
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(4 + headerBytes.length + body.length + 32, 0);
    prefix.writeUInt32BE(headerBytes.length, 4);
    const mac = crypto.createHmac('sha256', directionKey(direction)).update('ploinky-target-frame-v1\u0000').update(prefix).update(headerBytes).update(body).digest();
    return Buffer.concat([prefix, headerBytes, body, mac]);
}

function frameState(overrides = {}) {
    return {
        direction: 'worker-to-target', sessionKey: SESSION_KEY, claimsCanonical: CLAIMS_CANONICAL, binding: binding(),
        expected: { leaseId: sid('lease'), reservationId: EXPECTED.reservationId, operationId: EXPECTED.operationId, requestDigest: EXPECTED.requestDigest },
        channelEpoch: '1', nextSequence: '1', leaseState: 'active', ancillary: { count: 0, truncated: false, wellFormed: true, onFirstByte: true },
        channelManifest: channelManifest(), ...overrides
    };
}

test('a frame with the exact layout, direction key and next sequence validates', () => {
    const body = Buffer.from('synthetic bytes');
    const result = validateTargetFrame(frame({ body }), frameState());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.nextSequence, '2');
    assert.equal(result.value.bodyLength, body.length);
    assert.equal(frame({ body }).subarray(result.value.bodyOffset, result.value.bodyOffset + result.value.bodyLength).toString(), 'synthetic bytes');
});

test('FRM-01 altering any authenticated byte, or descriptor order, is refused', () => {
    const descriptorsHeader = header({ messageKind: 'prepare', descriptors: descriptors().slice(0, 2) });
    const bytes = frame({ head: descriptorsHeader, body: Buffer.from('prepare-body') });
    const state = frameState({ ancillary: { count: 2, truncated: false, wellFormed: true, onFirstByte: true } });
    assert.equal(validateTargetFrame(bytes, state).ok, true);
    for (let index = 0; index < bytes.length; index += 1) {
        const altered = Buffer.from(bytes);
        altered[index] ^= 0x01;
        const result = validateTargetFrame(altered, state);
        assert.equal(result.ok, false, `byte ${index}`);
        if (index >= 8) assert.equal(result.error.code, 'frame_authentication', `byte ${index}`);
        else assert.ok(['frame_layout', 'capacity_exceeded', 'frame_authentication'].includes(result.error.code), `length byte ${index}: ${result.error.code}`);
    }
    // Swapping the descriptor entries inside an otherwise identical header without re-signing.
    const swapped = canonical({ ...descriptorsHeader, bodyBytes: 12, bodyDigest: sha(Buffer.from('prepare-body')), descriptors: [...descriptorsHeader.descriptors].reverse() });
    const original = canonical({ ...descriptorsHeader, bodyBytes: 12, bodyDigest: sha(Buffer.from('prepare-body')) });
    assert.equal(swapped.length, original.length);
    const reordered = Buffer.from(bytes);
    Buffer.from(swapped).copy(reordered, 8);
    refused(validateTargetFrame(reordered, state), 'frame_authentication', 'descriptor order');
});

test('FRM-02 and CHN-03 duplicate or gapped sequence, stale epoch, wrong direction and retired lease', () => {
    refused(validateTargetFrame(frame(), frameState({ nextSequence: '2' })), 'frame_sequence', 'duplicate');
    refused(validateTargetFrame(frame({ head: header({ sequence: '3' }) }), frameState({ nextSequence: '2' })), 'frame_sequence', 'gap');
    refused(validateTargetFrame(frame(), frameState({ channelEpoch: '2' })), 'frame_binding', 'stale epoch');
    refused(validateTargetFrame(frame({ head: header({ direction: 'target-to-worker' }) }), frameState()), 'frame_binding', 'header names the other direction');
    refused(validateTargetFrame(frame({ direction: 'target-to-worker' }), frameState()), 'frame_authentication', 'reflected frame under the other direction key');
    refused(validateTargetFrame(frame(), frameState({ leaseState: 'retired' })), 'lease_retired', 'reconnect after cleanup');
    for (const [label, change] of [['workspace', { workspaceId: 'ws-other' }], ['lease', { leaseId: sid('lease-2') }], ['reservation', { reservationId: sid('res-2') }],
        ['binding digest', { targetBindingDigest: sdg('other') }], ['worker generation', { workerGeneration: sid('gen-2') }], ['attempt', { attemptId: sid('attempt-2') }]]) {
        refused(validateTargetFrame(frame({ head: header(change) }), frameState()), 'frame_binding', label);
    }
});

test('FD-01 descriptor count, truncation, misplaced rights and duplicate slots in frames', () => {
    const twoHeader = header({ messageKind: 'prepare', descriptors: descriptors().slice(0, 2) });
    const ancillary = (overrides) => frameState({ ancillary: { count: 2, truncated: false, wellFormed: true, onFirstByte: true, ...overrides } });
    refused(validateTargetFrame(frame({ head: twoHeader }), ancillary({ count: 3 })), 'descriptor_count', 'extra descriptor');
    refused(validateTargetFrame(frame({ head: twoHeader }), ancillary({ count: 1 })), 'descriptor_count', 'missing descriptor');
    refused(validateTargetFrame(frame({ head: twoHeader }), ancillary({ truncated: true })), 'descriptor_count', 'MSG_CTRUNC');
    refused(validateTargetFrame(frame({ head: twoHeader }), ancillary({ wellFormed: false })), 'descriptor_count', 'malformed rights');
    refused(validateTargetFrame(frame({ head: twoHeader }), ancillary({ onFirstByte: false })), 'descriptor_count', 'rights not on the first byte');
    const duplicateSlot = header({ messageKind: 'prepare', descriptors: descriptors().slice(0, 2).map((entry) => ({ ...entry, slot: 0 })) });
    refused(validateTargetFrame(frame({ head: duplicateSlot }), ancillary({})), 'descriptor_count', 'duplicate slot');
    refused(validateTargetFrame(frame({ head: header({ descriptors: descriptors().slice(0, 1) }) }), frameState({ ancillary: { count: 1, truncated: false, wellFormed: true, onFirstByte: true } })), 'descriptor_count', 'data frame with a descriptor');
    refused(validateTargetFrame(frame(), frameState({ ancillary: { count: 1, truncated: false, wellFormed: true, onFirstByte: true } })), 'descriptor_count', 'data frame with received rights');
});

test('CAP-01 frame, header, data and descriptor bounds at and above the ceiling', () => {
    const base = header({ messageKind: 'prepare' });
    const bodyFor = (total) => {
        const probe = frame({ head: base, body: Buffer.alloc(0) });
        return Buffer.alloc(total - probe.length - (String(total).length - 1));
    };
    let body = bodyFor(589824);
    let bytes = frame({ head: base, body });
    while (bytes.length > 589824) { body = body.subarray(1); bytes = frame({ head: base, body }); }
    while (bytes.length < 589824) { body = Buffer.alloc(body.length + 1); bytes = frame({ head: base, body }); }
    assert.equal(bytes.length, 589824);
    assert.equal(validateTargetFrame(bytes, frameState()).ok, true, 'frame at 589824 bytes');
    refused(validateTargetFrame(frame({ head: base, body: Buffer.alloc(body.length + 1) }), frameState()), 'capacity_exceeded', 'frame + 1');
    assert.equal(validateTargetFrame(frame({ body: Buffer.alloc(65536) }), frameState()).ok, true, 'data 65536');
    refused(validateTargetFrame(frame({ body: Buffer.alloc(65537) }), frameState()), 'capacity_exceeded', 'data 65537');
    const plain = frame();
    const headerLength = plain.readUInt32BE(4);
    assert.equal(validateTargetFrame(plain, frameState({ limits: { headerBytes: headerLength } })).ok, true, 'header at bound');
    refused(validateTargetFrame(plain, frameState({ limits: { headerBytes: headerLength - 1 } })), 'capacity_exceeded', 'header over bound');
    const many = (n) => Array.from({ length: n }, (_, slot) => ({ ...descriptors()[4], slot, descriptorId: sid(`fd-${slot}`) }));
    const at8 = frame({ head: header({ messageKind: 'open', descriptors: many(8) }) });
    assert.equal(validateTargetFrame(at8, frameState({ ancillary: { count: 8, truncated: false, wellFormed: true, onFirstByte: true } })).ok, true, '8 descriptors');
    refused(validateTargetFrame(frame({ head: header({ messageKind: 'open', descriptors: many(9) }) }), frameState({ ancillary: { count: 9, truncated: false, wellFormed: true, onFirstByte: true } })), 'capacity_exceeded', '9 descriptors');
});

test('frame header encoding: noncanonical, versioned, exact, consistent body and admitted channel', () => {
    const noncanonical = frame({ headerText: JSON.stringify(header(), null, 1) });
    refused(validateTargetFrame(noncanonical, frameState()), 'noncanonical_encoding', 'whitespace header with a valid MAC');
    refused(validateTargetFrame(frame({ head: { ...header(), version: 2 } }), frameState()), 'unsupported_version', 'version');
    refused(validateTargetFrame(frame({ head: { ...header(), extra: 1 } }), frameState()), 'invalid_request', 'unknown header key');
    refused(validateTargetFrame(frame({ head: { ...header(), bodyBytes: 5 }, fixBody: false, body: Buffer.from('four') }), frameState()), 'frame_layout', 'body length');
    refused(validateTargetFrame(frame({ head: { ...header(), bodyDigest: sdg('x'), bodyBytes: 4 }, fixBody: false, body: Buffer.from('four') }), frameState()), 'frame_layout', 'body digest');
    refused(validateTargetFrame(frame({ head: header({ messageKind: 'exec' }) }), frameState()), 'invalid_request', 'message kind');
    const disabled = channelManifest(['human-input']);
    refused(validateTargetFrame(frame({ head: header({ messageKind: 'open', channelId: 'human-input' }) }), frameState({ channelManifest: disabled })), 'channel_not_admitted', 'CHN-01 disabled channel open');
    assert.equal(validateTargetFrame(frame({ head: header({ messageKind: 'open', channelId: 'model' }) }), frameState()).ok, true);
});

// ---- Descriptor transfers (INP, FD) ------------------------------------------------------------------------------

function channelManifest(disabled = []) {
    return {
        version: 1, executionId: sid('exec'), attemptId: sid('attempt'), limitsDigest: sdg('limits'),
        channels: ['model', 'broker', 'mcp', 'human-input', 'task-failure'].map((kind) => (disabled.includes(kind)
            ? { channelId: kind, kind, enabled: false, required: false, endpoint: null, handler: null, policyDigest: null, finalExecTokenName: null }
            : {
                channelId: kind, kind, enabled: true, required: true,
                endpoint: kind === 'mcp' ? { transport: 'tcp', host: '127.0.0.1', port: 40123 } : { transport: 'unix', path: `/run/robo-work/channels/${kind}.sock` },
                handler: HANDLERS[kind], policyDigest: sdg(`policy-${kind}`), finalExecTokenName: null
            }))
    };
}

function inputManifest(skillIdentity = fsId('skill'), rootIdentity = fsId('skills-main')) {
    const entries = [{ path: 'config.toml', contentDigest: sdg('config'), mode: '0444' }];
    return {
        version: 1, executionId: sid('exec'), attemptId: sid('attempt'), configRevision: 2,
        home: { descriptorId: sid('d-home'), identity: fsId('home'), destination: '/home/robot', access: 'write' },
        grants: [{ grantId: 'alpha', descriptorId: sid('d-alpha'), identity: fsId('alpha'), destination: '/projects/alpha', access: 'write', filterPolicyDigest: sdg('filter-a') }],
        skillOverlay: {
            descriptorId: sid('d-skill'), identity: skillIdentity, destination: '/run/robo-work/skills', access: 'read', semantics: 'live-source',
            selectionDigest: sdg('skill-selection'), policyDigest: sdg('skill-policy'), viewStructureDigest: sdg('skill-view'),
            roots: [{ grantId: 'skills-main', identity: rootIdentity, bindingChainDigest: sdg('skill-chain'), required: true }],
            requiredSelectionIds: ['skill:review']
        },
        nativeConfigView: {
            descriptorId: sid('d-native'), identity: fsId('native'), destination: '/run/robo-work/config/native', access: 'read',
            semantics: 'immutable-backed', configRevision: 2, projectionDigest: targetDigest(entries).value, entries
        }
    };
}

function descriptors(manifest = inputManifest()) {
    return [
        { slot: 0, descriptorId: manifest.home.descriptorId, role: 'home', kind: 'directory', access: 'write', identity: manifest.home.identity, destination: '/home/robot', resourceId: sid('r-home') },
        { slot: 1, descriptorId: manifest.grants[0].descriptorId, role: 'grant-root', kind: 'directory', access: 'write', identity: manifest.grants[0].identity, destination: '/projects/alpha', resourceId: sid('r-alpha') },
        { slot: 2, descriptorId: manifest.skillOverlay.descriptorId, role: 'skill-overlay', kind: 'directory', access: 'read', identity: manifest.skillOverlay.identity, destination: '/run/robo-work/skills', resourceId: sid('r-skill') },
        { slot: 3, descriptorId: manifest.nativeConfigView.descriptorId, role: 'native-config-view', kind: 'directory', access: 'read', identity: manifest.nativeConfigView.identity, destination: '/run/robo-work/config/native', resourceId: sid('r-native') },
        { slot: 4, descriptorId: sid('d-stream'), role: 'connected-stream', kind: 'connected-stream', access: 'duplex', identity: { socketCookie: '12345' }, destination: null, resourceId: sid('r-stream') }
    ];
}

function transfer(overrides = {}) {
    const manifest = overrides.inputManifest ?? inputManifest();
    const entries = (overrides.descriptors ?? descriptors(manifest).slice(0, 4)).map((entry, slot) => ({ ...entry, slot }));
    const observed = Object.fromEntries(descriptors(manifest).slice(0, 4).map((entry) => [entry.descriptorId, { identity: entry.identity, parentChainVerified: true, rootLease: 'held' }]));
    observed[manifest.nativeConfigView.descriptorId] = { ...observed[manifest.nativeConfigView.descriptorId], backing: 'immutable', bytes: 1024, files: 1 };
    return {
        purpose: 'input', origin: 'worker', descriptors: entries, received: { count: entries.length, truncated: false, wellFormed: true },
        inputManifest: manifest, admitted: { skillSelectionDigest: sdg('skill-selection'), nativeConfigProjectionDigest: manifest.nativeConfigView.projectionDigest, configRevision: 2 },
        observed, skillRoots: { 'skills-main': { identity: manifest.skillOverlay.roots[0].identity, rootLease: 'held' } },
        availableSelectionIds: ['skill:review'], imported: [], phase: 'commit', held: { execution: 0, target: 0 },
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['inputManifest', 'descriptors'].includes(key)))
    };
}

test('an input batch matching the admitted manifest imports, in one or several authenticated batches', () => {
    const whole = validateDescriptorTransfer(transfer());
    assert.equal(whole.ok, true, JSON.stringify(whole));
    const first = validateDescriptorTransfer(transfer({ descriptors: descriptors().slice(0, 2), phase: 'import' }));
    assert.equal(first.ok, true);
    const second = validateDescriptorTransfer(transfer({ descriptors: descriptors().slice(2, 4), imported: first.value.imported, phase: 'commit' }));
    assert.equal(second.ok, true);
    assert.equal(second.value.imported.length, 4);
});

test('FD-01 and FD-02 extra or truncated descriptors, ALA handles and non-input handles are refused without retaining them', () => {
    const handles = [{ fd: 7, close() {} }, { fd: 8, close() {} }];
    const cases = [
        ['FD-01 extra descriptor', transfer({ received: { count: 5, truncated: false, wellFormed: true, handles } }), 'descriptor_count'],
        ['FD-01 ancillary truncation', transfer({ received: { count: 4, truncated: true, wellFormed: true, handles } }), 'descriptor_count'],
        ['FD-01 malformed rights', transfer({ received: { count: 4, truncated: false, wellFormed: false, handles } }), 'descriptor_count'],
        ['FD-01 duplicate import', transfer({ imported: [sid('d-home')] }), 'descriptor_count'],
        ['FD-02 ALA-supplied handle', transfer({ origin: 'ala' }), 'descriptor_role'],
        ['FD-02 namespace descriptor', transfer({ descriptors: [{ ...descriptors()[0], role: 'namespace' }], phase: 'import' }), 'descriptor_role'],
        ['FD-02 listener', transfer({ descriptors: [{ ...descriptors()[4], kind: 'listener' }], phase: 'import' }), 'descriptor_role'],
        ['FD-02 another HOME', transfer({ descriptors: [{ ...descriptors()[0], descriptorId: sid('other-home') }], phase: 'import' }), 'descriptor_role'],
        ['FD-02 store parent as a grant', transfer({ descriptors: [{ ...descriptors()[1], descriptorId: sid('store-parent'), destination: '/projects/beta' }], phase: 'import' }), 'descriptor_role'],
        ['FD-02 connected stream in an input batch', transfer({ descriptors: [descriptors()[4]], phase: 'import' }), 'descriptor_role']
    ];
    for (const [label, input, code] of cases) {
        const result = validateDescriptorTransfer(input);
        refused(result, code, label);
        assert.equal(JSON.stringify(result), JSON.stringify({ ok: false, error: { code } }), `${label}: no handle reference in the refusal`);
    }
});

test('INP-01..INP-04 role swaps, identity substitution, mutable native config and missing or changed inputs', () => {
    const manifest = inputManifest();
    const swapped = descriptors(manifest).slice(0, 4);
    [swapped[2].descriptorId, swapped[3].descriptorId] = [swapped[3].descriptorId, swapped[2].descriptorId];
    refused(validateDescriptorTransfer(transfer({ descriptors: swapped })), 'descriptor_role', 'INP-01 skill-overlay and native-config swapped');
    const observedChange = (descriptorId, change) => {
        const input = transfer();
        input.observed[descriptorId] = { ...input.observed[descriptorId], ...change };
        return input;
    };
    refused(validateDescriptorTransfer(observedChange(sid('d-alpha'), { parentChainVerified: false })), 'descriptor_identity', 'INP-02 parent-directory substitution');
    refused(validateDescriptorTransfer(observedChange(sid('d-alpha'), { identity: fsId('alpha', { inode: '1' }) })), 'descriptor_identity', 'INP-02 wrong inode');
    refused(validateDescriptorTransfer(observedChange(sid('d-home'), { identity: fsId('home', { mountId: '42' }) })), 'descriptor_identity', 'INP-02 wrong mount');
    refused(validateDescriptorTransfer(observedChange(sid('d-home'), { rootLease: 'lost' })), 'descriptor_identity', 'INP-02 stale root lease');
    refused(validateDescriptorTransfer(transfer({ skillRoots: { 'skills-main': { identity: fsId('skills-main'), rootLease: 'lost' } } })), 'descriptor_identity', 'INP-02 lost skill root lease');
    refused(validateDescriptorTransfer(transfer({ descriptors: [{ ...descriptors()[1], identity: fsId('alpha', { inode: '2' }) }], phase: 'import' })), 'descriptor_identity', 'INP-02 header identity differs from the manifest');
    refused(validateDescriptorTransfer(observedChange(sid('d-native'), { backing: 'mutable' })), 'native_config_mutable', 'INP-03 read-only bind over mutable backing');
    refused(validateDescriptorTransfer(observedChange(sid('d-native'), { backing: 'unknown' })), 'native_config_mutable', 'INP-03 unknown backing');
    assert.equal(validateDescriptorTransfer(observedChange(sid('d-native'), { bytes: 1048576 })).ok, true, 'CAP-01 1 MiB native config');
    refused(validateDescriptorTransfer(observedChange(sid('d-native'), { bytes: 1048577 })), 'capacity_exceeded', 'CAP-01 1 MiB + 1');
    refused(validateDescriptorTransfer(transfer({ descriptors: descriptors().slice(0, 3) })), 'required_input_missing', 'INP-04 missing native config at commit');
    refused(validateDescriptorTransfer(transfer({ skillRoots: {} })), 'required_input_missing', 'INP-04 missing required skill root');
    refused(validateDescriptorTransfer(transfer({ availableSelectionIds: [] })), 'required_input_missing', 'INP-04 missing required skill');
    refused(validateDescriptorTransfer(transfer({ admitted: { skillSelectionDigest: sdg('changed'), nativeConfigProjectionDigest: manifest.nativeConfigView.projectionDigest, configRevision: 2 } })), 'input_manifest_mismatch', 'INP-04 changed selection');
    refused(validateDescriptorTransfer(transfer({ admitted: { skillSelectionDigest: sdg('skill-selection'), nativeConfigProjectionDigest: sdg('other'), configRevision: 2 } })), 'input_manifest_mismatch', 'changed native projection');
    assert.equal(validateDescriptorTransfer(transfer({ held: { execution: 252, target: 0 } })).ok, true, 'CAP-01 256 descriptors per execution');
    refused(validateDescriptorTransfer(transfer({ held: { execution: 253, target: 0 } })), 'capacity_exceeded', 'CAP-01 257 per execution');
    refused(validateDescriptorTransfer(transfer({ held: { execution: 0, target: 2045 } })), 'capacity_exceeded', 'CAP-01 2049 per target');
});

function identityOf(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    return { filesystemId: 'synthetic-temp-fs', mountId: '1', device: String(stat.dev), inode: String(stat.ino), fileType: 'directory' };
}

test('INP-05 refreshing ordinary live skill bytes under the same admitted roots is accepted; root replacement is not', (t) => {
    const dir = makeTempDir(t);
    const root = path.join(dir, 'skills-main');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'synthetic skill v1');
    const manifest = inputManifest(identityOf(dir), identityOf(root));
    const run = (rootIdentity) => validateDescriptorTransfer(transfer({ inputManifest: manifest, skillRoots: { 'skills-main': { identity: rootIdentity, rootLease: 'held' } } }));
    assert.equal(run(identityOf(root)).ok, true, 'admitted');
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'synthetic skill v2 with different bytes');
    fs.writeFileSync(path.join(root, 'helper.py'), 'print("synthetic")');
    assert.equal(run(identityOf(root)).ok, true, 'live refresh: no frozen-content requirement');
    fs.renameSync(root, path.join(dir, 'skills-old'));
    fs.mkdirSync(root);
    refused(run(identityOf(root)), 'descriptor_identity', 'replaced root');
});

test('connected-stream transfers match the admitted socket identity', () => {
    const stream = descriptors()[4];
    const base = { purpose: 'stream', origin: 'worker', descriptors: [{ ...stream, slot: 0 }], received: { count: 1, truncated: false, wellFormed: true }, streams: { [stream.descriptorId]: { socketCookie: '12345' } } };
    assert.equal(validateDescriptorTransfer(base).ok, true);
    refused(validateDescriptorTransfer({ ...base, streams: { [stream.descriptorId]: { socketCookie: '999' } } }), 'descriptor_identity', 'other socket');
    refused(validateDescriptorTransfer({ ...base, streams: {} }), 'descriptor_role', 'not an admitted connection');
    refused(validateDescriptorTransfer({ ...base, descriptors: [{ ...descriptors()[0], slot: 0 }] }), 'descriptor_role', 'directory in a stream transfer');
});

// ---- Service-connect barrier (CHN, CON) -------------------------------------------------------------------------

function receipt(state = 'running') {
    return {
        version: 1, key: { workspaceId: 'ws-synthetic', workerGeneration: sid('worker-gen'), executionId: sid('exec'), attemptId: sid('attempt'), operationId: EXPECTED.operationId },
        targetBindingDigest: sha(canonical(binding())), reservationId: EXPECTED.reservationId, requestDigest: EXPECTED.requestDigest, journalStoreIdentity: sid('journal'),
        helperIncarnation: sid('helper-1'), leaseId: sid('lease'), state, receiptSequence: 4, gateReleased: state !== 'prepared',
        resources: [], inputCursors: [], observedAtMs: 1
    };
}

function connect(overrides = {}) {
    return {
        binding: binding(), receipt: receipt(), channelManifest: channelManifest(), lease: { leaseId: sid('lease'), channelEpoch: '3' },
        processId: '7', connectionId: sid('conn-7'), endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 8080 },
        services: [{ processId: '7', state: 'running', processClass: 'service' }, { processId: '8', state: 'running', processClass: 'task' }],
        relayPorts: [41000], ...overrides
    };
}

const OPEN_OK = () => ({ kind: 'open-ok', authenticated: true, targetBindingDigest: sha(canonical(binding())), leaseId: sid('lease'), processId: '7', connectionId: sid('conn-7'), channelEpoch: '3' });

test('a running admitted loopback service: open is requested first, a handle only after the exact authenticated open-ok', () => {
    assert.deepEqual(evaluateServiceConnect(connect()), { ok: true, value: { decision: 'open-requested', deliverHandle: false } });
    assert.deepEqual(evaluateServiceConnect(connect({ ack: OPEN_OK() })), { ok: true, value: { decision: 'deliver', deliverHandle: true } });
    assert.deepEqual(evaluateServiceConnect(connect({ processId: null, endpoint: { kind: 'channel', channelId: 'model' }, ack: { ...OPEN_OK(), processId: null } })).value, { decision: 'deliver', deliverHandle: true }, 'manifest channel');
});

test('CHN-01, CHN-04, CHN-05 and CHN-03 channel admission, relay ports, unix sockets and cleaned-up leases', () => {
    refused(evaluateServiceConnect(connect({ endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 40123 } })), 'relay_port', 'CHN-04 MCP relay port');
    refused(evaluateServiceConnect(connect({ endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 41000 }, services: [{ processId: '7', state: 'running', processClass: 'service', advertises: [41000] }] })), 'relay_port', 'CHN-04 relay port advertised by the service');
    refused(evaluateServiceConnect(connect({ endpoint: { kind: 'unix-socket', path: '/run/workload.sock' } })), 'unsupported_endpoint', 'CHN-05 unix socket');
    refused(evaluateServiceConnect(connect({ endpoint: { kind: 'loopback-port', host: '10.0.0.5', port: 8080 } })), 'unsupported_endpoint', 'non-loopback host');
    const disabledBinding = binding({ channelManifestDigest: sha(canonical(channelManifest(['human-input']))) });
    const disabledReceipt = { ...receipt(), targetBindingDigest: sha(canonical(disabledBinding)) };
    refused(evaluateServiceConnect(connect({ processId: null, endpoint: { kind: 'channel', channelId: 'human-input' }, channelManifest: channelManifest(['human-input']), binding: disabledBinding, receipt: disabledReceipt })), 'channel_not_admitted', 'CHN-01 disabled channel');
    refused(evaluateServiceConnect(connect({ processId: null, endpoint: { kind: 'channel', channelId: 'shell' } })), 'channel_not_admitted', 'CHN-01 unknown channel');
    refused(evaluateServiceConnect(connect({ processId: null, endpoint: { kind: 'channel', channelId: 'model', destination: { host: '10.0.0.1', port: 443 } } })), 'channel_not_admitted', 'CHN-01 caller-supplied worker destination');
    refused(evaluateServiceConnect(connect({ endpoint: { kind: 'worker', host: 'worker.internal', port: 443 } })), 'channel_not_admitted', 'CHN-01 worker destination');
    refused(evaluateServiceConnect(connect({ processId: '8' })), 'not_a_running_service', 'a task, not a service');
    refused(evaluateServiceConnect(connect({ processId: '9' })), 'not_a_running_service', 'unknown process');
    refused(evaluateServiceConnect(connect({ receipt: receipt('exited') })), 'lease_retired', 'CHN-03 reconnect after cleanup');
    refused(evaluateServiceConnect(connect({ lease: { leaseId: sid('lease-old'), channelEpoch: '3' } })), 'lease_retired', 'retired lease');
    refused(evaluateServiceConnect(connect({ binding: binding({ configRevision: 9 }) })), 'binding_mismatch', 'binding');
});

async function proxyHarness(t, ack) {
    const dir = makeTempDir(t);
    const socketPath = path.join(dir, 'p.sock');
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    t.after(() => server.close());
    const accepted = once(server, 'connection');
    const target = net.connect(socketPath);
    // Linux resets a peer whose unread bytes are discarded by destroy(); the
    // target side here only models early bytes, so its reset is not a result.
    target.on('error', () => {});
    const [proxy] = await accepted;
    // The target side sends early bytes and half-closes before anything is delivered to ALA.
    target.end(Buffer.from('early-bytes'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const delivered = [];
    assert.equal(proxy.bytesRead, 0, 'no premature read');
    const decision = evaluateServiceConnect(connect({ ack }));
    if (decision.ok && decision.value.deliverHandle) delivered.push(proxy);
    else proxy.destroy();
    t.after(() => { target.destroy(); proxy.destroy(); });
    return { decision, delivered, proxy };
}

test('CON-01 refused, timed-out, lost or unauthenticated acknowledgements transfer zero handles', async (t) => {
    const cases = [
        [undefined, null],
        [{ kind: 'open-refused' }, 'connect_refused'],
        [{ kind: 'timeout' }, 'connect_timeout'],
        [{ kind: 'unknown' }, 'outcome_unknown'],
        [{ kind: 'lost-reply' }, 'outcome_unknown'],
        [{ ...OPEN_OK(), authenticated: false }, 'frame_authentication'],
        [{ ...OPEN_OK(), connectionId: sid('conn-8') }, 'frame_binding'],
        [{ ...OPEN_OK(), processId: '8' }, 'frame_binding'],
        [{ ...OPEN_OK(), channelEpoch: '2' }, 'frame_binding'],
        [{ ...OPEN_OK(), leaseId: sid('lease-2') }, 'frame_binding'],
        [{ ...OPEN_OK(), targetBindingDigest: sdg('other') }, 'frame_binding']
    ];
    for (const [ack, code] of cases) {
        const { decision, delivered, proxy } = await proxyHarness(t, ack);
        if (code === null) assert.deepEqual(decision.value, { decision: 'open-requested', deliverHandle: false }, 'a tentative proxy is not a connect');
        else refused(decision, code, JSON.stringify(ack));
        assert.equal(delivered.length, 0, `no handle: ${JSON.stringify(ack)}`);
        assert.equal(proxy.destroyed, true, 'the proxy is closed');
    }
});

test('CON-02 after an acknowledged connect, early bytes and the half-close are preserved for ALA', async (t) => {
    const { decision, delivered } = await proxyHarness(t, OPEN_OK());
    assert.deepEqual(decision.value, { decision: 'deliver', deliverHandle: true });
    assert.equal(delivered.length, 1);
    const [handle] = delivered;
    const chunks = [];
    handle.on('data', (chunk) => chunks.push(chunk));
    handle.resume();
    await once(handle, 'end');
    assert.equal(Buffer.concat(chunks).toString(), 'early-bytes');
});
