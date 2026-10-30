// Slice P7 self-test of the rwcoord fixture: the worker-side authenticated target-admission front (production
// coordinatorAuth + availability + qualificationStore), its HTTP listener, the coordinator CLI and the LOCAL Router
// stand-in. Every identity, secret and record here is SYNTHETIC. Real HS256 Router Requests are minted with a generated
// provider secret (same claim shape as Ploinky's coordinator hop), so no verifier is mocked. No helper binary is needed:
// nothing here is skipped.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReplayCache, createVerifierConfig } from '../../../server/coordinatorAuth.mjs';
import { canonicalJson } from '../../../server/stateProtocol.mjs';
import { canonicalTargetJson, validateQualificationRecord } from '../../../server/executionTarget/contract.mjs';
import { createQualificationStore } from '../../../server/executionTarget/qualificationStore.mjs';
import { installFixtureRecord } from '../tools/install-fixture-record.mjs';
import {
    ROBOTEAM_PRINCIPAL, TARGET_ADMISSION_PATH, createAdmissionFront, deriveTargetOperationId, isKnownFrontCode, serveAdmissionFront
} from '../fixture/rwcoord/admissionFront.mjs';
import { admissionBody, admissionRequestPath, originIdFor } from '../fixture/rwcoord/coordinator.mjs';
import { buildFixture } from '../fixture/rwcoord/facts.mjs';
import { mintRouterRequest, startLocalRouter } from '../fixture/rwcoord/localRouter.mjs';
import { renderManifests } from '../fixture/rwcoord/render-manifests.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RWCOORD = path.resolve(here, '..', 'fixture', 'rwcoord');
const UID = process.getuid();
const sid = (label) => crypto.createHash('sha256').update(`rwcoord-selftest:${label}`).digest().subarray(0, 16).toString('base64url');
const clone = (value) => JSON.parse(JSON.stringify(value));

const WORKER = 'agent:rwrepo/rwworker';
const COORDINATOR = 'agent:rwrepo/rwcoord';
const SECOND_COORDINATOR = 'agent:rwrepo/rwcoord2';
const ROGUE = 'agent:rwrepo/rwrogue';
const TARGET = 'rwrepo/rwtarget';
const STALE_WORKER_ALIAS = 'agent:rwrepo/rw-worker-old';
const NOW_MS = 1_900_000_000_000;
const WORKER_IDENTITY = Object.freeze({ principal: WORKER, runtimeInstanceId: 'rwworker-instance-1', enableGeneration: 'rwworker-enable-1', generation: sid('worker-generation') });
const ORIGIN_SEEDS = ['success', 'second', 'third'];

function liveInput(overrides = {}) {
    return {
        workspaceId: 'workspace:synthetic-p7', boxIdentity: 'ploinky-box-synthetic-p7', boxGeneration: 'b'.repeat(64), coordinator: COORDINATOR,
        staleWorkerAlias: STALE_WORKER_ALIAS, candidateDigest: 'c'.repeat(64), worker: { ...WORKER_IDENTITY },
        target: {
            ref: TARGET, instanceId: 'rwtarget-instance-1', containerId: 'd'.repeat(64), enableGeneration: 'rwtarget-enable-1', helperIncarnation: sid('helper-1'),
            running: true, journalAvailable: true, journalStoreIdentity: sid('journal'), imageDigest: 'e'.repeat(64), helperExecutableDigest: 'f'.repeat(64),
            contractDigest: '1'.repeat(64), inventoryDigest: '2'.repeat(64), profileDigest: '3'.repeat(64), peerDigest: '4'.repeat(64)
        },
        platform: { kernelRelease: '6.8.0-synthetic', runtimeVersion: '5.0.0-synthetic' }, originSeeds: ORIGIN_SEEDS, ...overrides
    };
}

function tempBase(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rwc-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return base;
}

