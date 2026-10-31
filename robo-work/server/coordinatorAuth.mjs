import crypto from 'node:crypto';
import { canonicalJson } from './stateProtocol.mjs';
import { createVerifiedContext, createVerifiedCoordinatorContext, createVerifiedServiceContext } from './workerState.mjs';

// Provider-side verification of the Router-minted tokens of interface note 2.3:
// the coordinator hop Router Request (tool `__coordinator_admission__`, (6) and (5)),
// the MCP origin token (tool `__task_ref_origin__`, (2)) and the generic
// task-reference Router Request (tool `__task_ref__`, (3)). All three are HS256 JWS
// signed by the Router with this provider's own per-agent secret, with `aud` equal
// to the provider principal.
//
// Verification order for every token: strict decode, `alg`, HMAC (constant time),
// integer `iat`/`exp` with the maximum lifetime and clock skew, `aud`, `typ`/`iss`,
// then `tool`, `method`, `path` and `rch`, then claim cross-checks. The `jti` is
// consumed last, by `consumeReplay`, after every check of every token in the
// request has passed. Nothing is derived from the Router's `invocationBody`: the
// request surface is recomputed from what the provider actually received.
//
// Trusted facts returned here are frozen and branded. The S1 verified context is
// built only by the `context*` functions below, and only from branded facts.

export const COORDINATOR_ADMISSION_TOOL = '__coordinator_admission__';
export const TASK_REFERENCE_TOOL = '__task_ref__';
export const TASK_REFERENCE_ORIGIN_TOOL = '__task_ref_origin__';
export const TASK_REFERENCE_ORIGIN_METHOD = 'ORIGIN';
export const TASK_REFERENCE_ORIGIN_PATH = '/origin';
// Terminal-target inventory (interface note 2.3 (9); plan §10.1; S6 Part E).
export const TERMINAL_TARGETS_TOOL = '__provider_terminal_targets__';
// Robot-terminal launch evidence (M-8; Ploinky providerTerminalClient mints it through mintLaunchEvidence).
export const TERMINAL_LAUNCH_TOOL = '__provider_terminal_launch__';
export const TERMINAL_LAUNCH_METHOD = 'LAUNCH';
export const OWNER_SCOPE = 'execution:owner';
export const MAX_TOKEN_LIFETIME_SECONDS = 30;
export const CLOCK_SKEW_SECONDS = 30;

const MAX_TOKEN_LENGTH = 8192;
const MAX_JTI_LENGTH = 128;
const MAX_AUTH_INFO_LENGTH = 16384;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const AGENT_PRINCIPAL = /^agent:[^\s/:]+\/[^\s/:]+$/;
const USER_ID = /^[^\s]{1,160}$/;
// Wire binding-ID grammar (design A9): a RoboFlow flow, a schedule plus its stored revision,
// or a graph-generation ticket. Which forms a call site accepts depends on the call site
// (interface note 2.3 (7); S6 source-only subset §16 N-5): see the per-site helpers below.
const FLOW_BINDING_ID = /^flow_[0-9a-f]{24}$/;
const SCHEDULE_BINDING_ID = /^cron_[0-9a-f]{24}\.r[1-9][0-9]{0,8}$/;
const GENERATION_BINDING_ID = /^gen_[0-9a-f]{24}$/;
const GENERATION_BINDING_PREFIX = 'gen_';
const LIFECYCLE_KEY = 'lifecycle';
const OBLIGATIONS_KEY = 'obligations';
const TERMINAL_TARGETS_KEY = 'targets';
const RETENTION_MARGIN_MS = 2000;

// Bounded, enumerated refusal reasons. A reason never carries token or claim content.
export const AUTH_REASONS = Object.freeze([
    'auth_info', 'token_format', 'algorithm', 'signature', 'lifetime', 'not_yet_valid', 'expired',
    'audience', 'token_type', 'issuer', 'tool', 'method', 'path', 'rch', 'jti', 'replay', 'replay_capacity',
    'subject', 'actor', 'caller', 'coordinator', 'owner_evidence', 'owner_scope', 'delegation_source',
    'guest', 'origin_claims', 'origin_agent', 'origin_binding', 'origin_key', 'lookup_key', 'binding',
    'row_ambiguous', 'row_missing', 'administrator', 'configuration', 'operation_unmapped', 'delegated'
]);

const PUBLIC_MESSAGES = Object.freeze({
    unauthorized: 'The request is not authenticated.',
    forbidden: 'The request is not authorized.',
    invalid_request: 'The request is not valid.',
    unavailable: 'The service is unavailable.',
    operation_unavailable: 'The operation is not available.'
});

