import { fileURLToPath } from 'node:url';
import { runEndpointTopology } from './endpointTopology.mjs';
import { createFakeKeeper } from './fakeKeeper.mjs';
import { knownPayload } from './payload.mjs';
import { lastJson, nodeChannelEnvironment, removeDirectory, shortTempDirectory, startTopology } from './topology.mjs';

const endpointScript = fileURLToPath(new URL('../fixtures/transportEndpointFixture.mjs', import.meta.url));
const alaScript = fileURLToPath(new URL('../fixtures/transportAlaFixture.mjs', import.meta.url));

// The transport-only symmetric check (plan section 5.5): a non-Node parent creates a socket pair and starts two Node
// processes with NODE_CHANNEL_FD=3. The decision is made here from the two result lines and the exit statuses.
//
// options.endpointVariant: normal | read-one-byte | read-one-byte-unguarded
// options.alaVariant: normal | handle-with-message
// options.endpointChannel / options.alaChannel: the source bound to fd 3 (default: its end of the socket pair)
export async function runTransportCheck(options = {}) {
    const directory = shortTempDirectory('rw-sym');
    const topology = startTopology({
        pairs: ['channel'], waitFor: ['ala', 'endpoint'], timeoutS: 25,
        children: [
            {
                name: 'endpoint', env: nodeChannelEnvironment(),
                argv: [endpointScript, JSON.stringify({ variant: options.endpointVariant || 'normal', directory })],
                fds: { 3: options.endpointChannel || 'pair:channel:0' }
            },
            {
                name: 'ala', env: nodeChannelEnvironment(),
                argv: [alaScript, JSON.stringify({ variant: options.alaVariant || 'normal' })],
                fds: { 3: options.alaChannel || 'pair:channel:1' }
            }
        ]
    });
    try {
        const ended = await topology.finished;
        const endpoint = lastJson(ended.outputs.endpoint);
        const ala = lastJson(ended.outputs.ala);
        const exits = ended.summary?.children || {};
        const reasons = [];
        const need = (condition, reason) => { if (!condition) reasons.push(reason); };
        need(ended.summary !== null && ended.summary.timedOut === false, 'the topology did not finish in time');
        need(exits.endpoint?.code === 0, 'the endpoint process did not exit cleanly');
        need(exits.ala?.code === 0, 'the ALA process did not exit cleanly');
        need(endpoint !== null, 'the endpoint produced no result');
        need(ala !== null, 'the ALA fixture produced no result');
        if (endpoint && ala) {
            need(ala.connected === true, 'ALA had no connected channel');
            need(endpoint.helloSeen === true && ala.helloReceived === true, 'the hello exchange did not complete');
            need(endpoint.inventoryAnswered === true && ala.inventoryReceived === true, 'the JSON request exchange did not complete');
            need(ala.channelFailure === null, 'a channel-wide failure arrived during the exchange');
            need(ala.streamReceived === true, 'no paused socket arrived');
            need(ala.payloadMatches === true, `the payload was not received exactly (${ala.receivedBytes} bytes)`);
            need(ala.endOfStream === true, 'the end-of-stream was lost');
            need(ala.handleSent === true && ala.handleFailureReceived === true, 'the ALA-sent handle drew no channel-wide failure');
            need(ala.handlePeerClosed === true, 'the ALA-sent handle was not closed by the endpoint');
            need(endpoint.handleDetected === 'handle_from_ala', 'the endpoint did not detect the ALA-sent handle');
        }
        return { ok: reasons.length === 0, reasons, endpoint, ala, exits, stderr: ended.stderr };
    } finally {
        await topology.stop();
        removeDirectory(directory);
    }
}

// The full-stack variant: the REAL provider endpoint (providerEndpointMain.mjs), fd 4 served by the REAL supervisor
// request validator with a deterministic fake keeper. The workload's side of stdout writes the known payload and
// half-closes before the keeper reports the start, so the endpoint passes a socket that already holds the payload and
// the end-of-stream.
//
// options.variant: normal | handle-with-message
// options.endpointChannel: the source bound to the endpoint's fd 3 (default: its end of the socket pair)

const scenarioScript = fileURLToPath(new URL('../fixtures/alaScenario.mjs', import.meta.url));

export async function runFullStackCheck(options = {}) {
    const keeper = createFakeKeeper({
        script: ({ sockets, exit }) => { sockets.stdout.end(knownPayload()); sockets.stderr.end(); exit(0); }
    });
    const run = await runEndpointTopology({
        alaScript: scenarioScript, alaArgs: [JSON.stringify({ variant: options.variant || 'normal' })], keeper,
        ...(options.endpointChannel ? { endpointFds: { 3: options.endpointChannel } } : {})
    });
    const ala = run.ala;
    const reasons = [];
    const need = (condition, reason) => { if (!condition) reasons.push(reason); };
    need(run.timedOut === false, 'the topology did not finish in time');
    need(run.exits.ala?.code === 0, 'the ALA process did not exit cleanly');
    need(ala !== null, 'the ALA fixture produced no result');
    if (ala) {
        need(ala.connected === true && ala.helloReceived === true, 'the hello exchange did not complete');
        need(Array.isArray(ala.inventory) && ala.inventory.length === 2, 'the inventory was not answered through the supervisor');
        need(ala.startedReceived === true, 'the start was not admitted and started');
        need(ala.streams.length === 2, 'both standard streams were not delivered');
        need(ala.payloadMatches === true, `the payload was not received exactly (${ala.receivedBytes} bytes)`);
        need(ala.endOfStream === true, 'the end-of-stream was lost');
        need(ala.exitAfterStreams === true, 'exit did not follow every stream');
        need(ala.channelFailure === null || ala.handleFailureReceived === true, 'a channel-wide failure arrived before the handle step');
        need(ala.handleSent === true && ala.handleFailureReceived === true, 'the ALA-sent handle drew no channel-wide failure');
        need(ala.handlePeerClosed === true, 'the ALA-sent handle was not closed by the endpoint');
    }
    need(run.supervisor.ends.includes('endpoint_failure:handle_from_ala'), 'the supervisor was not told of the ALA-sent handle');
    return { ok: reasons.length === 0, reasons, ala, exits: run.exits, ends: run.supervisor.ends, stderr: run.stderr };
}
