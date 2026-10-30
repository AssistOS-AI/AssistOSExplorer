// Worker-side client of Ploinky's private helper-ticket operation (mint route spec 2026-10-30; T0 section 8, A1.7, A11).
//
// `mintTicket(request)` sends exactly the ten-key minter request (binding, leaseId, reservationId, operationId,
// requestDigest, helperNonce, channelEpoch, previousChannelEpoch, permissions, ttlSeconds) over an injected
// `transport(bytes) -> Promise<{status, body}>`; the host composes the transport from Ploinky's agent-side channel
// (`Agent/lib/helperTicketTransport.mjs`: signed private agent assertion to the Router's private listener). The Router
// derives the worker identity, the worker generation, the live Box scope and the target evidence itself; the client only
// carries the operation tuple.
//
// The worker holds no ticket key, so it cannot verify the signature (the target helper does). It does check that the
// ticket it received says exactly what it asked for before anything uses it: strict compact-JWS shape, the canonical
// header with the returned kid, canonical claims with exactly the eighteen frozen keys, the binding, lease, reservation,
// operation, request digest, helper nonce, epochs and permissions equal to the request, the audience derived from the
// binding's target identity, a lifetime equal to the requested ttl, metadata equal to the returned jti/iat/exp, and a
// canonical 32-byte session key. A ticket that differs is refused as `ticket_binding` and never returned.
//
// Result mapping: HTTP 200 with the minter's common result. `{ok:true,value:{ticket,kid,jti,iat,exp,sessionKey}}` is
// returned only after the checks above; `{ok:false,error:{code}}` keeps a known minter code and reduces any other code to
// `refused` (A11.6). Definite Router refusals are terminal: 403 `PRIVATE_CALLER_DENIED` is `forbidden`, a 400/413 for a
// malformed or oversized request is `invalid_request`, a 429 is `capacity_exceeded` (the limiter runs before any
// evidence, so nothing was minted). Any other status, transport failure or malformed answer throws: the outcome is
// unknown and the caller decides (a retry with the same helper nonce either mints or is `ticket_replayed`). The client
// retries nothing, caches nothing, logs nothing and never puts a ticket or session key into an error.

import crypto from 'node:crypto';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 65536;
const MAX_FUTURE_SKEW_MS = 2000;
const TICKET_TYPE = 'ploinky-target-helper+jwt';
const TICKET_PURPOSE = 'ploinky.target-helper.v1';
const TICKET_ISSUER = 'ploinky-router';
const TICKET_AUDIENCE_PREFIX = 'ploinky:target-helper:';

export const HELPER_TICKET_REQUEST_KEYS = Object.freeze([
    'binding', 'leaseId', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'channelEpoch',
    'previousChannelEpoch', 'permissions', 'ttlSeconds'
]);
const CLAIM_KEYS = Object.freeze([
    'version', 'iss', 'sub', 'purpose', 'aud', 'binding', 'leaseId', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'jti',
    'iat', 'exp', 'channelEpoch', 'previousChannelEpoch', 'permissions', 'limitsDigest'
]);
const VALUE_KEYS = Object.freeze(['ticket', 'kid', 'jti', 'iat', 'exp', 'sessionKey']);
// The Ploinky minter's refusal codes (targetHelperTicketMinter.mjs MINT_ERROR_CODES); anything else is `refused`.
export const HELPER_TICKET_MINT_CODES = Object.freeze([
    'invalid_request', 'caller_unverified', 'caller_mismatch', 'target_scope_mismatch', 'target_not_eligible', 'target_mismatch',
    'ticket_lifetime', 'ticket_permissions', 'ticket_format', 'channel_epoch_conflict', 'ticket_replayed',
    'secret_unavailable', 'capacity_exceeded'
]);

const PERMANENT_403 = new Set(['PRIVATE_CALLER_DENIED']);
const PERMANENT_400 = new Set(['invalid_request', 'invalid_identity', 'request_too_large', 'TARGET_HELPER_TICKET_REQUEST_INVALID']);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function exactKeys(value, keys) {
    return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function refusal(code) {
    return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

// Canonical JSON of plain JSON values: sorted keys, no whitespace, integers only (the target contract's encoding).
function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) throw new TypeError('non-integer number');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (!isPlainObject(value)) throw new TypeError('not a JSON value');
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function decodeSegment(segment) {
    if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment)) return null;
    const bytes = Buffer.from(segment, 'base64url');
    return bytes.toString('base64url') === segment ? bytes : null;
}

// The decoded JSON of a canonical segment, or null when the segment is not the canonical encoding of a JSON object.
function canonicalObject(segment) {
    const bytes = decodeSegment(segment);
    if (!bytes) return null;
    const text = bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').compare(bytes) !== 0) return null;
    let value;
    try {
        value = JSON.parse(text);
        if (!isPlainObject(value) || canonical(value) !== text) return null;
    } catch {
        return null;
    }
    return value;
}

function isSessionKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === value;
}

function audienceOf(scope) {
    const target = {
        workspaceId: scope.workspaceId, boxIdentity: scope.boxIdentity, boxGeneration: scope.boxGeneration,
        agentPrincipal: scope.agentPrincipal, containerId: scope.containerId, runtimeInstanceId: scope.runtimeInstanceId,
        enableGeneration: scope.enableGeneration, helperIncarnation: scope.helperIncarnation
    };
    return `${TICKET_AUDIENCE_PREFIX}${crypto.createHash('sha256').update(canonical(target), 'utf8').digest('hex')}`;
}