export class CoordinatorAuthError extends Error {
    constructor(code, reason) {
        if (!Object.hasOwn(PUBLIC_MESSAGES, code)) throw new TypeError('Unknown coordinator-auth error code');
        if (!AUTH_REASONS.includes(reason)) throw new TypeError('Unknown coordinator-auth error reason');
        super(PUBLIC_MESSAGES[code]);
        this.name = 'CoordinatorAuthError';
        this.code = code;
        this.reason = reason;
    }
}

function refuse(code, reason) {
    throw new CoordinatorAuthError(code, reason);
}

// ---- Hashing (wire-identical to Ploinky Agent/lib/requestHash.mjs) -------------

export function sha256b64url(input) {
    return crypto.createHash('sha256').update(input).digest('base64url');
}

// base64url(SHA-256(raw body bytes)); the empty body hashes to a nonempty value.
export function rawBodyHash(body) {
    if (!Buffer.isBuffer(body)) refuse('invalid_request', 'configuration');
    return sha256b64url(body);
}

export function computeRchHttp({ method, path, query, bodyHash }) {
    return sha256b64url(canonicalJson({ method, path, query, bodyHash }));
}

export function computeOriginRch({ originKey, originRequestId, agent, tool }) {
    return sha256b64url(canonicalJson({ originKey, originRequestId, agent, tool }));
}

// ---- Configuration -------------------------------------------------------------

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function defaultNowMs() {
    return Date.now();
}

// `secret`: this provider's own per-agent secret (Buffer, at least 32 bytes).
// `audience`: this provider's canonical principal `agent:<repo>/<agent>`.
// `coordinators`: the declared coordinator principals allowed on coordinator routes.
// `replayCache`: from `createReplayCache`. `now`: milliseconds clock (tests inject).
export function createVerifierConfig({ secret, audience, coordinators = [], replayCache, now = defaultNowMs }) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) refuse('unavailable', 'configuration');
    if (typeof audience !== 'string' || !AGENT_PRINCIPAL.test(audience)) refuse('unavailable', 'configuration');
    if (!Array.isArray(coordinators) || coordinators.length > 16
        || !coordinators.every((entry) => typeof entry === 'string' && AGENT_PRINCIPAL.test(entry))
        || new Set(coordinators).size !== coordinators.length) {
        refuse('unavailable', 'configuration');
    }
    if (!replayCache || typeof replayCache.consume !== 'function') refuse('unavailable', 'configuration');
    if (typeof now !== 'function') refuse('unavailable', 'configuration');
    return Object.freeze({
        secret: Buffer.from(secret), audience, coordinators: Object.freeze([...coordinators]), replayCache, now
    });
}

// ---- Replay cache --------------------------------------------------------------

// Bounded, fail-closed `jti` cache. A live entry is kept until the token could no
// longer be accepted (exp + skew, plus a margin). When full it refuses new entries
// instead of forgetting live ones. Several jtis are checked and recorded together,
// synchronously, so a request either consumes all of its tokens or none.
// In memory only: a provider restart forgets consumed jtis (reported limitation).
export function createReplayCache({ maxEntries = 32768, now = defaultNowMs } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || typeof now !== 'function') {
        refuse('unavailable', 'configuration');
    }
    const entries = new Map();
    function sweep(currentMs) {
        for (const [key, expiresAt] of entries) {
            if (expiresAt <= currentMs) entries.delete(key);
        }
    }
    return Object.freeze({
        consume(items) {
            const currentMs = now();
            if (!Number.isFinite(currentMs)) refuse('unavailable', 'replay_capacity');
            const keys = items.map((item) => crypto.createHash('sha256').update(item.jti, 'utf8').digest('base64url'));
            if (new Set(keys).size !== keys.length) refuse('unauthorized', 'replay');
            for (const key of keys) {
                const expiresAt = entries.get(key);
                if (expiresAt !== undefined && expiresAt > currentMs) refuse('unauthorized', 'replay');
            }
            if (entries.size + keys.length > maxEntries) sweep(currentMs);
            if (entries.size + keys.length > maxEntries) refuse('unavailable', 'replay_capacity');
            keys.forEach((key, index) => {
                entries.delete(key);
                entries.set(key, items[index].retainUntilMs);
            });
        },
        get size() { return entries.size; }
    });
}

// Consumes every `jti` of one request together. Call only after all checks passed.
export function consumeReplay(config, verifiedTokens) {
    const items = verifiedTokens.map((facts) => {
        const replay = REPLAY.get(facts);
        if (!replay) refuse('unauthorized', 'jti');
        return replay;
    });
    config.replayCache.consume(items);
}

