import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AGENT_ENV, buildWebchatInvocationArgs, mintWebchatEnvelope, restoreRouterEnvironment } from './helpers/router-webchat.mjs';
import { IPC_DEFAULTS, LiveSessionsIpcServer, loadOwnerVerifier } from '../server/live-sessions/ipc-server.mjs';
import { LiveSessionsRegistry } from '../server/live-sessions/registry.mjs';
import { rowViolation } from '../server/live-sessions/contract.mjs';
import { ipcClient, socketFixture } from './helpers/live-sessions-ipc-client.mjs';
import { LivePublisher } from '../copilot/src/lib/liveSessions/publisher.mjs';
import { webchatSignedArgs } from '../copilot/src/lib/webchat/webchatEnvelope.mjs';
import { createWebchatDispatcher } from '../copilot/src/lib/webchat/webchatRuntime.mjs';

// The copilot publisher end to end: real Router-minted WebChat envelopes, the
// copilot's signed-argument rebuild, a publisher in another process, the real
// IPC server with the production owner verifier, the registry and RoboTeam's
// HTTP routes with Router-signed users.
const { routerFetch, authHeader } = await import('./helpers/router-signed.mjs');
const { startHttpFixture } = await import('./helpers/live-sessions-http-fixture.mjs');
const CHILD = fileURLToPath(new URL('./fixtures/live-publisher-child.mjs', import.meta.url));
const TRANSCRIPT = '/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';

test.after(restoreRouterEnvironment);

async function until(predicate, label, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await delay(10);
    }
}

async function startService(t, { maxPublishers } = {}) {
    const verifyOwner = await loadOwnerVerifier(AGENT_ENV);
    assert.equal(typeof verifyOwner, 'function', 'the production loader resolves the real Agent verifier');
    const { socketPath, cleanup } = await socketFixture();
    const logs = [];
    const registry = new LiveSessionsRegistry({ log: () => {}, urlBase: '/base-agent-additional-server/roboTeamAgent/3001' });
    const transcripts = [];
    const server = new LiveSessionsIpcServer({ registry, verifyOwner, log: (line) => logs.push(line),
        readTranscript: async (sessionId, messageId) => { transcripts.push([sessionId, messageId]); return 'recorded turn'; },
        ...(maxPublishers ? { maxPublishers } : {}) });
    await server.listen(socketPath);
    t.after(async () => { await server.close(); registry.close(); await cleanup(); });
    return { registry, server, socketPath, logs, transcripts };
}

const signedArgsOf = (serialized) => webchatSignedArgs(JSON.parse(serialized));

test('the copilot rebuilds exactly the arguments the Router signed, and their claims verify', async (t) => {
    const { socketPath, registry } = await startService(t);
    const publisher = new LivePublisher({ socketPath });
    t.after(() => publisher.close({ flushMs: 0 }));
    const variants = {
        plain: {},
        hidden: { envelope: { presentation: { visible: false } } },
        references: { envelope: { references: [{ kind: 'workspace-path', path: 'docs/a.md', type: 'file', label: 'A' }, { kind: 'workspace-path', path: 'b.txt' }] } },
        attachments: { envelope: { attachments: [{ id: 'att-1', filename: 'notes.txt', mime: 'text/plain', size: 12, downloadUrl: '/blobs/att-1', localPath: '/tmp/notes.txt' }] } },
        unicode: { envelope: { text: 'Résumé ✓ — multi\nline' } },
        oddTab: { tabId: 'tab.with:odd chars', pageInstanceId: '' },
    };
    for (const [name, options] of Object.entries(variants)) {
        const serialized = mintWebchatEnvelope(options);
        const payload = JSON.parse(serialized);
        assert.deepEqual(signedArgsOf(serialized), buildWebchatInvocationArgs({ effectiveConfig: { agentName: 'roboTeamAgent', runtimeScope: 'principal' },
            tabId: options.tabId ?? 'ls-tab', pageInstanceId: options.pageInstanceId ?? 'ls-page', envelope: payload }), name);
        const owner = publisher.claimOwner(payload.invocation.token, signedArgsOf(serialized));
        const run = publisher.startRun({ kind: 'copilot-turn', title: name, owner });
        await until(() => registry.list({ principal: 'user:x', canAdmin: true }).some((row) => row.title === name), name);
        assert.equal(registry.list({ principal: 'user:x', canAdmin: true }).find((row) => row.title === name).ownerState, 'verified', name);
        run.end({ status: 'finished' });
    }
});

