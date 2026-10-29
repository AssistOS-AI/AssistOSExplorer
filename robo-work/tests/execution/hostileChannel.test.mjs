import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFakeKeeper } from './helpers/fakeKeeper.mjs';
import { runEndpointTopology } from './helpers/endpointTopology.mjs';
import { descriptorCount, waitFor } from './helpers/duplexPair.mjs';
import { lastJson, findPython, startTopology } from './helpers/topology.mjs';
import { attachSupervisor, conformanceAdmission } from './helpers/supervisorHarness.mjs';
import { spawnSync } from 'node:child_process';

// Channel-level hostile cases against a REAL endpoint process started with heap and descriptor bounds where Node and
// the platform allow them. A hostile "ALA" (Python, on the other end of the socket pair) attacks one execution while a
// well-behaved ALA uses a second one. This is bounded UNIT evidence on the Mac host, never G1 evidence: the endpoint is
// not inside an execution namespace, the bounds are provisional test values, and the supervisor is this test process.
const rawPeer = fileURLToPath(new URL('./fixtures/rawAlaPeer.py', import.meta.url));
const alaLoop = fileURLToPath(new URL('./fixtures/alaLoop.mjs', import.meta.url));
const MIB = 1024 * 1024;

const attack = (mode, args, options = {}) => runEndpointTopology({
    alaCommand: findPython(), alaScript: '-I', alaArgs: [rawPeer, mode, ...args.map(String)], ...options
});
const neighbour = (rounds = 25, interval = 100) => runEndpointTopology({
    alaScript: alaLoop, alaArgs: [rounds, interval], keeper: createFakeKeeper()
});

// Runs an attack and a neighbour concurrently and reports what the shared supervisor (this process) saw.
async function underAttack(mode, args, options) {
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    const [hostile, calm] = await Promise.all([attack(mode, args, options), neighbour()]);
    return { hostile, calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) };
}
const endedWith = (outcome) => outcome.hostile.supervisor.ends;
const RSS_BOUND = 96 * MIB; // PROVISIONAL recorded bound for the supervisor's resident-memory growth

// `after` is a function so that the supervisor's descriptor table can be re-read until the closed sockets are gone; the
// table must return to its baseline exactly, with no slack.
async function assertContained({ calm, before, after }, label) {
    assert.deepEqual(calm.ala, { rounds: 25, answered: 25, failure: null }, `${label}: the second execution kept being served`);
    assert.deepEqual(calm.supervisor.ends.length, 1, `${label}: the neighbour ended only by its own disconnect`);
    await waitFor(() => after().descriptors <= before.descriptors, 3000);
    const now = after();
    assert.ok(now.descriptors <= before.descriptors, `${label}: supervisor descriptors ${before.descriptors} -> ${now.descriptors}`);
    assert.ok(now.rss - before.rss < RSS_BOUND, `${label}: supervisor RSS grew by ${now.rss - before.rss}`);
}

test('an ALA that sends valid requests and never reads makes the endpoint end its execution at the outbound backlog bound', async () => {
    // The inbound bound is set well above the pacing jitter so that the outbound bound is the one that fires.
    const outcome = await underAttack('flood-never-read', [600, 5], {
        limits: { maxOutboundBacklogMessages: 16, maxInFlightRequests: 64, maxInboundQueue: 32 }
    });
    assert.deepEqual(endedWith(outcome), ['endpoint_failure:outbound_backlog']);
    assert.equal(outcome.hostile.exits.endpoint.code, 70);
    await assertContained(outcome, 'backlog');
});

test('a flood of valid messages above the inbound queue bound ends only that execution', async () => {
    const outcome = await underAttack('burst', [400]);
    assert.deepEqual(endedWith(outcome), ['endpoint_failure:inbound_queue_overflow']);
    assert.equal(outcome.hostile.exits.endpoint.code, 70);
    await assertContained(outcome, 'queue');
});

test('a line of hundreds of MiB without a newline ends the endpoint under its heap limit and no further than its own execution', async () => {
    const outcome = await underAttack('long-line', [768], { endpointFlags: ['--max-old-space-size=48'], timeoutS: 60 });
    const [endpoint] = [outcome.hostile.exits.endpoint];
    assert.ok(endpoint.code !== 0 || endpoint.signal !== null, `the endpoint ended abnormally: ${JSON.stringify(endpoint)}`);
    assert.equal(endedWith(outcome).length, 1);
    assert.match(endedWith(outcome)[0], /^(endpoint_lost|endpoint_failure:[a-z_]+)$/u);
    assert.ok(outcome.hostile.ala.sent < 768, `the hostile peer was cut off after ${outcome.hostile.ala.sent} MiB`);
    await assertContained(outcome, 'long line');
});

