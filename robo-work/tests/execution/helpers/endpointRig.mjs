import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { createProviderEndpoint } from '../../../server/execution/providerEndpoint.mjs';
import { createFakeKeeper } from './fakeKeeper.mjs';
import { duplexPair, waitFor } from './duplexPair.mjs';
import { attachSupervisor, conformanceAdmission, testLimits } from './supervisorHarness.mjs';
import { removeDirectory, shortTempDirectory } from './topology.mjs';

// A fake of the Node IPC channel that ALA would be on the other end of. Messages go through JSON like the real one.
// `holdCallbacks` makes it behave like an ALA that has stopped reading: no send callback ever fires.
export function createFakeAlaChannel({ holdCallbacks = false } = {}) {
    const channel = new EventEmitter();
    channel.connected = true;
    channel.sent = [];
    channel.send = (message, handle, callback) => {
        if (typeof handle === 'function') { callback = handle; handle = undefined; }
        if (!channel.connected) throw Object.assign(new Error('channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
        channel.sent.push({ message: JSON.parse(JSON.stringify(message)), handle, bytesRead: handle?.bytesRead });
        if (!holdCallbacks) setImmediate(() => callback?.(null));
        return true;
    };
    channel.disconnect = () => {
        if (!channel.connected) return;
        channel.connected = false;
        setImmediate(() => channel.emit('disconnect'));
    };
    // What ALA does: deliver a message (and optionally a handle) to the endpoint.
    channel.fromAla = (message, handle) => channel.emit('message', JSON.parse(JSON.stringify(message)), handle);
    channel.messages = () => channel.sent.map((entry) => entry.message);
    channel.find = (predicate, limit) => waitFor(() => channel.sent.find((entry) => predicate(entry.message)), limit);
    return channel;
}

export const VALID_START = Object.freeze({
    processClass: 'run', executable: 'codex', args: ['run'], env: {}, home: '/home/robot', cwd: '/projects/g',
    folders: [{ path: '/projects/g', access: 'read' }], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' },
    lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true }
});
export const SERVICE_START = Object.freeze({
    ...VALID_START, processClass: 'service', args: ['serve'],
    communication: { kind: 'service', endpoint: 'loopback-port', stdin: 'ignore' },
    lifecycle: { stopGraceMs: 2000, ready: { condition: 'announced-endpoint', timeoutMs: 1000 } }
});

// The endpoint in this process, wired to the real supervisor server and a fake keeper.
export async function createEndpointRig({ limits = {}, keeper, relays = [], holdCallbacks = false } = {}) {
    const directory = shortTempDirectory('rw-rig');
    const streamDirectory = path.join(directory, 's');
    fs.mkdirSync(streamDirectory);
    const channel = createFakeAlaChannel({ holdCallbacks });
    const [supervisorSide, endpointSide] = duplexPair();
    const fakeKeeper = keeper || createFakeKeeper();
    let resolved;
    try { resolved = testLimits(limits); } catch (error) { removeDirectory(directory); throw error; }
    const supervisor = attachSupervisor({ socket: supervisorSide, admission: conformanceAdmission(streamDirectory), keeper: fakeKeeper, limits: resolved });
    const endEvents = [];
    const endpoint = createProviderEndpoint({
        channel, supervisorSocket: endpointSide, limits: resolved, streamDirectory, relays, onEnd: (reason) => endEvents.push(reason)
    });
    await endpoint.started;
    const hello = async () => {
        channel.fromAla({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
        await channel.find((message) => message.type === 'hello');
    };
    return {
        channel, endpoint, supervisor, keeper: fakeKeeper, directory, streamDirectory, endEvents, hello,
        streamEntries: () => fs.readdirSync(streamDirectory),
        // Always removes what the rig created, even when the endpoint does not close in time.
        dispose: async () => {
            try {
                endpoint.fail('test_dispose');
                await Promise.race([endpoint.closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
            } finally {
                for (const entry of channel.sent) entry.handle?.destroy?.();
                fakeKeeper.closeAll?.();
                supervisorSide.destroy();
                endpointSide.destroy();
                removeDirectory(directory);
            }
        }
    };
}
