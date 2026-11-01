import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail } from './robot-paths.mjs';

const defaults = { 'ploinky-runtime': 'ploinky-runtime', 'human-input': 'roboflow-human-input', 'task-failure': 'roboteam-task-failure' };
const routes = {
    'ploinky-runtime': new Set(['/agent-call', '/ensure-agent', '/task-status', '/task-started', '/live-session']),
    'human-input': new Set(['/require-human-input']),
    'task-failure': new Set(['/report-task-blocked']),
};

export function validateChannels(input = []) {
    if (!Array.isArray(input) || input.length > 3) throw fail('INVALID_INPUT', 'Invalid channels');
    const names = new Set(), aliases = new Set();
    return input.map(value => {
        const alias = value?.alias || defaults[value?.name];
        if (!Object.hasOwn(defaults, value?.name) || names.has(value.name) || !/^[a-z][a-z0-9-]{1,63}$/u.test(alias || '')
            || alias === 'roboteam-soul' || aliases.has(alias)) throw fail('INVALID_INPUT', 'Invalid channel name or alias');
        const context = value.context || {};
        if (!context || typeof context !== 'object' || Array.isArray(context)
            || Object.keys(context).some(key => !['version', 'workingDir', 'resources', 'paths', 'origin'].includes(key))
            || Buffer.byteLength(JSON.stringify(context)) > 65536) throw fail('INVALID_INPUT', 'Invalid channel context');
        names.add(value.name); aliases.add(alias);
        return { name: value.name, alias, context };
    });
}

export class RunChannels {
    constructor({ directory, definitions = [], changed = () => {} }) {
        Object.assign(this, { directory, definitions: validateChannels(definitions), changed });
        this.pending = new Map(); this.servers = []; this.mounts = []; this.closed = false;
    }

    async prepare() {
        for (const definition of this.definitions) {
            const directory = path.join(this.directory, definition.name);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const token = randomBytes(32).toString('hex');
            await fs.writeFile(path.join(directory, 'context.json'), JSON.stringify({ ...definition.context, token, eventToken: token }), { mode: 0o600 });
            const server = http.createServer(async (req, res) => {
                const reply = (status, body) => {
                    if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
                };
                const supplied = Buffer.from(String(req.headers['x-task-capability'] || req.headers['x-ploinky-event-token'] || ''));
                const expected = Buffer.from(token);
                if (this.closed || req.method !== 'POST' || !routes[definition.name].has(req.url)
                    || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(403, { error: 'Callback refused' });
                try {
                    const chunks = []; let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 65536) { reply(413, { error: 'Callback too large' }); req.destroy(); return; }
                        chunks.push(chunk);
                    }
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
                    if (this.pending.size >= 1000) return reply(429, { error: 'Too many callbacks' });
                    const callback = { id: randomUUID(), channel: definition.name, path: req.url, body };
                    const entry = { callback, reply };
                    this.pending.set(callback.id, entry);
                    await fs.writeFile(path.join(directory, callback.id + '.json'), JSON.stringify(callback), { mode: 0o600, flag: 'wx' });
                    this.changed();
                } catch { reply(400, { error: 'Invalid callback' }); }
            });
            // A request can remain unanswered across a controller restart.
            server.requestTimeout = 0;
            server.headersTimeout = 15000;
            const socket = path.join(directory, 'request.sock');
            await fs.unlink(socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
            await fs.chmod(socket, 0o600);
            if (definition.name === 'ploinky-runtime') {
                await fs.unlink(path.join(directory, 'tasks.sock')).catch(error => { if (error.code !== 'ENOENT') throw error; });
                await fs.symlink('request.sock', path.join(directory, 'tasks.sock'));
            }
            this.servers.push(server);
            this.mounts.push({ source: directory, target: '/workspace/' + definition.alias, alias: definition.alias });
        }
        return this.mounts;
    }

    list() { return [...this.pending.values()].map(entry => entry.callback); }

    async reply({ id, status = 200, body = {} }) {
        if (typeof id !== 'string' || !Number.isInteger(status) || status < 100 || status > 599
            || Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw fail('INVALID_INPUT', 'Invalid callback reply');
        const entry = this.pending.get(id);
        if (!entry) throw fail('UNKNOWN_CALLBACK', 'Callback is not pending', 404);
        await fs.rename(path.join(this.directory, entry.callback.channel, id + '.json'), path.join(this.directory, entry.callback.channel, id + '.answered'));
        this.pending.delete(id);
        entry.reply(status, body);
    }

    async close() {
        this.closed = true;
        for (const entry of this.pending.values()) entry.reply(503, { error: 'Run interrupted' });
        for (const server of this.servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
}
