import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { mock } from 'node:test';
import { ENDPOINT_LIMIT_DEFAULTS } from '../../server/execution/executionLimits.mjs';
import { createProviderEndpoint } from '../../server/execution/providerEndpoint.mjs';
import { createFakeAlaChannel } from './helpers/endpointRig.mjs';
import { duplexPair } from './helpers/duplexPair.mjs';

import { SERVICE_START, VALID_START, createEndpointRig } from './helpers/endpointRig.mjs';
import { createFakeKeeper } from './helpers/fakeKeeper.mjs';
import { knownPayload } from './helpers/payload.mjs';
import { waitFor } from './helpers/duplexPair.mjs';

// The endpoint's request logic, in process, against the real supervisor server and a fake keeper. The real Node IPC
// transport (descriptor passing between processes) is exercised by the symmetric-topology tests.

async function readAll(socket) {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.resume();
    await once(socket, 'end');
    return Buffer.concat(chunks);
}

test('the handshake: hello is answered, anything before it is a channel-wide failure, a second hello too', async (context) => {
    const first = await createEndpointRig();
    context.after(() => first.dispose());
    first.channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    assert.deepEqual((await first.channel.find((m) => m.type === 'hello')).message, { type: 'hello', protocol: 'ala-execution-provider', version: 1 });
    first.channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    assert.equal((await first.channel.find((m) => m.type === 'failure')).message.error.message, 'repeated hello');

    const early = await createEndpointRig();
    context.after(() => early.dispose());
    early.channel.fromAla({ type: 'inventory', id: 1 });
    assert.equal((await early.channel.find((m) => m.type === 'failure')).message.error.code, 'protocol');
    assert.equal(early.channel.messages().some((m) => m.type === 'result'), false);

    const version = await createEndpointRig();
    context.after(() => version.dispose());
    version.channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [2] });
    assert.ok(await version.channel.find((m) => m.type === 'failure'));
});

test('a standard stream written and half-closed by the workload before the transfer arrives complete, with its end', async (context) => {
    const payload = knownPayload();
    const keeper = createFakeKeeper({ script: ({ sockets, exit }) => { sockets.stdout.end(payload); sockets.stderr.end(); exit(0); } });
    const rig = await createEndpointRig({ keeper });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
    const stdout = await rig.channel.find((m) => m.type === 'stream' && m.stream === 'stdout');
    assert.equal(stdout.bytesRead, 0, 'the endpoint passed the socket without reading a byte');
    assert.deepEqual(await readAll(stdout.handle), payload);
    assert.ok(await rig.channel.find((m) => m.type === 'stream' && m.stream === 'stderr'));
    const exit = await rig.channel.find((m) => m.type === 'exit');
    assert.deepEqual([exit.message.code, exit.message.signal], [0, null]);
    // Order: started (no handle), every stream, then exit.
    const order = rig.channel.sent.map((entry) => `${entry.message.type}${entry.handle ? '+handle' : ''}`);
    assert.deepEqual(order, ['hello', 'started', 'stream+handle', 'stream+handle', 'exit']);
    // The path of each stream is gone as soon as it has been accepted.
    assert.deepEqual(rig.streamEntries(), []);
});

test('a piped stdin is delivered too, and the workload sees what ALA writes to it', async (context) => {
    const rig = await createEndpointRig({ keeper: createFakeKeeper({ script: ({ sockets, exit }) => {
        sockets.stdin.on('data', (chunk) => sockets.stdout.write(chunk));
        sockets.stdin.on('end', () => exit(0));
    } }) });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: { ...VALID_START, args: ['echo'], processClass: 'session', communication: { kind: 'streams', stdin: 'pipe' } } });
    const stdin = await rig.channel.find((m) => m.type === 'stream' && m.stream === 'stdin');
    const stdout = await rig.channel.find((m) => m.type === 'stream' && m.stream === 'stdout');
    const echoed = readAll(stdout.handle);
    stdin.handle.end('first\nsecond\n');
    assert.equal((await echoed).toString(), 'first\nsecond\n');
});

