import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { IPC_SOCKET_PATH, LiveSessionsIpcServer } from '../../server/live-sessions/ipc-server.mjs';
import { LiveSessionsRegistry } from '../../server/live-sessions/registry.mjs';
import { socketFixture } from '../../tests/helpers/live-sessions-ipc-client.mjs';
import { LIVE_SOCKET_PATH, LivePublisher, createCopilotPublisher, splitOutput } from '../src/lib/liveSessions/publisher.mjs';

// The copilot publisher against the real RoboTeam IPC server and registry.
// Owner verification is a deterministic stand-in here; the Router-token path
// is covered end to end by roboTeamAgent/tests/live-sessions-publisher.test.mjs.
const ADMIN = { principal: 'user:root', canAdmin: true };

function fakeVerifier(token) {
    const match = /^valid:(.+)$/u.exec(token);
    return match ? { ok: true, payload: { sub: `user:${match[1]}`, actor: { kind: 'user', id: `user:${match[1]}`, roles: ['user'] } } } : { ok: false };
}

async function until(predicate, label, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await delay(10);
    }
}

async function startServer(t, options = {}, fixture = null) {
    const own = fixture || await socketFixture();
    const logs = [];
    const registry = new LiveSessionsRegistry({ log: (line) => logs.push(line) });
    const server = new LiveSessionsIpcServer({ registry, verifyOwner: fakeVerifier, log: (line) => logs.push(line), ...options });
    await server.listen(own.socketPath);
    let closed = false;
    const stop = async () => { if (!closed) { closed = true; await server.close(); registry.close(); } };
    t.after(async () => { await stop(); if (!fixture) await own.cleanup(); });
    return { server, registry, logs, socketPath: own.socketPath, fixture: own, stop };
}

// One socket path for services that start late or restart; the path is
// removed only after every service on it closed.
async function sharedSocket(t) {
    const fixture = await socketFixture();
    const servers = [];
    t.after(async () => { for (const server of servers) await server.stop(); await fixture.cleanup(); });
    return { fixture, socketPath: fixture.socketPath,
        start: async (options = {}) => { const server = await startServer(t, options, fixture); servers.push(server); return server; } };
}

function publisherFor(t, socketPath, options = {}) {
    const logs = [];
    const publisher = new LivePublisher({ socketPath, log: (event, fields) => logs.push({ event, ...fields }), backoffMinMs: 20, backoffMaxMs: 100, ...options });
    t.after(() => publisher.close({ flushMs: 0 }));
    return { publisher, logs };
}

const rows = (registry) => registry.list(ADMIN);
const rowOf = (registry, kind = 'copilot-turn') => rows(registry).find((row) => row.kind === kind);

function outputOf(registry, id) {
    return registry.runs.get(id).ring.map((entry) => JSON.parse(entry.frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)));
}
const textOf = (registry, id) => outputOf(registry, id).map((frame) => frame.text).join('');

test('the publisher targets the service socket and is enabled only by the copilot switch', () => {
    assert.equal(LIVE_SOCKET_PATH, IPC_SOCKET_PATH);
    for (const value of [undefined, '', '1', 'true', 'COPILOT', 'robot-task']) {
        assert.equal(createCopilotPublisher(value === undefined ? {} : { ROBOTEAM_LIVE_PUBLISH: value }), null, String(value));
    }
    assert.ok(createCopilotPublisher({ ROBOTEAM_LIVE_PUBLISH: 'copilot' }) instanceof LivePublisher);
});

test('an enabled publisher makes no connection until it has something to publish', async (t) => {
    const connects = [];
    const { socketPath, registry } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath, { connect: (target) => { connects.push(target); return net.connect(target); } });
    await delay(50);
    assert.equal(connects.length, 0);
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Turn', cwd: '/w', robot: 'default' });
    await until(() => rowOf(registry), 'the run row');
    assert.deepEqual(connects, [socketPath]);
    run.end({ status: 'finished', code: 0 });
    await until(() => rowOf(registry)?.status === 'finished', 'the run end');
});