// One front with its store, base facts file and clock. `options.record` replaces the record; `options.install` false
// leaves the store empty; `options.mode`, `options.worker`, `options.coordinators`, `options.sourceState` configure it.
function world(t, options = {}) {
    const base = tempBase(t);
    const secret = crypto.randomBytes(32);
    let nowMs = options.nowMs ?? NOW_MS;
    const clock = () => nowMs;
    const fixture = buildFixture(liveInput(options.live ?? {}), options.fixtureNowMs ?? NOW_MS);
    const storeRoot = path.join(base, 'qualification');
    if (options.install === false) {
        assert.equal(createQualificationStore({ fs, root: storeRoot, uid: UID, create: true }).ok, true);
    } else if (options.productionRecord) {
        const opened = createQualificationStore({ fs, root: storeRoot, uid: UID, create: true });
        const record = { ...clone(fixture.record), qualificationClass: 'production', fixture: null };
        const installed = opened.value.install({ ref: TARGET, record, expectedLive: { containerId: record.scope.containerId, helperIncarnation: record.scope.helperIncarnation }, allowedClasses: ['production'] });
        assert.equal(installed.ok, true, JSON.stringify(installed));
    } else {
        const record = options.record ?? fixture.record;
        const installed = installFixtureRecord({
            fs, uid: UID, storeRoot, create: true, ref: TARGET, recordText: Buffer.from(canonicalTargetJson(record, { maxBytes: 1 << 20 }).value),
            expectedLive: { containerId: record.scope.containerId, helperIncarnation: record.scope.helperIncarnation }
        });
        assert.equal(installed.ok, true, JSON.stringify(installed));
    }
    const factsFile = path.join(base, 'facts.json');
    const writeFacts = (value) => fs.writeFileSync(factsFile, JSON.stringify(value));
    writeFacts(options.facts ?? fixture.variants['facts-base.json']);
    const verifier = createVerifierConfig({
        secret, audience: WORKER, coordinators: options.coordinators ?? [COORDINATOR, SECOND_COORDINATOR], replayCache: createReplayCache({ maxEntries: 1024, now: clock }), now: clock
    });
    const events = [];
    let factsReads = 0;
    const stateDir = path.join(base, 'front');
    const front = createAdmissionFront({
        verifier, worker: options.worker ?? WORKER_IDENTITY, mode: options.mode ?? 'proof-fixture',
        store: { fs, root: storeRoot, uid: UID, forbiddenRoots: [] },
        loadBaseFacts: () => { factsReads += 1; return JSON.parse(fs.readFileSync(factsFile, 'utf8')); },
        ...(options.sourceState ? { sourceState: options.sourceState } : {}),
        stateDir, now: clock, log: (event) => events.push(event)
    });
    // One authenticated request. `selection` is the body selection; `seed` names the origin; `caller` the verified
    // coordinator principal; `claims` overrides token claims; `alter` changes what the front receives after minting.
    async function call({ selection = TARGET, seed = 'success', origin, surface = 'terminal', caller = COORDINATOR, claims = {}, owner = null,
        tokenSecret = secret, provider = WORKER, signPath = TARGET_ADMISSION_PATH, signQuery = '', rawBody, alter = {} } = {}) {
        const body = rawBody ?? admissionBody({ originRequestId: origin ?? originIdFor(seed), selection, surface });
        const authInfo = mintRouterRequest({ secret: tokenSecret, provider, caller, method: 'POST', path: signPath, query: signQuery, body, nowS: Math.floor(nowMs / 1000), owner, claims });
        const request = { authInfo, method: 'POST', path: signPath, query: signQuery, body, ...alter };
        const result = await front.handle(request);
        return { ...result, request };
    }
    function observe() {
        const store = createQualificationStore({ fs, root: storeRoot, uid: UID }).value;
        const facts = store.facts().value;
        const dir = path.join(stateDir, 'admissions');
        return { used: facts.executionsUsed[TARGET] ?? null, admissions: fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [] };
    }
    return { base, secret, front, call, observe, events, fixture, factsFile, writeFacts, factsReads: () => factsReads, setNow: (value) => { nowMs = value; }, storeRoot, verifier };
}

// A refusal leaves the count and the admission records exactly as they were.
async function expectRefusal(w, request, { status = 200, stage = 'admission', code, reason }, label) {
    const before = w.observe();
    const result = await w.call(request);
    assert.equal(result.status, status, `${label}: status ${JSON.stringify(result.body)}`);
    assert.equal(result.body.ok, false, label);
    assert.equal(result.body.stage, stage, `${label}: stage`);
    assert.equal(result.body.code, code, `${label}: code`);
    if (reason !== undefined) assert.equal(result.body.reason, reason, `${label}: reason`);
    assert.ok(isKnownFrontCode(result.body.code), `${label}: ${result.body.code} is enumerated`);
    assert.deepEqual(w.observe(), before, `${label}: no count, no admission record`);
    return result;
}

test('P7 authenticated admission: the verified coordinator admits the qualified target once; retries are idempotent', async (t) => {
    const w = world(t);
    const first = await w.call();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.ok, true);
    assert.equal(first.body.replayed, false);
    const expectedOperation = deriveTargetOperationId({ coordinator: COORDINATOR, originRequestId: originIdFor('success') });
    assert.equal(first.body.value.operationId, expectedOperation);
    assert.ok(w.fixture.plan.operationIds.includes(expectedOperation), 'the operator plan lists the derived operation');
    assert.deepEqual({ ...first.body.value, qualificationRecordDigest: undefined }, {
        backend: 'target', ref: TARGET, principal: `agent:${TARGET}`, qualificationClass: 'proof-fixture', qualificationRecordDigest: undefined,
        operationId: expectedOperation, coordinator: COORDINATOR, executionsUsed: 1
    });
    assert.match(first.body.value.qualificationRecordDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(w.observe(), { used: 1, admissions: [`${expectedOperation}.json`] });
    // A retry of the same origin (fresh token) returns the recorded admission and counts nothing.
    const retry = await w.call();
    assert.equal(retry.body.ok, true);
    assert.equal(retry.body.replayed, true);
    assert.deepEqual(retry.body.value, first.body.value);
    assert.deepEqual(w.observe(), { used: 1, admissions: [`${expectedOperation}.json`] });
    // Another body under the same origin conflicts, without a count.
    await expectRefusal(w, { selection: 'rwrepo/nosuch' }, { code: 'operation_conflict' }, 'changed body, same origin');
    await expectRefusal(w, { surface: 'browser' }, { code: 'operation_conflict' }, 'changed surface, same origin');
    // A second admissible origin is a second execution.
    const second = await w.call({ seed: 'second' });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.value.executionsUsed, 2);
    // Events carry no token, body or secret.
    const serialized = JSON.stringify(w.events);
    assert.doesNotMatch(serialized, /invocationToken|eyJ/);
    assert.equal(serialized.includes(w.secret.toString('hex')), false);
});

