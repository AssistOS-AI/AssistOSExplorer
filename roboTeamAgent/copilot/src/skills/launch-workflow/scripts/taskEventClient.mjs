import net from 'node:net';
import { randomUUID } from 'node:crypto';

export async function sendTaskEvent(socketPath, token, event, { id = randomUUID(), timeoutMs = 20000 } = {}) {
    const message = JSON.stringify({ id, token, event }) + '\n';
    if (Buffer.byteLength(message) > 1024 * 1024) throw new Error('Task notification exceeds 1 MiB.');
    let failure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await new Promise((resolve, reject) => {
                const socket = net.createConnection(socketPath);
                let buffer = '';
                let done = false;
                const finish = error => {
                    if (done) return;
                    done = true;
                    socket.destroy();
                    if (error) reject(error); else resolve();
                };
                socket.setTimeout(timeoutMs, () => finish(new Error('Task notification acknowledgement timed out.')));
                socket.on('error', finish);
                socket.on('close', () => finish(new Error('Task notification channel closed before acknowledgement.')));
                socket.on('connect', () => socket.write(message));
                socket.setEncoding('utf8');
                socket.on('data', chunk => {
                    buffer += chunk;
                    if (buffer.length > 4096) return finish(new Error('Invalid task acknowledgement.'));
                    const end = buffer.indexOf('\n');
                    if (end < 0) return;
                    try {
                        const ack = JSON.parse(buffer.slice(0, end));
                        if (ack.id !== id || ack.ok !== true) throw new Error('Task notification was not accepted.');
                        finish();
                    } catch (error) { finish(error); }
                });
            });
            return;
        } catch (error) { failure = error; }
    }
    throw failure;
}
