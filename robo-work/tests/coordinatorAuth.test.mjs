import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
    COORDINATOR_ADMISSION_TOOL, TASK_REFERENCE_ORIGIN_TOOL, TASK_REFERENCE_TOOL, computeOriginRch, computeRchHttp,
    consumeReplay, contextForBinding, contextForBindingRead, contextForCoordinatorRead, contextForLifecycle, contextForOrigin,
    contextForOwner, contextForTaskReferenceCaller, createReplayCache, createVerifierConfig, bindingKind, isBindingId, lifecycleScope,
    rawBodyHash, replayItems, requireBindingId, scopeFor, verifyCoordinatorRequest, verifyOriginToken, verifyTaskReferenceRequest
} from '../server/coordinatorAuth.mjs';

// Real HS256 signing and verification with generated test keys. No auth mock: the
// minter below produces the same JWS bytes as Ploinky's signer (known-answer test).

const PROVIDER = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const OTHER_AGENT = 'agent:RoboRepo/otherAgent';
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function b64json(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
    const input = `${b64json(header)}.${b64json(payload)}`;
    return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function setup(options = {}) {
    const secret = crypto.randomBytes(32);
    let nowMs = options.nowMs ?? NOW_MS;
    const now = () => nowMs;
    const replayCache = createReplayCache({ maxEntries: options.maxEntries ?? 1024, now });
    const config = createVerifierConfig({ secret, audience: PROVIDER, coordinators: [COORDINATOR], replayCache, now });
    return { secret, config, replayCache, setNow(value) { nowMs = value; } };
}

function hopRequest(secret, overrides = {}, claims = {}) {
    const method = overrides.signMethod ?? 'POST';
    const path = overrides.signPath ?? '/v1/coordinator/admissions';
    const query = overrides.signQuery ?? '';
    const body = Buffer.from(overrides.signBody ?? '{"robotId":"r"}');
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method, path, tool: COORDINATOR_ADMISSION_TOOL,
        rch: computeRchHttp({ method, path, query, bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat: NOW_S, exp: NOW_S + 30, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    const token = sign(payload, overrides.secret ?? secret, overrides.header);
    return {
        authInfo: JSON.stringify({ invocationToken: token, invocationBody: { ignored: true } }),
        method: overrides.method ?? method, path: overrides.path ?? path, query: overrides.query ?? query,
        body: overrides.body ?? body
    };
}

const OWNER_CLAIMS = Object.freeze({
    usr: { id: 'alice', username: 'alice', email: '', roles: ['user'] },
    delegation: { jti: 'grant-1', scope: ['execution:owner'], sourceAgentId: COORDINATOR }
});

function originToken(secret, origin = {}, claims = {}) {
    const bound = { originKey: 'user:alice', originRequestId: crypto.randomBytes(16).toString('base64url'), agent: COORDINATOR, tool: 'runRobotTask', ...origin };
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: bound.originKey, method: 'ORIGIN', path: '/origin',
        tool: TASK_REFERENCE_ORIGIN_TOOL, rch: computeOriginRch(bound), origin: bound,
        jti: crypto.randomBytes(16).toString('base64url'), iat: NOW_S, exp: NOW_S + 30, ...claims
    };
    return { token: sign(payload, secret), bound };
}

function taskRefRequest(secret, overrides = {}, claims = {}) {
    const method = overrides.method ?? 'GET';
    const path = overrides.path ?? '/v1/task-refs/AAAAAAAAAAAAAAAAAAAAAA';
    const body = overrides.body ?? Buffer.alloc(0);
    const payload = {
        typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: 'user:alice',
        actor: { kind: 'user', id: 'user:alice', roles: ['user'] }, method, path, tool: TASK_REFERENCE_TOOL,
        rch: computeRchHttp({ method, path, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat: NOW_S, exp: NOW_S + 30, ...claims
    };
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return { authInfo: JSON.stringify({ invocationToken: sign(payload, secret) }), method, path, query: '', body };
}

function expectReason(fn, code, reason) {
    assert.throws(fn, (error) => {
        assert.equal(error.name, 'CoordinatorAuthError');
        assert.equal(error.reason, reason);
        assert.equal(error.code, code);
        return true;
    });
}

// ---- Wire compatibility ----------------------------------------------------------

test('known-answer vectors match Ploinky requestHash.mjs and the ALA HS256 signer', () => {
    // Generated once from ploinky Agent/lib/requestHash.mjs and achillesAgentLib jwt/jwtSign.mjs.
    const body = Buffer.from('{"robotId":"x","n":1}');
    assert.equal(rawBodyHash(body), 'DhffWpJxmBgEZc8aHB8lsMSdtC4MF6jHPh7qY8-NWlg');
    assert.equal(computeRchHttp({ method: 'POST', path: '/v1/coord/admit', query: '?a=1', bodyHash: rawBodyHash(body) }),
        't5N6DAU4WxvfU1ahaIIrjzcqMzUBpqRw4YtwcXqKz9U');
    assert.equal(computeOriginRch({ originKey: 'user:alice', originRequestId: 'AAAAAAAAAAAAAAAAAAAAAA', agent: 'agent:R/tool', tool: 'run' }),
        'Q-E-X1ideYw_p4sNly3NQ-7ZbTaDHHYSC4pcDxIRUnQ');
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0eXAiOiJyb3V0ZXItcmVxdWVzdCIsImlzcyI6InBsb2lua3ktcm91dGVyIiwiYXVkIjoiYWdlbnQ6Ui9wcm92IiwianRpIjoiajEiLCJpYXQiOjEwMDAsImV4cCI6MTAzMCwicmNoIjoidDVONkRBVTRXeHZmVTFhaGFJSXJqemNxTXpVQnBxUnc0WXR3Y1hxS3o5VSJ9.Qv0iyjFoZudFqZidnWDd-ZfMBwxy1BGRpmYf8XwUF8s';
    assert.equal(sign({ typ: 'router-request', iss: 'ploinky-router', aud: 'agent:R/prov', jti: 'j1', iat: 1000, exp: 1030,
        rch: 't5N6DAU4WxvfU1ahaIIrjzcqMzUBpqRw4YtwcXqKz9U' }, Buffer.alloc(32, 7)), token);
    const now = () => 1_010_000;
    const make = (secret) => createVerifierConfig({ secret, audience: 'agent:R/prov', coordinators: [], replayCache: createReplayCache({ now }), now });
    const request = { authInfo: JSON.stringify({ invocationToken: token }), method: 'POST', path: '/v1/coord/admit', query: '?a=1', body };
    // The Ploinky-signed token passes signature, lifetime, audience, type and issuer; it lacks the tool claim.
    expectReason(() => verifyCoordinatorRequest(make(Buffer.alloc(32, 7)), request), 'unauthorized', 'tool');
    expectReason(() => verifyCoordinatorRequest(make(Buffer.alloc(32, 8)), request), 'unauthorized', 'signature');
});

// ---- Coordinator hop token ----------------------------------------------------------

test('a valid coordinator hop yields branded facts with the verified coordinator and owner', () => {
    const { secret, config } = setup();
    const facts = verifyCoordinatorRequest(config, hopRequest(secret, {}, OWNER_CLAIMS));
    assert.equal(facts.coordinator, COORDINATOR);
    assert.deepEqual({ ...facts.owner, roles: [...facts.owner.roles] }, { userId: 'alice', roles: ['user'], administrator: false });
    assert.ok(Object.isFrozen(facts));
    consumeReplay(config, [facts]);
    const context = contextForOwner('ws', facts, 'admit');
    assert.equal(context.originNamespace, `coordinator:${COORDINATOR}`);
    assert.equal(context.originKey, 'owner:user:alice');
    assert.equal(context.ownerId, 'user:alice');
    assert.deepEqual([...context.operations], ['admit']);
    assert.equal(context.scope, scopeFor(context.originNamespace, context.originKey));
});

test('wrong or missing token type, audience and tool are refused', () => {
    const { secret, config } = setup();
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { typ: 'router-service' })), 'unauthorized', 'token_type');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { typ: undefined })), 'unauthorized', 'token_type');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { iss: 'someone' })), 'unauthorized', 'issuer');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { aud: OTHER_AGENT })), 'unauthorized', 'audience');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { aud: [PROVIDER] })), 'unauthorized', 'audience');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { aud: undefined })), 'unauthorized', 'audience');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { tool: '__http_route__' })), 'unauthorized', 'tool');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { tool: TASK_REFERENCE_TOOL })), 'unauthorized', 'tool');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { tool: undefined })), 'unauthorized', 'tool');
});