test('P7 authentication: every hop defect refuses before any fact is read, and a replayed token never admits twice', async (t) => {
    const w = world(t);
    const cases = [
        [{ tokenSecret: crypto.randomBytes(32) }, 401, 'unauthorized', 'signature', 'forged signature'],
        [{ provider: 'agent:rwrepo/otherworker' }, 401, 'unauthorized', 'audience', 'another provider audience'],
        [{ claims: { tool: '__task_ref__' } }, 401, 'unauthorized', 'tool', 'wrong tool'],
        [{ claims: { typ: 'router-service' } }, 401, 'unauthorized', 'token_type', 'wrong token type'],
        [{ claims: { iss: 'someone' } }, 401, 'unauthorized', 'issuer', 'wrong issuer'],
        [{ alter: { body: admissionBody({ originRequestId: originIdFor('success'), selection: 'rwrepo/other' }) } }, 401, 'unauthorized', 'rch', 'body changed after the Router signed it'],
        [{ alter: { query: '?x=1' } }, 401, 'unauthorized', 'rch', 'query added after signing'],
        [{ alter: { path: '/v1/other' } }, 401, 'unauthorized', 'path', 'received path differs from the signed path'],
        [{ alter: { method: 'PUT' } }, 401, 'unauthorized', 'method', 'received method differs'],
        [{ caller: ROGUE }, 403, 'forbidden', 'coordinator', 'undeclared coordinator principal'],
        [{ claims: { actor: { kind: 'agent', id: ROGUE, roles: [] } } }, 403, 'forbidden', 'actor', 'actor differs from caller'],
        [{ claims: { sub: ROGUE } }, 403, 'forbidden', 'subject', 'subject differs from caller'],
        [{ claims: { caller: { kind: 'user', id: 'user:alice', roles: [] } } }, 403, 'forbidden', 'caller', 'user caller'],
        [{ claims: { iat: Math.floor(NOW_MS / 1000) - 200, exp: Math.floor(NOW_MS / 1000) - 170 } }, 401, 'unauthorized', 'expired', 'expired token'],
        [{ claims: { iat: Math.floor(NOW_MS / 1000) + 120, exp: Math.floor(NOW_MS / 1000) + 140 } }, 401, 'unauthorized', 'not_yet_valid', 'future token'],
        [{ claims: { exp: Math.floor(NOW_MS / 1000) + 60 } }, 401, 'unauthorized', 'lifetime', 'lifetime above 30 seconds'],
        [{ alter: { authInfo: undefined } }, 401, 'unauthorized', 'auth_info', 'no Router auth info'],
        [{ owner: { usr: { id: 'guest:visitor', roles: ['user'] }, delegation: { scope: ['execution:owner'], sourceAgentId: COORDINATOR } } }, 403, 'forbidden', 'guest', 'guest owner evidence'],
        [{ owner: { usr: { id: 'alice', roles: ['guest'] }, delegation: { scope: ['execution:owner'], sourceAgentId: COORDINATOR } } }, 403, 'forbidden', 'guest', 'guest role'],
        [{ owner: { usr: { id: 'alice', roles: ['user'] }, delegation: { scope: ['execution:owner'], sourceAgentId: ROGUE } } }, 403, 'forbidden', 'delegation_source', 'delegation from another agent'],
        [{ owner: { usr: { id: 'alice', roles: ['user'] }, delegation: { scope: ['read'], sourceAgentId: COORDINATOR } } }, 403, 'forbidden', 'owner_scope', 'owner scope missing']
    ];
    for (const [request, status, code, reason, label] of cases) {
        await expectRefusal(w, request, { status, stage: 'authenticate', code, reason }, label);
    }
    assert.equal(w.observe().used, 0, 'nothing was counted');
    assert.equal(w.factsReads(), 0, 'no base fact was read for an unauthenticated request');
    // Replay: the same Router Request presented twice admits once; the second presentation is refused.
    const first = await w.call({ seed: 'third' });
    assert.equal(first.body.ok, true);
    const before = w.observe();
    const replayed = await w.front.handle(first.request);
    assert.equal(replayed.status, 401);
    assert.equal(replayed.body.reason, 'replay');
    assert.deepEqual(w.observe(), before);
    // A token whose request was refused is burned as well: presenting it again is refused, never re-decided.
    const refused = await w.call({ selection: 'rwrepo/nosuch', seed: 'refused-then-replayed' });
    assert.equal(refused.body.code, 'target_missing');
    const again = await w.front.handle(refused.request);
    assert.deepEqual([again.status, again.body.stage, again.body.reason], [401, 'authenticate', 'replay']);
    assert.deepEqual(w.observe(), before);
});

test('P7 request surface: route, query and exact body; caller-supplied authority fields are refused', async (t) => {
    const w = world(t);
    const origin = originIdFor('success');
    await expectRefusal(w, { signPath: '/v1/coordinator/admissions' }, { status: 404, stage: 'route', code: 'route_not_found' }, 'another coordinator route');
    await expectRefusal(w, { signQuery: '?selection=x' }, { status: 404, stage: 'route', code: 'route_not_found' }, 'query string');
    const bodies = [
        [{ version: 1, originRequestId: origin, selection: TARGET, coordinatorPrincipal: COORDINATOR }, 'forged coordinator principal in the body'],
        [{ version: 1, originRequestId: origin, selection: TARGET, operationId: sid('op') }, 'caller-chosen operation ID'],
        [{ version: 1, originRequestId: origin, selection: TARGET, mode: 'proof-fixture' }, 'caller-chosen mode'],
        [{ version: 1, originRequestId: origin, selection: '' }, 'blank selection (ordinary backend, not served here)'],
        [{ version: 2, originRequestId: origin, selection: TARGET }, 'unsupported version'],
        [{ version: 1, originRequestId: 'short', selection: TARGET }, 'malformed origin request ID'],
        [{ version: 1, originRequestId: origin, selection: TARGET, surface: 'gui' }, 'unknown surface'],
        [[], 'array body']
    ];
    for (const [value, label] of bodies) {
        await expectRefusal(w, { rawBody: Buffer.from(JSON.stringify(value)) }, { status: 400, stage: 'request', code: 'invalid_request' }, label);
    }
    await expectRefusal(w, { rawBody: Buffer.from('{not json') }, { status: 400, stage: 'request', code: 'invalid_request' }, 'malformed JSON');
});