// ---- JWS -----------------------------------------------------------------------

function decodeSegment(segment) {
    if (!SEGMENT.test(segment)) refuse('unauthorized', 'token_format');
    return Buffer.from(segment, 'base64url');
}

function parseJsonObject(bytes) {
    let value;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    } catch {
        return refuse('unauthorized', 'token_format');
    }
    if (!isPlainObject(value)) refuse('unauthorized', 'token_format');
    return value;
}

// Signature, lifetime and audience. Never consumes the jti.
function verifyJwsCore(token, config) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) refuse('unauthorized', 'token_format');
    const parts = token.split('.');
    if (parts.length !== 3) refuse('unauthorized', 'token_format');
    const header = parseJsonObject(decodeSegment(parts[0]));
    if (header.alg !== 'HS256') refuse('unauthorized', 'algorithm');
    const signature = decodeSegment(parts[2]);
    const expected = crypto.createHmac('sha256', config.secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) refuse('unauthorized', 'signature');
    const payload = parseJsonObject(decodeSegment(parts[1]));
    const { iat, exp } = payload;
    if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > MAX_TOKEN_LIFETIME_SECONDS) {
        refuse('unauthorized', 'lifetime');
    }
    const nowMs = config.now();
    if (!Number.isFinite(nowMs)) refuse('unavailable', 'configuration');
    const nowSec = Math.floor(nowMs / 1000);
    if (iat > nowSec + CLOCK_SKEW_SECONDS) refuse('unauthorized', 'not_yet_valid');
    if (exp + CLOCK_SKEW_SECONDS < nowSec) refuse('unauthorized', 'expired');
    if (typeof payload.aud !== 'string' || payload.aud !== config.audience) refuse('unauthorized', 'audience');
    if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > MAX_JTI_LENGTH) refuse('unauthorized', 'jti');
    return payload;
}

function verifyRouterRequestSurface(payload, { tool, method, path, rch }) {
    if (payload.typ !== 'router-request') refuse('unauthorized', 'token_type');
    if (payload.iss !== 'ploinky-router') refuse('unauthorized', 'issuer');
    if (payload.tool !== tool) refuse('unauthorized', 'tool');
    if (payload.method !== method) refuse('unauthorized', 'method');
    if (payload.path !== path) refuse('unauthorized', 'path');
    if (rch === null) return;
    if (typeof payload.rch !== 'string' || payload.rch !== rch) refuse('unauthorized', 'rch');
}

const VERIFIED_FACTS = new WeakSet();
const REPLAY = new WeakMap();

function brand(facts, payload) {
    const frozen = Object.freeze(facts);
    VERIFIED_FACTS.add(frozen);
    REPLAY.set(frozen, { jti: payload.jti, retainUntilMs: (payload.exp + CLOCK_SKEW_SECONDS) * 1000 + RETENTION_MARGIN_MS });
    return frozen;
}

function requireFacts(facts, kind) {
    if (!VERIFIED_FACTS.has(facts) || facts.kind !== kind) refuse('unauthorized', 'configuration');
    return facts;
}

// ---- Request surface -------------------------------------------------------------

// The trusted `x-ploinky-auth-info` value written by the Router. Inbound
// `x-ploinky-*` headers from callers are stripped by the Router, so only the Router
// can supply it; its `invocationBody` is ignored.
function invocationTokenFrom(authInfo) {
    if (typeof authInfo !== 'string' || authInfo.length === 0 || authInfo.length > MAX_AUTH_INFO_LENGTH) refuse('unauthorized', 'auth_info');
    let parsed;
    try {
        parsed = JSON.parse(authInfo);
    } catch {
        return refuse('unauthorized', 'auth_info');
    }
    if (!isPlainObject(parsed) || typeof parsed.invocationToken !== 'string') refuse('unauthorized', 'auth_info');
    return parsed.invocationToken;
}

// `query` is the received WHATWG `search` string: '' or '?...'. `body` is the raw bytes.
function receivedSurface({ method, path, query, body }) {
    if (typeof method !== 'string' || typeof path !== 'string' || typeof query !== 'string') refuse('invalid_request', 'configuration');
    if (query !== '' && !query.startsWith('?')) refuse('invalid_request', 'configuration');
    const upper = method.toUpperCase();
    const bodyHash = rawBodyHash(body);
    return { method: upper, path, query, bodyHash, rch: computeRchHttp({ method: upper, path, query, bodyHash }) };
}

