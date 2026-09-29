import net from 'node:net';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/;

// Only task notifications travel here; MCP requests use the real Ploinky client.
export async function createTaskEventSocket({ socketPath, token, onTask }) {
    const receipts = new Map();
    const pending = new Set();
    const connections = new Set();
    const server = net.createServer(socket => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
        socket.on('error', () => {});
        socket.setTimeout(15000, () => socket.destroy());
        let bytes = Buffer.alloc(0);
        let received = false;
        socket.on('data', chunk => {
            if (received) return;
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > MAX_BYTES) { socket.destroy(); return; }
            const newline = bytes.indexOf(10);
            if (newline < 0) return;
            received = true;
            const handle = async () => {
                let message;
                try {
                    message = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
                    if (message.token !== token || !UUID.test(message.id) || message.event?.type !== 'task-started'
                        || typeof message.event.task?.taskId !== 'string' || !message.event.task.taskId) {
                        throw new Error('Invalid task notification.');
                    }
                    const hash = createHash('sha256').update(JSON.stringify(message.event)).digest('hex');
                    let receipt = receipts.get(message.id);
                    if (receipt && receipt.hash !== hash) throw new Error('Conflicting task notification.');
                    if (!receipt) {
                        if (receipts.size >= 10000) throw new Error('Too many task notifications.');
                        receipt = { hash, done: Promise.resolve().then(() => onTask(message.event.task)) };
                        receipts.set(message.id, receipt);
                        receipt.done.catch(() => receipts.delete(message.id));
                    }
                    await receipt.done;
                    socket.end(JSON.stringify({ id: message.id, ok: true }) + '\n');
                } catch {
                    socket.end(JSON.stringify({ id: message?.id, ok: false, error: 'Task notification was not accepted.' }) + '\n');
                }
            };
            const work = handle();
            pending.add(work);
            work.finally(() => pending.delete(work));
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    let closing;
    return { close() { return closing ||= (async () => {
        const closed = new Promise(resolve => server.close(resolve));
        // No backend processes remain when the host closes; drain accepted notifications.
        await Promise.allSettled([...pending]);
        for (const socket of connections) socket.end();
        await closed;
    })(); } };
}