test('P7 RoboTeam and owning-worker exclusion by principal, stale spelling, coordinator stand-in and runtime identity', async (t) => {
    const w = world(t);
    const cases = [
        [WORKER, 'owning worker by canonical principal'],
        ['rwrepo/rwworker', 'owning worker by Ref'],
        [ROBOTEAM_PRINCIPAL, 'RoboTeam by canonical principal (unresolved)'],
        ['AchillesIDE/roboTeamAgent', 'RoboTeam by Ref (unresolved)'],
        [STALE_WORKER_ALIAS, 'stale saved worker spelling (unresolved)'],
        [COORDINATOR, 'the verified coordinator (RoboTeam stand-in)'],
        ['rwrepo/rwshadow', 'an entry resolving to the worker runtime instance (base facts do not list it)']
    ];
    for (const [selection, label] of cases) await expectRefusal(w, { selection }, { code: 'target_excluded' }, label);
    // The base facts can extend the exclusions but never remove the front's own: an empty base list still excludes.
    const facts = clone(w.fixture.variants['facts-base.json']);
    facts.excluded = { principals: [], aliases: [], runtimeInstanceIds: [] };
    w.writeFacts(facts);
    await expectRefusal(w, { selection: WORKER }, { code: 'target_excluded' }, 'worker with empty base exclusions');
    await expectRefusal(w, { selection: ROBOTEAM_PRINCIPAL }, { code: 'target_excluded' }, 'RoboTeam with empty base exclusions');
    await expectRefusal(w, { selection: 'rwrepo/rwshadow' }, { code: 'target_excluded' }, 'runtime identity with empty base exclusions');
    // An entry carrying an excluded alias is excluded even when selected by its own Ref.
    facts.entries = [{ ...facts.entries[0], aliases: [WORKER] }];
    w.writeFacts(facts);
    await expectRefusal(w, { selection: TARGET }, { code: 'target_excluded' }, 'target entry aliased to the worker');
    // A second declared coordinator is excluded as well while it calls.
    await expectRefusal(w, { selection: 'rwrepo/rwcoord2', caller: SECOND_COORDINATOR, seed: 'x2' }, { code: 'target_excluded' }, 'calling coordinator selects itself');
});

