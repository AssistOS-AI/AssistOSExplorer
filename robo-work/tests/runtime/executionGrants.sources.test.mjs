import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    SOURCE_ACTIVATED, createRuntimeSourceProvider, createSourceWatch, defaultRuntimeSourcesFetch, resolveExecutionGrants
} from '../../server/runtime/executionGrants.mjs';
import { ExecutionSetupError } from '../../server/runtime/setupError.mjs';
import { resolveGrant } from '../../server/views/grantResolver.mjs';

// M-63: an active runtime source is never a writable robot grant; read-only views of it stay permitted; the list is asked for once per
// launch that has a writable grant, and its absence fails writable work closed. The REAL provider (with an injected fetch), the REAL
// resolveExecutionGrants and the REAL anchored resolver run on a real temporary tree.

const GENERATION = `sha256:${'a'.repeat(64)}`;
const ACTIVATION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const envelope = (sources, extra = {}) => ({ schemaVersion: 1, authorizationGeneration: GENERATION, activationId: ACTIVATION, sources, outsideWorkspace: 0, ...extra });
const openFdCount = () => fs.readdirSync('/dev/fd').length;

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-sources-')));
    const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-sources-store-')));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(store, { recursive: true, force: true }); });
    for (const directory of ['AchillesIDE/roboTeamAgent/copilot/src/skills/x', 'proj/sub', 'group/ploinky/cli', 'X/sub', '.ploinky/repos', 'ala/bin', 'plain']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'AchillesIDE/roboTeamAgent/copilot/src/skills/x/SKILL.md'), '---\nname: x\n---\n');
    // A managed-repository spelling of a workspace checkout: `.ploinky/repos/X` is a symlink to `<ws>/X`.
    fs.symlinkSync(path.join(root, 'X'), path.join(root, '.ploinky/repos/X'));
    return { root, store };
}

// The real provider over a counting fetch that returns the given answers in turn (a function answer is called).
function provider(root, answers, { localRoots = [], timeoutMs } = {}) {
    const queue = Array.isArray(answers) ? [...answers] : null;
    const counter = { fetches: 0 };
    const fetch = async () => {
        counter.fetches += 1;
        const next = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : answers;
        return typeof next === 'function' ? next() : next;
    };
    return { sourceProvider: createRuntimeSourceProvider({ workspaceRoot: root, localRoots, fetch, ...(timeoutMs ? { timeoutMs } : {}) }), counter };
}

// The real resolver, counted.
function countingResolve() {
    const counter = { calls: 0 };
    return { counter, resolve: async (request, context) => { counter.calls += 1; return resolveGrant(request, context); } };
}

async function outcome(promise) {
    try {
        const grants = await promise;
        const result = grants.map((grant) => grant.access);
        for (const grant of grants) await grant.close();
        return { ok: true, access: result };
    } catch (error) {
        assert.ok(error instanceof ExecutionSetupError, `an ExecutionSetupError, not ${error?.name}: ${error?.message}`);
        return { ok: false, reason: error.reason };
    }
}

const write = (relativePath) => ({ relativePath, access: 'write' });
const read = (relativePath) => ({ relativePath, access: 'read' });
const AGENT_REPO = { kind: 'agent-repository', relativePath: 'AchillesIDE' };
const SKILL = 'AchillesIDE/roboTeamAgent/copilot/src/skills/x';

test('AC1: a write grant on a workspace-origin agent checkout is refused grant_inside_active_source, with no descriptor left open', async (t) => {
    const { root, store } = workspace(t);
    const { sourceProvider, counter } = provider(root, envelope([AGENT_REPO]));
    const before = openFdCount();
    const result = await outcome(resolveExecutionGrants([write('AchillesIDE/roboTeamAgent')], { workspaceRoot: root, workerStore: store, sourceProvider }));
    assert.deepEqual(result, { ok: false, reason: 'grant_inside_active_source' });
    assert.equal(openFdCount(), before, 'the refusal closed everything');
    assert.equal(counter.fetches, 1, 'one fetch for the launch');
});