test('a message carrying a real descriptor in Node\'s handle framing is closed and fails the channel', async () => {
    const outcome = await attack('raw-handle', []);
    assert.deepEqual(outcome.supervisor.ends, ['endpoint_failure:handle_from_ala']);
    assert.equal(outcome.ala.failure, 'client messages carry no handles');
    assert.equal(outcome.ala.answered, false, 'the message that carried the descriptor was not served');
    assert.equal(outcome.ala.peerClosed, true, 'the endpoint closed the descriptor it was sent');
});

// R3-8. A raw sendmsg that carries many descriptors on an ordinary message never reaches endpoint code as a handle, so
// this asserts containment, not detection: no descriptor is delivered to or used by endpoint code, the endpoint stays
// at or below its RLIMIT_NOFILE, the supervisor stays within its recorded bound and a second execution keeps running.
test('a raw sendmsg carrying many descriptors is contained: bounded descriptors, no delivery to endpoint code, neighbour unaffected', async () => {
    const LIMIT = 80;
    const outcome = await underAttack('many-fds', [60, 6], { endpointRlimit: LIMIT });
    const ends = endedWith(outcome);
    assert.ok(ends.every((reason) => !reason.includes('handle_from_ala')), `endpoint code never saw a handle: ${ends}`);
    assert.ok(ends.length <= 1);
    if (ends.length === 0) {
        // The endpoint survived: it answered afterwards and its table stayed within the limit.
        assert.equal(outcome.hostile.ala.answered, true);
    }
    await assertContained(outcome, 'many descriptors');
});

// The endpoint's own table is full of relay connections. Node hides an EMFILE on accept (libuv accepts and closes the
// connection), so that part is containment, not detection: the endpoint stays within its limit, refuses the surplus
// clients and keeps serving. An EMFILE on the endpoint's own connect IS visible and ends the execution; that path is
// asserted deterministically in providerEndpoint.test.mjs with an injected error.
test('a flood of relay connections against a small descriptor limit stays within the limit, refuses the surplus and spares the neighbour', async () => {
    const LIMIT = 48;
    const clients = [];
    const upstream = net.createServer((socket) => socket.on('data', () => {}));
    const reserved = net.createServer();
    await new Promise((resolve) => reserved.listen(0, '127.0.0.1', resolve));
    const relayPort = reserved.address().port;
    await new Promise((resolve) => reserved.close(resolve));
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    let status = null;
    try {
        const [hostile, calm] = await Promise.all([
            runEndpointTopology({
                alaScript: alaLoop, alaArgs: [300, 30], endpointRlimit: LIMIT, limits: { maxRelayConnections: 1000 },
                relays: (directory) => [{ port: relayPort, target: path.join(directory, 'mcp.sock') }],
                during: async ({ directory, supervisor }) => {
                    await new Promise((resolve) => upstream.listen(path.join(directory, 'mcp.sock'), resolve));
                    for (let index = 0; index < 120 && supervisor.ends.length === 0; index += 1) {
                        const socket = net.connect(relayPort, '127.0.0.1');
                        socket.on('error', () => {});
                        clients.push(socket);
                        await new Promise((resolve) => setTimeout(resolve, 5));
                    }
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    status = supervisor.ends.length === 0 ? await supervisor.server.report() : null;
                    assert.ok(supervisor.ends.length === 0 || supervisor.ends[0] === 'endpoint_failure:descriptor_exhaustion', `ended ${supervisor.ends}`);
                    const refused = clients.filter((socket) => socket.destroyed).length;
                    assert.ok(refused > 0 || supervisor.ends.length > 0, 'the surplus clients were refused or the endpoint failed');
                    if (status) assert.ok(status.relayConnections * 2 <= LIMIT, `relay connections ${status.relayConnections} use at most ${LIMIT} descriptors`);
                }
            }),
            neighbour()
        ]);
        assert.ok(hostile.supervisor.ends.length <= 1);
        // The test's own sockets are released before the supervisor's table is compared with its baseline.
        for (const socket of clients) socket.destroy();
        await new Promise((resolve) => upstream.close(resolve));
        await assertContained({ calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) }, 'relay flood');
    } finally {
        for (const socket of clients) socket.destroy();
        if (upstream.listening) upstream.close();
    }
});