test('a refused start is answered refused, starts nothing and leaves no listener path behind', async (context) => {
    const rig = await createEndpointRig();
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: { ...VALID_START, cwd: '/outside' } });
    const refused = await rig.channel.find((m) => m.type === 'refused');
    assert.equal(refused.message.error.code, 'path_outside_view');
    assert.equal(rig.keeper.log.starts.length, 0);
    assert.deepEqual(rig.streamEntries(), []);
    // A schema-invalid start never reaches the supervisor at all.
    rig.channel.fromAla({ type: 'start', process: 2, request: { ...VALID_START, extra: 1 } });
    assert.equal((await rig.channel.find((m) => m.type === 'refused' && m.process === 2)).message.error.code, 'invalid_request');
    assert.equal(rig.supervisor.server.stats().requestsHandled, 1);
    assert.deepEqual(rig.endEvents, [], 'refusals do not end the execution');
});

test('process numbers must increase and an unknown stop is a channel-wide failure', async (context) => {
    const rig = await createEndpointRig();
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 5, request: { ...VALID_START, cwd: '/outside' } });
    await rig.channel.find((m) => m.type === 'refused');
    rig.channel.fromAla({ type: 'start', process: 5, request: VALID_START });
    assert.equal((await rig.channel.find((m) => m.type === 'failure')).message.error.message, 'process numbers must increase');

    const stopper = await createEndpointRig();
    context.after(() => stopper.dispose());
    await stopper.hello();
    stopper.channel.fromAla({ type: 'stop', process: 3, graceMs: 0 });
    assert.equal((await stopper.channel.find((m) => m.type === 'failure')).message.error.code, 'protocol');
});

test('a workload stream that is never connected fails that process, asks the supervisor to stop it and removes the path', async (context) => {
    const keeper = createFakeKeeper({ script: () => {} });
    keeper.start = async (call) => { keeper.log.starts.push(call); };
    const rig = await createEndpointRig({ keeper, limits: { streamAcceptDeadlineMs: 100 } });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
    const failure = await rig.channel.find((m) => m.type === 'failure' && m.process === 1);
    assert.equal(failure.message.error.code, 'stream_not_connected');
    assert.equal(await waitFor(() => keeper.log.stops.length === 1), true);
    assert.deepEqual(keeper.log.stops[0], { process: 1, graceMs: 0 });
    assert.deepEqual(rig.streamEntries(), []);
    assert.deepEqual(rig.endEvents, []);
});

test('a handle sent by ALA is closed and is a channel-wide failure that ends the execution', async (context) => {
    const rig = await createEndpointRig();
    context.after(() => rig.dispose());
    await rig.hello();
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    const accepted = once(server, 'connection');
    const kept = net.connect(server.address().port, '127.0.0.1');
    await once(kept, 'connect');
    const [handle] = await accepted;
    const ended = once(kept, 'close');
    kept.resume();
    rig.channel.fromAla({ type: 'inventory', id: 1 }, handle);
    assert.equal((await rig.channel.find((m) => m.type === 'failure')).message.error.message, 'client messages carry no handles');
    await ended;
    assert.equal(handle.destroyed, true);
    assert.equal(rig.channel.messages().some((m) => m.type === 'result'), false, 'the message that carried the handle was not served');
    assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
    assert.deepEqual(rig.endEvents, ['handle_from_ala']);
    assert.equal(await waitFor(() => rig.supervisor.ends.length === 1), true);
    assert.deepEqual(rig.supervisor.ends, ['endpoint_failure:handle_from_ala']);
});

test('unknown message types, malformed messages and invalid ids are channel-wide failures', async (context) => {
    for (const message of [{ type: 'shell', command: 'true' }, { type: 'inventory', id: 'one' }, { type: 'stop', process: 1 }, { nothing: true }]) {
        const rig = await createEndpointRig();
        context.after(() => rig.dispose());
        await rig.hello();
        rig.channel.fromAla(message);
        assert.ok(await rig.channel.find((m) => m.type === 'failure'), JSON.stringify(message));
    }
});

