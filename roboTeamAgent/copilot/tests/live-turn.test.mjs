import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLiveTurn } from '../src/lib/liveSessions/liveTurn.mjs';

// The copilot-turn adapter: ALA events become run output, and owner messages
// resolve only from the ALA receipt that carries their id.
function fakePublisher() {
    const record = { starts: [], output: [], ends: [] };
    return {
        record,
        startRun(options) {
            record.starts.push(options);
            return { output: (text, style) => record.output.push([style, text]), status() {}, end: (result) => record.ends.push(result) };
        },
    };
}

function turn(options = {}) {
    const publisher = fakePublisher();
    const aborts = [];
    const live = createLiveTurn(publisher, { title: 'Copilot · hi', cwd: '/w', robot: 'default', owner: { claimId: 'c_1' },
        transcriptUrl: '/t', abort: () => aborts.push(true), ...options });
    const control = (request) => publisher.record.starts[0].onControl(request);
    return { live, record: publisher.record, aborts, control };
}

test('without a publisher there is no run', () => {
    assert.equal(createLiveTurn(null, { title: 'x' }), null);
});

test('the run is a copilot turn with its owner claim and transcript link', () => {
    const { record } = turn();
    assert.equal(record.starts.length, 1);
    const { onControl, ...start } = record.starts[0];
    assert.equal(typeof onControl, 'function');
    assert.deepEqual(start, { kind: 'copilot-turn', title: 'Copilot · hi', cwd: '/w', robot: 'default', owner: { claimId: 'c_1' }, transcriptUrl: '/t' });
});

test('ALA events are rendered per the event table', () => {
    const { live, record } = turn();
    live.event({ type: 'coding-agent-selected', agent: 'claude', model: 'opus' });
    live.event({ type: 'progress', reason: 'Starting ALA' });
    live.event({ type: 'coding-agent-message', message: 'Hel', outputKind: 'assistant' });
    live.event({ type: 'coding-agent-message', message: 'lo', outputKind: 'assistant', outputComplete: true });
    live.event({ type: 'coding-agent-message', message: 'tool output\n', outputKind: 'command' });
    live.event({ type: 'diagnostic', message: 'stderr line' });
    live.event({ type: 'coding-agent-request', id: 'r1', kind: 'permission', options: [] });
    live.event({ type: 'message-accepted', id: 'other', delivery: 'queued' });
    live.event({ type: 'message-rejected', id: 'other2', error: 'Execution is no longer accepting messages.' });
    live.event({ type: 'coding-agent-final', message: 'final' });
    live.event({ type: 'turn-started' });
    assert.deepEqual(record.output, [
        ['status', 'Coding agent: Claude Code (opus)\n'],
        ['status', 'Starting ALA\n'],
        ['assistant', 'Hel'],
        ['assistant', 'lo\n'],
        ['output', 'tool output\n'],
        ['status', 'stderr line\n'],
        ['status', 'permission requested — answer in WebChat\n'],
        ['user', 'Message queued\n'],
        ['user', 'Message rejected: Execution is no longer accepting messages.\n'],
    ]);
});

test('a message before the child holds its prompt is refused and never written', async () => {
    const { control } = turn();
    assert.deepEqual(await control({ action: 'message', requestId: 'q1', message: 'early' }), { outcome: 'rejected', detail: 'the turn is not ready for messages yet' });
});

test('a message is written with its request id and resolves only on the matching receipt', async () => {
    const { live, control, record } = turn();
    const written = [];
    live.attach((message) => { written.push(message); return true; });
    let settled = null;
    const pending = control({ action: 'message', requestId: 'req-7', message: 'please also add tests' }).then((value) => { settled = value; return value; });
    assert.deepEqual(written, [{ type: 'message', id: 'req-7', message: 'please also add tests' }]);
    live.event({ type: 'message-accepted', id: 'someone-else', delivery: 'delivered' });
    await delay(10);
    assert.equal(settled, null, 'another id does not settle it');
    live.event({ type: 'message-accepted', id: 'req-7', delivery: 'queued' });
    assert.equal(await pending, 'queued');
    assert.deepEqual(record.output.at(-1), ['user', '> please also add tests (queued)\n']);
});

test('a rejected receipt resolves as rejected with the ALA reason', async () => {
    const { live, control } = turn();
    live.attach(() => true);
    const pending = control({ action: 'message', requestId: 'req-r', message: 'x' });
    live.event({ type: 'message-rejected', id: 'req-r', error: 'Task message queue is full.' });
    assert.deepEqual(await pending, { outcome: 'rejected', detail: 'Task message queue is full.' });
});

test('child exit settles pending messages as run_ended; later ones are run_ended at once', async () => {
    const { live, control } = turn();
    live.attach(() => true);
    const pending = control({ action: 'message', requestId: 'req-x', message: 'x' });
    live.childExited();
    assert.equal(await pending, 'run_ended');
    assert.equal(await control({ action: 'message', requestId: 'req-y', message: 'y' }), 'run_ended');
    assert.equal(await control({ action: 'stop', requestId: 'req-z' }), 'run_ended');
});

test('a writer that can no longer write gives run_ended instead of waiting', async () => {
    const { live, control } = turn();
    live.attach(() => false);
    assert.equal(await control({ action: 'message', requestId: 'req-w', message: 'x' }), 'run_ended');
});

test('no receipt within the timeout is unknown', async () => {
    const { live, control } = turn({ receiptTimeoutMs: 20 });
    live.attach(() => true);
    assert.equal(await control({ action: 'message', requestId: 'req-t', message: 'x' }), 'unknown');
});

test('stop aborts the turn; end reports the outcome once', async () => {
    const { live, control, aborts, record } = turn();
    assert.equal(await control({ action: 'stop', requestId: 's1' }), 'delivered');
    assert.equal(aborts.length, 1);
    live.end({ status: 'stopped', reason: 'stopped' });
    assert.deepEqual(record.ends, [{ status: 'stopped', reason: 'stopped' }]);
});
