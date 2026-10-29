// The ALA side of the full-stack symmetric check: a second Node process started with NODE_CHANNEL_FD=3 by the non-Node
// parent. It talks to the REAL provider endpoint, which relays to the real supervisor validator behind a fake keeper.
//   node alaScenario.mjs <json: { variant }>        variants: normal | handle-with-message
import net from 'node:net';
import { once } from 'node:events';
import { knownPayload } from '../helpers/payload.mjs';

const config = JSON.parse(process.argv[2] || '{}');
const expected = knownPayload();
const result = {
    connected: process.connected, helloReceived: false, inventory: null, startedReceived: false, streams: [], payloadMatches: false,
    endOfStream: false, receivedBytes: 0, exitReceived: false, exitAfterStreams: false, channelFailure: null, handleSent: false,
    handleFailureReceived: false, handlePeerClosed: false, error: null
};
const inbox = [];
const waiters = [];
const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
process.on('message', (message, handle) => { inbox.push({ message, handle }); wake(); });
process.on('disconnect', wake);

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
const failed = (entry) => {
    if (entry?.message.type === 'failure') { result.channelFailure = entry.message.error; return true; }
    return false;
};
const START = {
    processClass: 'run', executable: 'codex', args: ['payload'], env: {}, home: '/home/robot', cwd: '/projects/g',
    folders: [{ path: '/projects/g', access: 'read' }], exclusions: [], communication: { kind: 'streams', stdin: 'ignore' },
    lifecycle: { stopGraceMs: 2000 }, network: 'robot-egress', requirements: { privateProc: true }
};

async function sendHandleWithMessage(message) {
    const { kept, passed } = await pair();
    const closed = new Promise((resolve) => { kept.once('close', () => resolve(true)); kept.resume(); });
    result.handleSent = await send(message, passed);
    const entry = await next((m) => m.type === 'result');
    result.handleFailureReceived = entry?.message.type === 'failure';
    if (result.handleFailureReceived) result.channelFailure = entry.message.error;
    result.handlePeerClosed = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
}

async function run() {
    if (!process.connected) return;
    await send({ type: 'hello', protocol: 'ala-execution-provider', versions: [1] });
    let entry = await next((m) => m.type === 'hello');
    if (failed(entry)) return;
    result.helloReceived = entry?.message.type === 'hello';
    if (!result.helloReceived) return;
    if (config.variant === 'handle-with-message') { await sendHandleWithMessage({ type: 'inventory', id: 1 }); return; }

    await send({ type: 'inventory', id: 1 });
    entry = await next((m) => m.type === 'result');
    if (failed(entry)) return;
    result.inventory = entry?.message.value ?? null;

    await send({ type: 'start', process: 1, request: START });
    entry = await next((m) => m.type === 'started' || m.type === 'refused');
    if (failed(entry)) return;
    result.startedReceived = entry?.message.type === 'started';
    const handles = {};
    for (let count = 0; count < 2; count += 1) {
        entry = await next((m) => m.type === 'stream');
        if (failed(entry) || !entry) return;
        result.streams.push(entry.message.stream);
        handles[entry.message.stream] = entry.handle;
    }
    for (const [name, handle] of Object.entries(handles)) {
        const chunks = [];
        const ended = new Promise((resolve) => handle.once('end', () => resolve(true)));
        handle.on('data', (chunk) => chunks.push(chunk));
        handle.resume();
        const sawEnd = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(false), 3000))]);
        const received = Buffer.concat(chunks);
        if (name === 'stdout') {
            result.endOfStream = sawEnd;
            result.receivedBytes = received.length;
            result.payloadMatches = received.equals(expected);
        } else if (!sawEnd || received.length !== 0) result.error = 'stderr was not an empty stream with an end';
        handle.destroy();
    }
    entry = await next((m) => m.type === 'exit');
    if (failed(entry)) return;
    result.exitReceived = entry?.message.type === 'exit';
    result.exitAfterStreams = result.exitReceived && result.streams.length === 2;
    await sendHandleWithMessage({ type: 'inventory', id: 2 });
}

run().catch((error) => { result.error = String(error.message); }).finally(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
});