test('inventory and tempdir are relayed and answered as results', async (context) => {
    const rig = await createEndpointRig();
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'inventory', id: 1 });
    rig.channel.fromAla({ type: 'tempdir', id: 2 });
    assert.deepEqual((await rig.channel.find((m) => m.type === 'result' && m.id === 1)).message.value, [{ name: 'codex' }, { name: 'claude' }]);
    assert.deepEqual((await rig.channel.find((m) => m.type === 'result' && m.id === 2)).message.value, { path: '/tmp/ala-execution-1' });
});

async function withService(context, handler) {
    const server = net.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    return server.address().port;
}

async function startedService(rig) {
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: SERVICE_START });
    await rig.channel.find((m) => m.type === 'started');
}

test('a service connection is made from the endpoint, paused before it completes, and passed unread with its bytes and end intact', async (context) => {
    const payload = knownPayload(1500);
    const port = await withService(context, (socket) => { socket.end(payload); });
    const rig = await createEndpointRig({ keeper: createFakeKeeper({ script: () => {} }) });
    context.after(() => rig.dispose());
    await startedService(rig);
    rig.channel.fromAla({ type: 'connect', id: 7, process: 1, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port } });
    const result = await rig.channel.find((m) => m.type === 'result' && m.id === 7);
    assert.equal(result.message.ok, true);
    assert.equal(result.bytesRead, 0);
    // Let the service's bytes and end-of-stream arrive in the kernel before anyone reads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readAll(result.handle), payload);
});

test('connect refusals: the unix-socket form, the endpoint\'s own relay port, an unknown process, a non-service process', async (context) => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const home = await createEndpointRig();
    context.after(() => home.dispose());
    const target = path.join(home.directory, 'mcp.sock');
    await new Promise((resolve) => echo.listen(target, resolve));
    context.after(() => echo.close());
    const rig = await createEndpointRig({ relays: [{ port: 0, target }], keeper: createFakeKeeper({ script: () => {} }) });
    context.after(() => rig.dispose());
    const [relayPort] = rig.endpoint.ownPorts();
    await startedService(rig);
    rig.channel.fromAla({ type: 'start', process: 2, request: VALID_START });
    await rig.channel.find((m) => m.type === 'started' && m.process === 2);
    const attempts = [
        [1, { kind: 'unix-socket', path: '/run/workload.sock' }, 1, 'unsupported_endpoint'],
        [2, { kind: 'loopback-port', host: '127.0.0.1', port: relayPort }, 1, 'own_port'],
        [3, { kind: 'loopback-port', host: '127.0.0.1', port: 4321 }, 9, 'unknown_process'],
        [4, { kind: 'loopback-port', host: '127.0.0.1', port: 4321 }, 2, 'not_a_running_service']
    ];
    for (const [id, endpoint, processNumber, code] of attempts) {
        rig.channel.fromAla({ type: 'connect', id, process: processNumber, endpoint });
        const result = await rig.channel.find((m) => m.type === 'result' && m.id === id);
        assert.deepEqual([result.message.ok, result.message.error.code, result.handle], [false, code, undefined], `id ${id}`);
    }
    assert.deepEqual(rig.endEvents, [], 'refusals do not end the execution');
});

test('M-26: a relay with a fixed port is an own port from construction on, so ALA can never connect to the model channel relay', async (context) => {
    const home = await createEndpointRig();
    context.after(() => home.dispose());
    const echo = net.createServer((socket) => socket.pipe(socket));
    const target = path.join(home.directory, 'model.sock');
    await new Promise((resolve) => echo.listen(target, resolve));
    context.after(() => echo.close());
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const fixedPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const rig = await createEndpointRig({ relays: [{ port: fixedPort, target: { path: target } }], keeper: createFakeKeeper({ script: () => {} }) });
    context.after(() => rig.dispose());
    // Synchronously after construction, before the relay listener has been bound: the port is already refused.
    assert.deepEqual(rig.endpoint.ownPorts(), [fixedPort]);
    await startedService(rig);
    rig.channel.fromAla({ type: 'start', process: 2, request: VALID_START });
    await rig.channel.find((m) => m.type === 'started' && m.process === 2);
    rig.channel.fromAla({ type: 'connect', id: 7, process: 2, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: fixedPort } });
    const refused = await rig.channel.find((m) => m.type === 'result' && m.id === 7);
    assert.deepEqual([refused.message.ok, refused.message.error.code, refused.handle], [false, 'own_port', undefined]);
    // The relay itself copies bytes to the unix target (the path form the model channel uses).
    const client = net.connect({ host: '127.0.0.1', port: fixedPort });
    await once(client, 'connect');
    client.write('ping');
    const [echoed] = await once(client, 'data');
    assert.equal(echoed.toString(), 'ping');
    client.destroy();
});