test('AC2: a read-only skill view on the same checkout resolves with 0 fetches; a mixed plan (write proj, read the skill) resolves both with 1 fetch', async (t) => {
    const { root, store } = workspace(t);
    const only = provider(root, envelope([AGENT_REPO]));
    assert.deepEqual(await outcome(resolveExecutionGrants([read(SKILL)], { workspaceRoot: root, workerStore: store, sourceProvider: only.sourceProvider })), { ok: true, access: ['read'] });
    assert.equal(only.counter.fetches, 0, 'a read-only launch never asks for the list');
    const mixed = provider(root, envelope([AGENT_REPO]));
    assert.deepEqual(await outcome(resolveExecutionGrants([write('proj'), read(SKILL)], { workspaceRoot: root, workerStore: store, sourceProvider: mixed.sourceProvider })),
        { ok: true, access: ['write', 'read'] });
    assert.equal(mixed.counter.fetches, 1);
    // A read-only view of the checkout ROOT is a read too.
    assert.deepEqual(await outcome(resolveExecutionGrants([write('proj'), read('AchillesIDE')], { workspaceRoot: root, workerStore: store, sourceProvider: mixed.sourceProvider })),
        { ok: true, access: ['write', 'read'] });
});

test('AC3: inside, contains and a real symlink alias are refused for writable working projects; the worker\'s ALA is a source too', async (t) => {
    const { root, store } = workspace(t);
    const run = async (entries, sources, options = {}) => outcome(resolveExecutionGrants(entries, {
        workspaceRoot: root, workerStore: store, sourceProvider: provider(root, envelope(sources), options).sourceProvider
    }));
    assert.deepEqual(await run([write('AchillesIDE')], [AGENT_REPO]), { ok: false, reason: 'grant_inside_active_source' });
    assert.deepEqual(await run([write('group')], [{ kind: 'agent-library', relativePath: 'group/ploinky' }]), { ok: false, reason: 'grant_contains_active_source' });
    assert.deepEqual(await run([write('group/ploinky/cli')], [{ kind: 'agent-library', relativePath: 'group/ploinky' }]), { ok: false, reason: 'grant_inside_active_source' });
    // The source is reported under its managed spelling `.ploinky/repos/X`, a symlink to `<ws>/X`: the real resolver still sees the grant
    // `X/sub` inside it.
    assert.deepEqual(await run([write('X/sub')], [{ kind: 'linked-repository', relativePath: '.ploinky/repos/X' }]), { ok: false, reason: 'grant_inside_active_source' });
    assert.deepEqual(await run([write('X')], [{ kind: 'linked-repository', relativePath: '.ploinky/repos/X' }]), { ok: false, reason: 'grant_inside_active_source' });
    assert.deepEqual(await run([write('ala')], [], { localRoots: [path.join(root, 'ala')] }), { ok: false, reason: 'grant_inside_active_source' });
    // Siblings and unrelated folders stay writable.
    assert.deepEqual(await run([write('proj/sub'), write('plain')], [AGENT_REPO, { kind: 'agent-library', relativePath: 'group/ploinky' }]), { ok: true, access: ['write', 'write'] });
});

test('AC4: an unavailable list fails writable work closed before any grant is resolved; no-grant and read-only plans still resolve', async (t) => {
    const { root, store } = workspace(t);
    const failures = {
        throws: () => { throw Object.assign(new Error('router down'), { code: 'RUNTIME_SOURCES_UNAVAILABLE' }); },
        malformed: { sources: 'AchillesIDE' },
        timeout: () => new Promise(() => {})
    };
    for (const [label, answer] of Object.entries(failures)) {
        const { sourceProvider, counter } = provider(root, answer, { timeoutMs: 50 });
        const { resolve, counter: resolves } = countingResolve();
        const before = openFdCount();
        assert.deepEqual(await outcome(resolveExecutionGrants([read(SKILL), write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider, resolve })),
            { ok: false, reason: 'runtime_sources_unavailable' }, label);
        assert.equal(resolves.calls, 0, `${label}: no grant resolved`);
        assert.equal(counter.fetches, 1, label);
        assert.equal(openFdCount(), before, label);
        assert.deepEqual(await outcome(resolveExecutionGrants([], { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: true, access: [] }, `${label}: no grant`);
        assert.deepEqual(await outcome(resolveExecutionGrants([read(SKILL), read('proj')], { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: true, access: ['read', 'read'] }, `${label}: read-only`);
        assert.equal(counter.fetches, 1, `${label}: the other plans never asked`);
    }
    // No provider at all, a provider that throws itself and an unreadable workspace root are the same refusal.
    assert.deepEqual(await outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider: null })), { ok: false, reason: 'runtime_sources_unavailable' });
    assert.deepEqual(await outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider: { locations: async () => { throw new Error('x'); } } })), { ok: false, reason: 'runtime_sources_unavailable' });
    const gone = createRuntimeSourceProvider({ workspaceRoot: path.join(root, 'missing'), fetch: async () => envelope([]) });
    assert.deepEqual(await gone.locations(), { ok: false, code: 'runtime_sources_unavailable', cause: 'ENOENT' });
});

