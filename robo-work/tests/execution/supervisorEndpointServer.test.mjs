import assert from 'node:assert/strict';
import test from 'node:test';

import { HEADER_BYTES, encodeFrame } from '../../server/execution/frameCodec.mjs';
import { createSupervisorEndpointServer } from '../../server/execution/supervisorEndpointServer.mjs';
import { createAdmission } from '../../server/execution/supervisorRequestValidator.mjs';
import { descriptorCount, duplexPair, waitFor } from './helpers/duplexPair.mjs';
import { TEST_LIMITS, testLimits } from './helpers/supervisorHarness.mjs';

const STREAMS = '/run/ep/streams';
const admission = createAdmission({
    grants: [{ path: '/projects/g', access: 'write' }], inventory: [{ name: 'codex', version: '1' }], streamDirectory: STREAMS
});
const request = (extra = {}) => ({
    processClass: 'run', executable: 'codex', args: ['run'], env: {}, home: '/home/robot', cwd: '/projects/g',
    folders: [{ path: '/projects/g', access: 'read' }], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' },
    lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true }, ...extra
});
const streams = { stdout: `${STREAMS}/aaaaaaaaaaaa`, stderr: `${STREAMS}/bbbbbbbbbbbb` };

// A stand-in for the endpoint: frames go to the real supervisor server over an in-memory socket.
function execution(keeperOverrides = {}, limitOverrides = {}) {
    const [serverSide, endpointSide] = duplexPair();
    let exitHandler = () => {};
    const calls = [];
    const keeper = {
        setExitHandler: (handler) => { exitHandler = handler; },
        tempdir: async () => '/tmp/ala-1',
        start: async (call) => { calls.push(['start', call]); },
        stop: async (call) => { calls.push(['stop', call]); },
        ...keeperOverrides
    };
    const ends = [];
    const server = createSupervisorEndpointServer({
        socket: serverSide, admission, keeper, limits: testLimits(limitOverrides), onEnd: (reason) => ends.push(reason)
    });
    const received = [];
    let buffer = Buffer.alloc(0);
    endpointSide.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= HEADER_BYTES && buffer.length >= HEADER_BYTES + buffer.readUInt32BE(0)) {
            const length = buffer.readUInt32BE(0);
            received.push(JSON.parse(buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString()));
            buffer = buffer.subarray(HEADER_BYTES + length);
        }
    });
    endpointSide.on('error', () => {});
    const send = (frame) => endpointSide.write(encodeFrame(frame, { maxFrameBytes: 1 << 20 }));
    const answer = (id) => waitFor(() => received.find((frame) => frame.id === id));
    return { server, ends, send, answer, received, calls, keeper, exit: (...args) => exitHandler(...args), endpointSide };
}

test('an admitted start reaches the keeper with the request and stream paths and is answered ok', async () => {
    const run = execution();
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    assert.deepEqual(await run.answer(1), { id: 1, ok: true });
    assert.deepEqual(run.calls[0][1].streams, streams);
    assert.equal(run.calls[0][1].request.executable, 'codex');
});

test('an exit that arrives before the start is answered is sent after the answer, never before it', async () => {
    const run = execution({ start: async ({ process }) => { run.exit(process, 0, null); } });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    await waitFor(() => run.received.length === 2);
    assert.deepEqual(run.received.map((frame) => frame.id ?? frame.event), [1, 'exit']);
});

test('a refused start never reaches the keeper and the refusal carries its own code', async () => {
    const run = execution();
    run.send({ id: 1, op: 'start', process: 1, request: request({ cwd: '/outside' }), streams });
    run.send({ id: 2, op: 'start', process: 2, request: request({ executable: '/bin/sh' }), streams });
    run.send({ id: 3, op: 'start', process: 3, request: request({ extra: true }), streams });
    run.send({ id: 4, op: 'start', process: 4, request: request(), streams: { stdout: '/etc/passwd', stderr: streams.stderr } });
    const answers = await Promise.all([1, 2, 3, 4].map(run.answer));
    assert.deepEqual(answers.map((frame) => [frame.ok, frame.kind, frame.error.code]), [
        [false, 'refused', 'path_outside_view'], [false, 'refused', 'executable_not_in_inventory'],
        [false, 'refused', 'invalid_request'], [false, 'refused', 'stream_path_not_admitted']
    ]);
    assert.equal(run.calls.length, 0);
    assert.deepEqual(run.ends, [], 'a refusal does not end the execution');
});