test('a service that refuses the connection is a failed connect, not a failed endpoint', async (context) => {
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address();
    await new Promise((resolve) => closed.close(resolve));
    const rig = await createEndpointRig({ keeper: createFakeKeeper({ script: () => {} }) });
    context.after(() => rig.dispose());
    await startedService(rig);
    rig.channel.fromAla({ type: 'connect', id: 1, process: 1, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port } });
    assert.equal((await rig.channel.find((m) => m.type === 'result' && m.id === 1)).message.error.code, 'connect_failed');
    assert.deepEqual(rig.endEvents, []);
});

test('MCP relays copy bytes both ways without parsing and refuse connections past the limit', async (context) => {
    const rig0 = await createEndpointRig();
    const target = path.join(rig0.directory, 'mcp.sock');
    context.after(() => rig0.dispose());
    const upstream = net.createServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))));
    await new Promise((resolve) => upstream.listen(target, resolve));
    context.after(() => upstream.close());
    const rig = await createEndpointRig({ relays: [{ port: 0, target }], limits: { maxRelayConnections: 2 } });
    context.after(() => rig.dispose());
    const [port] = rig.endpoint.ownPorts();
    assert.deepEqual(rig.supervisor.server.stats().relayPorts, [port], 'the supervisor learned the relay port');
    const open = async () => { const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); await once(socket, 'connect'); return socket; };
    const first = await open();
    const bytes = Buffer.from([0, 255, 10, 13, 0x7b, 0x22]);
    first.write(bytes);
    const [echoed] = await once(first, 'data');
    assert.deepEqual(echoed, Buffer.concat([Buffer.from('echo:'), bytes]));
    // The limit counts connections: a limit of 2 admits exactly two, whatever sockets each one uses.
    const second = await open();
    const third = await open();
    const closed = once(third, 'close');
    await closed;
    assert.equal(third.destroyed, true, 'a connection past the limit is closed');
    assert.equal(first.destroyed, false);
    assert.equal(second.destroyed, false);
    assert.equal(rig.endpoint.stats().relayConnections, 2);
    first.destroy();
    second.destroy();
    assert.equal(await waitFor(() => rig.endpoint.stats().relayConnections === 0), true, 'closing a client closes its upstream');
});

test('outbound backlog: replies ALA has not read past the bound end the execution; an ALA that keeps reading never trips it', async (context) => {
    const stuck = await createEndpointRig({ holdCallbacks: true, limits: { maxOutboundBacklogMessages: 5 } });
    context.after(() => stuck.dispose());
    stuck.channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    for (let id = 1; id <= 8; id += 1) {
        stuck.channel.fromAla({ type: 'inventory', id });
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await waitFor(() => stuck.endEvents.length === 1), true);
    assert.deepEqual(stuck.endEvents, ['outbound_backlog']);
    assert.equal(stuck.channel.connected, false);
    assert.deepEqual(stuck.supervisor.ends, ['endpoint_failure:outbound_backlog']);
    assert.ok(stuck.channel.sent.length <= 6 + 1, 'the endpoint stopped writing at the bound');

    const reading = await createEndpointRig({ limits: { maxOutboundBacklogMessages: 5 } });
    context.after(() => reading.dispose());
    await reading.hello();
    for (let id = 1; id <= 40; id += 1) {
        reading.channel.fromAla({ type: 'inventory', id });
        await reading.channel.find((m) => m.type === 'result' && m.id === id);
    }
    assert.deepEqual(reading.endEvents, []);

    const bytes = await createEndpointRig({ holdCallbacks: true, limits: { maxOutboundBacklogMessages: 1000, maxOutboundBacklogBytes: 700 } });
    context.after(() => bytes.dispose());
    bytes.channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    for (let id = 1; id <= 12; id += 1) {
        bytes.channel.fromAla({ type: 'inventory', id });
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await waitFor(() => bytes.endEvents.length === 1), true);
    assert.deepEqual(bytes.endEvents, ['outbound_backlog']);
});