function normalizeRoles(roles) {
    if (roles === undefined) return [];
    if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) refuse('unauthorized', 'owner_evidence');
    return roles.map((role) => role.trim()).filter(Boolean);
}

function isGuest(id, roles) {
    return id.toLowerCase().startsWith('guest:') || roles.some((role) => role.toLowerCase() === 'guest');
}

// Administrator: roles trimmed and lowercased, `admin` present and no `guest` in any case,
// matching Ploinky `policy/Caller.js` and RoboTeam `isAdminActor` (design §10 RI-3). A
// `guest:` id prefix is refused before this check by `isGuest`.
function isAdministrator(roles) {
    const lower = roles.map((role) => role.trim().toLowerCase());
    return lower.includes('admin') && !lower.includes('guest');
}

// Owner evidence (5): `usr` plus `delegation` with the `execution:owner` scope whose
// source is the verified coordinator. Both or neither.
function ownerFromClaims(payload, coordinator) {
    const hasUsr = payload.usr !== undefined;
    const hasDelegation = payload.delegation !== undefined;
    if (!hasUsr && !hasDelegation) return null;
    if (!hasUsr || !hasDelegation || !isPlainObject(payload.usr) || !isPlainObject(payload.delegation)) refuse('forbidden', 'owner_evidence');
    if (typeof payload.usr.id !== 'string') refuse('forbidden', 'owner_evidence');
    // The Router's grant normalizer already strips the one `user:` prefix, so a
    // remaining prefix would alias another user (`user:alice` vs `alice`): refused.
    const id = payload.usr.id.trim();
    if (!USER_ID.test(id) || /^user:/i.test(id)) refuse('forbidden', 'owner_evidence');
    const roles = normalizeRoles(payload.usr.roles);
    if (isGuest(id, roles)) refuse('forbidden', 'guest');
    const { scope, sourceAgentId } = payload.delegation;
    if (!Array.isArray(scope) || !scope.includes(OWNER_SCOPE)) refuse('forbidden', 'owner_scope');
    if (sourceAgentId !== coordinator) refuse('forbidden', 'delegation_source');
    return Object.freeze({ userId: id, roles: Object.freeze(roles), administrator: isAdministrator(roles) });
}

// Coordinator hop (6): the Router Request minted on a private-listener forward to a
// declared coordinator route. Returns branded facts; the jti is not yet consumed.
export function verifyCoordinatorRequest(config, request) {
    const surface = receivedSurface(request);
    const token = invocationTokenFrom(request.authInfo);
    const payload = verifyJwsCore(token, config);
    verifyRouterRequestSurface(payload, { tool: COORDINATOR_ADMISSION_TOOL, method: surface.method, path: surface.path, rch: surface.rch });
    const caller = payload.caller;
    if (!isPlainObject(caller) || caller.kind !== 'agent' || typeof caller.id !== 'string' || !AGENT_PRINCIPAL.test(caller.id)) {
        refuse('forbidden', 'caller');
    }
    const actor = payload.actor;
    if (!isPlainObject(actor) || actor.kind !== 'agent' || actor.id !== caller.id) refuse('forbidden', 'actor');
    if (payload.sub !== caller.id) refuse('forbidden', 'subject');
    if (!config.coordinators.includes(caller.id)) refuse('forbidden', 'coordinator');
    const owner = ownerFromClaims(payload, caller.id);
    return brand({ kind: 'coordinator', coordinator: caller.id, owner, method: surface.method, path: surface.path, query: surface.query, bodyHash: surface.bodyHash }, payload);
}

// MCP origin token (2), carried to the provider by the coordinator. The four bound
// values travel as the nested `origin` claim (the token's own `tool` claim names the
// origin purpose); `rch` binds them.
export function verifyOriginToken(config, token) {
    const payload = verifyJwsCore(token, config);
    verifyRouterRequestSurface(payload, {
        tool: TASK_REFERENCE_ORIGIN_TOOL, method: TASK_REFERENCE_ORIGIN_METHOD, path: TASK_REFERENCE_ORIGIN_PATH, rch: null
    });
    const origin = payload.origin;
    if (!isPlainObject(origin) || Object.keys(origin).length !== 4
        || !['originKey', 'originRequestId', 'agent', 'tool'].every((key) => typeof origin[key] === 'string' && origin[key].length > 0 && origin[key].length <= 200)) {
        refuse('unauthorized', 'origin_claims');
    }
    // `rch` over exactly the four bound values (null above defers it to here).
    if (typeof payload.rch !== 'string' || payload.rch !== computeOriginRch(origin)) refuse('unauthorized', 'rch');
    if (!callerKeyValid(origin.originKey)) refuse('unauthorized', 'origin_key');
    if (!AGENT_PRINCIPAL.test(origin.agent)) refuse('unauthorized', 'origin_claims');
    // The Router minter always sets `sub` to the origin key.
    if (payload.sub !== origin.originKey) refuse('unauthorized', 'subject');
    return brand({
        kind: 'origin', originKey: origin.originKey, originRequestId: origin.originRequestId, agent: origin.agent, tool: origin.tool
    }, payload);
}