test('a missing or malformed token carrier is refused', () => {
    const { secret, config } = setup();
    const request = hopRequest(secret);
    expectReason(() => verifyCoordinatorRequest(config, { ...request, authInfo: undefined }), 'unauthorized', 'auth_info');
    expectReason(() => verifyCoordinatorRequest(config, { ...request, authInfo: '{}' }), 'unauthorized', 'auth_info');
    expectReason(() => verifyCoordinatorRequest(config, { ...request, authInfo: 'not json' }), 'unauthorized', 'auth_info');
    expectReason(() => verifyCoordinatorRequest(config, { ...request, authInfo: JSON.stringify({ routerServiceToken: 'x' }) }), 'unauthorized', 'auth_info');
    expectReason(() => verifyCoordinatorRequest(config, { ...request, authInfo: JSON.stringify({ invocationToken: 'a.b' }) }), 'unauthorized', 'token_format');
});

test('signature, algorithm and lifetime are enforced', () => {
    const { secret, config, setNow } = setup();
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { secret: crypto.randomBytes(32) })), 'unauthorized', 'signature');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { header: { alg: 'none' } })), 'unauthorized', 'algorithm');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { header: { alg: 'HS512' } })), 'unauthorized', 'algorithm');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { exp: NOW_S + 31 })), 'unauthorized', 'lifetime');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { iat: NOW_S + 31, exp: NOW_S + 60 })), 'unauthorized', 'not_yet_valid');
    const request = hopRequest(secret);
    setNow(NOW_MS + 61_000);
    expectReason(() => verifyCoordinatorRequest(config, request), 'unauthorized', 'expired');
    setNow(NOW_MS + 60_000);
    assert.ok(verifyCoordinatorRequest(config, request));
});

