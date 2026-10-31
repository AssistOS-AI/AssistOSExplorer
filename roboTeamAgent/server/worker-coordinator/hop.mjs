import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WorkerCoordinatorError } from './errors.mjs';

// The private-listener coordinator hop (design S3c §6.2): RoboTeam calls the worker's
// coordinator API through the Router's private listener named by the verified generated
// Router descriptor. Each call carries a private agent assertion over the exact body bytes
// it sends, and the user grant header only when the caller passes a grant. The grant is
// never logged, persisted or returned.
//
// Construction never fails. Every call refuses with `worker_coordinator_unavailable`,
// before any I/O, when the coordinator base, the Agent libraries, the descriptor or the
// private identity is missing.

export const COORDINATOR_BASE_ENV = 'ROBOTEAM_WORKER_COORDINATOR_BASE';
export const GRANT_HEADER = 'x-ploinky-user-delegation';
export const ASSERTION_HEADER = 'ploinky-agent-assertion';
const REFUSAL_HEADER = 'x-ploinky-refusal';
const BASE_PATTERN = /^\/base-agent-additional-server\/[A-Za-z0-9_-]+\/[1-9][0-9]{0,4}$/u;
// Exactly the operations RoboTeam calls (RoboWork r10 decisions M-6, M-29 and M-54): the robot and
// operation reads and lifecycle calls (provision, configure, get, delete, and Close terminals) are added
// to the admission, lookup, binding and reference operations. `robots/list`, `obligations*` and
// everything else stay refused before any I/O.
const OPERATION_PATTERN = /^(admissions|lookup|bindings|robots\/(provision|configure|get|delete|terminals\/close)|operations\/get|references\/[A-Za-z0-9_-]{22,64}\/(read|events|control))$/u;
const GRANT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const REFUSAL_PATTERN = /^v=1; stage=(route|auth|relay); cause=([a-z-]{1,64})$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_GRANT_BYTES = 16 * 1024;
// Every status the worker's coordinator routes answer with. A complete response with any
// other status and no Router refusal marker (for example the Router's 502 or 504 after the
// upstream dropped a dispatched request) has an unknown outcome.
const WORKER_STATUSES = new Set([200, 400, 401, 403, 404, 409, 500, 503]);

function unavailable() {
    return new WorkerCoordinatorError('worker_coordinator_unavailable', 503);
}

// The Router's pre-forward refusal marker, or null when absent or malformed. A response
// without a valid marker counts as having reached the upstream.
export function parseRefusalMarker(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const match = REFUSAL_PATTERN.exec(raw.trim());
    return match ? { stage: match[1], cause: match[2] } : null;
}

function parseJson(bytes) {
    try {
        return JSON.parse(bytes.toString('utf8'));
    } catch {
        return undefined;
    }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// {outcome: 'response', status, json, refusal} | {outcome: 'unknown', status}
export function classifyResponse(status, headers, bytes) {
    const refusal = parseRefusalMarker(headers?.[REFUSAL_HEADER]);
    const json = parseJson(bytes);
    if (refusal) return { outcome: 'response', status, json, refusal };
    if (!WORKER_STATUSES.has(status)) return { outcome: 'unknown', status };
    if (status === 200 && !isPlainObject(json)) return { outcome: 'unknown', status };
    return { outcome: 'response', status, json, refusal: null };
}

function identityComplete(env) {
    return /^[a-f0-9]{64}$/iu.test(String(env.PLOINKY_AGENT_PRIVATE_SECRET || '').trim())
        && ['PLOINKY_AGENT_ID', 'PLOINKY_AGENT_INSTANCE_ID', 'PLOINKY_AGENT_ENABLE_GENERATION']
            .every((name) => String(env[name] || '').trim().length > 0);
}

function bodyBytes(body) {
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    if (isPlainObject(body)) return Buffer.from(JSON.stringify(body), 'utf8');
    throw new WorkerCoordinatorError('invalid_request', 400);
}

function send(request, url, headers, bytes, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        let connected = false;
        let req = null;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        // Bytes may have reached the Router once the connection was established.
        const lost = () => finish(connected ? { outcome: 'unknown' } : { outcome: 'unsent' });
        const timer = setTimeout(() => { lost(); req?.destroy(); }, timeoutMs);
        timer.unref?.();
        try {
            req = request(url, { method: 'POST', headers, agent: false }, (res) => {
                connected = true;
                const status = res.statusCode;
                const declared = Number(res.headers['content-length']);
                if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
                    finish({ outcome: 'unknown', status });
                    res.destroy();
                    return;
                }
                const chunks = [];
                let total = 0;
                res.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > MAX_RESPONSE_BYTES) {
                        finish({ outcome: 'unknown', status });
                        res.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => finish(classifyResponse(status, res.headers, Buffer.concat(chunks))));
                res.on('aborted', () => finish({ outcome: 'unknown' }));
                res.on('error', () => finish({ outcome: 'unknown' }));
            });
        } catch {
            finish({ outcome: 'unsent' });
            return;
        }
        req.on('socket', (socket) => {
            if (socket && socket.connecting === false) connected = true;
            else socket?.once?.('connect', () => { connected = true; });
        });
        req.on('error', lost);
        req.end(bytes);
    });
}

