import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openCodeGatewayModels } from '../soul-gateway-models.mjs';

// Installed unchanged in each robot's global OpenCode plugins directory.
export const SoulGateway = async () => {
    let server, directory;
    const capability = `Bearer ${randomBytes(32).toString('hex')}`;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const close = async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            server = null;
        }
        await directory?.close();
        directory = null;
    };
    return {
        async config(config) {
            await close();
            // A directory fd also works when the mounted home exceeds UNIX path limits.
            directory = await fs.open(root, 'r');
            const socketPath = `/proc/self/fd/${directory.fd}/soul-gateway.sock`;
            try {
                const catalog = await new Promise((resolve, reject) => {
                    const request = http.get({ socketPath, path: '/v1/models' }, response => {
                        const chunks = [];
                        let size = 0;
                        response.on('data', chunk => {
                            size += chunk.length;
                            if (size > 4 * 1024 * 1024) response.destroy(new Error('Model catalog too large.'));
                            else chunks.push(chunk);
                        });
                        response.on('error', reject);
                        response.on('end', () => {
                            if (response.statusCode !== 200) return reject(new Error('Model catalog unavailable.'));
                            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
                            catch { reject(new Error('Invalid model catalog.')); }
                        });
                    });
                    request.setTimeout(20000, () => request.destroy(new Error('Model catalog timed out.')));
                    request.on('error', reject);
                });
                const models = openCodeGatewayModels(catalog);
                server = http.createServer((req, res) => {
                    const actual = Buffer.from(req.headers.authorization || '');
                    const expected = Buffer.from(capability);
                    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
                        res.writeHead(401); res.end(); return;
                    }
                    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
                        res.writeHead(404); res.end(); return;
                    }
                    const upstream = http.request({ socketPath, path: req.url, method: 'POST',
                        headers: { 'content-type': 'application/json' } }, response => {
                        res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' });
                        response.on('error', () => res.destroy());
                        response.pipe(res);
                    });
                    upstream.setTimeout(520000, () => upstream.destroy());
                    upstream.on('error', () => {
                        if (!res.headersSent) res.writeHead(502);
                        res.end();
                    });
                    req.on('error', () => upstream.destroy());
                    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
                    req.pipe(upstream);
                });
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(0, '127.0.0.1', resolve);
                });
                server.unref();
                config.provider = { ...config.provider, 'soul-gateway': {
                    npm: '@ai-sdk/openai-compatible', name: 'Soul Gateway', models,
                    options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: capability.slice(7) },
                } };
            } catch {
                await close();
                throw new Error('Soul Gateway is unavailable. Reopen the robot after RoboTeam is ready.');
            }
        },
        dispose: close,
    };
};