test('changed method, path, query or body breaks the rch binding', () => {
    const { secret, config } = setup();
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { method: 'PUT' })), 'unauthorized', 'method');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { path: '/v1/coordinator/other' })), 'unauthorized', 'path');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { query: '?x=1' })), 'unauthorized', 'rch');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { signQuery: '?x=1', query: '' })), 'unauthorized', 'rch');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { body: Buffer.from('{"robotId":"s"}') })), 'unauthorized', 'rch');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, { body: Buffer.from('{"robotId":"r"} ') })), 'unauthorized', 'rch');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { rch: '' })), 'unauthorized', 'rch');
    // A Router streaming forward signs an empty bodyHash; it never matches received bytes.
    const method = 'POST';
    const path = '/v1/coordinator/admissions';
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { rch: computeRchHttp({ method, path, query: '', bodyHash: '' }) })),
        'unauthorized', 'rch');
    assert.ok(verifyCoordinatorRequest(config, hopRequest(secret, { signQuery: '?x=1', query: '?x=1' })));
});

test('a consumed jti stays refused through the whole acceptance window, then the token is expired', () => {
    const { secret, config, setNow } = setup();
    const request = hopRequest(secret);
    const exp = NOW_S + 30;
    consumeReplay(config, [verifyCoordinatorRequest(config, request)]);
    for (const offset of [15, 30]) {
        setNow((exp + offset) * 1000);
        // Still inside the acceptance window (exp + 30 s skew): only the replay cache refuses it.
        const again = verifyCoordinatorRequest(config, request);
        expectReason(() => consumeReplay(config, [again]), 'unauthorized', 'replay');
    }
    setNow((exp + 31) * 1000);
    expectReason(() => verifyCoordinatorRequest(config, request), 'unauthorized', 'expired');
});