const STREAM_IDLE_MS = 90000;

function dropped() {
    return new WorkerCoordinatorError('worker_stream_dropped', 503);
}

// Opens the streaming request. Connection and header handling follow `send`; a non-200 answer is
// read whole (bounded) and classified like any other response.
function openStream(requestImpl, url, headers, bytes, { timeoutMs, idleMs, signal }) {
    return new Promise((resolve) => {
        let settled = false;
        let connected = false;
        let req = null;
        const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { done(connected ? { outcome: 'unknown' } : { outcome: 'unsent' }); req?.destroy(); }, timeoutMs);
        timer.unref?.();
        const abort = () => { req?.destroy(); done({ outcome: connected ? 'unknown' : 'unsent' }); };
        if (signal?.aborted) { done({ outcome: 'unsent' }); return; }
        signal?.addEventListener('abort', abort, { once: true });
        try {
            req = requestImpl(url, { method: 'POST', headers, agent: false }, (res) => {
                connected = true;
                const status = res.statusCode;
                const contentType = String(res.headers['content-type'] || '');
                if (status !== 200 || !/ndjson|jsonl/iu.test(contentType)) {
                    const chunks = [];
                    let total = 0;
                    res.on('data', (chunk) => {
                        total += chunk.length;
                        if (total > MAX_RESPONSE_BYTES) { done({ outcome: 'unknown', status }); res.destroy(); return; }
                        chunks.push(chunk);
                    });
                    res.on('end', () => done(classifyResponse(status, res.headers, Buffer.concat(chunks))));
                    res.on('aborted', () => done({ outcome: 'unknown' }));
                    res.on('error', () => done({ outcome: 'unknown' }));
                    return;
                }
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                done({ outcome: 'stream', status, lines: lines(res, req, idleMs, signal) });
            });
        } catch {
            done({ outcome: 'unsent' });
            return;
        }
        req.on('socket', (socket) => {
            if (socket && socket.connecting === false) connected = true;
            else socket?.once?.('connect', () => { connected = true; });
        });
        req.on('error', () => done(connected ? { outcome: 'unknown' } : { outcome: 'unsent' }));
        req.end(bytes);
    });
}

async function* lines(res, req, idleMs, signal) {
    let buffer = '';
    let idle;
    let wake;
    let failure = null;
    let finished = false;
    const queue = [];
    const poke = () => { wake?.(); wake = null; };
    const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { failure = dropped(); req.destroy(); poke(); }, idleMs);
        idle.unref?.();
    };
    const onAbort = () => { failure = dropped(); req.destroy(); poke(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    res.setEncoding('utf8');
    arm();
    res.on('data', (chunk) => {
        arm();
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line) continue;
            if (line.length > MAX_RESPONSE_BYTES) { failure = dropped(); req.destroy(); break; }
            const value = parseJson(Buffer.from(line));
            if (!isPlainObject(value)) { failure = dropped(); req.destroy(); break; }
            queue.push(value);
        }
        if (buffer.length > MAX_RESPONSE_BYTES) { failure = dropped(); req.destroy(); }
        poke();
    });
    res.on('end', () => { finished = true; poke(); });
    res.on('aborted', () => { failure ||= dropped(); poke(); });
    res.on('error', () => { failure ||= dropped(); poke(); });
    res.on('close', () => { if (!finished) failure ||= dropped(); poke(); });
    try {
        for (;;) {
            if (queue.length) { yield queue.shift(); continue; }
            if (failure) throw failure;
            if (finished) return;
            await new Promise((resolve) => { wake = resolve; });
        }
    } finally {
        clearTimeout(idle);
        signal?.removeEventListener('abort', onAbort);
        req.destroy();
    }
}

