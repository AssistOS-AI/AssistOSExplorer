import http from 'node:http';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { soulGatewayConnection } from './soul-gateway-connection.mjs';

function send(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
}

// The generated-local transport accepts buffered chat. Emit the completed message
// as SSE for OpenCode, preserving tool calls, usage and the upstream finish reason.
function sendCompletion(res, response) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = { id: response.id, object: 'chat.completion.chunk', created: response.created,
        model: response.model, choices: response.choices.map((choice, index) => ({
            index: choice.index ?? index, finish_reason: null,
            delta: { ...choice.message, ...(choice.message?.tool_calls ? {
                tool_calls: choice.message.tool_calls.map((call, i) => ({ ...call, index: i })),
            } : {}) },
        })) };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, usage: response.usage,
        choices: response.choices.map((choice, index) => ({ index: choice.index ?? index,
            delta: {}, finish_reason: choice.finish_reason || 'stop' })) })}\n\n`);
    res.end('data: [DONE]\n\n');
}

// A mount shared from a macOS host (virtiofs) cannot store a socket's mode:
// chmod fails with EINVAL and the socket stays 0666. Only that failure is
// tolerated, because socket access already follows robot-home access.
async function restrictSocket(socketPath) {
    try {
        await fs.chmod(socketPath, 0o600);
    } catch (error) {
        if (error.code !== 'EINVAL') throw error;
        console.warn(`[roboTeamAgent] Soul Gateway socket permissions cannot be set on this filesystem; the socket is not owner-only: ${socketPath}`);
    }
}

export function createSoulGatewayOpenCode({ connect = soulGatewayConnection } = {}) {
    let server, starting, connection, directory;
    let closed = false;
    const controllers = new Set();
    async function start(upstream, socketPath) {
        if (closed) throw new Error('Soul Gateway adapter is closed.');
        if (server?.listening) {
            if (connection.scope !== upstream.scope) throw new Error('Soul Gateway identity changed; reopen the conversation.');
            return;
        }
        if (starting) return starting;
        starting = (async () => {
            directory = await fs.open(path.dirname(socketPath), 'r');
            const address = `/proc/self/fd/${directory.fd}/${path.basename(socketPath)}`;
            const existing = await fs.lstat(socketPath).catch(error => {
                if (error.code !== 'ENOENT') throw error;
            });
            if (existing) {
                if (!existing.isSocket()) throw new Error('Unsafe Soul Gateway socket path.');
                const live = await new Promise((resolve, reject) => {
                    const probe = net.connect(address);
                    probe.once('connect', () => { probe.destroy(); resolve(true); });
                    probe.once('error', error => {
                        if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
                        else reject(error);
                    });
                });
                if (live) throw new Error('Soul Gateway socket already has an owner.');
                await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
            }
            connection = upstream;
            server = http.createServer(async (req, res) => {
                const models = req.method === 'GET' && req.url === '/v1/models';
                if (!models && (req.method !== 'POST' || req.url !== '/v1/chat/completions')) return send(res, 404, { error: { message: 'Not found' } });
                const controller = new AbortController();
                controllers.add(controller);
                res.on('close', () => { if (!res.writableEnded) controller.abort(); });
                try {
                    if (models) return send(res, 200, await connection.request('models', undefined, controller.signal));
                    const chunks = [];
                    let length = 0;
                    for await (const chunk of req) {
                        length += chunk.length;
                        if (length > 2 * 1024 * 1024) {
                            send(res, 413, { error: { message: 'Request too large' } });
                            return;
                        }
                        chunks.push(chunk);
                    }
                    let body;
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                    catch { return send(res, 400, { error: { message: 'Invalid JSON' } }); }
                    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
                        return send(res, 400, { error: { message: 'Model and messages are required' } });
                    }
                    const streaming = body.stream === true;
                    const payload = { ...body, stream: false };
                    delete payload.stream_options;
                    const response = await connection.request('chat', payload, controller.signal);
                    if (!Array.isArray(response?.choices)) throw new Error('Invalid completion response.');
                    if (streaming) sendCompletion(res, response);
                    else send(res, 200, response);
                } catch (error) {
                    if (res.headersSent) res.destroy();
                    else if (!res.destroyed) {
                        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
                        send(res, status, { error: { message: `Soul Gateway request failed (HTTP ${status}).` } });
                    }
                } finally { controllers.delete(controller); }
            });
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(address, resolve);
            });
            try {
                await restrictSocket(socketPath);
            } catch (error) {
                // The server unlinks its socket through the directory handle,
                // so close it before that handle, and drop accepted
                // connections so the close does not wait for their requests.
                const listener = server;
                server = null;
                listener.closeAllConnections();
                await new Promise((resolve) => listener.close(resolve));
                await directory.close();
                directory = null;
                throw error;
            }
        })();
        try { await starting; } finally { starting = null; }
    }
    return {
        async listen(socketPath, sourceEnv = process.env) {
            const upstream = await connect(sourceEnv);
            if (!upstream) return false;
            await start(upstream, socketPath);
            return true;
        },
        async close() {
            closed = true;
            await starting?.catch(() => {});
            for (const controller of controllers) controller.abort();
            if (server) {
                server.closeAllConnections();
                await new Promise((resolve) => server.close(resolve));
                server = null;
            }
            await directory?.close();
            directory = null;
        },
    };
}
