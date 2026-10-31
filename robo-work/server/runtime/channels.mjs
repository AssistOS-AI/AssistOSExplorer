import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { CATALOG_ERRORS, validateCatalogResult } from './workflowCatalogRequests.mjs';

// The worker-hosted channels of one execution (RoboWork r10, decision M-14; plan sections 5.5 and 9): the task-failure channel that
// the `report-task-blocked` skill calls and the human-input channel of `require-human-input`, with RoboTeam's local protocol
// (roboTeamAgent/server/task-failure-channel.mjs and human-input-channel.mjs): HTTP over a Unix socket, `POST /report-task-blocked`
// `{message}` and `POST /require-human-input` `{question, options}`, JSON answers `{ok:true, ...}`.
//
// Where the sockets are, inside `<runtime>/x/<rid>/channels` (read-only at /run/robo-work/channels in every workload; connecting to a
// socket needs no write access to the mount):
//   task-failure.sock, human-input.sock             the plan's paths; the sockets of one admitted execution need no token
//   task-failure/request.sock + context.json,       the layout the existing skill scripts read (`<directory>/request.sock` and a
//   human-input/request.sock + context.json         capability token in `context.json`), so that they work when pointed at
//                                                   /run/robo-work/channels/<channel>; the token is then required
// A channel exists only when the execution is admitted for it. The handlers record durably BEFORE the reply is written.

const MAX_BODY = 64 * 1024;
const MESSAGE_MAX = 8000;
const SOCKET_PATH_MAX = 100;

class ChannelError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Removes control characters other than tab and newline, then trims; the failure message is shown to people and stored in events.
export const sanitizeMessage = (value) => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').trim();

export function parseFailure(input) {
    if (typeof input?.message !== 'string') throw new ChannelError(400, 'Provide a nonempty message of at most 8000 characters');
    const message = sanitizeMessage(input.message);
    if (!message || input.message.length > MESSAGE_MAX) throw new ChannelError(400, 'Provide a nonempty message of at most 8000 characters');
    return { message };
}

export function parseQuestion(input) {
    const clean = (text) => sanitizeMessage(text);
    if (!input || typeof input.question !== 'string' || !clean(input.question) || input.question.length > MESSAGE_MAX
        || !Array.isArray(input.options) || input.options.length !== 3
        || input.options.some((option) => typeof option !== 'string' || !clean(option) || option.length > 2000)
        || new Set(input.options.map((option) => clean(option))).size !== 3) {
        throw new ChannelError(400, 'Provide a question and exactly three distinct nonempty options');
    }
    return { question: clean(input.question), options: input.options.map(clean) };
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new ChannelError(413, 'The request is too large');
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ChannelError(400, 'Invalid JSON'); }
}

function serve({ socketPath, route, token, handle }) {
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) throw new Error('A channel socket path is too long');
    const server = http.createServer(async (req, res) => {
        const reply = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
            res.end(JSON.stringify(body));
        };
        try {
            if (req.method !== 'POST' || req.url !== route) throw new ChannelError(403, 'Invalid task callback');
            if (token !== null) {
                const supplied = Buffer.from(String(req.headers['x-task-capability'] || ''));
                const expected = Buffer.from(token);
                if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new ChannelError(403, 'Invalid task callback');
            }
            reply(200, { ok: true, ...(await handle(await readJson(req))) });
        } catch (error) {
            reply(error instanceof ChannelError ? error.status : (error?.statusCode ?? 500), { error: error instanceof ChannelError || error?.statusCode ? error.message : 'The request could not be recorded' });
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 15000;
    server.maxConnections = 8;
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve(server)); });
}

// `taskFailure({message}) -> {}` and `humanInput({question, options}) -> {id, instruction?}` are the durable handlers; either may be
// absent (the channel is then not created). Returns { close() }.
export async function createExecutionChannels({ directory, taskFailure = null, humanInput = null, workflowCatalog = null }) {
    const servers = [];
    const defs = [
        ['task-failure', '/report-task-blocked', taskFailure && (async (input) => taskFailure(parseFailure(input)))],
        ['human-input', '/require-human-input', humanInput && (async (input) => {
            const result = await humanInput(parseQuestion(input));
            return { ...result, instruction: 'End this execution now. Wait for the user answer.' };
        })]
    ];
    try {
        if (workflowCatalog) {
            const catalogDir = path.join(directory, 'workflow-catalog');
            await fs.mkdir(catalogDir, { mode: 0o700 });
            servers.push(await serveWorkflowCatalog(path.join(catalogDir, 'request.sock'), workflowCatalog));
        }
        for (const [name, route, handle] of defs) {
            if (!handle) continue;
            servers.push(await serve({ socketPath: path.join(directory, `${name}.sock`), route, token: null, handle }));
            const compat = path.join(directory, name);
            const token = crypto.randomBytes(32).toString('hex');
            await fs.mkdir(compat, { mode: 0o700 });
            await fs.writeFile(path.join(compat, 'context.json'), JSON.stringify({ token }), { mode: 0o600 });
            servers.push(await serve({ socketPath: path.join(compat, 'request.sock'), route, token, handle }));
        }
    } catch (error) {
        workflowCatalog?.close();
        await Promise.allSettled(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
        throw error;
    }
    return {
        async close() {
            workflowCatalog?.close();
            await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); })));
        }
    };
}

// The catalog socket is execution-local, read-only and tokenless. Its sole request is exactly POST /list-workflows {}.
function serveWorkflowCatalog(socketPath, catalog) {
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX) throw new Error('A channel socket path is too long');
    const server = http.createServer((req, res) => {
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size <= 1024) chunks.push(chunk);
        });
        req.on('error', () => {});
        req.on('end', async () => {
            const reply = (status, body) => {
                if (res.destroyed) return;
                res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
                res.end(JSON.stringify(body));
            };
            try {
                if (req.method !== 'POST' || req.url !== '/list-workflows' || size > 1024) throw new Error('invalid_request');
                const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error('invalid_request');
                reply(200, validateCatalogResult(await catalog.read({ signal: controller.signal })));
            } catch (error) {
                const code = CATALOG_ERRORS.includes(error?.code) ? error.code
                    : error?.message === 'invalid_request' || error instanceof SyntaxError ? 'invalid_request' : 'catalog_unavailable';
                reply(code === 'invalid_request' ? 400 : 503, { ok: false, error: code });
            }
        });
    });
    server.requestTimeout = 35000;
    server.headersTimeout = 10000;
    server.maxConnections = 8;
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve(server)); });
}