test('a keeper failure is answered as a failure with a generic message and no keeper text', async () => {
    const run = execution({ start: async () => { throw new Error('secret /host/path detail'); } });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    const answer = await run.answer(1);
    assert.deepEqual([answer.ok, answer.kind, answer.error.code], [false, 'failure', 'setup_failed']);
    assert.equal(JSON.stringify(answer).includes('secret'), false);
});

test('process numbers are unique and bounded per execution', async () => {
    const run = execution({}, { maxProcesses: 2 });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    run.send({ id: 2, op: 'start', process: 1, request: request(), streams });
    run.send({ id: 3, op: 'start', process: 2, request: request(), streams });
    run.send({ id: 4, op: 'start', process: 3, request: request(), streams });
    const answers = await Promise.all([1, 2, 3, 4].map(run.answer));
    assert.deepEqual(answers.map((frame) => frame.error?.code ?? 'ok'), ['ok', 'duplicate_process', 'ok', 'capacity_exceeded']);
});

test('stop, connect, inventory and tempdir follow the admitted process table', async () => {
    const run = execution({}, {});
    run.send({ id: 1, op: 'stop', process: 9, graceMs: 0 });
    assert.equal((await run.answer(1)).error.code, 'unknown_process');
    run.send({ id: 2, op: 'start', process: 1, request: request({ processClass: 'service', communication: { kind: 'service', endpoint: 'loopback-port', stdin: 'ignore' } }), streams });
    run.send({ id: 3, op: 'start', process: 2, request: request(), streams });
    await run.answer(2); await run.answer(3);
    run.send({ id: 4, op: 'connect', process: 1, port: 4321 });
    run.send({ id: 5, op: 'connect', process: 2, port: 4321 });
    run.send({ id: 6, op: 'connect', process: 7, port: 4321 });
    assert.equal((await run.answer(4)).ok, true);
    assert.equal((await run.answer(5)).error.code, 'not_a_running_service');
    assert.equal((await run.answer(6)).error.code, 'not_a_running_service');
    run.send({ id: 7, op: 'stop', process: 1, graceMs: 100 });
    assert.equal((await run.answer(7)).ok, true);
    assert.deepEqual(run.calls.filter(([name]) => name === 'stop').map(([, call]) => call), [{ process: 1, graceMs: 100 }]);
    run.send({ id: 8, op: 'inventory' });
    assert.deepEqual((await run.answer(8)).value, [{ name: 'codex', version: '1' }]);
    run.send({ id: 9, op: 'tempdir' });
    assert.deepEqual((await run.answer(9)).value, { path: '/tmp/ala-1' });
});

test('the endpoint\'s own relay ports are never admitted as a connect target', async () => {
    const run = execution();
    run.send({ event: 'ready', relayPorts: [5555] });
    run.send({ id: 1, op: 'start', process: 1, request: request({ processClass: 'service', communication: { kind: 'service', endpoint: 'loopback-port', stdin: 'ignore' } }), streams });
    await run.answer(1);
    run.send({ id: 2, op: 'connect', process: 1, port: 5555 });
    assert.equal((await run.answer(2)).error.code, 'relay_port');
});

test('a tempdir that is not a normalized virtual path is a failure', async () => {
    const run = execution({ tempdir: async () => '/tmp/../etc' });
    run.send({ id: 1, op: 'tempdir' });
    assert.equal((await run.answer(1)).kind, 'failure');
});