// Router caller key (1): `user:<id>` or `agent:<repo>/<agent>`.
function callerKeyValid(key) {
    if (typeof key !== 'string' || key.length > 200) return false;
    if (AGENT_PRINCIPAL.test(key)) return true;
    const match = /^user:(.+)$/.exec(key);
    return match !== null && USER_ID.test(match[1]) && !/^user:/i.test(match[1]) && !match[1].toLowerCase().startsWith('guest:');
}

// The direct caller key of a `__task_ref__` request, from the verified actor, and whether
// that caller is a verified direct administrator (user actors only; an agent actor never
// is, whatever `usr` or `delegation` claims it carries).
function callerFromActor(payload) {
    const actor = payload.actor;
    if (!isPlainObject(actor)) refuse('forbidden', 'actor');
    if (actor.kind === 'user') {
        if (typeof actor.id !== 'string') refuse('forbidden', 'actor');
        const roles = normalizeRoles(actor.roles);
        const id = actor.id.trim().replace(/^user:/i, '');
        if (isGuest(id, roles)) refuse('forbidden', 'guest');
        const key = `user:${id}`;
        if (!callerKeyValid(key)) refuse('forbidden', 'actor');
        return { key, administrator: isAdministrator(roles) };
    }
    if (actor.kind === 'agent') {
        if (typeof actor.id !== 'string' || !AGENT_PRINCIPAL.test(actor.id)) refuse('forbidden', 'actor');
        if (payload.caller !== undefined && (!isPlainObject(payload.caller) || payload.caller.id !== actor.id)) refuse('forbidden', 'caller');
        return { key: actor.id, administrator: false };
    }
    return refuse('forbidden', 'actor');
}

// Generic task-reference request (3): read, events, control or lookup forwarded by
// the Router's `/task-refs` route. For lookup the signed `originKey` claim is
// required and must equal the caller key derived from the verified actor.
export function verifyTaskReferenceRequest(config, request, { lookup = false } = {}) {
    const surface = receivedSurface(request);
    const token = invocationTokenFrom(request.authInfo);
    const payload = verifyJwsCore(token, config);
    verifyRouterRequestSurface(payload, { tool: TASK_REFERENCE_TOOL, method: surface.method, path: surface.path, rch: surface.rch });
    const { key: callerKey, administrator } = callerFromActor(payload);
    if (payload.sub !== callerKey) refuse('forbidden', 'subject');
    if (lookup) {
        if (payload.originKey !== callerKey) refuse('forbidden', 'lookup_key');
    } else if (payload.originKey !== undefined && payload.originKey !== callerKey) {
        refuse('forbidden', 'lookup_key');
    }
    return brand({
        kind: 'task-reference', callerKey, administrator, method: surface.method, path: surface.path, query: surface.query, bodyHash: surface.bodyHash
    }, payload);
}

// Terminal-target inventory request (interface note 2.3 (9), S6 Part E): a Router Request
// with tool `__provider_terminal_targets__`, exact method, path and `rch` over the received
// surface, whose actor is a direct non-guest user with the role `admin`. Agent actors and
// delegated evidence (`usr` or `delegation` claims, or a `caller` other than that user) are
// refused. No Router minter exists yet (O11); the assumed token shape is the user Router
// Request of the `/task-refs` route: `actor: {kind: 'user', id: 'user:<id>', roles}` with
// `sub` equal to `user:<id>`. Returns branded facts; the jti is not yet consumed.
export function verifyProviderTerminalTargetsRequest(config, request) {
    const surface = receivedSurface(request);
    const token = invocationTokenFrom(request.authInfo);
    const payload = verifyJwsCore(token, config);
    verifyRouterRequestSurface(payload, { tool: TERMINAL_TARGETS_TOOL, method: surface.method, path: surface.path, rch: surface.rch });
    const userKey = directAdministratorKey(payload);
    return brand({ kind: 'terminal-targets', userKey, method: surface.method, path: surface.path, query: surface.query, bodyHash: surface.bodyHash }, payload);
}