// RoboTeam declares principal runtime scope, so the Router signs runtimeScope into every
// envelope and RoboTeam rebuilds it from its manifest: a principal-minted claim verifies, and an
// envelope minted as a shared-scope Router would mint it stays owner unverified.
test('a shared-minted envelope stays owner unverified, and a principal-minted one verifies', async (t) => {
    const { socketPath, registry } = await startService(t);
    const publisher = new LivePublisher({ socketPath });
    t.after(() => publisher.close({ flushMs: 0 }));
    const shared = mintWebchatEnvelope({ effectiveConfig: { agentName: 'roboTeamAgent' } });
    const sharedRun = publisher.startRun({ kind: 'copilot-turn', title: 'shared', owner: publisher.claimOwner(JSON.parse(shared).invocation.token, signedArgsOf(shared)) });
    const principal = mintWebchatEnvelope({ effectiveConfig: { agentName: 'roboTeamAgent', runtimeScope: 'principal' } });
    const principalRun = publisher.startRun({ kind: 'copilot-turn', title: 'principal', owner: publisher.claimOwner(JSON.parse(principal).invocation.token, signedArgsOf(principal)) });
    await until(() => registry.list({ principal: 'user:x', canAdmin: true }).length === 2, 'the rows');
    const state = (title) => registry.list({ principal: 'user:x', canAdmin: true }).find((row) => row.title === title).ownerState;
    assert.equal(state('shared'), 'unverified');
    assert.equal(state('principal'), 'verified');
    sharedRun.end({ status: 'finished' });
    principalRun.end({ status: 'finished' });
});