test('probe: invalid answers (empty, traversal, absolute, too long, NUL, unknown kind, bad generation) are unavailable, not partial lists', async (t) => {
    const { root, store } = workspace(t);
    const bad = [
        envelope([{ kind: 'agent-repository', relativePath: '' }]),
        envelope([{ kind: 'agent-repository', relativePath: '..' }]),
        envelope([{ kind: 'agent-repository', relativePath: 'a/../b' }]),
        envelope([{ kind: 'agent-repository', relativePath: './a' }]),
        envelope([{ kind: 'agent-repository', relativePath: '/abs' }]),
        envelope([{ kind: 'agent-repository', relativePath: 'a'.repeat(4097) }]),
        envelope([{ kind: 'agent-repository', relativePath: 'a\0b' }]),
        envelope([{ kind: 'mystery', relativePath: 'AchillesIDE' }]),
        envelope([AGENT_REPO], { authorizationGeneration: 7 }),
        envelope([AGENT_REPO], { outsideWorkspace: -1 }),
        envelope(Array.from({ length: 513 }, (_, index) => ({ kind: 'agent-repository', relativePath: `r${index}` }))),
        null, [], 'text'
    ];
    for (const [index, answer] of bad.entries()) {
        const { sourceProvider } = provider(root, answer);
        assert.deepEqual(await outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: false, reason: 'runtime_sources_unavailable' }, `answer ${index}`);
    }
});

test('probe: an empty list (nothing active) allows writable grants after one fetch', async (t) => {
    const { root, store } = workspace(t);
    const { sourceProvider, counter } = provider(root, envelope([]));
    assert.deepEqual(await outcome(resolveExecutionGrants([write('AchillesIDE/roboTeamAgent')], { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: true, access: ['write'] });
    assert.equal(counter.fetches, 1);
});

test('probe: no cache: the same task launched twice, with the source enabled between the launches, is admitted then refused', async (t) => {
    const { root, store } = workspace(t);
    const { sourceProvider, counter } = provider(root, [envelope([]), envelope([AGENT_REPO])]);
    const entries = [write('AchillesIDE/roboTeamAgent')];
    assert.deepEqual(await outcome(resolveExecutionGrants(entries, { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: true, access: ['write'] });
    assert.deepEqual(await outcome(resolveExecutionGrants(entries, { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: false, reason: 'grant_inside_active_source' });
    assert.equal(counter.fetches, 2);
});

test('probe: a source not yet cloned is still reported lexically, and a grant containing its future place is refused', async (t) => {
    const { root, store } = workspace(t);
    const { sourceProvider } = provider(root, envelope([{ kind: 'linked-repository', relativePath: 'plain/DocumentationSkills' }]));
    assert.deepEqual(await outcome(resolveExecutionGrants([write('plain')], { workspaceRoot: root, workerStore: store, sourceProvider })), { ok: false, reason: 'grant_contains_active_source' });
});

test('a refusal after earlier grants closes the grants already opened; the worker store stays refused for reads and writes', async (t) => {
    const { root, store } = workspace(t);
    const { sourceProvider } = provider(root, envelope([AGENT_REPO]));
    const before = openFdCount();
    assert.deepEqual(await outcome(resolveExecutionGrants([write('proj'), read('plain'), write('AchillesIDE/roboTeamAgent')], { workspaceRoot: root, workerStore: store, sourceProvider })),
        { ok: false, reason: 'grant_inside_active_source' });
    assert.equal(openFdCount(), before);
    // The worker store inside the workspace: refused whatever the access mode.
    fs.mkdirSync(path.join(root, 'plain/store'), { recursive: true });
    for (const entry of [read('plain/store'), write('plain/store'), read('plain')]) {
        const result = await outcome(resolveExecutionGrants([entry], { workspaceRoot: root, workerStore: path.join(root, 'plain/store'), sourceProvider }));
        assert.equal(result.ok, false, JSON.stringify(entry));
        assert.match(result.reason, /^grant_(inside|contains)_protected_location$/u);
    }
});

test('the launch logs the fetch with the authorization generation and counts by kind (never a path); a failure logs its cause', async (t) => {
    const { root, store } = workspace(t);
    const logs = [];
    const log = (event, data) => logs.push([event, data]);
    const { sourceProvider } = provider(root, envelope([AGENT_REPO, { kind: 'linked-repository', relativePath: 'DocumentationSkills' }], { outsideWorkspace: 2 }), { localRoots: [path.join(root, 'ala')] });
    await outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider, log }));
    assert.deepEqual(logs, [['runtime_sources_fetched', {
        purpose: 'launch', authorizationGeneration: GENERATION, outsideWorkspace: 2, localRoots: 1,
        sources: { 'agent-repository': 1, 'agent-library': 0, 'agent-runtime-library': 0, 'linked-repository': 1 }
    }]]);
    assert.ok(!JSON.stringify(logs).includes(root), 'no host path in the log');
    logs.length = 0;
    await outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider: provider(root, { bad: true }).sourceProvider, log }));
    assert.deepEqual(logs, [['runtime_sources_unavailable', { purpose: 'launch', cause: 'invalid_answer' }]]);
});