// The verified direct administrator of a terminal Router Request (discovery and launch): a direct non-guest user actor with the role
// `admin` (roles trimmed and lowercased), `sub` equal to `user:<id>`, no `usr` or `delegation` claim and no `caller` other than that user.
// Agent actors, guests and delegated evidence are refused. Returns the user key `user:<id>`.
function directAdministratorKey(payload) {
    const actor = payload.actor;
    if (!isPlainObject(actor) || actor.kind !== 'user' || typeof actor.id !== 'string') refuse('forbidden', 'actor');
    if (payload.usr !== undefined || payload.delegation !== undefined) refuse('forbidden', 'delegated');
    if (actor.roles !== undefined && (!Array.isArray(actor.roles) || !actor.roles.every((role) => typeof role === 'string'))) refuse('forbidden', 'actor');
    const roles = (actor.roles ?? []).map((role) => role.trim()).filter(Boolean);
    const id = actor.id.trim().replace(/^user:/i, '');
    if (isGuest(id, roles)) refuse('forbidden', 'guest');
    const userKey = `user:${id}`;
    if (!callerKeyValid(userKey)) refuse('forbidden', 'actor');
    if (payload.caller !== undefined && (!isPlainObject(payload.caller) || payload.caller.kind !== 'user' || payload.caller.id !== actor.id)) {
        refuse('forbidden', 'delegated');
    }
    if (payload.sub !== userKey) refuse('forbidden', 'subject');
    if (!isAdministrator(roles)) refuse('forbidden', 'administrator');
    return userKey;
}

// Robot-terminal launch evidence (M-8 SPEC, plan-review F-7): the `launchEvidence` JWS of a `launch` frame. The Router mints it as a
// Router Request (`typ: router-request`, `iss: ploinky-router`, `aud` = this provider) for the creating browser request's revalidated
// administrator lease, with tool `__provider_terminal_launch__`, method `LAUNCH`, `path` = the declared `terminals.path` and `rch` =
// computeRch({operationId, targetId, project, cols, rows}) of the exact launch fields (`expectedRch`, recomputed here by the caller).
// The actor is checked as for discovery (directAdministratorKey). Returns branded facts; the jti is NOT consumed here: the terminal path
// consumes it durably (S1 token_replay) before anything is admitted, so a replay is refused across a restart.
export function verifyProviderTerminalLaunch(config, token, { path, expectedRch }) {
    if (typeof path !== 'string' || !path.startsWith('/') || typeof expectedRch !== 'string' || expectedRch.length === 0) refuse('unavailable', 'configuration');
    const payload = verifyJwsCore(token, config);
    verifyRouterRequestSurface(payload, { tool: TERMINAL_LAUNCH_TOOL, method: TERMINAL_LAUNCH_METHOD, path, rch: expectedRch });
    const userKey = directAdministratorKey(payload);
    return brand({ kind: 'terminal-launch', userKey, path }, payload);
}

// ---- Verified context construction ----------------------------------------------

// S1 scope: a 1:1 bounded function of (originNamespace, originKey), so one verified
// caller key never appears under two scopes.
export function scopeFor(originNamespace, originKey) {
    return `v1:${sha256b64url(canonicalJson({ originNamespace, originKey }))}`;
}

// Robot rows are workspace resources (design A7): every context records and compares
// them against `workspace:<workspaceId>`, while the execution owner stays `ownerId`.
function robotOwnerFor(workspaceId) {
    return `workspace:${workspaceId}`;
}

function buildContext({ workspaceId, originNamespace, originKey, ownerId, operation, administrator = false, coordinator }) {
    if (originNamespace.length > 200 || originKey.length > 200 || ownerId.length > 200) refuse('invalid_request', 'configuration');
    const fields = {
        workspaceId, scope: scopeFor(originNamespace, originKey), ownerId, operations: [operation], originNamespace, originKey,
        administrator, robotOwnerId: robotOwnerFor(workspaceId)
    };
    if (coordinator !== undefined) fields.coordinator = coordinator;
    return createVerifiedContext(fields);
}

// MCP row: namespace `mcp`, key = the verified origin token's caller key.
export function contextForOrigin(workspaceId, originFacts, operation) {
    requireFacts(originFacts, 'origin');
    return buildContext({ workspaceId, originNamespace: 'mcp', originKey: originFacts.originKey, ownerId: originFacts.originKey, operation });
}