test('a claimed owner, output and end reach the registry; the owner sees a verified row', async (t) => {
    const { socketPath, registry } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const owner = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Copilot · hello', cwd: '/w', robot: 'default', owner,
        transcriptUrl: '/base-agent-additional-server/roboTeamAgent/3001/webchat-logs/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002' });
    run.output('first ', 'assistant');
    run.output('second\n', 'assistant');
    run.status('Starting ALA');
    await until(() => rowOf(registry) && textOf(registry, rowOf(registry).id).includes('Starting ALA'), 'output');
    const [mine] = registry.list({ principal: 'user:alice', canAdmin: false });
    assert.equal(mine.ownerState, 'verified');
    assert.equal(mine.isOwner, true);
    assert.equal(mine.title, 'Copilot · hello');
    assert.deepEqual(registry.list({ principal: 'user:bob', canAdmin: false }), []);
    assert.deepEqual(outputOf(registry, mine.id), [
        { text: 'first ', style: 'assistant' }, { text: 'second\n', style: 'assistant' }, { text: 'Starting ALA\n', style: 'status' }]);
    run.end({ status: 'failed', code: 7, reason: 'Native provider failed.\nsecond line' });
    await until(() => rowOf(registry)?.status === 'failed', 'the failed end');
    assert.deepEqual(rowOf(registry).exit, { reason: 'Native provider failed.', code: 7 });
});

test('a turn without a proved owner publishes as owner unverified', async (t) => {
    const { socketPath, registry } = await startServer(t);
    const { publisher, logs } = publisherFor(t, socketPath);
    const owner = publisher.claimOwner('forged', { surface: 'webchat' });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Turn', owner });
    await until(() => rowOf(registry), 'the row');
    assert.equal(rowOf(registry).ownerState, 'unverified');
    assert.ok(logs.some((entry) => entry.event === 'live.claim.rejected'));
    assert.equal(JSON.stringify(logs).includes('forged'), false, 'the token is never logged');
    run.end({ status: 'finished' });
});

test('publishing never blocks: with no service every call returns at once and nothing is listed', async (t) => {
    const { root, socketPath, cleanup } = await socketFixture();
    t.after(cleanup);
    const { publisher, logs } = publisherFor(t, socketPath);
    const started = performance.now();
    const owner = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Turn', owner });
    for (let index = 0; index < 1000; index += 1) run.output('x'.repeat(1024), 'output');
    run.end({ status: 'finished' });
    publisher.releaseOwner(owner);
    assert.ok(performance.now() - started < 500, 'synchronous calls');
    await delay(100);
    assert.equal(logs.filter((entry) => entry.event === 'live.connect.failed').length, 1, 'one record per failure streak');
    assert.deepEqual(publisher.snapshot().runs, [], 'a run that never reached the service is dropped at its end');
    assert.equal(publisher.snapshot().outputBytes, 0);
    assert.ok(root);
});

test('output is bounded and drops its oldest events; the lifecycle queue is never dropped', async (t) => {
    const shared = await sharedSocket(t);
    const { publisher } = publisherFor(t, shared.socketPath, { outputBytes: 64 });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Bounded' });
    for (let index = 1; index <= 20; index += 1) run.output(`event-${String(index).padStart(2, '0')}\n`);
    const snapshot = publisher.snapshot();
    assert.ok(snapshot.outputBytes <= 64, `output bytes ${snapshot.outputBytes}`);
    assert.equal(snapshot.runs.length, 1, 'the run start stays queued');
    // The service comes up late: the start, the newest events and a gap marker arrive.
    const { registry } = await shared.start();
    await until(() => rowOf(registry) && textOf(registry, rowOf(registry).id).includes('event-20'), 'the newest output');
    const text = textOf(registry, rowOf(registry).id);
    assert.match(text, /\[1[0-9] output event\(s\) were lost\]/u);
    assert.equal(text.includes('event-01'), false, 'the oldest event was dropped');
    run.end({ status: 'finished' });
    await until(() => rowOf(registry)?.status === 'finished', 'the end');
});

test('a chunk larger than one frame is split below the line limit and arrives whole', async (t) => {
    assert.deepEqual(splitOutput('abcdef', 4), ['abcd', 'ef']);
    assert.deepEqual(splitOutput('ab😀cd', 3), ['ab', '😀c', 'd'], 'never inside a surrogate pair');
    const { socketPath, registry, logs, server } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Large' });
    // JSON escaping makes each control character six bytes: one unsplit frame
    // would exceed the 1 MiB line limit and close the connection.
    const large = '\u0001'.repeat(200 * 1024);
    run.output(large);
    run.end({ status: 'finished' });
    await until(() => rowOf(registry)?.status === 'finished', 'the end');
    // The registry ring (1 MiB of escaped frames) keeps the newest frames.
    const received = textOf(registry, rowOf(registry).id);
    assert.ok(received.length >= 5 * 32 * 1024, `received ${received.length}`);
    assert.equal(received, large.slice(-received.length));
    assert.equal(logs.some((line) => /line limit/u.test(line)), false, 'the connection was never closed for its line size');
    assert.equal(server.connections.size, 1);
});