test('P7 refusal precedence: one fault per A1.7 step, and each adjacent pair resolves to the earlier step', async (t) => {
    const base = (w) => clone(w.fixture.variants['facts-base.json']);
    const target = (facts) => facts.entries[0];
    const withFacts = async (w, mutate, request, code, label) => {
        const facts = base(w);
        mutate(facts);
        w.writeFacts(facts);
        await expectRefusal(w, request, { code }, label);
    };
    const w = world(t);
    // Step 1: malformed selection (before the surface check), non-terminal surface.
    await expectRefusal(w, { selection: 'not a ref' }, { code: 'invalid_selection' }, '1 malformed selection');
    await expectRefusal(w, { surface: 'browser', seed: 's1' }, { code: 'environment_not_terminal' }, '1 non-terminal surface');
    await expectRefusal(w, { selection: 'not a ref', surface: 'desktop', seed: 's1b' }, { code: 'invalid_selection' }, '1 malformed beats surface');
    await expectRefusal(w, { selection: WORKER, surface: 'browser', seed: 's1c' }, { code: 'environment_not_terminal' }, '1 surface beats 2 exclusion');
    // Step 2 vs 3: an excluded literal principal that does not resolve is excluded, not missing.
    await expectRefusal(w, { selection: ROBOTEAM_PRINCIPAL, seed: 's2' }, { code: 'target_excluded' }, '2 beats 3');
    // Step 3: missing and ambiguous.
    await expectRefusal(w, { selection: 'rwrepo/nosuch', seed: 's3' }, { code: 'target_missing' }, '3 missing');
    await withFacts(w, (f) => { f.entries.push({ ...target(f), ref: 'rwrepo/rwtwin', principal: 'agent:rwrepo/rwtwin', aliases: ['agent:rwrepo/shared'] }); target(f).aliases = ['agent:rwrepo/shared']; },
        { selection: 'agent:rwrepo/shared', seed: 's3b' }, 'target_ambiguous', '3 ambiguous');
    // Step 3 vs 4: an ambiguous match that includes the entry resolving to the worker's runtime identity is ambiguous,
    // not excluded (resolution precedes the resolved-identity exclusion).
    await withFacts(w, (f) => { target(f).aliases = ['agent:rwrepo/shared']; f.entries[1].aliases = ['agent:rwrepo/shared']; },
        { selection: 'agent:rwrepo/shared', seed: 's3c' }, 'target_ambiguous', '3 beats 4');
    // Step 4 vs 5: a resolved entry excluded by runtime identity, together with a later fault.
    await withFacts(w, (f) => { f.entries[1].boxGeneration = 'other-generation'; }, { selection: 'rwrepo/rwshadow', seed: 's4' }, 'target_excluded', '4 beats 5');
    // Step 5: wrong workspace or Box; with step 6.
    await withFacts(w, (f) => { target(f).boxGeneration = 'other-generation'; }, { seed: 's5' }, 'target_scope_mismatch', '5 Box generation');
    await withFacts(w, (f) => { target(f).workspaceId = 'workspace:other'; target(f).running = false; }, { seed: 's5b' }, 'target_scope_mismatch', '5 beats 6');
    // Step 6: disabled, stopped, non-container, non-global, missing identity; with step 7.
    for (const [mutate, label] of [
        [(e) => { e.running = false; }, 'stopped'], [(e) => { e.enabled = false; }, 'disabled'], [(e) => { e.runtime = 'bwrap'; }, 'non-container'],
        [(e) => { e.placement = 'local'; }, 'non-global'], [(e) => { e.helperIncarnation = null; }, 'no helper incarnation']
    ]) await withFacts(w, (f) => mutate(target(f)), { seed: `s6-${label}` }, 'target_not_eligible', `6 ${label}`);
    await withFacts(w, (f) => { target(f).running = false; target(f).declaration = null; }, { seed: 's6b' }, 'target_not_eligible', '6 beats 7');
    // Step 7: missing or invalid declaration; with step 8.
    await withFacts(w, (f) => { target(f).declaration = null; }, { seed: 's7' }, 'target_contract_missing', '7 missing declaration');
    await withFacts(w, (f) => { target(f).declaration = { valid: false }; }, { seed: 's7b' }, 'target_contract_invalid', '7 invalid declaration');
    await withFacts(w, (f) => { target(f).declaration = null; f.sourceState.record = null; }, { seed: 's7c' }, 'target_contract_missing', '7 beats 8');
    // Step 8: source protection; with step 9 (the operator variant carries both faults).
    await withFacts(w, (f) => { f.sourceState.record = null; }, { seed: 's8' }, 'source_unavailable', '8 no source record');
    await withFacts(w, (f) => { f.sourceState.record.protectionStatus = 'unavailable'; }, { seed: 's8b' }, 'source_unprotected', '8 unprotected');
    await withFacts(w, (f) => { f.sourceState.aliasCoverage = 'partial'; }, { seed: 's8c' }, 'source_alias_unproven', '8 alias coverage');
    await withFacts(w, (f) => { f.sourceState.previouslyRobotWritable = true; }, { seed: 's8d' }, 'source_provenance_unaccepted', '8 previously robot-writable');
    await withFacts(w, (f) => { f.sourceState.writableBacking = true; }, { seed: 's8e' }, 'source_unprotected', '8 writable backing');
    await withFacts(w, (f) => { f.sourceState.currentClosureDigest = 'f'.repeat(64); }, { seed: 's8f' }, 'source_binding_mismatch', '8 changed closure');
    await withFacts(w, (f) => { f.sourceState.record.boxGeneration = 'old-generation'; }, { seed: 's8g' }, 'source_unavailable', '8 record of an old Box generation');
    w.writeFacts(w.fixture.variants['facts-no-source-unprepared.json']);
    await expectRefusal(w, { seed: 's8h' }, { code: 'source_unavailable' }, '8 beats 9 (operator variant)');
    // Step 9: preparation and journal; with step 10.
    w.writeFacts(w.fixture.variants['facts-unprepared.json']);
    await expectRefusal(w, { seed: 's9' }, { code: 'target_unprepared' }, '9 unprepared (operator variant)');
    await withFacts(w, (f) => { target(f).journal = 'unavailable'; }, { seed: 's9b' }, 'journal_unavailable', '9 journal unavailable');
    const empty = world(t, { install: false });
    empty.writeFacts(empty.fixture.variants['facts-unprepared.json']);
    await expectRefusal(empty, {}, { code: 'target_unprepared' }, '9 beats 10 (no record either)');
    // Step 10: qualification class and scope; with step 11.
    w.writeFacts(w.fixture.variants['facts-base.json']);
    empty.writeFacts(empty.fixture.variants['facts-base.json']);
    await expectRefusal(empty, {}, { code: 'qualification_missing' }, '10 no record');
    await expectRefusal(w, { origin: sid('unlisted-origin') }, { code: 'qualification_scope' }, '10 origin not in the record');
    await expectRefusal(w, { caller: SECOND_COORDINATOR }, { code: 'qualification_scope' }, '10 another declared coordinator');
    await withFacts(w, (f) => { target(f).helperIncarnation = sid('helper-2'); }, {}, 'qualification_scope', '10 replaced helper incarnation (target reinstall)');
    await withFacts(w, (f) => { target(f).helperIncarnation = sid('helper-2'); target(f).attestation.profileDigest = '9'.repeat(64); }, {}, 'qualification_scope', '10 beats 11');
    const late = world(t, { nowMs: NOW_MS + 7 * 3600000 });
    await expectRefusal(late, {}, { code: 'qualification_scope' }, '10 outside the validity window');
    const otherGeneration = world(t, { worker: { ...WORKER_IDENTITY, generation: sid('worker-generation-2') } });
    await expectRefusal(otherGeneration, {}, { code: 'qualification_scope' }, '10 another worker generation');
    const otherInstance = world(t, { worker: { ...WORKER_IDENTITY, runtimeInstanceId: 'rwworker-instance-2' } });
    await expectRefusal(otherInstance, {}, { code: 'qualification_scope' }, '10 another worker runtime instance');
    const production = world(t, { mode: 'production' });
    await expectRefusal(production, {}, { code: 'qualification_class' }, '10 production admission refuses a fixture record (QUA-01)');
    // Step 11: security, profile, inventory, HOME and channel; with step 12.
    await withFacts(w, (f) => { target(f).attestation.effectiveSecurityDigest = '9'.repeat(64); }, {}, 'target_attestation_mismatch', '11 effective security');
    await withFacts(w, (f) => { target(f).attestation.targetImageDigest = `sha256:${'9'.repeat(64)}`; }, {}, 'target_attestation_mismatch', '11 image-only clone');
    await withFacts(w, (f) => { f.home.targetInventoryDigest = '9'.repeat(64); }, {}, 'home_incompatible', '11 unlisted HOME transition');
    await withFacts(w, (f) => { target(f).attestation.channelSchemaDigest = '9'.repeat(64); target(f).activeExecutions = 8; }, {}, 'target_attestation_mismatch', '11 beats 12');
    // Step 12: capacity (live executions and the record's execution budget); with step 13.
    await withFacts(w, (f) => { target(f).activeExecutions = 8; }, {}, 'capacity_exceeded', '12 executions per target');
    const productionRecord = world(t, { mode: 'production', productionRecord: true });
    const busy = clone(productionRecord.fixture.variants['facts-base.json']);
    busy.entries[0].activeExecutions = 8;
    productionRecord.writeFacts(busy);
    await expectRefusal(productionRecord, {}, { code: 'capacity_exceeded' }, '12 beats 13');
    // Step 13: a fully eligible production target has no activated backend.
    productionRecord.writeFacts(productionRecord.fixture.variants['facts-base.json']);
    await expectRefusal(productionRecord, {}, { code: 'backend_not_activated' }, '13 production backend not activated');
});

