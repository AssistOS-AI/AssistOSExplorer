// Test-only stand-in for ALA, the second Node process started with NODE_CHANNEL_FD=3 by the non-Node parent. It
// performs the steps of the symmetric check and prints one JSON result line. The parent and the test decide pass or
// fail from that line and from the exit status, never from a crash trace.
import net from 'node:net';
import { once } from 'node:events';
import { knownPayload } from '../helpers/payload.mjs';

const config = JSON.parse(process.argv[2]);
const expected = knownPayload();
const result = {
    connected: process.connected, helloReceived: false, inventoryReceived: false, channelFailure: null,
    streamReceived: false, payloadMatches: false, endOfStream: false, receivedBytes: 0,
    handleSent: false, handleFailureReceived: false, handlePeerClosed: false
};
const inbox = [];
const waiters = [];
process.on('message', (message, handle) => {
    inbox.push({ message, handle });
    for (const waiter of waiters.splice(0)) waiter();
});
process.on('disconnect', () => { for (const waiter of waiters.splice(0)) waiter(); });

async function next(predicate, limitMs = 5000) {
    const deadline = Date.now() + limitMs;
    for (;;) {
        const index = inbox.findIndex((entry) => predicate(entry.message) || entry.message.type === 'failure');
        if (index >= 0) return inbox.splice(index, 1)[0];
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !process.connected) return null;
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, Math.min(remaining, 100)); });
    }
}

const send = (message, handle) => new Promise((resolve) => {
    try { process.send(message, handle, (error) => resolve(!error)); } catch { resolve(false); }
});

async function pair() {
    const server = net.createServer({ pauseOnConnect: true });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted = once(server, 'connection');
    const kept = net.connect(server.address().port, '127.0.0.1');
    await once(kept, 'connect');
    const [passed] = await accepted;
    server.close();
    return { kept, passed };
}

async function run() {
    if (!process.connected) return;
    await send({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    let entry = await next((message) => message.type === 'hello');
    if (entry?.message.type === 'failure') { result.channelFailure = entry.message.error; return; }
    result.helloReceived = entry?.message.type === 'hello';
    if (!result.helloReceived) return;

    if (config.variant === 'handle-with-message') {
        // The defect: ALA attaches a handle to an ordinary message. The endpoint must answer a channel-wide failure.
        const { kept, passed } = await pair();
        const closed = new Promise((resolve) => { kept.once('close', () => resolve(true)); kept.resume(); });
        result.handleSent = await send({ type: 'inventory', id: 1 }, passed);
        entry = await next((message) => message.type === 'result');
        if (entry?.message.type === 'failure') result.channelFailure = entry.message.error;
        result.handlePeerClosed = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
        return;
    }

    await send({ type: 'inventory', id: 1 });
    entry = await next((message) => message.type === 'result');
    if (entry?.message.type === 'failure') { result.channelFailure = entry.message.error; return; }
    result.inventoryReceived = entry?.message.type === 'result';

    await send({ type: 'transfer' });
    entry = await next((message) => message.type === 'stream');
    if (entry?.message.type === 'failure') { result.channelFailure = entry.message.error; return; }
    if (entry?.handle) {
        result.streamReceived = true;
        const chunks = [];
        const ended = new Promise((resolve) => { entry.handle.once('end', () => resolve(true)); });
        entry.handle.on('data', (chunk) => chunks.push(chunk));
        entry.handle.resume();
        result.endOfStream = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
        const received = Buffer.concat(chunks);
        result.receivedBytes = received.length;
        result.payloadMatches = received.equals(expected);
        entry.handle.destroy();
    }

    // An ALA-sent handle is detected and closed by the endpoint, which answers a channel-wide failure.
    const { kept, passed } = await pair();
    const closed = new Promise((resolve) => { kept.once('close', () => resolve(true)); kept.resume(); });
    result.handleSent = await send({ type: 'inventory', id: 2 }, passed);
    entry = await next((message) => message.type === 'result');
    result.handleFailureReceived = entry?.message.type === 'failure';
    result.handlePeerClosed = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
}

run().catch((error) => { result.error = String(error.message); }).finally(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
});