test('a reconnect resumes the same incarnation, resends what was missed and delivers an outage end', async (t) => {
    const { socketPath, registry, server } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Resumed' });
    run.output('before\n');
    await until(() => rowOf(registry) && textOf(registry, rowOf(registry).id).includes('before'), 'first output');
    const id = rowOf(registry).id;
    const publishers = [...server.publishers.keys()];
    for (const connection of server.connections) connection.socket.destroy();
    await until(() => rowOf(registry).status === 'reconnecting' || rowOf(registry).status === 'running', 'disconnect');
    run.output('during\n');
    run.end({ status: 'finished', code: 0 });
    await until(() => rowOf(registry).status === 'finished', 'the end after resume');
    assert.deepEqual([...server.publishers.keys()], publishers, 'the same incarnation resumed');
    assert.equal(rows(registry).length, 1, 'no duplicate row');
    assert.equal(rowOf(registry).id, id);
    assert.equal(textOf(registry, id), 'before\nduring\n');
});

test('after a service restart old runs are not announced again and old owner proofs give unverified runs', async (t) => {
    const shared = await sharedSocket(t);
    const first = await shared.start();
    const { publisher, logs } = publisherFor(t, shared.socketPath);
    const owner = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const old = publisher.startRun({ kind: 'copilot-turn', title: 'Old', owner });
    await until(() => rowOf(first.registry)?.ownerState === 'verified', 'the verified row');
    await first.stop();
    const second = await shared.start();
    old.output('lost with its incarnation\n');
    // A later run of the same claim cannot prove its owner to the new service.
    const later = publisher.startRun({ kind: 'copilot-task', title: 'Later', owner });
    await until(() => rowOf(second.registry, 'copilot-task'), 'the new row');
    assert.ok(logs.some((entry) => entry.event === 'live.resume.rejected'));
    assert.equal(rowOf(second.registry, 'copilot-turn'), undefined, 'the old run is not announced again');
    assert.equal(rowOf(second.registry, 'copilot-task').ownerState, 'unverified');
    old.end({ status: 'finished' });
    later.end({ status: 'finished' });
    await until(() => rowOf(second.registry, 'copilot-task').status === 'finished', 'the end');
    assert.equal(rows(second.registry).length, 1);
});

test('an unused claim is released; a claim used by a run is kept by the service until its last run ends', async (t) => {
    const { socketPath, server } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const handles = () => [...server.publishers.values()].flatMap((entry) => [...entry.handles.values()]);
    const unused = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    await until(() => handles().length === 1, 'the handle');
    publisher.releaseOwner(unused);
    await until(() => handles().length === 0, 'the release');
    const used = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Used', owner: used });
    await until(() => handles().some((handle) => handle.used), 'the used handle');
    publisher.releaseOwner(used);
    await delay(50);
    assert.equal(handles().length, 1, 'a used claim is not released by the publisher');
    run.end({ status: 'finished' });
    await until(() => handles().length === 0, 'the service drops the handle with its last run');
    // A release before the claim was even sent never reaches the service.
    const fixture = await socketFixture();
    t.after(fixture.cleanup);
    const idle = publisherFor(t, fixture.socketPath).publisher;
    idle.releaseOwner(idle.claimOwner('valid:alice', { surface: 'webchat' }));
    assert.deepEqual(idle.snapshot().claims, []);
});

test('controls reach the run handler and its outcome is the control result', async (t) => {
    const { socketPath, registry } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const received = [];
    const owner = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const run = publisher.startRun({ kind: 'copilot-turn', title: 'Controlled', owner, onControl: (control) => {
        received.push(control);
        if (control.action === 'stop') return 'delivered';
        return control.message === 'reject me' ? { outcome: 'rejected', detail: 'not now' } : Promise.resolve('queued');
    } });
    await until(() => rowOf(registry), 'the row');
    const { id } = rowOf(registry);
    const controls = registry.runs.get(id).controls;
    assert.equal(await controls.message('hello'), 'queued');
    await assert.rejects(controls.message('reject me'), (error) => error.liveOutcome === 'rejected' && error.message === 'not now');
    await controls.stop();
    await until(() => received.length === 3, 'the stop');
    assert.deepEqual(received.map(({ action, message }) => [action, message]), [['message', 'hello'], ['message', 'reject me'], ['stop', undefined]]);
    assert.ok(received.every((control) => typeof control.requestId === 'string' && control.requestId.length > 8));
    run.end({ status: 'stopped', reason: 'stopped' });
    await until(() => rowOf(registry).status === 'stopped', 'the stop end');
});