test('a consumed jti is refused on replay', () => {
    const { secret, config } = setup();
    const request = hopRequest(secret);
    consumeReplay(config, [verifyCoordinatorRequest(config, request)]);
    const again = verifyCoordinatorRequest(config, request);
    expectReason(() => consumeReplay(config, [again]), 'unauthorized', 'replay');
});

test('a wrong coordinator principal, actor, caller or subject is refused', () => {
    const { secret, config } = setup();
    const other = { sub: OTHER_AGENT, actor: { kind: 'agent', id: OTHER_AGENT }, caller: { kind: 'agent', id: OTHER_AGENT } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, other)), 'forbidden', 'coordinator');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { caller: undefined })), 'forbidden', 'caller');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { caller: { kind: 'user', id: COORDINATOR } })), 'forbidden', 'caller');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { actor: { kind: 'user', id: 'user:alice' } })), 'forbidden', 'actor');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { actor: { kind: 'agent', id: OTHER_AGENT } })), 'forbidden', 'actor');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { sub: 'user:alice' })), 'forbidden', 'subject');
});

test('owner evidence requires usr and delegation with the execution:owner scope from the coordinator', () => {
    const { secret, config } = setup();
    const noScope = { ...OWNER_CLAIMS, delegation: { ...OWNER_CLAIMS.delegation, scope: ['execution:read'] } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, noScope)), 'forbidden', 'owner_scope');
    const emptyScope = { ...OWNER_CLAIMS, delegation: { jti: 'g', sourceAgentId: COORDINATOR } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, emptyScope)), 'forbidden', 'owner_scope');
    const wrongSource = { ...OWNER_CLAIMS, delegation: { ...OWNER_CLAIMS.delegation, sourceAgentId: OTHER_AGENT } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, wrongSource)), 'forbidden', 'delegation_source');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { usr: OWNER_CLAIMS.usr })), 'forbidden', 'owner_evidence');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { delegation: OWNER_CLAIMS.delegation })), 'forbidden', 'owner_evidence');
    const guest = { ...OWNER_CLAIMS, usr: { id: 'alice', roles: ['guest'] } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, guest)), 'forbidden', 'guest');
    const guestId = { ...OWNER_CLAIMS, usr: { id: 'guest:abc', roles: [] } };
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, guestId)), 'forbidden', 'guest');
    const admin = { ...OWNER_CLAIMS, usr: { id: 'root', roles: ['admin'] } };
    const facts = verifyCoordinatorRequest(config, hopRequest(secret, {}, admin));
    assert.equal(facts.owner.userId, 'root');
    assert.equal(facts.owner.administrator, true);
    // RI-3: roles are trimmed and lowercased (Ploinky Caller.js, RoboTeam isAdminActor); any guest spelling disqualifies.
    for (const roles of [['Admin'], [' ADMIN '], ['user', 'admin']]) {
        assert.equal(verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'root', roles } })).owner.administrator, true);
    }
    for (const roles of [['administrator'], ['user'], []]) {
        assert.equal(verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'root', roles } })).owner.administrator, false);
    }
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'root', roles: ['admin', 'Guest'] } })), 'forbidden', 'guest');
    // A leftover `user:` prefix (the Router already stripped one) would alias user `alice`: refused.
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'user:alice', roles: [] } })), 'forbidden', 'owner_evidence');
    expectReason(() => verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'USER:alice', roles: [] } })), 'forbidden', 'owner_evidence');
    const hop = verifyCoordinatorRequest(config, hopRequest(secret));
    assert.equal(hop.owner, null);
    expectReason(() => contextForOwner('ws', hop, 'admit'), 'forbidden', 'owner_evidence');
});

// ---- Origin token -------------------------------------------------------------------