test('inbound queue: more unanswered ALA requests than the bound end the execution', async (context) => {
    const keeper = createFakeKeeper();
    keeper.tempdir = () => new Promise(() => {});
    const rig = await createEndpointRig({ keeper, limits: { maxInboundQueue: 3 } });
    context.after(() => rig.dispose());
    await rig.hello();
    for (let id = 1; id <= 4; id += 1) rig.channel.fromAla({ type: 'tempdir', id });
    assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
    assert.deepEqual(rig.endEvents, ['inbound_queue_overflow']);
});

test('the endpoint ends when ALA disconnects or when the supervisor channel closes, and reports failures to the supervisor', async (context) => {
    const alaGone = await createEndpointRig();
    context.after(() => alaGone.dispose());
    alaGone.channel.disconnect();
    assert.equal(await waitFor(() => alaGone.endEvents.length === 1), true);
    assert.deepEqual(alaGone.endEvents, ['ala_disconnected']);

    const supervisorGone = await createEndpointRig();
    context.after(() => supervisorGone.dispose());
    supervisorGone.supervisor.server.end('test_end');
    assert.equal(await waitFor(() => supervisorGone.endEvents.length === 1), true);
    assert.deepEqual(supervisorGone.endEvents, ['supervisor_closed']);
});

test('the queue bound cannot exceed the frame in-flight bound, at limit resolution and at construction', async () => {
    const { createProviderEndpoint } = await import('../../server/execution/providerEndpoint.mjs');
    const { testLimits } = await import('./helpers/supervisorHarness.mjs');
    assert.throws(() => testLimits({ maxInboundQueue: 8, maxInFlightRequests: 4 }), /maxInboundQueue must not exceed maxInFlightRequests/);
    const consistent = testLimits();
    assert.throws(() => createProviderEndpoint({ channel: {}, supervisorSocket: {}, limits: { ...consistent, maxInboundQueue: 99 }, streamDirectory: '/x' }), TypeError);
});

// EMFILE or ENFILE on the endpoint's own connect is an endpoint failure (R3-8). Node reports it on the connecting
// socket, so it is injected here at net.connect; the OS-level flood is in hostileChannel.test.mjs.
test('descriptor exhaustion on the endpoint\'s own service connect or relay upstream connect is an endpoint failure', async (context) => {
    for (const code of ['EMFILE', 'ENFILE']) {
        const rig = await createEndpointRig({ keeper: createFakeKeeper({ script: () => {} }) });
        context.after(() => rig.dispose());
        await startedService(rig);
        const real = net.connect;
        const injected = mock.method(net, 'connect', (...args) => {
            const socket = new net.Socket();
            socket.connect = () => socket;
            setImmediate(() => socket.emit('error', Object.assign(new Error(code), { code })));
            return args.length ? socket : real(...args);
        });
        try {
            rig.channel.fromAla({ type: 'connect', id: 1, process: 1, endpoint: { kind: 'loopback-port', host: '127.0.0.1', port: 4321 } });
            assert.equal(await waitFor(() => rig.endEvents.length === 1), true, code);
            assert.deepEqual(rig.endEvents, ['descriptor_exhaustion']);
            assert.deepEqual(rig.channel.messages().filter((m) => m.type === 'result'), [], 'no result is claimed for a failed endpoint');
            assert.equal(await waitFor(() => rig.supervisor.ends.length === 1), true);
            assert.deepEqual(rig.supervisor.ends, ['endpoint_failure:descriptor_exhaustion']);
        } finally { injected.mock.restore(); }
    }
    // The relay upstream connect.
    const home = await createEndpointRig();
    context.after(() => home.dispose());
    const real = net.connect;
    const injected = mock.method(net, 'connect', (...args) => {
        if (typeof args[0] === 'string') {
            const socket = new net.Socket();
            socket.connect = () => socket;
            setImmediate(() => socket.emit('error', Object.assign(new Error('EMFILE'), { code: 'EMFILE' })));
            return socket;
        }
        return real(...args);
    });
    try {
        const rig = await createEndpointRig({ relays: [{ port: 0, target: path.join(home.directory, 'x.sock') }] });
        context.after(() => rig.dispose());
        const [port] = rig.endpoint.ownPorts();
        const client = real({ host: '127.0.0.1', port });
        client.on('error', () => {});
        context.after(() => client.destroy());
        assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
        assert.deepEqual(rig.endEvents, ['descriptor_exhaustion']);
    } finally { injected.mock.restore(); }
});

