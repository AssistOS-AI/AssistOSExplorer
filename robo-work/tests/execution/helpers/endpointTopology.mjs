import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeKeeper } from './fakeKeeper.mjs';
import { alaRoot } from './alaSuite.mjs';
import { TEST_LIMITS, attachSupervisor, conformanceAdmission, testLimits } from './supervisorHarness.mjs';
import { lastJson, nodeChannelEnvironment, removeDirectory, shortTempDirectory, startTopology } from './topology.mjs';

const endpointMain = fileURLToPath(new URL('../../../server/execution/providerEndpointMain.mjs', import.meta.url));

// Starts the REAL provider endpoint and an ALA-side script under the non-Node parent, with this test process serving
// fd 4 through the real supervisor server and a fake keeper.
//
// options.alaScript, options.alaArgs        the ALA-side Node script and its arguments
// options.limits                            endpoint limit overrides (the supervisor side uses the same values)
// options.endpointFlags, endpointRlimit     Node flags and RLIMIT_NOFILE for the endpoint process
// options.relays                            [{ port, target }] hosted by the endpoint
// options.keeper                            a keeper (default: createFakeKeeper())
// options.onDirectory(directory)            called with the short temp directory before anything starts
export async function runEndpointTopology(options) {
    const directory = shortTempDirectory('rw-ep');
    const streamDirectory = path.join(directory, 's');
    fs.mkdirSync(streamDirectory);
    options.onDirectory?.(directory);
    const limits = testLimits(options.limits);
    const keeper = options.keeper || createFakeKeeper();
    const relays = typeof options.relays === 'function' ? options.relays(directory) : options.relays ?? [];
    const config = JSON.stringify({ limits: { ...TEST_LIMITS, ...options.limits }, streamDirectory, relays });
    const topology = startTopology({
        pairs: ['channel'], supervisors: ['sup'], waitFor: options.waitFor || ['ala', 'endpoint'], timeoutS: options.timeoutS || 30,
        children: [
            {
                name: 'endpoint', env: nodeChannelEnvironment(), argv: [endpointMain, config],
                nodeFlags: options.endpointFlags, rlimitNofile: options.endpointRlimit,
                fds: { 3: 'pair:channel:0', 4: 'supervisor:sup', ...options.endpointFds }
            },
            {
                name: 'ala', env: nodeChannelEnvironment({ ALA_ROOT: alaRoot(), ...options.alaEnv }),
                command: options.alaCommand, argv: [options.alaScript, ...(options.alaArgs || [])], fds: { 3: 'pair:channel:1', ...options.alaFds }
            }
        ]
    });
    const supervisor = attachSupervisor({
        socket: topology.sockets.sup, admission: options.admission ? options.admission(streamDirectory) : conformanceAdmission(streamDirectory), sandbox: keeper, limits
    });
    try {
        // With `during`, the test drives the running topology and the harness then ends it by the recorded parent.
        if (options.during) {
            try { await options.during({ topology, supervisor, keeper, directory, streamDirectory }); } finally { await topology.stop(); }
        }
        const ended = await topology.finished;
        return {
            ala: lastJson(ended.outputs.ala), exits: ended.summary?.children || {}, timedOut: ended.summary?.timedOut,
            supervisor, keeper, stderr: ended.stderr, directory, streamDirectory, topology, outputs: ended.outputs
        };
    } finally {
        await topology.stop();
        removeDirectory(directory);
    }
}