test('the default fetch loads lib/runtimeSources.mjs from ROBO_WORK_PLOINKY_AGENT_DIR lazily and passes the environment; a missing reader is unavailable', async (t) => {
    const { root } = workspace(t);
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-agent-dir-'));
    t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(agentDir, 'lib'));
    fs.writeFileSync(path.join(agentDir, 'lib', 'runtimeSources.mjs'),
        `export async function fetchRuntimeSources({ env }) { return { schemaVersion: 1, authorizationGeneration: 'sha256:${'b'.repeat(64)}', activationId: '${ACTIVATION}', sources: [{ kind: 'agent-library', relativePath: env.MARK }], outsideWorkspace: 0 }; }\n`);
    const env = { ROBO_WORK_PLOINKY_AGENT_DIR: agentDir, MARK: 'ploinky' };
    const answer = await createRuntimeSourceProvider({ workspaceRoot: root, fetch: defaultRuntimeSourcesFetch({ env }) }).locations();
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.locations, [{ label: 'active source (agent-library)', path: path.join(root, 'ploinky') }]);
    const missing = await createRuntimeSourceProvider({ workspaceRoot: root, fetch: defaultRuntimeSourcesFetch({ env: { ROBO_WORK_PLOINKY_AGENT_DIR: path.join(agentDir, 'nope') } }) }).locations();
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'runtime_sources_unavailable');
});

test('probe: 8 parallel launches on one provider whose answers alternate with failures: one fetch each, no write grant without a successful fetch', async (t) => {
    const { root, store } = workspace(t);
    let call = 0;
    const { sourceProvider, counter } = provider(root, () => {
        call += 1;
        if (call % 2 === 0) throw Object.assign(new Error('edge generation changed twice'), { code: 'RUNTIME_SOURCES_UNAVAILABLE' });
        return envelope([AGENT_REPO]);
    });
    const { resolve, counter: resolves } = countingResolve();
    const before = openFdCount();
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(resolveExecutionGrants([write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider, resolve }))));
    assert.equal(counter.fetches, 8, 'one fetch per launch');
    const refused = results.filter((result) => !result.ok);
    const opened = results.filter((result) => result.ok);
    assert.equal(refused.length, 4);
    assert.ok(refused.every((result) => result.reason === 'runtime_sources_unavailable'));
    assert.ok(opened.every((result) => result.access.length === 1 && result.access[0] === 'write'));
    assert.equal(resolves.calls, 4, 'a grant is resolved only after a successful fetch');
    assert.equal(openFdCount(), before, 'everything opened was closed');
    // The one retry on edge_generation_changed belongs to Ploinky's reader (its own tests, AC9); the worker never retries.
});

// --- the recheck (decision M-67 Q2) ------------------------------------------------------------------------------------------

function fakeTimers() {
    const intervals = new Map();
    let next = 1;
    return {
        timers: {
            setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return { id, unref() {} }; },
            clearInterval: (handle) => { intervals.delete(handle?.id); }
        },
        intervals,
        fire: async () => { for (const { fn } of [...intervals.values()]) fn(); await new Promise((resolve) => setImmediate(resolve)); }
    };
}