test('a publisher in another process lists a verified turn and a delegated task, takes owner messages and stops', async (t) => {
    const { socketPath, registry, transcripts, logs: serviceLogs } = await startService(t);
    const fixture = await startHttpFixture(t, { liveSessions: registry });
    const child = spawn(process.execPath, [CHILD, socketPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const reports = [];
    readline.createInterface({ input: child.stdout }).on('line', (line) => reports.push(JSON.parse(line)));
    const envelope = mintWebchatEnvelope();
    const token = JSON.parse(envelope).invocation.token;
    child.stdin.write(`${JSON.stringify({ op: 'publish', envelope, transcriptUrl: TRANSCRIPT })}\n`);
    await until(() => reports.some((entry) => entry.published), 'the child');
    await until(() => registry.list({ principal: 'user:x', canAdmin: true }).length === 2, 'both rows');

    const list = async (user, roles = ['user']) => {
        const response = await routerFetch(`${fixture.baseUrl}/api/live-sessions`, { headers: { 'x-ploinky-auth-info': authHeader(user, roles) } });
        assert.equal(response.status, 200);
        return (await response.json()).sessions;
    };
    const mine = await list('owner-1');
    assert.equal(mine.length, 2);
    for (const row of mine) assert.equal(rowViolation(row, 'roboTeamAgent'), null, row.kind);
    const turn = mine.find((row) => row.kind === 'copilot-turn');
    const task = mine.find((row) => row.kind === 'copilot-task');
    assert.equal(turn.ownerState, 'verified');
    assert.equal(turn.isOwner, true);
    assert.deepEqual(turn.capabilities, { watch: true, input: false, stop: true, message: true });
    assert.equal(turn.transcriptUrl, `/base-agent-additional-server/roboTeamAgent/3001/api/live-sessions/${turn.id}/transcript`);
    assert.equal(task.ownerState, 'verified', 'the task carries the turn\'s owner proof');
    assert.deepEqual(task.capabilities, { watch: true, input: false, stop: true, message: false }, 'delegated tasks take no messages');
    assert.deepEqual(await list('someone-else'), [], 'a foreign user sees nothing');
    assert.equal((await list('root', ['admin'])).length, 2);

    const post = (user, path, body) => routerFetch(`${fixture.baseUrl}${path}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader(user) }, body: JSON.stringify(body) });
    const delivered = await post('owner-1', `/api/live-sessions/${turn.id}/messages`, { message: 'please also update the changelog' });
    assert.equal(delivered.status, 200);
    assert.deepEqual(await delivered.json(), { delivery: 'delivered' });
    assert.ok(reports.some((entry) => entry.control === 'message' && entry.message === 'please also update the changelog' && entry.requestId));
    const toTask = await post('owner-1', `/api/live-sessions/${task.id}/messages`, { message: 'x' });
    assert.equal(toTask.status, 403, 'no message path to a delegated task');

    const transcript = await routerFetch(`${fixture.baseUrl}/api/live-sessions/${turn.id}/transcript`, { headers: { 'x-ploinky-auth-info': authHeader('owner-1') } });
    assert.equal(transcript.status, 200);
    assert.equal(await transcript.text(), 'recorded turn');
    assert.deepEqual(transcripts, [['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']]);

    assert.equal((await post('owner-1', `/api/live-sessions/${task.id}/stop`, {})).status, 200);
    await until(() => reports.some((entry) => entry.taskControl === 'stop'), 'the task stop');
    assert.equal((await post('owner-1', `/api/live-sessions/${turn.id}/stop`, {})).status, 200);
    await until(() => reports.some((entry) => entry.closed), 'the child close');
    const ended = registry.list({ principal: 'user:x', canAdmin: true });
    assert.deepEqual(ended.map((row) => [row.kind, row.status]).sort(), [['copilot-task', 'stopped'], ['copilot-turn', 'stopped']]);
    assert.equal(await new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', resolve))), 0);
    assert.ok(token.length > 20);
    assert.equal(reports.some((entry) => JSON.stringify(entry).includes(token)), false, 'the token value never reaches publisher output or logs');
    assert.equal(serviceLogs.some((line) => line.includes(token)), false, 'the token value never reaches service logs');
    assert.equal(JSON.stringify(registry.list({ principal: 'user:x', canAdmin: true })).includes(token), false);
});

test('the publisher cap covers every copilot process of a router; the next one is refused and logged', async (t) => {
    assert.equal(IPC_DEFAULTS.maxPublishers, 64);
    const { socketPath, logs } = await startService(t);
    const clients = [];
    t.after(() => Promise.all(clients.map((client) => client.close())));
    for (let index = 0; index < IPC_DEFAULTS.maxPublishers; index += 1) {
        const client = await ipcClient(socketPath);
        clients.push(client);
        assert.equal((await client.hello()).type, 'welcome', `publisher ${index + 1}`);
    }
    const extra = await ipcClient(socketPath);
    clients.push(extra);
    extra.send({ type: 'hello', pid: process.pid });
    assert.deepEqual(await extra.next('hello-refused'), { type: 'hello-refused', reason: 'publisher-limit' });
    await extra.closedPromise;
    assert.ok(logs.some((line) => /publisher limit/u.test(line)), 'the refusal is logged by the service');
});

// Publisher pressure: disconnected incarnations give way to new publishers.
async function pressureService(t, maxPublishers) {
    let now = 1_000_000;
    const clock = { now: () => now, advance: (ms) => { now += ms; } };
    const { socketPath, cleanup } = await socketFixture();
    const logs = [];
    const registry = new LiveSessionsRegistry({ log: () => {}, now: clock.now });
    const server = new LiveSessionsIpcServer({ registry, log: (line) => logs.push(line), now: clock.now, maxPublishers });
    await server.listen(socketPath);
    const clients = [];
    t.after(async () => { await Promise.all(clients.map((client) => client.close())); await server.close(); registry.close(); await cleanup(); });
    const connect = async () => { const client = await ipcClient(socketPath); clients.push(client); return client; };
    const statusOf = (runId) => registry.list({ principal: 'user:root', canAdmin: true }).find((row) => row.id === runId)?.status;
    return { server, registry, logs, clock, connect, statusOf };
}

test('churned disconnected incarnations never block a new publisher; the longest-disconnected one is evicted and lost', async (t) => {
    const { server, logs, clock, connect, statusOf } = await pressureService(t, 3);
    const live = await connect();
    const liveWelcome = await live.hello();
    const kept = await live.start({ localRef: 'kept' });
    const gone = [];
    for (let index = 0; index < 2; index += 1) {
        const client = await connect();
        const welcome = await client.hello();
        const started = await client.start({ localRef: `gone-${index}` });
        await client.close();
        await until(() => statusOf(started.runId) === 'reconnecting', 'reconnecting');
        gone.push({ welcome, runId: started.runId });
        clock.advance(1000);
    }
    // Ten churned processes in a row, all within the 30-second window.
    for (let round = 0; round < 10; round += 1) {
        const next = await connect();
        const welcome = await next.hello();
        assert.equal(welcome.type, 'welcome', `round ${round}`);
        await next.close();
        await until(() => server.publishers.get(welcome.publisherId)?.connection === null, 'disconnect');
        clock.advance(1000);
    }
    assert.equal(server.publishers.size, 3);
    // The first evicted incarnation was the one disconnected longest; its run is lost and its resume rejected.
    assert.equal(statusOf(gone[0].runId), 'lost');
    assert.equal(statusOf(gone[1].runId), 'lost');
    const late = await connect();
    late.send({ type: 'resume', publisherId: gone[0].welcome.publisherId, resumeToken: gone[0].welcome.resumeToken, runs: [] });
    assert.equal((await late.next('resume-rejected')).type, 'resume-rejected');
    // The connected publisher was never touched.
    assert.equal(live.closed, false);
    assert.equal(statusOf(kept.runId), 'running');
    assert.ok(server.publishers.get(liveWelcome.publisherId)?.connection, 'the connected incarnation is still present');
    // One eviction per admitted hello at the bound.
    const evictions = logs.filter((line) => /publisher limit: disconnected publisher \S+ evicted; its runs are lost/u.test(line));
    assert.equal(evictions.length, 10);
    assert.ok(evictions[0].includes(gone[0].welcome.publisherId), 'the longest-disconnected incarnation went first');
    assert.equal(logs.some((line) => line.includes(gone[0].welcome.resumeToken)), false, 'no resume token is logged');
});

test('a new hello is refused only when every incarnation is connected', async (t) => {
    const { server, logs, connect } = await pressureService(t, 2);
    const first = await connect();
    await first.hello();
    const second = await connect();
    await second.hello();
    const third = await connect();
    third.send({ type: 'hello', pid: process.pid });
    assert.deepEqual(await third.next('hello-refused'), { type: 'hello-refused', reason: 'publisher-limit' });
    await third.closedPromise;
    assert.ok(logs.some((line) => /publisher limit, every publisher is connected/u.test(line)));
    assert.equal(first.closed, false);
    assert.equal(second.closed, false);
    assert.equal(server.publishers.size, 2);
    // Once one disconnects, the next publisher is admitted in its place.
    await second.close();
    await until(() => [...server.publishers.values()].some((publisher) => publisher.connection === null), 'the disconnect');
    const fourth = await connect();
    assert.equal((await fourth.hello()).type, 'welcome');
    assert.equal(first.closed, false);
});

test('an owner claim larger than the line limit fails alone; other users on the shared connection stay verified', async (t) => {
    const { socketPath, registry, server, logs } = await startService(t);
    const publisherLogs = [];
    const publisher = new LivePublisher({ socketPath, log: (event, fields) => publisherLogs.push({ event, ...fields }) });
    t.after(() => publisher.close({ flushMs: 0 }));
    const users = { A: 'user-a', B: 'user-b', C: 'user-c' };
    // B's prompt escapes to more than 1 MiB of JSON; A and C are ordinary.
    const texts = { A: 'first prompt', B: '€'.repeat(400000), C: 'third prompt' };
    const runs = {};
    for (const name of ['A', 'B', 'C']) {
        const serialized = mintWebchatEnvelope({ user: { id: users[name], roles: ['user'] }, tabId: `tab-${name}`, envelope: { text: texts[name] } });
        const owner = publisher.claimOwner(JSON.parse(serialized).invocation.token, signedArgsOf(serialized));
        runs[name] = publisher.startRun({ kind: 'copilot-turn', title: `Turn ${name}`, owner });
    }
    await until(() => registry.list({ principal: 'user:x', canAdmin: true }).length === 3, 'three rows');
    const owners = Object.fromEntries(registry.list({ principal: 'user:x', canAdmin: true }).map((row) => [row.title, [row.ownerState, row.ownerLabel]]));
    assert.deepEqual(owners, { 'Turn A': ['verified', 'user-a'], 'Turn B': ['unverified', 'owner unverified'], 'Turn C': ['verified', 'user-c'] });
    assert.equal(server.connections.size, 1, 'the shared connection was never dropped');
    assert.equal(logs.some((line) => /line limit/u.test(line)), false);
    const tooLarge = publisherLogs.filter((entry) => entry.event === 'live.claim.too-large');
    assert.equal(tooLarge.length, 1);
    assert.equal(JSON.stringify(tooLarge).includes('€'), false, 'logged without content');
    for (const run of Object.values(runs)) run.end({ status: 'finished' });
});

test('two users\' WebChat messages through one dispatcher and one publisher are each verified as their own principal', async (t) => {
    const { socketPath, registry } = await startService(t);
    const publisher = new LivePublisher({ socketPath });
    t.after(() => publisher.close({ flushMs: 0 }));
    const workingDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ls-dispatch-')));
    t.after(() => fs.rm(workingDir, { recursive: true, force: true }));
    const session = { sessionId: '00000000-0000-4000-8000-0000000000cc', messages: [], createdAt: 't', updatedAt: 't' };
    const runtime = { workingDir, livePublisher: publisher,
        sessionStore: { ensureCurrentSession: async () => session, loadSession: () => session },
        // A stand-in engine that publishes each turn with the claim the dispatcher captured.
        engine: { getModel: async () => ({ backend: 'codex', model: null }), executeTurn: async ({ context }) => {
            const run = publisher.startRun({ kind: 'copilot-turn', title: `Turn from ${context.rawText}`, owner: context.liveOwner });
            run.end({ status: 'finished' });
            return { outputText: 'ok' };
        } },
        historyManager: { add: async () => {} }, skillCatalog: { getSkills: () => [] }, settings: {} };
    const dispatcher = createWebchatDispatcher(runtime, { write: () => {} });
    t.after(() => dispatcher.cancel());
    dispatcher.receive(mintWebchatEnvelope({ user: { id: 'alice', roles: ['user'] }, tabId: 'tab-alice', envelope: { text: 'alice' } }));
    dispatcher.receive(mintWebchatEnvelope({ user: { id: 'bob', roles: ['user'] }, tabId: 'tab-bob', envelope: { text: 'bob' } }));
    await dispatcher.drain();
    await until(() => registry.list({ principal: 'user:x', canAdmin: true }).filter((row) => row.status === 'finished').length === 2, 'both runs');
    const titles = (principal) => registry.list({ principal, canAdmin: false }).map((row) => [row.title, row.ownerState, row.isOwner]);
    assert.deepEqual(titles('user:alice'), [['Turn from alice', 'verified', true]]);
    assert.deepEqual(titles('user:bob'), [['Turn from bob', 'verified', true]]);
});