test('P7 a retry after the admission record was lost at the last budget slot is admitted without a second charge', async (t) => {
    const fixture = buildFixture(liveInput(), NOW_MS);
    const record = clone(fixture.record);
    record.fixture.maxExecutions = 1;
    const w = world(t, { record });
    const admissions = path.join(w.base, 'front', 'admissions');
    // The count succeeds, the admission record cannot be written (a real EACCES on the record directory).
    fs.chmodSync(admissions, 0o500);
    const lost = await w.call();
    fs.chmodSync(admissions, 0o700);
    assert.deepEqual([lost.status, lost.body.stage, lost.body.code], [503, 'state', 'state_unavailable']);
    assert.deepEqual(w.observe(), { used: 1, admissions: [] }, 'counted, not recorded');
    // Another body under the same origin conflicts with the intent, without a count.
    await expectRefusal(w, { selection: 'rwrepo/nosuch' }, { code: 'operation_conflict' }, 'changed body after a lost record');
    // The same request again: admitted, the count stays at the budget of 1.
    const retry = await w.call();
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual([retry.body.ok, retry.body.replayed, retry.body.value.executionsUsed], [true, false, 1]);
    const operationId = deriveTargetOperationId({ coordinator: COORDINATOR, originRequestId: originIdFor('success') });
    assert.deepEqual(w.observe(), { used: 1, admissions: [`${operationId}.json`] });
    assert.deepEqual(fs.readdirSync(path.join(w.base, 'front', 'intents')), [], 'the intent is removed once recorded');
    // The given-back slot is never a new execution: a second origin is still beyond the budget.
    await expectRefusal(w, { seed: 'second' }, { code: 'capacity_exceeded' }, 'second origin after the retry');
    // An intent whose operation was never counted gets no slot either: the store refuses beyond the budget.
    const w2 = world(t, { record });
    assert.equal((await w2.call()).body.ok, true);
    const secondOperation = deriveTargetOperationId({ coordinator: COORDINATOR, originRequestId: originIdFor('second') });
    const requestDigest = (selection) => crypto.createHash('sha256').update(canonicalJson({
        coordinator: COORDINATOR, ownerUserId: null, originRequestId: originIdFor('second'), selection, surface: 'terminal'
    })).digest('hex');
    const intentFile = path.join(w2.base, 'front', 'intents', `${secondOperation}.json`);
    fs.writeFileSync(intentFile, JSON.stringify({ version: 1, requestDigest: requestDigest(TARGET), ref: TARGET }), { mode: 0o600 });
    await expectRefusal(w2, { seed: 'second' }, { code: 'capacity_exceeded' }, 'intent of an operation that was never counted');
    fs.writeFileSync(intentFile, JSON.stringify({ version: 1, requestDigest: requestDigest('rwrepo/other'), ref: TARGET }), { mode: 0o600 });
    await expectRefusal(w2, { seed: 'second' }, { code: 'operation_conflict' }, 'intent recorded for another body');
});

test('P7 the record binds the verified coordinator: another declared coordinator is refused even when its operation is listed', async (t) => {
    const fixture = buildFixture(liveInput(), NOW_MS);
    const record = clone(fixture.record);
    const foreignOperation = deriveTargetOperationId({ coordinator: SECOND_COORDINATOR, originRequestId: originIdFor('foreign') });
    record.fixture.operationIds = [...record.fixture.operationIds, foreignOperation].sort();
    const w = world(t, { record });
    await expectRefusal(w, { caller: SECOND_COORDINATOR, seed: 'foreign' }, { code: 'qualification_scope' }, 'listed operation, other coordinator');
    // The coordinator the record names admits its own operation.
    assert.equal((await w.call()).body.ok, true);
});