test('a valid origin token yields the bound origin and an MCP-row context', () => {
    const { secret, config } = setup();
    const { token, bound } = originToken(secret);
    const origin = verifyOriginToken(config, token);
    assert.equal(origin.originKey, 'user:alice');
    assert.equal(origin.originRequestId, bound.originRequestId);
    assert.equal(origin.agent, COORDINATOR);
    consumeReplay(config, [origin]);
    const context = contextForOrigin('ws', origin, 'admit');
    assert.equal(context.originNamespace, 'mcp');
    assert.equal(context.originKey, 'user:alice');
});

test('origin token refusals: expired, type, tool, method, path, rch and claim shape', () => {
    const { secret, config, setNow } = setup();
    const { token } = originToken(secret);
    setNow(NOW_MS + 61_000);
    expectReason(() => verifyOriginToken(config, token), 'unauthorized', 'expired');
    setNow(NOW_MS);
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { typ: 'router-service' }).token), 'unauthorized', 'token_type');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { tool: COORDINATOR_ADMISSION_TOOL }).token), 'unauthorized', 'tool');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { method: 'POST' }).token), 'unauthorized', 'method');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { path: '/lookup' }).token), 'unauthorized', 'path');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { aud: OTHER_AGENT }).token), 'unauthorized', 'audience');
    const tampered = originToken(secret);
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { origin: { ...tampered.bound, originKey: 'user:mallory' }, rch: computeOriginRch(tampered.bound) }).token),
        'unauthorized', 'rch');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { origin: undefined }).token), 'unauthorized', 'origin_claims');
    expectReason(() => verifyOriginToken(config, originToken(secret, { originKey: 'owner:user:alice' }).token), 'unauthorized', 'origin_key');
    expectReason(() => verifyOriginToken(config, originToken(secret, { agent: 'robo' }).token), 'unauthorized', 'origin_claims');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { sub: 'user:mallory' }).token), 'unauthorized', 'subject');
    expectReason(() => verifyOriginToken(config, originToken(secret, {}, { sub: undefined }).token), 'unauthorized', 'subject');
});

// ---- Task-reference token -----------------------------------------------------------

test('task-reference requests: caller key from the verified actor, lookup needs the signed originKey', () => {
    const { secret, config } = setup();
    const read = verifyTaskReferenceRequest(config, taskRefRequest(secret));
    assert.equal(read.callerKey, 'user:alice');
    const agent = verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, {
        sub: OTHER_AGENT, actor: { kind: 'agent', id: OTHER_AGENT, roles: [] }, caller: { kind: 'agent', id: OTHER_AGENT, roles: ['agent'] }
    }));
    assert.equal(agent.callerKey, OTHER_AGENT);
    assert.equal(contextForTaskReferenceCaller('ws', agent, 'read').originKey, OTHER_AGENT);
    const lookup = { method: 'POST', path: '/v1/task-refs/lookup', body: Buffer.from('{"originRequestId":"AAAAAAAAAAAAAAAAAAAAAA"}') };
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, lookup), { lookup: true }), 'forbidden', 'lookup_key');
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, lookup, { originKey: 'user:bob' }), { lookup: true }), 'forbidden', 'lookup_key');
    assert.ok(verifyTaskReferenceRequest(config, taskRefRequest(secret, lookup, { originKey: 'user:alice' }), { lookup: true }));
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { sub: 'user:bob' })), 'forbidden', 'subject');
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { actor: { kind: 'guest', id: 'guest:1' } })), 'forbidden', 'actor');
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { actor: { kind: 'user', id: 'user:alice', roles: ['guest'] } })), 'forbidden', 'guest');
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { tool: COORDINATOR_ADMISSION_TOOL })), 'unauthorized', 'tool');
    expectReason(() => verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { tool: '__http_route__' })), 'unauthorized', 'tool');
});

// ---- Replay cache and context brand ---------------------------------------------------

test('jtis of one request are consumed together or not at all', () => {
    const { secret, config, replayCache } = setup();
    const first = verifyCoordinatorRequest(config, hopRequest(secret));
    const { token } = originToken(secret);
    consumeReplay(config, [verifyOriginToken(config, token)]);
    const size = replayCache.size;
    expectReason(() => consumeReplay(config, [first, verifyOriginToken(config, token)]), 'unauthorized', 'replay');
    assert.equal(replayCache.size, size);
    consumeReplay(config, [first]);
    assert.equal(replayCache.size, size + 1);
});

