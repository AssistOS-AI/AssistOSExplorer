import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { GIT_HOST } from './git-credentials.mjs';

export const GIT_CREDENTIAL_SOCKET = 'git-credentials.sock';

function send(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
}

// As for the Soul Gateway socket, only a host-shared mount that cannot store a socket mode is tolerated.
async function restrictSocket(socketPath, log) {
    try { await fs.chmod(socketPath, 0o600); }
    catch (error) {
        if (error.code !== 'EINVAL') throw error;
        log(`[git-credentials] socket permissions cannot be set on this filesystem; the socket is not owner-only: ${socketPath}`);
    }
}

async function readJson(req, limit = 4096) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return null;
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

// One listener per robot at <soul>/git-credentials.sock. It answers only an https github.com request, reads the
// credential at request time so a removal takes effect at once, and logs each use without the token.
function createListener(id, socketPath, { store, log }) {
    let server = null, directory = null;
    return {
        async listen() {
            directory = await fs.open(path.dirname(socketPath), 'r');
            const address = `/proc/self/fd/${directory.fd}/${path.basename(socketPath)}`;
            try {
                const existing = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
                if (existing) {
                    if (!existing.isSocket()) throw new Error('Unsafe git credential socket path.');
                    const live = await new Promise((resolve, reject) => {
                        const probe = net.connect(address);
                        probe.once('connect', () => { probe.destroy(); resolve(true); });
                        probe.once('error', error => { if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false); else reject(error); });
                    });
                    if (live) throw new Error('Git credential socket already has an owner.');
                    await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
                }
                server = http.createServer(async (req, res) => {
                    try {
                        if (req.method !== 'POST' || req.url !== '/credential') return send(res, 404, { error: 'Not found' });
                        const body = await readJson(req);
                        if (body?.protocol !== 'https' || body?.host !== GIT_HOST) return send(res, 404, { error: 'Not found' });
                        const credential = await store.read(id);
                        if (!credential.readable) return send(res, 404, { error: 'Not found' });
                        log(`git credential served robot=${id} host=${GIT_HOST}`);
                        send(res, 200, { username: credential.secret.username, password: credential.secret.token });
                    } catch {
                        if (!res.headersSent) send(res, 404, { error: 'Not found' });
                    }
                });
                await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
                await restrictSocket(socketPath, log);
            } catch (error) { await this.close(); throw error; }
        },
        async close() {
            if (server) {
                const listener = server; server = null;
                listener.closeAllConnections();
                // Closing the server unlinks the socket through the directory handle, so it precedes that handle.
                await new Promise(resolve => listener.close(resolve));
            }
            if (directory) { await directory.close(); directory = null; }
        },
    };
}

export function createGitCredentialSockets({ store, log = message => console.log(message) } = {}) {
    const robots = new Map();
    let closed = false;
    return {
        socketPath: soul => path.join(soul, GIT_CREDENTIAL_SOCKET),
        async prepare(id, soul) {
            if (closed) throw new Error('Git credential service is closed.');
            if (robots.has(id)) return robots.get(id);
            const work = (async () => {
                const listener = createListener(id, path.join(soul, GIT_CREDENTIAL_SOCKET), { store, log });
                await listener.listen();
                return listener;
            })();
            robots.set(id, work);
            try { return await work; } catch (error) { robots.delete(id); throw error; }
        },
        async remove(id) {
            const work = robots.get(id);
            robots.delete(id);
            const listener = await work?.catch(() => null);
            await listener?.close();
        },
        has: id => robots.has(id),
        async close() {
            closed = true;
            await Promise.all([...robots.values()].map(async work => (await work.catch(() => null))?.close()));
            robots.clear();
        },
    };
}
