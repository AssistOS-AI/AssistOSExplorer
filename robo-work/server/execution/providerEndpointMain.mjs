// Entry point of the provider endpoint process. The keeper starts it with ALA's provider channel as fd 3
// (NODE_CHANNEL_FD=3, JSON serialization) and the framed supervisor channel as fd 4. Its configuration is one JSON
// argument: { limits, streamDirectory, relays: [{ port, target }] }.
import net from 'node:net';

import { createProviderEndpoint } from './providerEndpoint.mjs';
import { resolveEndpointLimits } from './executionLimits.mjs';

const EXIT_QUIET = 0;
const EXIT_FAILURE = 70;
const EXIT_NO_CHANNEL = 78;

const config = JSON.parse(process.argv[2] ?? '{}');
const limits = resolveEndpointLimits(config.limits);
const supervisorSocket = new net.Socket({ fd: 4, readable: true, writable: true });

if (!process.connected || typeof process.send !== 'function') {
    process.exit(EXIT_NO_CHANNEL);
}

process.on('uncaughtException', (error) => {
    // Only the error class and code are written: stderr is diagnostic and carries no request data.
    process.stderr.write(`endpoint uncaught ${error?.name ?? 'Error'} ${error?.code ?? ''}\n`, () => process.exit(EXIT_FAILURE));
});

const endpoint = createProviderEndpoint({
    channel: process,
    supervisorSocket,
    limits,
    streamDirectory: config.streamDirectory,
    relays: config.relays ?? [],
    onEnd: (reason) => {
        const quiet = reason === 'ala_disconnected' || reason === 'supervisor_closed';
        endpoint.closed.then(() => process.exit(quiet ? EXIT_QUIET : EXIT_FAILURE));
        setTimeout(() => process.exit(quiet ? EXIT_QUIET : EXIT_FAILURE), 1000).unref();
    }
});