test('a full replay cache refuses new jtis instead of evicting live ones', () => {
    const { secret, config } = setup({ maxEntries: 1 });
    const first = hopRequest(secret);
    consumeReplay(config, [verifyCoordinatorRequest(config, first)]);
    expectReason(() => consumeReplay(config, [verifyCoordinatorRequest(config, hopRequest(secret))]), 'unavailable', 'replay_capacity');
    expectReason(() => consumeReplay(config, [verifyCoordinatorRequest(config, first)]), 'unauthorized', 'replay');
});

test('expired replay entries are swept, so capacity recovers after the acceptance window', () => {
    const { secret, config, setNow } = setup({ maxEntries: 1 });
    consumeReplay(config, [verifyCoordinatorRequest(config, hopRequest(secret))]);
    setNow(NOW_MS + 63_000);
    const late = hopRequest(secret, {}, { iat: NOW_S + 60, exp: NOW_S + 90 });
    consumeReplay(config, [verifyCoordinatorRequest(config, late)]);
});

test('contexts are built only from branded verified facts; serialized facts are refused', () => {
    const { secret, config } = setup();
    const facts = verifyCoordinatorRequest(config, hopRequest(secret, {}, OWNER_CLAIMS));
    const copy = JSON.parse(JSON.stringify(facts));
    expectReason(() => contextForOwner('ws', copy, 'admit'), 'unauthorized', 'configuration');
    expectReason(() => contextForOrigin('ws', facts, 'admit'), 'unauthorized', 'configuration');
    expectReason(() => consumeReplay(config, [copy]), 'unauthorized', 'jti');
    assert.notEqual(scopeFor('mcp', 'user:a'), scopeFor('mcp', 'user:b'));
    assert.notEqual(scopeFor('coordinator:agent:R/a', 'owner:user:x'), scopeFor('coordinator:agent:R/a', 'binding:x'));
    assert.ok(scopeFor('coordinator:agent:R/a', 'owner:user:x').length <= 200);
});

test('verifier configuration is validated', () => {
    const replayCache = createReplayCache();
    expectReason(() => createVerifierConfig({ secret: Buffer.alloc(8), audience: PROVIDER, replayCache }), 'unavailable', 'configuration');
    expectReason(() => createVerifierConfig({ secret: crypto.randomBytes(32), audience: 'robo-work', replayCache }), 'unavailable', 'configuration');
    expectReason(() => createVerifierConfig({ secret: crypto.randomBytes(32), audience: PROVIDER, coordinators: ['*'], replayCache }), 'unavailable', 'configuration');
    expectReason(() => createVerifierConfig({ secret: crypto.randomBytes(32), audience: PROVIDER }), 'unavailable', 'configuration');
});

// ---- S3b r3: binding grammar, durable replay items and service contexts -----------------

test('wire binding IDs: flow and schedule-revision forms; the generation form is operation_unavailable', () => {
    const flow = `flow_${'0123456789abcdef01234567'}`;
    const schedule = `cron_${'89abcdef0123456789abcdef'}.r12`;
    assert.equal(bindingKind(flow), 'flow');
    assert.equal(bindingKind(schedule), 'schedule');
    assert.equal(requireBindingId(flow), flow);
    for (const bad of ['flow_0123', `flow_${'G'.repeat(24)}`, `cron_${'a'.repeat(24)}`, `cron_${'a'.repeat(24)}.r0`, `cron_${'a'.repeat(24)}.r01`,
        `cron_${'a'.repeat(24)}.r1234567890`, 'flow1', '', 7]) {
        assert.equal(isBindingId(bad), false);
        expectReason(() => requireBindingId(bad), 'invalid_request', 'binding');
    }
    expectReason(() => requireBindingId(`gen_${'a'.repeat(24)}`), 'operation_unavailable', 'operation_unmapped');
});

