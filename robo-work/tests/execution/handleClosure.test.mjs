import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { closeHandle } from '../../server/execution/channelTransport.mjs';
import { waitFor } from './helpers/duplexPair.mjs';

// F2. A handle that ALA sends is closed whatever it is. Sockets have destroy(); a listening net.Server and a dgram
// socket have only close(), so a closer that calls destroy() alone leaves the listener accepting until the process ends.
const child = fileURLToPath(new URL('./fixtures/handleChild.mjs', import.meta.url));

test('closeHandle destroys a socket, closes a server and a dgram socket, and ignores nothing else', async (context) => {
    const socketServer = net.createServer();
    const udp = dgram.createSocket('udp4');
    // Whatever closeHandle fails to close is closed here, so a failing assertion cannot keep the process alive.
    context.after(() => { try { socketServer.close(); } catch { /* closed */ } try { udp.close(); } catch { /* closed */ } });
    await new Promise((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
    closeHandle(socketServer);
    assert.equal(socketServer.listening, false);

    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
    closeHandle(udp);
    assert.throws(() => udp.address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });

    const socket = new net.Socket();
    closeHandle(socket);
    assert.equal(socket.destroyed, true);
    assert.doesNotThrow(() => closeHandle(undefined));
    assert.doesNotThrow(() => closeHandle({ close() { throw new Error('already closed'); } }));
});

for (const kind of ['server', 'dgram']) {
    test(`an ALA-sent ${kind} handle is closed while the endpoint process is still alive (closure is not process exit)`, async (context) => {
        const process_ = fork(child, [], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
        context.after(() => { if (process_.exitCode === null && process_.signalCode === null) process_.kill('SIGKILL'); });
        let text = '';
        process_.stdout.on('data', (chunk) => { text += chunk; });

        let handle;
        let port;
        context.after(() => { try { handle?.close(); } catch { /* closed */ } });
        if (kind === 'server') {
            handle = net.createServer();
            await new Promise((resolve) => handle.listen(0, '127.0.0.1', resolve));
            port = handle.address().port;
        } else {
            handle = dgram.createSocket('udp4');
            await new Promise((resolve) => handle.bind(0, '127.0.0.1', resolve));
            port = handle.address().port;
        }
        const sent = once(process_, 'message').catch(() => {});
        process_.send({ type: 'inventory', id: 1, port }, handle);
        void sent;
        // This process closes its own copy, so only the copy in the child could still be open.
        setTimeout(() => { try { handle.close(); } catch { /* already closed */ } }, 30);

        assert.equal(await waitFor(() => text.includes('\n'), 5000), true, 'the child reported');
        const report = JSON.parse(text.split('\n')[0]);
        assert.equal(report.detail, 'handle_from_ala');
        assert.equal(report.kind, kind === 'server' ? 'Server' : 'Socket');
        assert.equal(report.destroy, 'undefined', 'this handle type has no destroy(), which is why destroy() alone does not close it');
        assert.equal(report.close, 'function');
        assert.equal(report.closed, true, report.why);
        assert.equal(process_.exitCode, null, 'the child is still alive: it was closed by closeHandle, not by exiting');
        assert.equal(process_.signalCode, null);
    });
}
