import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// JSONL test client for the Live Sessions IPC server.
export async function ipcClient(socketPath) {
    const socket = net.connect(socketPath);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.setEncoding('utf8');
    const messages = [];
    const waiters = [];
    let buffer = '';
    let closed = false;
    const closedPromise = new Promise((resolve) => socket.once('close', () => { closed = true; resolve(); for (const waiter of waiters.splice(0)) waiter.reject(new Error('connection closed')); }));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
            const message = JSON.parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            messages.push(message);
            for (const waiter of [...waiters]) {
                if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
            }
            newline = buffer.indexOf('\n');
        }
    });
    const client = {
        socket,
        messages,
        get closed() { return closed; },
        closedPromise,
        send(message) { socket.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`); },
        raw(text) { socket.write(text); },
        next(match, timeoutMs = 2000) {
            const predicate = typeof match === 'string' ? (message) => message.type === match : match;
            const found = messages.find(predicate);
            if (found) { messages.splice(messages.indexOf(found), 1); return Promise.resolve(found); }
            if (closed) return Promise.reject(new Error('connection closed'));
            return new Promise((resolve, reject) => {
                const waiter = { match: predicate, resolve: (message) => { messages.splice(messages.indexOf(message), 1); resolve(message); }, reject };
                waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('timed out waiting for IPC message')); }, timeoutMs);
                waiters.push(waiter);
            });
        },
        async hello() {
            client.send({ type: 'hello', pid: process.pid, start: 'test', boot: 'test' });
            return client.next('welcome');
        },
        async start(fields) {
            client.send({ type: 'run-start', kind: 'copilot-turn', title: 'Turn', cwd: 'project', robot: 'default', ...fields });
            return client.next((message) => ['run-id', 'run-refused'].includes(message.type) && message.localRef === fields.localRef);
        },
        close() { socket.destroy(); return closedPromise; },
    };
    return client;
}

// A short private socket path (macOS limits Unix socket paths to 104 bytes).
// The caller removes the root with cleanup() after closing its listener, so
// the listener's own identity-checked cleanup runs first.
export async function socketFixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lsipc-')));
    return { root, socketPath: path.join(root, 'roboteam-live', 'registry.sock'),
        cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