test('M-67 Q2: the recheck runs one shared timer only while a writable attempt is registered; an overlap ends that attempt once', async (t) => {
    const { root, store } = workspace(t);
    const answers = [envelope([]), envelope([AGENT_REPO])];
    const { sourceProvider, counter } = provider(root, answers);
    const clock = fakeTimers();
    const logs = [];
    const watch = createSourceWatch({ provider: sourceProvider, tickMs: 60000, timers: clock.timers, log: (event, data) => logs.push([event, data]) });
    // Grants admitted while nothing was active (empty list at launch).
    const launch = provider(root, envelope([])).sourceProvider;
    const [inside, other] = await resolveExecutionGrants([write('AchillesIDE/roboTeamAgent'), write('proj')], { workspaceRoot: root, workerStore: store, sourceProvider: launch });
    const [readOnly] = await resolveExecutionGrants([read(SKILL)], { workspaceRoot: root, workerStore: store, sourceProvider: launch });
    t.after(async () => { for (const grant of [inside, other, readOnly]) await grant.close(); });

    // A read-only attempt is never registered: no timer, no fetch.
    const noop = watch.register({ executionId: 'R', grants: [readOnly], onOverlap: () => assert.fail('read-only attempts are never revoked') });
    assert.equal(clock.intervals.size, 0);
    noop();
    await watch.tick();
    assert.equal(counter.fetches, 0, 'no tick work without a writable attempt');

    const revoked = [];
    const unregisterA = watch.register({ executionId: 'A', grants: [inside, readOnly], onOverlap: (reason) => revoked.push(['A', reason]) });
    const unregisterB = watch.register({ executionId: 'B', grants: [other], onOverlap: (reason) => revoked.push(['B', reason]) });
    assert.equal(clock.intervals.size, 1, 'ONE shared timer for the worker');
    assert.equal([...clock.intervals.values()][0].ms, 60000);
    await clock.fire();
    await watch.tick(); // the tick the timer started is shared, not repeated
    assert.deepEqual(revoked, [], 'nothing active yet');
    assert.equal(counter.fetches, 1, 'one fetch per tick, whatever the number of attempts');
    await watch.tick();
    assert.deepEqual(revoked, [['A', SOURCE_ACTIVATED]], 'the overlapping attempt is revoked, the other is not');
    await watch.tick();
    assert.deepEqual(revoked, [['A', SOURCE_ACTIVATED]], 'revoked at most once');
    assert.deepEqual(logs.filter(([event]) => event === 'source_activated'), [['source_activated', { executionId: 'A', code: 'inside_active_source' }]]);
    unregisterA();
    unregisterB();
    assert.equal(clock.intervals.size, 0, 'the timer stops with the last writable attempt');
});

test('M-67 Q2: a failing recheck does nothing and is logged once per state change; an attempt that ended during the fetch is not revoked', async (t) => {
    const { root, store } = workspace(t);
    let mode = 'fail';
    let release = null;
    const { sourceProvider, counter } = provider(root, () => {
        if (mode === 'fail') throw new Error('router down');
        if (mode === 'slow') return new Promise((resolve) => { release = () => resolve(envelope([AGENT_REPO])); });
        return envelope([AGENT_REPO]);
    });
    const clock = fakeTimers();
    const logs = [];
    const watch = createSourceWatch({ provider: sourceProvider, tickMs: 60000, timers: clock.timers, log: (event, data) => logs.push([event, data]) });
    const [grant] = await resolveExecutionGrants([write('AchillesIDE/roboTeamAgent')], { workspaceRoot: root, workerStore: store, sourceProvider: provider(root, envelope([])).sourceProvider });
    t.after(() => grant.close());
    const revoked = [];
    const unregister = watch.register({ executionId: 'A', grants: [grant], onOverlap: (reason) => revoked.push(reason) });
    await watch.tick();
    await watch.tick();
    await watch.tick();
    assert.deepEqual(revoked, [], 'a failure takes no action');
    assert.equal(counter.fetches, 3);
    assert.equal(logs.filter(([event]) => event === 'runtime_sources_recheck_unavailable').length, 1, 'logged once per state change');
    // In flight: a second tick while the first fetch is pending is skipped; the attempt ends before the answer arrives.
    mode = 'slow';
    const first = watch.tick();
    while (release === null) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watch.tick(), first, 'a tick that comes while the previous fetch is pending shares it');
    assert.equal(counter.fetches, 4, 'no second fetch');
    unregister();
    release();
    await first;
    assert.deepEqual(revoked, [], 'an attempt that ended during the fetch is not revoked');
    assert.equal(clock.intervals.size, 0);
});