// Whether the returned ticket says exactly what `request` asked for (see the module comment). Never throws.
function ticketMatchesRequest(value, request, nowMs) {
    try {
        if (!exactKeys(value, VALUE_KEYS) || typeof value.ticket !== 'string' || value.ticket.length > MAX_TOKEN_LENGTH) return false;
        if (typeof value.kid !== 'string' || typeof value.jti !== 'string' || !Number.isSafeInteger(value.iat)
            || !Number.isSafeInteger(value.exp) || !isSessionKey(value.sessionKey)) return false;
        const parts = value.ticket.split('.');
        if (parts.length !== 3 || !decodeSegment(parts[2])) return false;
        const header = canonicalObject(parts[0]);
        if (!header || canonical(header) !== canonical({ alg: 'HS256', kid: value.kid, typ: TICKET_TYPE })) return false;
        const claims = canonicalObject(parts[1]);
        if (!claims || !exactKeys(claims, CLAIM_KEYS)) return false;
        const scope = request.binding.scope;
        if (claims.version !== 1 || claims.iss !== TICKET_ISSUER || claims.purpose !== TICKET_PURPOSE) return false;
        if (claims.sub !== scope.workerPrincipal || claims.aud !== audienceOf(scope)) return false;
        if (canonical(claims.binding) !== canonical(request.binding) || claims.limitsDigest !== request.binding.limitsDigest) return false;
        for (const key of ['leaseId', 'reservationId', 'operationId', 'requestDigest', 'helperNonce', 'channelEpoch', 'previousChannelEpoch']) {
            if (claims[key] !== request[key]) return false;
        }
        if (canonical(claims.permissions) !== canonical(request.permissions)) return false;
        if (claims.jti !== value.jti || claims.iat !== value.iat || claims.exp !== value.exp) return false;
        if (claims.exp - claims.iat !== request.ttlSeconds) return false;
        // A ticket that is already expired, or issued in the future beyond the helper's skew, is useless.
        if (!(nowMs < claims.exp * 1000) || claims.iat * 1000 > nowMs + MAX_FUTURE_SKEW_MS) return false;
        return true;
    } catch {
        return false;
    }
}

function terminalRefusal(answer) {
    if (![400, 403, 413, 429].includes(answer.status)) return null;
    let code;
    try {
        const body = JSON.parse(Buffer.isBuffer(answer.body) ? answer.body.toString('utf8') : String(answer.body ?? ''));
        code = isPlainObject(body) && typeof body.error === 'string' ? body.error : '';
    } catch {
        return null;
    }
    if (answer.status === 403 && PERMANENT_403.has(code)) return refusal('forbidden');
    if ((answer.status === 400 || answer.status === 413) && PERMANENT_400.has(code)) return refusal('invalid_request');
    if (answer.status === 429 && code === 'capacity_exceeded') return refusal('capacity_exceeded');
    return null;
}

/**
 * Create the client. `transport(bytes)` resolves `{status, body}`; `now()` is epoch milliseconds (injected in tests).
 * `mintTicket(request)` resolves the common result described in the module comment, or throws for an unknown outcome.
 */
export function createHelperTicketClient({ transport, now = () => Date.now() } = {}) {
    if (typeof transport !== 'function' || typeof now !== 'function') {
        throw new TypeError('createHelperTicketClient requires a transport function');
    }

    async function mintTicket(request) {
        // Malformed requests never leave the worker.
        if (!exactKeys(request, HELPER_TICKET_REQUEST_KEYS) || !isPlainObject(request.binding) || !isPlainObject(request.binding.scope)
            || !Number.isSafeInteger(request.ttlSeconds) || !Array.isArray(request.permissions)) {
            return refusal('invalid_request');
        }
        let bytes;
        try {
            bytes = Buffer.from(JSON.stringify(request), 'utf8');
        } catch {
            return refusal('invalid_request');
        }
        if (bytes.length > MAX_REQUEST_BYTES) return refusal('invalid_request');
        const answer = await transport(bytes);
        const terminal = isPlainObject(answer) ? terminalRefusal(answer) : null;
        if (terminal) return terminal;
        if (!isPlainObject(answer) || answer.status !== 200) throw new Error(`helper_ticket_http_${isPlainObject(answer) ? answer.status : 'invalid'}`);
        const raw = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(String(answer.body ?? ''), 'utf8');
        if (raw.length > MAX_RESPONSE_BYTES) throw new Error('helper_ticket_response_too_large');
        let parsed;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch {
            throw new Error('helper_ticket_response_invalid');
        }
        if (!isPlainObject(parsed) || typeof parsed.ok !== 'boolean') throw new Error('helper_ticket_response_invalid');
        if (parsed.ok === false) {
            if (!exactKeys(parsed, ['ok', 'error']) || !isPlainObject(parsed.error) || typeof parsed.error.code !== 'string') {
                throw new Error('helper_ticket_response_invalid');
            }
            return refusal(HELPER_TICKET_MINT_CODES.includes(parsed.error.code) ? parsed.error.code : 'refused');
        }
        if (!exactKeys(parsed, ['ok', 'value'])) throw new Error('helper_ticket_response_invalid');
        if (!ticketMatchesRequest(parsed.value, request, now())) return refusal('ticket_binding');
        const { ticket, kid, jti, iat, exp, sessionKey } = parsed.value;
        return Object.freeze({ ok: true, value: Object.freeze({ ticket, kid, jti, iat, exp, sessionKey }) });
    }

    return Object.freeze({ mintTicket });
}