test('P7 the record execution budget is durable and exhausts without counting a refusal', async (t) => {
    const fixture = buildFixture(liveInput(), NOW_MS);
    const record = clone(fixture.record);
    record.fixture.maxExecutions = 1;
    const w = world(t, { record });
    assert.equal((await w.call()).body.ok, true);
    await expectRefusal(w, { seed: 'second' }, { code: 'capacity_exceeded' }, 'second execution beyond maxExecutions 1');
    assert.equal((await w.call()).body.replayed, true, 'the admitted operation is still served as recorded');
    // An unreadable counter exhausts the fixture instead of reading as zero (erratum A10.3).
    const w2 = world(t);
    const counters = path.join(w2.storeRoot, 'counters');
    const name = `${crypto.createHash('sha256').update(TARGET).digest('hex')}.json`;
    fs.writeFileSync(path.join(counters, name), 'garbage', { mode: 0o600 });
    await expectRefusal(w2, {}, { code: 'capacity_exceeded' }, 'unreadable counter');
});

test('P7 base facts are operator-owned only: front-owned fields, unreadable facts and an unsafe store refuse without admitting', async (t) => {
    const w = world(t);
    for (const [mutate, label] of [
        [(f) => { f.request = { coordinatorPrincipal: COORDINATOR, operationId: sid('x'), nowMs: NOW_MS }; }, 'operator-supplied request'],
        [(f) => { f.mode = 'proof-fixture'; }, 'operator-supplied mode'],
        [(f) => { f.qualifications = {}; }, 'operator-supplied qualifications'],
        [(f) => { f.current.worker = { ...WORKER_IDENTITY }; }, 'operator-supplied worker half'],
        [(f) => { f.excluded.principals = 'none'; }, 'malformed exclusions'],
        [(f) => { delete f.home; }, 'missing HOME facts']
    ]) {
        const facts = clone(w.fixture.variants['facts-base.json']);
        mutate(facts);
        w.writeFacts(facts);
        await expectRefusal(w, {}, { status: 503, stage: 'facts', code: 'facts_unavailable' }, label);
    }
    fs.writeFileSync(w.factsFile, '{broken');
    await expectRefusal(w, {}, { status: 503, stage: 'facts', code: 'facts_unavailable' }, 'unparseable facts');
    w.writeFacts(w.fixture.variants['facts-base.json']);
    fs.chmodSync(w.storeRoot, 0o755);
    const before = { admissions: fs.existsSync(path.join(w.base, 'front', 'admissions')) ? fs.readdirSync(path.join(w.base, 'front', 'admissions')) : [] };
    const result = await w.call();
    assert.deepEqual([result.status, result.body.code], [503, 'store_unavailable']);
    assert.deepEqual(fs.readdirSync(path.join(w.base, 'front', 'admissions')), before.admissions);
    fs.chmodSync(w.storeRoot, 0o700);
});

test('P7 source state from a provider: a missing or pending Ploinky record is source_unavailable; a protected one admits', async (t) => {
    const calls = [];
    let answer = null;
    const provider = async (value) => {
        calls.push(value);
        if (value && value.provider === 'ploinky') return answer === null ? null : { ...value.supplement, record: answer };
        return value;
    };
    const w = world(t, { sourceState: provider });
    w.writeFacts(w.fixture.variants['facts-ploinky-source.json']);
    await expectRefusal(w, {}, { code: 'source_unavailable' }, 'Ploinky has no protected record');
    answer = clone(w.fixture.variants['facts-base.json'].sourceState.record);
    const admitted = await w.call();
    assert.equal(admitted.body.ok, true, JSON.stringify(admitted.body));
    assert.equal(calls.length, 2);
    // Without a provider a {provider} placeholder never becomes source authority.
    const plain = world(t);
    plain.writeFacts(plain.fixture.variants['facts-ploinky-source.json']);
    await expectRefusal(plain, {}, { code: 'source_unavailable' }, 'placeholder without a provider');
});

test('P7 operator facts tool: derived operation IDs, installable record, labelled variants', () => {
    const { variants, record, plan } = buildFixture(liveInput(), NOW_MS);
    assert.deepEqual(Object.keys(variants).sort(), ['facts-base.json', 'facts-no-source-unprepared.json', 'facts-ploinky-source.json', 'facts-unprepared.json']);
    assert.deepEqual(plan.operationIds, ORIGIN_SEEDS.map((seed) => deriveTargetOperationId({ coordinator: COORDINATOR, originRequestId: originIdFor(seed) })).sort());
    assert.deepEqual(record.fixture.operationIds, plan.operationIds);
    assert.equal(record.fixture.coordinatorPrincipal, COORDINATOR);
    assert.equal(variants['facts-base.json'].excluded.principals.length, 0, 'the front, not the operator, owns the mandatory exclusions');
    assert.equal(Object.hasOwn(variants['facts-base.json'], 'request'), false);
    assert.equal(variants['facts-ploinky-source.json'].sourceState.provider, 'ploinky');
    assert.equal(Object.hasOwn(variants['facts-ploinky-source.json'].sourceState.supplement, 'record'), false);
    assert.ok(plan.labels.live.length > 0 && plan.labels.fixture.length > 0);
    assert.throws(() => buildFixture(liveInput({ originSeeds: [] }), NOW_MS), /originSeeds/);
});