// MCP row of an obligation admission (S6 Part D): as contextForOrigin, plus the verified hop
// coordinator, which must be the origin token's serving agent; S1 records it as the
// obligation's admitting coordinator.
export function contextForOriginObligation(workspaceId, originFacts, coordinatorFacts, operation) {
    requireFacts(originFacts, 'origin');
    requireFacts(coordinatorFacts, 'coordinator');
    if (originFacts.agent !== coordinatorFacts.coordinator) refuse('forbidden', 'origin_agent');
    return buildContext({
        workspaceId, originNamespace: 'mcp', originKey: originFacts.originKey, ownerId: originFacts.originKey, operation,
        coordinator: coordinatorFacts.coordinator
    });
}

// The coordinator alone (no user grant) for obligation accept, reject, list and outbox (S6
// Part D). Decision receipts live in the coordinator's obligations scope (`obligations` is
// never a valid origin key).
export function contextForObligationCoordinator(workspaceId, coordinatorFacts, operation) {
    requireFacts(coordinatorFacts, 'coordinator');
    if (coordinatorFacts.owner) refuse('forbidden', 'row_ambiguous');
    return createVerifiedCoordinatorContext({
        workspaceId, scope: scopeFor(`coordinator:${coordinatorFacts.coordinator}`, OBLIGATIONS_KEY), coordinator: coordinatorFacts.coordinator,
        operations: [operation]
    });
}

// Coordinator-API row: `coordinator:<principal>` / `owner:user:<id>` from the verified hop
// claims, with the grant user's administrator status.
export function contextForOwner(workspaceId, coordinatorFacts, operation) {
    requireFacts(coordinatorFacts, 'coordinator');
    const { owner } = coordinatorFacts;
    if (!owner) refuse('forbidden', 'owner_evidence');
    return buildContext({
        workspaceId, originNamespace: `coordinator:${coordinatorFacts.coordinator}`, originKey: `owner:user:${owner.userId}`,
        ownerId: `user:${owner.userId}`, operation, administrator: owner.administrator
    });
}

// Background row for admission or a derived binding: `coordinator:<principal>` /
// `binding:<id>` with `ownerId` read from the registered binding (never the coordinator).
// The binding ID comes only from the request body whose bytes the hop token's `rch` binds.
// Grammar-neutral (any well-formed binding ID): each call site enforces its own prefixes.
export function contextForBinding(workspaceId, coordinatorFacts, bindingId, ownerId, operation) {
    requireFacts(coordinatorFacts, 'coordinator');
    if (coordinatorFacts.owner) refuse('forbidden', 'row_ambiguous');
    if (!isAnyBindingId(bindingId)) refuse('invalid_request', 'binding');
    if (typeof ownerId !== 'string' || ownerId.length === 0) refuse('invalid_request', 'configuration');
    return buildContext({
        workspaceId, originNamespace: `coordinator:${coordinatorFacts.coordinator}`, originKey: `binding:${bindingId}`, ownerId, operation
    });
}

// Coordinator-alone origin-row reads of a background binding (observe, events, lookup):
// the sentinel owner `coordinator:<principal>` never equals an execution owner, so only
// the origin-row rule can make a reference visible. Grammar-neutral, like contextForBinding.
export function contextForBindingRead(workspaceId, coordinatorFacts, bindingId, operation) {
    requireFacts(coordinatorFacts, 'coordinator');
    if (coordinatorFacts.owner) refuse('forbidden', 'row_ambiguous');
    if (!isAnyBindingId(bindingId)) refuse('invalid_request', 'binding');
    return buildContext({
        workspaceId, originNamespace: `coordinator:${coordinatorFacts.coordinator}`, originKey: `binding:${bindingId}`,
        ownerId: `coordinator:${coordinatorFacts.coordinator}`, operation
    });
}

// The coordinator lifecycle scope (design A10): `lifecycle` is never a valid origin key, so
// it cannot collide with an origin scope.
export function lifecycleScope(coordinator) {
    return scopeFor(`coordinator:${coordinator}`, LIFECYCLE_KEY);
}

// Robot lifecycle (provision, configure, delete) needs a verified direct administrator
// grant; receipts and completions live in the coordinator lifecycle scope.
export function contextForLifecycle(workspaceId, coordinatorFacts, operation) {
    requireFacts(coordinatorFacts, 'coordinator');
    const { owner } = coordinatorFacts;
    if (!owner) refuse('forbidden', 'owner_evidence');
    if (!owner.administrator) refuse('forbidden', 'administrator');
    return createVerifiedServiceContext({
        workspaceId, scope: lifecycleScope(coordinatorFacts.coordinator), ownerId: `user:${owner.userId}`,
        robotOwnerId: robotOwnerFor(workspaceId), operations: [operation], administrator: true
    });
}

