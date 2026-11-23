import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import net from 'node:net';
import { dirname } from 'node:path';

const repository = '/Axiologic/simpleCSVMailSend.git';
const commands = new Set(['git-upload-pack', 'git-receive-pack']);
const advertisements = new Set([...commands].map(command => `/info/refs?service=${command}`));

export function createCsvMailGitServer({ readCredential, request = https.request }) {
    return http.createServer(async (req, res) => {
        const service = advertisements.has(req.url);
        const command = req.url?.slice(1);
        const pack = commands.has(command) && req.headers['content-type'] === `application/x-${command}-request`;
        if (!(req.method === 'GET' && service) && !(req.method === 'POST' && pack)) {
            res.writeHead(404).end();
            return;
        }
        const credential = await readCredential().catch(() => null);
        if (!credential) {
            res.writeHead(503).end();
            return;
        }
        if (res.destroyed) return;
        const headers = { authorization: `Basic ${Buffer.from(`${credential.username}:${credential.token}`).toString('base64')}` };
        for (const name of ['content-type', 'content-length', 'content-encoding', 'git-protocol', 'user-agent']) {
            if (req.headers[name]) headers[name] = req.headers[name];
        }
        const upstream = request({ hostname: 'github.com', path: repository + req.url, method: req.method, headers, timeout: 60_000 }, reply => {
            if (reply.statusCode >= 300 && reply.statusCode < 400) {
                reply.destroy();
                res.writeHead(502).end();
                return;
            }
            const responseHeaders = {};
            for (const name of ['content-type', 'content-length', 'content-encoding']) {
                if (reply.headers[name]) responseHeaders[name] = reply.headers[name];
            }
            res.writeHead(reply.statusCode, responseHeaders);
            reply.on('error', () => res.destroy());
            reply.pipe(res);
        });
        upstream.on('timeout', () => upstream.destroy(new Error('GitHub request timed out')));
        upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
        req.on('error', () => upstream.destroy());
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
    });
}

export async function listenCsvMailGit(socketPath, readCredential) {
    // Some shared filesystems honor directory modes but cannot chmod a socket inode.
    await fs.chmod(dirname(socketPath), 0o700);
    const entry = await fs.lstat(socketPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
    });
    if (entry) {
        if (!entry.isSocket()) throw new Error('Expected a Unix socket for CSV Mail Git');
        const listening = await new Promise((resolve, reject) => {
            const probe = net.connect(socketPath);
            probe.once('connect', () => { probe.destroy(); resolve(true); });
            probe.once('error', error => {
                if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
                else reject(error);
            });
        });
        if (listening) throw new Error('CSV Mail Git socket is already listening');
        await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    const server = createCsvMailGitServer({ readCredential });
    await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
    try {
        await fs.chmod(socketPath, 0o600);
    } catch (error) {
        if (error.code !== 'EINVAL') {
            server.close();
            throw error;
        }
    }
    return server;
}
