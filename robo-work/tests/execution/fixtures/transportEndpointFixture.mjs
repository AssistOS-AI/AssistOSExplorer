// Test-only stand-in for the provider endpoint, reduced to the transport. It runs as one of the two Node processes
// that the non-Node parent starts with NODE_CHANNEL_FD=3. It uses the production transport module and adds, as a
// test-only variant, the endpoint defects that the negative controls must expose.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createAlaChannel, passPausedSocket } from '../../../server/execution/channelTransport.mjs';
import { resolveEndpointLimits } from '../../../server/execution/executionLimits.mjs';
import { knownPayload } from '../helpers/payload.mjs';

const config = JSON.parse(process.argv[2]);
const result = { helloSeen: false, inventoryAnswered: false, transferred: false, handleDetected: null, error: null };
const finish = (code) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
};

async function transfer(ala) {
    const payload = knownPayload();
    const socketPath = path.join(config.directory, 'stream.sock');
    const server = net.createServer({ pauseOnConnect: true });
    server.listen(socketPath);
    await once(server, 'listening');
    const accepted = once(server, 'connection');
    // The peer stands in for the keeper: it writes the payload and half-closes BEFORE the endpoint passes the socket.
    const peer = net.connect(socketPath);
    await once(peer, 'connect');
    peer.end(payload);
    await once(peer, 'finish');
    const [socket] = await accepted;
    server.close();
    fs.rmSync(socketPath, { force: true });
    if (config.variant === 'read-one-byte') {
        // The defect: the endpoint reads before it passes. The production guard must refuse the transfer.
        await new Promise((resolve) => socket.once('readable', resolve));
        socket.read(1);
        await passPausedSocket(process, { type: 'stream', stream: 'stdout' }, socket);
    } else if (config.variant === 'read-one-byte-unguarded') {
        // The same defect with the guard bypassed, so that the check's own byte comparison is what must catch it.
        await new Promise((resolve) => socket.once('readable', resolve));
        socket.read(1);
        await ala.send({ type: 'stream', stream: 'stdout' }, socket);
    } else {
        await passPausedSocket(process, { type: 'stream', stream: 'stdout' }, socket);
    }
    result.transferred = true;
}

const ala = createAlaChannel(process, {
    limits: resolveEndpointLimits(),
    onMessage: (message) => {
        if (message.type === 'hello') {
            result.helloSeen = true;
            ala.send({ type: 'hello', protocol: 'ala-execution-provider', version: 1 });
        } else if (message.type === 'inventory') {
            result.inventoryAnswered = true;
            ala.send({ type: 'result', id: message.id, ok: true, value: [{ name: 'codex' }] });
        } else if (message.type === 'transfer') {
            transfer(ala).catch((error) => {
                result.error = String(error.message);
                ala.fail('protocol', 'transfer failed', 'transfer_failed');
            });
        }
    },
    onFailure: (detail) => { result.handleDetected = detail; },
    onClose: () => finish(0)
});