// Robot list, robot get and lifecycle operation outcome, open to the declared coordinator
// alone or with a grant, in the lifecycle scope with the sentinel owner and no
// administrator flag.
export function contextForCoordinatorRead(workspaceId, coordinatorFacts) {
    requireFacts(coordinatorFacts, 'coordinator');
    return createVerifiedServiceContext({
        workspaceId, scope: lifecycleScope(coordinatorFacts.coordinator), ownerId: `coordinator:${coordinatorFacts.coordinator}`,
        robotOwnerId: robotOwnerFor(workspaceId), operations: ['read']
    });
}

// Terminal-target inventory: a read of the workspace robots for the verified direct
// administrator, with no origin row. Discovery records nothing except the token replay key.
export function contextForTerminalTargets(workspaceId, terminalFacts) {
    requireFacts(terminalFacts, 'terminal-targets');
    return createVerifiedServiceContext({
        workspaceId, scope: scopeFor('provider:terminals', TERMINAL_TARGETS_KEY), ownerId: terminalFacts.userKey,
        robotOwnerId: robotOwnerFor(workspaceId), operations: ['read'], administrator: true
    });
}

// Generic task-reference caller: the MCP row of the direct caller, administrator only for a
// verified direct administrator user actor.
export function contextForTaskReferenceCaller(workspaceId, taskReferenceFacts, operation) {
    requireFacts(taskReferenceFacts, 'task-reference');
    return buildContext({
        workspaceId, originNamespace: 'mcp', originKey: taskReferenceFacts.callerKey, ownerId: taskReferenceFacts.callerKey, operation,
        administrator: taskReferenceFacts.administrator === true
    });
}

// ---- Binding IDs and durable replay items ------------------------------------------------

// The `/bindings` grammar: a flow or a schedule.
export function isBindingId(value) {
    return typeof value === 'string' && (FLOW_BINDING_ID.test(value) || SCHEDULE_BINDING_ID.test(value));
}

// Any well-formed binding ID: a flow, a schedule or a generation ticket.
export function isAnyBindingId(value) {
    return isBindingId(value) || (typeof value === 'string' && GENERATION_BINDING_ID.test(value));
}

// The binding kind follows the prefix: `flow` or `schedule`; null for anything else.
export function bindingKind(value) {
    if (typeof value !== 'string') return null;
    if (FLOW_BINDING_ID.test(value)) return 'flow';
    if (SCHEDULE_BINDING_ID.test(value)) return 'schedule';
    return null;
}

// Per-call-site binding-ID grammar (interface note 2.3 (7)):
//   `/bindings` root and derived parent   flow_, cron_        requireBindingId
//   background-row admission              flow_, gen_         requireAdmissionBindingId
//   background-row read, events, lookup   flow_, cron_, gen_  requireReadBindingId
// A `gen_` binding is created only by an accepted obligation. A well-formed but unregistered
// or foreign binding answers not_found from the store.

// `/bindings`: the generation-ticket form is `operation_unavailable`, any other
// non-matching value `invalid_request`.
export function requireBindingId(value) {
    if (typeof value === 'string' && value.startsWith(GENERATION_BINDING_PREFIX)) refuse('operation_unavailable', 'operation_unmapped');
    if (!isBindingId(value)) refuse('invalid_request', 'binding');
    return value;
}

// Background-row admission: a flow or a generation ticket. A schedule binding only parents
// derived flows, so `cron_...` is `invalid_request`, as is anything else.
export function requireAdmissionBindingId(value) {
    if (typeof value !== 'string' || !(FLOW_BINDING_ID.test(value) || GENERATION_BINDING_ID.test(value))) refuse('invalid_request', 'binding');
    return value;
}

// Background-row read, events and lookup: any well-formed binding ID.
export function requireReadBindingId(value) {
    if (!isAnyBindingId(value)) refuse('invalid_request', 'binding');
    return value;
}

// Durable replay items for S1 (`replay = {items}`): the key is the SHA-256 (base64url) of
// the verified token's `jti`, retained until its acceptance window ends.
export function replayItems(verifiedTokens) {
    return verifiedTokens.map((facts) => {
        const replay = REPLAY.get(facts);
        if (!replay) refuse('unauthorized', 'jti');
        return { key: sha256b64url(Buffer.from(replay.jti, 'utf8')), retainUntilMs: replay.retainUntilMs };
    });
}