// ---------------------------------------------------------------------------------------------------------------
// F1: a stop is never dropped, and never reaches the supervisor ahead of its start frame.
function slowKeeper() {
    const base = createFakeKeeper({ script: () => {} });
    const gate = {};
    gate.wait = new Promise((resolve) => { gate.release = resolve; });
    const order = [];
    const keeper = {
        ...base,
        async start(call) { order.push('start-called'); await gate.wait; await base.start(call); order.push('start-done'); },
        async stop(call) { order.push(`stop:${call.graceMs}`); return base.stop(call); }
    };
    return { keeper, base, gate, order };
}

for (const [label, wait] of [
    ['in the same tick as the start (before the start frame is sent)', async () => {}],
    ['after the keeper has begun the start (the start frame is already at the supervisor)', async (rig, keeper) => { await waitFor(() => keeper.order.includes('start-called')); }]
]) {
    test(`a stop sent ${label} is performed after the start and leaves no live process`, async (context) => {
        const kit = slowKeeper();
        const rig = await createEndpointRig({ keeper: kit.keeper });
        context.after(() => rig.dispose());
        await rig.hello();
        rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
        await wait(rig, kit);
        rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 0 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(kit.order, ['start-called'], 'the start is still pending and the stop has not been performed early');
        kit.gate.release();
        assert.equal(await waitFor(() => kit.base.log.stops.length === 1), true, 'the stop reached the keeper');
        assert.deepEqual(kit.base.log.stops, [{ process: 1, graceMs: 0 }]);
        assert.deepEqual(kit.order, ['start-called', 'start-done', 'stop:0'], 'start first, then the stop');
        assert.deepEqual([...kit.base.live.keys()], [], 'no live process remains');
        assert.deepEqual(rig.endEvents, []);
    });
}

test('ALA\'s start-timeout path (stop with graceMs 0) is carried out even though ALA has already given up on the start', async (context) => {
    const kit = slowKeeper();
    const rig = await createEndpointRig({ keeper: kit.keeper });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
    await waitFor(() => kit.order.includes('start-called'));
    // The client's timer fires: it stops the process with graceMs 0 and marks it abandoned. Nothing more comes from it.
    rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 0 });
    kit.gate.release();
    assert.equal(await waitFor(() => kit.base.live.size === 0 && kit.base.log.stops.length === 1), true);
    assert.deepEqual(kit.base.log.stops, [{ process: 1, graceMs: 0 }]);
});

test('ALA close() (stop of each pending process, then disconnect) loses neither the stop nor the guarantee of no live process', async (context) => {
    const kit = slowKeeper();
    const rig = await createEndpointRig({ keeper: kit.keeper });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
    await waitFor(() => kit.order.includes('start-called'));
    rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 0 });
    rig.channel.disconnect();
    assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
    assert.deepEqual(rig.endEvents, ['ala_disconnected']);
    // The stop frame reached the supervisor before the channel closed.
    assert.equal(rig.supervisor.server.stats().requestsHandled, 2);
    kit.gate.release();
    // The endpoint removed its stream paths when it ended, so the keeper's start cannot connect them and the process is
    // never created; if it had been created, the recorded stop would end it. Either way nothing is left running.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([...kit.base.live.keys()], []);
    assert.ok(kit.base.log.stops.length <= 1);
});