// Hostile endpoint behaviour. Each case ends only this execution, and a neighbour keeps being served.
const hostile = [
    ['a frame that is not a request', (run) => run.send({ hello: 'world' }), 'channel_violation:bad_frame'],
    ['an event that is not in the protocol', (run) => run.send({ event: 'shell' }), 'channel_violation:bad_event'],
    ['a request id that is reused', (run) => { run.send({ id: 1, op: 'inventory' }); run.send({ id: 1, op: 'inventory' }); }, 'channel_violation:duplicate_id'],
    ['an endpoint that reports its own failure', (run) => run.send({ event: 'failure', reason: 'descriptor_exhaustion' }), 'endpoint_failure:descriptor_exhaustion'],
    ['an oversize length prefix', (run) => run.endpointSide.write(Buffer.from([0x7f, 0xff, 0xff, 0xff])), 'channel_violation:oversize_frame'],
    ['a frame that is not JSON', (run) => { const body = Buffer.from('not json'); const head = Buffer.alloc(4); head.writeUInt32BE(body.length); run.endpointSide.write(Buffer.concat([head, body])); }, 'channel_violation:malformed_frame'],
    ['a socket that closes', (run) => run.endpointSide.destroy(), 'endpoint_lost']
];
for (const [name, act, reason] of hostile) {
    test(`hostile endpoint: ${name} ends only this execution`, async () => {
        const before = descriptorCount();
        const neighbour = execution();
        const run = execution();
        act(run);
        assert.equal(await waitFor(() => run.ends.length > 0), true, 'the execution ended');
        assert.deepEqual(run.ends, [reason]);
        assert.equal(run.server.stats().ended, true);
        neighbour.send({ id: 1, op: 'tempdir' });
        assert.deepEqual((await neighbour.answer(1)).value, { path: '/tmp/ala-1' }, 'the neighbouring execution is still served');
        assert.deepEqual(neighbour.ends, []);
        assert.equal(descriptorCount(), before, 'the supervisor holds no more descriptors');
    });
}

test('hostile endpoint: more requests in flight than the bound ends the execution', async () => {
    const release = [];
    const run = execution({ tempdir: () => new Promise((resolve) => release.push(resolve)) }, { maxInFlightRequests: 3, maxInboundQueue: 3 });
    for (let id = 1; id <= 4; id += 1) run.send({ id, op: 'tempdir' });
    assert.equal(await waitFor(() => run.ends.length > 0), true);
    assert.deepEqual(run.ends, ['channel_violation:in_flight_overflow']);
    assert.equal(TEST_LIMITS.maxInFlightRequests > 3, true, 'the test lowered the bound itself');
});

test('hostile endpoint: a partial frame that stalls ends the execution at the deadline', async () => {
    const run = execution({}, { partialFrameDeadlineMs: 60 });
    run.endpointSide.write(Buffer.from([0, 0, 1]));
    assert.equal(await waitFor(() => run.ends.length > 0, 1000), true);
    assert.deepEqual(run.ends, ['channel_violation:partial_frame_deadline']);
});

// ---------------------------------------------------------------------------------------------------------------
// F1: a stop that arrives while the start is pending is carried out once the start has resolved.
const gated = () => { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; };
function slowStart() {
    const startGate = gated();
    const stops = [];
    const keeper = {
        start: async () => { await startGate.wait; },
        stop: async (call) => { stops.push(call); }
    };
    return { startGate, stops, keeper };
}