test('durable replay items: SHA-256 of the jti, retained through the acceptance window', () => {
    const { secret, config } = setup();
    const jti = 'jti-for-durable-replay';
    const facts = verifyCoordinatorRequest(config, hopRequest(secret, {}, { jti }));
    const [entry] = replayItems([facts]);
    assert.equal(entry.key, crypto.createHash('sha256').update(jti).digest('base64url'));
    assert.match(entry.key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(entry.retainUntilMs, (NOW_S + 30 + 30) * 1000 + 2000);
    expectReason(() => replayItems([{ ...facts }]), 'unauthorized', 'jti');
});

test('contexts: workspace robot owner, lifecycle needs an administrator grant, coordinator reads and task-reference administrators', () => {
    const { secret, config } = setup();
    const owner = verifyCoordinatorRequest(config, hopRequest(secret, {}, OWNER_CLAIMS));
    const admin = verifyCoordinatorRequest(config, hopRequest(secret, {}, { ...OWNER_CLAIMS, usr: { id: 'root', roles: ['Admin'] } }));
    const alone = verifyCoordinatorRequest(config, hopRequest(secret));
    const ownerContext = contextForOwner('ws', owner, 'admit');
    assert.equal(ownerContext.robotOwnerId, 'workspace:ws');
    assert.equal(ownerContext.administrator, false);
    assert.equal(contextForOwner('ws', admin, 'read').administrator, true);
    const background = contextForBinding('ws', alone, `flow_${'a'.repeat(24)}`, 'user:alice', 'admit');
    assert.equal(background.ownerId, 'user:alice');
    assert.equal(background.originKey, `binding:flow_${'a'.repeat(24)}`);
    expectReason(() => contextForBinding('ws', owner, `flow_${'a'.repeat(24)}`, 'user:alice', 'admit'), 'forbidden', 'row_ambiguous');
    const reader = contextForBindingRead('ws', alone, `flow_${'a'.repeat(24)}`, 'read');
    assert.equal(reader.ownerId, `coordinator:${COORDINATOR}`);
    assert.equal(reader.scope, background.scope);
    expectReason(() => contextForLifecycle('ws', owner, 'provision'), 'forbidden', 'administrator');
    expectReason(() => contextForLifecycle('ws', alone, 'provision'), 'forbidden', 'owner_evidence');
    const lifecycle = contextForLifecycle('ws', admin, 'provision');
    assert.equal(lifecycle.scope, lifecycleScope(COORDINATOR));
    assert.equal(lifecycle.originNamespace, null);
    assert.equal(lifecycle.ownerId, 'user:root');
    assert.equal(lifecycle.robotOwnerId, 'workspace:ws');
    const read = contextForCoordinatorRead('ws', alone);
    assert.deepEqual([...read.operations], ['read']);
    assert.equal(read.administrator, false);
    assert.equal(read.ownerId, `coordinator:${COORDINATOR}`);
    assert.notEqual(lifecycleScope(COORDINATOR), scopeFor(`coordinator:${COORDINATOR}`, 'owner:user:lifecycle'));
    const adminActor = verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, { actor: { kind: 'user', id: 'user:alice', roles: [' Admin '] } }));
    assert.equal(contextForTaskReferenceCaller('ws', adminActor, 'read').administrator, true);
    const plainActor = verifyTaskReferenceRequest(config, taskRefRequest(secret));
    assert.equal(contextForTaskReferenceCaller('ws', plainActor, 'read').administrator, false);
    // An agent actor never counts as an administrator, whatever user or delegation claims it carries.
    const agent = verifyTaskReferenceRequest(config, taskRefRequest(secret, {}, {
        sub: OTHER_AGENT, actor: { kind: 'agent', id: OTHER_AGENT, roles: ['admin'] }, caller: { kind: 'agent', id: OTHER_AGENT, roles: ['admin'] },
        usr: { id: 'root', roles: ['admin'] }, delegation: { jti: 'g', scope: ['execution:owner'], sourceAgentId: OTHER_AGENT }
    }));
    assert.equal(contextForTaskReferenceCaller('ws', agent, 'read').administrator, false);
});