// `routerUrl` and `request` are test injections; production reads the private Router
// location from the verified descriptor only.
export function createWorkerCoordinatorHop({ env = process.env, routerUrl, request = http.request, timeoutMs = 15000, libraries: injected = null,
    streamIdleMs = STREAM_IDLE_MS } = {}) {
    const runtimeRoot = () => String(env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent');
    let libraries = injected ? { assertion: injected.assertion, descriptor: null } : null;

    async function load() {
        if (libraries) return libraries;
        const root = runtimeRoot();
        const importFrom = (relative) => import(pathToFileURL(path.resolve(root, relative)).href);
        try {
            const assertion = await importFrom('lib/agentAssertion.mjs');
            const descriptor = routerUrl ? null : await importFrom('client/generatedRouterDescriptor.mjs');
            if (typeof assertion.signPrivateRouterAssertion !== 'function') throw unavailable();
            if (descriptor && typeof descriptor.loadVerifiedGeneratedRouterDescriptor !== 'function') throw unavailable();
            libraries = { assertion, descriptor };
            return libraries;
        } catch {
            throw unavailable();
        }
    }

    function privateOrigin(libs) {
        if (routerUrl) return String(routerUrl);
        try {
            return String(libs.descriptor.loadVerifiedGeneratedRouterDescriptor({ env }).payload.internalRouterUrl || '');
        } catch {
            throw unavailable();
        }
    }

    // Validates the operation, grant and identity and signs the exact body: everything before I/O.
    async function prepare(operation, body, grant) {
        if (typeof operation !== 'string' || !OPERATION_PATTERN.test(operation)) throw new WorkerCoordinatorError('invalid_request', 400);
        const sendsGrant = typeof grant === 'string' && grant.length > 0;
        if (sendsGrant && (grant.length > MAX_GRANT_BYTES || !GRANT_PATTERN.test(grant))) {
            throw new WorkerCoordinatorError('owner_evidence_unavailable', 403);
        }
        const bytes = bodyBytes(body);
        const base = String(env[COORDINATOR_BASE_ENV] || '').trim();
        if (!BASE_PATTERN.test(base) || !identityComplete(env)) throw unavailable();
        const libs = await load();
        const target = `${base}/v1/coordinator/${operation}`;
        let url;
        try {
            url = new URL(target, privateOrigin(libs));
        } catch (error) {
            if (error instanceof WorkerCoordinatorError) throw error;
            throw unavailable();
        }
        if (url.protocol !== 'http:' || url.pathname !== target || url.search || url.hash || url.username || url.password) throw unavailable();
        let assertion;
        try {
            assertion = libs.assertion.signPrivateRouterAssertion({ method: 'POST', path: target, query: '', body: bytes, env });
        } catch {
            throw unavailable();
        }
        const headers = {
            'content-type': 'application/json',
            'content-length': String(bytes.length),
            accept: 'application/json',
            [ASSERTION_HEADER]: assertion,
        };
        if (sendsGrant) headers[GRANT_HEADER] = grant;
        return { url, headers, bytes };
    }

    async function call(operation, body, { grant } = {}) {
        const { url, headers, bytes } = await prepare(operation, body, grant);
        return send(request, url, headers, bytes, timeoutMs);
    }

    // A streaming response (NDJSON, one JSON object per line), authorized at open by the grant sent
    // with the opening request alone. Resolves like `call` for any answer that is not a 200 stream
    // ({outcome: 'unsent' | 'unknown' | 'response'}); for a 200 stream resolves
    // {outcome: 'stream', status: 200, lines} where `lines` is an async iterable of parsed objects.
    // The iteration ends normally when the worker ends the stream. It throws
    // `worker_stream_dropped` when the connection fails or goes idle, or a line is malformed or too
    // large: the caller then reattaches from its cursor, with a fresh grant.
    async function stream(operation, body, { grant, signal } = {}) {
        const { url, headers, bytes } = await prepare(operation, body, grant);
        return openStream(request, url, { ...headers, accept: 'application/x-ndjson' }, bytes, { timeoutMs, idleMs: streamIdleMs, signal });
    }

    return Object.freeze({ call, stream });
}