test('several stops sent before the start frame collapse into one stop with the smallest grace', async (context) => {
    const kit = slowKeeper();
    const rig = await createEndpointRig({ keeper: kit.keeper });
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: VALID_START });
    for (const graceMs of [4000, 9000, 250, 250]) rig.channel.fromAla({ type: 'stop', process: 1, graceMs });
    kit.gate.release();
    assert.equal(await waitFor(() => kit.base.log.stops.length >= 1), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(kit.base.log.stops, [{ process: 1, graceMs: 250 }]);
});

test('a stop for a start that was refused is dropped quietly', async (context) => {
    const rig = await createEndpointRig();
    context.after(() => rig.dispose());
    await rig.hello();
    rig.channel.fromAla({ type: 'start', process: 1, request: { ...VALID_START, cwd: '/outside' } });
    rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 0 });
    await rig.channel.find((m) => m.type === 'refused');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(rig.keeper.log.stops, []);
    assert.deepEqual(rig.endEvents, []);
});

// ---------------------------------------------------------------------------------------------------------------
// F3: stops count against the inbound bound, and a stop flood is attributed to ALA.
async function runningProcesses(rig, count) {
    await rig.hello();
    for (let process = 1; process <= count; process += 1) {
        rig.channel.fromAla({ type: 'start', process, request: VALID_START });
        await rig.channel.find((m) => m.type === 'started' && m.process === process);
    }
}
const neverStops = () => {
    const keeper = createFakeKeeper({ script: () => {} });
    keeper.stop = async (call) => { keeper.log.stops.push(call); await new Promise(() => {}); };
    return keeper;
};

test('F3: a flood of identical stops for one process collapses to one stop at the keeper and ends nothing', async (context) => {
    const keeper = neverStops();
    const rig = await createEndpointRig({ keeper });
    context.after(() => rig.dispose());
    await runningProcesses(rig, 1);
    for (let index = 0; index < 50; index += 1) rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(keeper.log.stops, [{ process: 1, graceMs: 30000 }]);
    assert.deepEqual(rig.endEvents, []);
    assert.deepEqual(rig.supervisor.ends, []);
});

test('F3: a flood of stops that each ask for a smaller grace ends as an ALA inbound overflow, not a supervisor violation', async (context) => {
    const keeper = neverStops();
    const rig = await createEndpointRig({ keeper });
    context.after(() => rig.dispose());
    await runningProcesses(rig, 1);
    for (let index = 0; index < 12; index += 1) rig.channel.fromAla({ type: 'stop', process: 1, graceMs: 30000 - index });
    assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
    assert.deepEqual(rig.endEvents, ['inbound_queue_overflow']);
    assert.equal(await waitFor(() => rig.supervisor.ends.length === 1), true);
    assert.deepEqual(rig.supervisor.ends, ['endpoint_failure:inbound_queue_overflow']);
});

test('F3: stops for many different processes are bounded by the same inbound queue', async (context) => {
    const keeper = neverStops();
    const rig = await createEndpointRig({ keeper });
    context.after(() => rig.dispose());
    await runningProcesses(rig, 6);
    for (let process = 1; process <= 6; process += 1) rig.channel.fromAla({ type: 'stop', process, graceMs: 30000 });
    assert.equal(await waitFor(() => rig.endEvents.length === 1), true);
    assert.deepEqual(rig.endEvents, ['inbound_queue_overflow']);
    assert.deepEqual(rig.supervisor.ends, ['endpoint_failure:inbound_queue_overflow']);
});

// ---------------------------------------------------------------------------------------------------------------
// F4: a realistic prompt passes, limits that cannot hold a request are refused, and a failed relay is answered.
const withDefaults = (extra = {}) => ({ ...ENDPOINT_LIMIT_DEFAULTS, ...extra });

test('F4: a 128 KiB prompt as the last argument (Codex and Pi put it there) passes the default limits and starts', async (context) => {
    const rig = await createEndpointRig({ limits: withDefaults() });
    context.after(() => rig.dispose());
    await rig.hello();
    const prompt = 'Explain "this" function\n'.repeat(6000).slice(0, 128 * 1024);
    assert.equal(Buffer.byteLength(prompt), 128 * 1024);
    rig.channel.fromAla({ type: 'start', process: 1, request: { ...VALID_START, args: ['exec', '--json', prompt] } });
    const started = await rig.channel.find((m) => m.type === 'started' || m.type === 'refused' || m.type === 'failure');
    assert.equal(started.message.type, 'started', JSON.stringify(started.message));
    assert.equal(rig.keeper.log.starts[0].request.args.at(-1).length, prompt.length);
});