test('a stop that arrives while the start is pending is performed as soon as the start resolves, with the smallest grace', async () => {
    const { startGate, stops, keeper } = slowStart();
    const run = execution(keeper);
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    run.send({ id: 2, op: 'stop', process: 1, graceMs: 5000 });
    run.send({ id: 3, op: 'stop', process: 1, graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(stops, [], 'nothing can be stopped before it exists');
    assert.deepEqual(run.received, [], 'a stop is answered only after it was performed, so neither answer is out yet');
    startGate.release();
    const answers = await Promise.all([1, 2, 3].map(run.answer));
    assert.deepEqual(answers.map((frame) => frame.ok), [true, true, true]);
    assert.deepEqual(stops, [{ process: 1, graceMs: 0 }], 'one stop with the smallest grace');
    assert.deepEqual(run.received.map((frame) => frame.id), [1, 2, 3], 'the start is answered before the stops');
});

test('a stop that waited for a failed start has nothing to stop and is answered ok without reaching the keeper', async () => {
    const stops = [];
    const startGate = gated();
    const run = execution({ start: async () => { await startGate.wait; throw new Error('setup'); }, stop: async (call) => { stops.push(call); } });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    run.send({ id: 2, op: 'stop', process: 1, graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    startGate.release();
    assert.equal((await run.answer(1)).kind, 'failure');
    assert.equal((await run.answer(2)).ok, true);
    assert.deepEqual(stops, []);
});

test('repeated stops of a running process collapse: one that asks for no less grace waits for the stop already sent', async () => {
    const stops = [];
    const stopGate = gated();
    const run = execution({ stop: async (call) => { stops.push(call); await stopGate.wait; } });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    await run.answer(1);
    run.send({ id: 2, op: 'stop', process: 1, graceMs: 5000 });
    run.send({ id: 3, op: 'stop', process: 1, graceMs: 5000 });
    run.send({ id: 4, op: 'stop', process: 1, graceMs: 9000 });
    run.send({ id: 5, op: 'stop', process: 1, graceMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(stops, [{ process: 1, graceMs: 5000 }, { process: 1, graceMs: 100 }], 'only a smaller grace is sent again');
    stopGate.release();
    for (const id of [2, 3, 4, 5]) assert.equal((await run.answer(id)).ok, true, `stop ${id}`);
});

test('a keeper that fails to stop is answered as a failure, not as ok', async () => {
    const run = execution({ stop: async () => { throw new Error('cannot stop'); } });
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    await run.answer(1);
    run.send({ id: 2, op: 'stop', process: 1, graceMs: 0 });
    assert.equal((await run.answer(2)).kind, 'failure');
});

test('the stop of a pending start is still performed when the endpoint is gone before the start resolves', async () => {
    const { startGate, stops, keeper } = slowStart();
    const run = execution(keeper);
    run.send({ id: 1, op: 'start', process: 1, request: request(), streams });
    run.send({ id: 2, op: 'stop', process: 1, graceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    run.endpointSide.destroy();
    assert.equal(await waitFor(() => run.ends.length === 1), true);
    startGate.release();
    assert.equal(await waitFor(() => stops.length === 1), true);
    assert.deepEqual(stops, [{ process: 1, graceMs: 0 }]);
});

// ---------------------------------------------------------------------------------------------------------------
// (b) fd-4 events are bounded by count.
test('events are bounded: a second ready, a status nobody asked for and a flood of statuses each end the execution', async () => {
    const second = execution();
    second.send({ event: 'ready', relayPorts: [5000] });
    second.send({ event: 'ready', relayPorts: [] });
    assert.equal(await waitFor(() => second.ends.length === 1), true);
    assert.deepEqual(second.ends, ['channel_violation:repeated_ready']);
    assert.deepEqual(second.server.stats().relayPorts, [5000], 'ports are not replaced by a later ready');

    const unsolicited = execution();
    unsolicited.send({ event: 'status', descriptors: 3 });
    assert.equal(await waitFor(() => unsolicited.ends.length === 1), true);
    assert.deepEqual(unsolicited.ends, ['channel_violation:unsolicited_status']);

    const flood = execution();
    for (let index = 0; index < 200; index += 1) flood.send({ event: 'status', descriptors: index });
    assert.equal(await waitFor(() => flood.ends.length === 1), true);
    assert.deepEqual(flood.ends, ['channel_violation:unsolicited_status']);
});

test('a status that answers a report is accepted once, including one that arrives after the report timed out', async () => {
    const run = execution();
    const first = run.server.report(1000);
    await waitFor(() => run.received.some((frame) => frame.event === 'report'));
    run.send({ event: 'status', descriptors: 7 });
    assert.equal((await first).descriptors, 7);
    const late = run.server.report(30);
    assert.equal(await late, null);
    run.send({ event: 'status', descriptors: 8 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(run.ends, [], 'the late answer was asked for');
    run.send({ event: 'status', descriptors: 9 });
    assert.equal(await waitFor(() => run.ends.length === 1), true);
    assert.deepEqual(run.ends, ['channel_violation:unsolicited_status']);
});