test('the publisher refused at the incarnation cap logs it and lists nothing', async (t) => {
    const { socketPath, registry, logs: serverLogs } = await startServer(t, { maxPublishers: 1 });
    const { publisher: first } = publisherFor(t, socketPath);
    first.startRun({ kind: 'copilot-turn', title: 'Admitted' });
    await until(() => rows(registry).length === 1, 'the first row');
    const { publisher: second, logs } = publisherFor(t, socketPath, { refusedBackoffMs: 60 * 1000 });
    const refused = second.startRun({ kind: 'copilot-turn', title: 'Refused' });
    await until(() => logs.some((entry) => entry.event === 'live.hello.refused'), 'the client log');
    assert.equal(logs.find((entry) => entry.event === 'live.hello.refused').reason, 'publisher-limit');
    assert.ok(serverLogs.some((line) => /publisher limit/u.test(line)), 'the service logs the refusal too');
    refused.end({ status: 'finished' });
    await delay(50);
    assert.deepEqual(rows(registry).map((row) => row.title), ['Admitted']);
});

test('a delegated task started inside its turn keeps the turn\'s owner; one started after its runs ended cannot', async (t) => {
    const { socketPath, registry } = await startServer(t);
    const { publisher } = publisherFor(t, socketPath);
    const owner = publisher.claimOwner('valid:alice', { surface: 'webchat' });
    const turn = publisher.startRun({ kind: 'copilot-turn', title: 'Turn', owner });
    const inside = publisher.startRun({ kind: 'copilot-task', title: 'Inside', owner });
    turn.end({ status: 'finished' });
    await until(() => rowOf(registry)?.status === 'finished' && rows(registry).some((row) => row.title === 'Inside'), 'the turn end');
    // The task outlives its turn and keeps the proof; the service drops the
    // handle only with the last run that used it.
    assert.equal(rows(registry).find((row) => row.title === 'Inside').ownerState, 'verified');
    inside.end({ status: 'finished' });
    await until(() => rows(registry).find((row) => row.title === 'Inside').status === 'finished', 'the task end');
    const late = publisher.startRun({ kind: 'copilot-task', title: 'Late', owner });
    await until(() => rows(registry).some((row) => row.title === 'Late'), 'the late task');
    const owners = Object.fromEntries(rows(registry).map((row) => [row.title, row.ownerState]));
    assert.deepEqual(owners, { Turn: 'verified', Inside: 'verified', Late: 'unverified' });
    assert.deepEqual(registry.list({ principal: 'user:alice', canAdmin: false }).map((row) => row.title).sort(), ['Inside', 'Turn']);
    late.end({ status: 'finished' });
});

test('only the copilot entrypoint creates a publisher; robot task processes never get one', async () => {
    const source = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');
    const index = await source('../src/index.mjs');
    // The factory is called once, inside main(), which robot-cli.mjs runs.
    assert.equal(index.match(/createCopilotPublisher\(/gu).length, 1);
    const mainBody = index.slice(index.indexOf('export async function main('));
    assert.match(mainBody, /const livePublisher = createCopilotPublisher\(process\.env/u);
    assert.match(index, /export async function createCliRuntime\(options, \{[^}]*livePublisher = null \} = \{\}\)/u);
    const robotCli = await source('../../server/robot-cli.mjs');
    assert.match(robotCli, /process\.env\.ROBOTEAM_LIVE_PUBLISH = 'copilot';\s+const \{ main \} = await import\('\.\.\/copilot\/src\/index\.mjs'\);/u);
    // Robot tasks build their runtime directly, without main() and without a publisher.
    const robotTask = await source('../../server/robot-task.mjs');
    assert.match(robotTask, /createCliRuntime\(/u);
    assert.doesNotMatch(robotTask, /\bmain\b|livePublisher|ROBOTEAM_LIVE_PUBLISH|createCopilotPublisher/u);
});