test('F4: an oversize prompt is refused as an invalid request at every layer, never as an opaque provider failure', async (context) => {
    const rig = await createEndpointRig({ limits: withDefaults() });
    context.after(() => rig.dispose());
    await rig.hello();
    // Escape-heavy: 100 KiB of control characters encode to 6 bytes each, above the encoded-request bound but below the
    // message bound (a message above that bound is a channel-wide failure instead).
    rig.channel.fromAla({ type: 'start', process: 1, request: { ...VALID_START, args: ['exec', '\u0001'.repeat(100 * 1024)] } });
    rig.channel.fromAla({ type: 'start', process: 2, request: { ...VALID_START, args: ['exec', 'x'.repeat(ENDPOINT_LIMIT_DEFAULTS.maxArgBytes + 1)] } });
    const first = await rig.channel.find((m) => m.process === 1 && m.type !== 'hello');
    const second = await rig.channel.find((m) => m.process === 2 && m.type !== 'hello');
    for (const answer of [first, second]) {
        assert.equal(answer.message.type, 'refused', JSON.stringify(answer.message));
        assert.equal(answer.message.error.code, 'invalid_request');
    }
    assert.equal(rig.keeper.log.starts.length, 0);
});

test('F4: limits that contradict each other are refused when they are resolved', async () => {
    const { resolveEndpointLimits, frameEnvelopeBytes } = await import('../../server/execution/executionLimits.mjs');
    assert.doesNotThrow(() => resolveEndpointLimits({}));
    const d = ENDPOINT_LIMIT_DEFAULTS;
    assert.throws(() => resolveEndpointLimits({ maxFrameBytes: d.maxRequestBytes }), /maxFrameBytes must hold maxRequestBytes/);
    assert.throws(() => resolveEndpointLimits({ maxFrameBytes: d.maxRequestBytes + frameEnvelopeBytes(d) - 1 }), /maxFrameBytes/);
    assert.doesNotThrow(() => resolveEndpointLimits({ maxFrameBytes: d.maxRequestBytes + frameEnvelopeBytes(d) }));
    assert.throws(() => resolveEndpointLimits({ maxMessageBytes: d.maxRequestBytes }), /maxMessageBytes must hold/);
    assert.throws(() => resolveEndpointLimits({ maxArgBytes: d.maxRequestBytes + 1, maxFrameBytes: 4 * d.maxRequestBytes, maxMessageBytes: 4 * d.maxRequestBytes }), /single argument/);
    assert.throws(() => resolveEndpointLimits({ maxInboundQueue: 20 }), /maxInboundQueue/);
    // A schema-valid request therefore always fits a frame: the largest accepted encoding plus the envelope is a frame.
    assert.ok(d.maxRequestBytes + frameEnvelopeBytes(d) <= d.maxFrameBytes);
});

test('F4: a frame that cannot be encoded fails that request, clears its pending call and answers ALA', async (context) => {
    const channel = createFakeAlaChannel();
    const [far, near] = duplexPair();
    far.on('data', () => {});
    const limits = withDefaults();
    const endpoint = createProviderEndpoint({ channel, supervisorSocket: near, limits, streamDirectory: '/tmp/unused' });
    await endpoint.started;
    context.after(async () => { endpoint.fail('test_dispose'); await endpoint.closed; });
    channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    await channel.find((m) => m.type === 'hello');
    near.write = () => { throw new RangeError('Frame payload is outside the frame size bound'); };
    channel.fromAla({ type: 'inventory', id: 1 });
    const answer = await channel.find((m) => m.type === 'result' && m.id === 1);
    assert.deepEqual([answer.message.ok, answer.message.error.code], [false, 'endpoint_error']);
    assert.equal(endpoint.stats().pendingCalls, 0, 'no stale pending call is left behind');
    assert.equal(endpoint.stats().inboundPending, 0);
});