function runNode(script, args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

test('P7 over HTTP: coordinator CLI -> LOCAL Router stand-in -> front listener; an undeclared caller never reaches the front', async (t) => {
    // The stand-in mints with the real clock, so this front and its record use it too.
    const realNow = Date.now();
    const w = world(t, { nowMs: realNow, fixtureNowMs: realNow });
    const server = await serveAdmissionFront(w.front, { port: 0 });
    t.after(() => server.close());
    const router = await startLocalRouter({
        port: 0, providerRoute: 'rwworker', providerPrincipal: WORKER, callers: [COORDINATOR], frontPort: server.address().port, routePort: 7301, secret: w.secret
    });
    t.after(() => router.close());
    const routerUrl = `http://127.0.0.1:${router.address().port}`;
    const cli = path.join(RWCOORD, 'coordinator.mjs');
    const admit = (caller, seed, selection = TARGET) => runNode(cli, ['admit', '--provider', 'rwworker', '--port', '7301', '--selection', selection,
        '--origin-request-id', originIdFor(seed), '--local-router', routerUrl, '--local-caller', caller]);
    const ok = await admit(COORDINATOR, 'success');
    assert.equal(ok.code, 0, ok.stderr);
    const okLine = JSON.parse(ok.stdout);
    assert.equal(okLine.status, 200);
    assert.equal(okLine.answer.ok, true);
    assert.equal(okLine.answer.value.executionsUsed, 1);
    assert.equal(okLine.transport, 'local-stand-in');
    const eventsBefore = w.events.length;
    const rogue = await admit(ROGUE, 'second');
    assert.equal(rogue.code, 3);
    assert.deepEqual(JSON.parse(rogue.stdout).answer, { error: 'COORDINATOR_CALLER_DENIED' });
    assert.equal(w.events.length, eventsBefore, 'the front never saw the undeclared caller');
    const excluded = await admit(COORDINATOR, 'third', WORKER);
    assert.equal(excluded.code, 3);
    assert.equal(JSON.parse(excluded.stdout).answer.code, 'target_excluded');
    assert.equal(w.observe().used, 1);
    // The CLI's derived operation ID is the front's.
    const derived = await runNode(cli, ['operation-id', '--coordinator', COORDINATOR, '--origin-request-id', originIdFor('success')]);
    assert.equal(JSON.parse(derived.stdout).operationId, okLine.answer.value.operationId);
    assert.equal(admissionRequestPath('rwworker', 7301), `/base-agent-additional-server/rwworker/7301${TARGET_ADMISSION_PATH}`);
});

test('P7 front process: refuses to start without the Ploinky worker identity and never prints the secret', async (t) => {
    const base = tempBase(t);
    const front = path.join(RWCOORD, 'front.mjs');
    const args = ['serve', '--port', '0', '--store-root', path.join(base, 'q'), '--facts', path.join(base, 'f.json'), '--state', path.join(base, 's'),
        '--coordinator', COORDINATOR, '--worker-generation', WORKER_IDENTITY.generation];
    const missing = await runNode(front, args);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /worker identity Ploinky provides is unavailable/);
    const secret = crypto.randomBytes(32).toString('hex');
    const child = spawn(process.execPath, [front, ...args], {
        env: { PATH: process.env.PATH, PLOINKY_AGENT_ID: WORKER, PLOINKY_AGENT_INSTANCE_ID: 'i-1', PLOINKY_AGENT_ENABLE_GENERATION: 'g-1', PLOINKY_AGENT_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => child.kill('SIGKILL'));
    const line = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(chunk.toString('utf8'))));
    const event = JSON.parse(line.trim().split('\n')[0]);
    assert.equal(event.event, 'listening');
    assert.equal(event.worker, WORKER);
    assert.equal(line.includes(secret), false);
    child.kill('SIGTERM');
});

test('P7 manifests: one declared coordinator route on a non-provider port, callers exactly the coordinator, image by digest', () => {
    const image = `localhost/rwp7@sha256:${'a'.repeat(64)}`;
    const manifests = renderManifests({ image, repo: 'rwrepo', workerGeneration: WORKER_IDENTITY.generation });
    assert.deepEqual(Object.keys(manifests).sort(), ['rwcoord.manifest.json', 'rwrogue.manifest.json', 'rwworker.manifest.json']);
    const provider = manifests['rwworker.manifest.json'].executionProvider;
    assert.deepEqual(provider.coordinatorRoutes, [{ path: `/base-agent-additional-server/rwworker/7301${TARGET_ADMISSION_PATH}`, callers: [COORDINATOR] }]);
    assert.equal(provider.port, 7300);
    assert.deepEqual(manifests['rwworker.manifest.json'].routerAccess, {
        agentPorts: [7301], httpRoutes: [{ path: `/base-agent-additional-server/rwworker/7301${TARGET_ADMISSION_PATH}`, access: 'authenticated' }]
    });
    assert.match(manifests['rwworker.manifest.json'].start, /front\.mjs serve --port 7301 .*--coordinator agent:rwrepo\/rwcoord --worker-generation /);
    assert.equal(Object.hasOwn(manifests['rwcoord.manifest.json'], 'executionProvider'), false);
    assert.equal(Object.hasOwn(manifests['rwrogue.manifest.json'], 'executionProvider'), false);
    assert.throws(() => renderManifests({ image: 'localhost/rwp7:latest', repo: 'rwrepo', workerGeneration: 'x' }), /digest/);
    assert.throws(() => renderManifests({ image, repo: 'rwrepo', workerGeneration: 'x', frontPort: 7300 }), /provider port/);
});
