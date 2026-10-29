// The ALA-facing end of the production createAlaChannel, as a real IPC child, for handles that are not sockets. The
// parent sends a net.Server or a dgram socket together with a message. After the channel has failed on it, this child
// reports whether the handle it received is closed, and stays alive: a handle closed only by process exit does not count.
import net from 'node:net';
import { createAlaChannel } from '../../../server/execution/channelTransport.mjs';
import { resolveEndpointLimits } from '../../../server/execution/executionLimits.mjs';

let received = null;
let port = null;
// Observe the raw handle before the production handler closes it.
process.prependListener('message', (message, handle) => {
    port = message?.port ?? null;
    received = handle ? { handle, constructor: handle.constructor?.name, destroy: typeof handle.destroy, close: typeof handle.close } : null;
});

async function closed() {
    const { handle } = received;
    if (received.constructor === 'Server') {
        if (handle.listening) return { closed: false, why: 'the server is still listening' };
        // Nothing may still accept on the port.
        const refused = await new Promise((resolve) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.on('connect', () => { socket.destroy(); resolve(false); });
            socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
        });
        return { closed: refused, why: refused ? 'connection refused' : 'still accepting' };
    }
    try { handle.address(); return { closed: false, why: 'the dgram socket still has an address' }; } catch (error) {
        return { closed: error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING', why: error.code };
    }
}

createAlaChannel(process, {
    limits: resolveEndpointLimits(), onMessage() {}, onClose() {},
    onFailure: (detail) => {
        setTimeout(async () => {
            const state = received ? await closed() : { closed: null, why: 'no handle arrived' };
            process.stdout.write(`${JSON.stringify({ detail, kind: received?.constructor, destroy: received?.destroy, close: received?.close, ...state, pid: process.pid })}\n`);
        }, 80);
    }
});
setInterval(() => {}, 1000);