// The fd-4 parser is the last barrier before the shared supervisor: a compromised endpoint attacks it directly. The
// peer is a Python process holding the endpoint end of a real socket pair, and the parser is the production one.
const rawEndpointPeer = fileURLToPath(new URL('./fixtures/rawEndpointPeer.py', import.meta.url));
const kernelProbe = fileURLToPath(new URL('./fixtures/scmKernelProbe.py', import.meta.url));

async function attackFd4(mode, args, { keeper, limits } = {}) {
    const topology = startTopology({
        waitFor: ['endpoint'], timeoutS: 20, supervisors: ['sup'],
        children: [{ name: 'endpoint', command: findPython(), argv: ['-I', rawEndpointPeer, mode, ...args], fds: { 4: 'supervisor:sup' } }]
    });
    const supervisor = attachSupervisor({
        socket: topology.sockets.sup, admission: conformanceAdmission('/run/ep/streams'), keeper: keeper || createFakeKeeper(), limits
    });
    try {
        const ended = await topology.finished;
        return { supervisor, peer: lastJson(ended.outputs.endpoint), exits: ended.summary?.children, stderr: ended.stderr };
    } finally { await topology.stop(); }
}

test('fd 4: a length prefix above the maximum is refused before allocation and ends only that execution', async () => {
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    const [hostile, calm] = await Promise.all([attackFd4('oversize', []), neighbour()]);
    assert.deepEqual(hostile.supervisor.ends, ['channel_violation:oversize_frame']);
    assert.ok(hostile.supervisor.server.stats().peakRetained <= 4, 'nothing but the header was retained');
    await assertContained({ calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) }, 'fd 4 oversize');
});

test('fd 4: a partial frame that stalls ends only that execution at the deadline', async () => {
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    const [hostile, calm] = await Promise.all([attackFd4('partial', []), neighbour()]);
    assert.deepEqual(hostile.supervisor.ends, ['channel_violation:partial_frame_deadline']);
    await assertContained({ calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) }, 'fd 4 partial');
});

test('fd 4: more unanswered requests than the in-flight bound end only that execution', async () => {
    const keeper = createFakeKeeper();
    keeper.tempdir = () => new Promise(() => {});
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    const [hostile, calm] = await Promise.all([attackFd4('overflow', [30], { keeper }), neighbour()]);
    assert.deepEqual(hostile.supervisor.ends, ['channel_violation:in_flight_overflow']);
    await assertContained({ calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) }, 'fd 4 overflow');
});

test('fd 4: an endpoint that sends valid requests and never reads the answers cannot grow the supervisor without bound', async () => {
    const before = { descriptors: descriptorCount(), rss: process.memoryUsage().rss };
    const [hostile, calm] = await Promise.all([attackFd4('never-read', [3000]), neighbour()]);
    assert.deepEqual(hostile.supervisor.ends, ['channel_violation:in_flight_overflow']);
    assert.ok(hostile.peer.sent < 3000, `the peer was cut off after ${hostile.peer.sent} requests`);
    assert.ok(hostile.supervisor.server.stats().buffered <= 16 * 1024, 'unflushed answers stayed within a few frames');
    await assertContained({ calm, before, after: () => ({ descriptors: descriptorCount(), rss: process.memoryUsage().rss }) }, 'fd 4 never-read');
});

test('R3-7 descriptor discard on fd 4: holds only where the kernel discards; FALSIFIED on this Darwin host (descriptors are installed and leaked)', async () => {
    const probe = JSON.parse(spawnSync(findPython(), ['-I', kernelProbe], { encoding: 'utf8' }).stdout);
    const before = descriptorCount();
    const hostile = await attackFd4('scm', [20]);
    assert.equal(hostile.peer.sent, 60, 'descriptors were really attached');
    assert.equal(hostile.supervisor.server.stats().requestsHandled, 3, 'the carrying frames were parsed and served');
    const delta = descriptorCount() - before;
    if (probe.behavior === 'discards') assert.equal(delta, 0);
    else assert.ok(delta > 0, `this kernel installs the descriptors of a plain read(): the table grew by ${delta} (R3-7 not satisfied on this host)`);
});
