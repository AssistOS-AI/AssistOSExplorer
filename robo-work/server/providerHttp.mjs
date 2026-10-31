import { WorkerStateError } from './stateProtocol.mjs';
import { CoordinatorAuthError } from './coordinatorAuth.mjs';
import { COORDINATOR_BASE } from './coordinatorAdapter.mjs';
import { TargetInventoryError } from './terminalTargets.mjs';

// HTTP layer for the coordinator routes and the generic task-reference routes (design §3.5).
// Each export returns a pure `(req, res)` handler: no listener, manifest or bootstrap is
// created here. A handler reads at most `limits.requestBytes + 16384` raw body bytes, takes
// the request path and search from the raw request target (design A6), the trusted
// `x-ploinky-auth-info` value, dispatches by exact method and path, and answers JSON with
// `Cache-Control: no-store`. A response never carries a refusal reason, a token or a claim;
// the optional `onRefusal({route, code, reason})` hook serves local diagnostics.

const BODY_ALLOWANCE = 16384;
const MAX_TARGET_LENGTH = 8192;
const PATH_CHARACTERS = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;
const REFERENCE_ID = '([A-Za-z0-9_-]{22,64})';

const AUTH_STATUS = Object.freeze({ unauthorized: 401, forbidden: 403, invalid_request: 400, unavailable: 503, operation_unavailable: 400 });
const STATE_STATUS = Object.freeze({
    invalid_request: 400, not_found: 404, forbidden: 403,
    operation_conflict: 409, revision_conflict: 409, robot_busy: 409, resource_quarantined: 409, resource_present: 409,
    runtime_unavailable: 503, recovery_pending: 503, stale_generation: 503, capacity_exceeded: 503,
    state_corrupt: 500, environment_unavailable: 400, terminals_open: 409
});
// Terminal-target inventory bound (interface note 2.3 (9)): the body is exactly {error}.
const INVENTORY_STATUS = Object.freeze({ target_inventory_too_large: 503 });

class HttpRefusal extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

// {status, body, code, reason} for a thrown error. `reason` is for onRefusal only.
export function mapRefusal(error) {
    if (error instanceof HttpRefusal) return { status: error.status, body: { error: error.code }, code: error.code, reason: null };
    if (error instanceof TargetInventoryError && Object.hasOwn(INVENTORY_STATUS, error.code)) {
        return { status: INVENTORY_STATUS[error.code], body: { error: error.code }, code: error.code, reason: null };
    }
    if (error instanceof CoordinatorAuthError && Object.hasOwn(AUTH_STATUS, error.code)) {
        return { status: AUTH_STATUS[error.code], body: { error: error.code }, code: error.code, reason: error.reason };
    }
    if (error instanceof WorkerStateError && Object.hasOwn(STATE_STATUS, error.code)) {
        // A durably consumed token presented again is an authentication refusal.
        if (error.reason === 'token_replayed') return { status: 401, body: { error: 'unauthorized' }, code: 'unauthorized', reason: 'token_replayed' };
        // M-54: the count of open robot terminals travels with `terminals_open` (a number, never an id), so RoboTeam can name it.
        if (error.code === 'terminals_open' && Number.isSafeInteger(error.terminals)) {
            return { status: 409, body: { error: 'terminals_open', terminals: error.terminals }, code: 'terminals_open', reason: null };
        }
        return { status: STATE_STATUS[error.code], body: { error: error.code }, code: error.code, reason: error.reason ?? null };
    }
    return { status: 500, body: { error: 'internal_error' }, code: 'internal_error', reason: null };
}

// The raw request target, split at the first `?`. The path must already be canonical: no
// percent-encoding, backslash, empty or dot segment, and equal to its WHATWG pathname. The
// search is '' (also for a bare `?`) or `?...`, exactly as received.
export function parseTarget(target) {
    if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH || target.includes('#')) {
        throw new HttpRefusal(400, 'invalid_request');
    }
    const index = target.indexOf('?');
    const path = index === -1 ? target : target.slice(0, index);
    const rest = index === -1 ? '' : target.slice(index + 1);
    if (!PATH_CHARACTERS.test(path) || path.includes('//') || path.split('/').some((segment) => segment === '.' || segment === '..')) {
        throw new HttpRefusal(400, 'invalid_request');
    }
    let pathname;
    try {
        pathname = new URL(path, 'http://provider.invalid').pathname;
    } catch {
        throw new HttpRefusal(400, 'invalid_request');
    }
    if (pathname !== path) throw new HttpRefusal(400, 'invalid_request');
    return { path, query: rest === '' ? '' : `?${rest}` };
}

async function readBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new HttpRefusal(400, 'invalid_request');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function authInfoFrom(headers) {
    const value = headers?.['x-ploinky-auth-info'];
    return typeof value === 'string' ? value : undefined;
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(Buffer.byteLength(payload)));
    res.end(payload);
}

function validateLimits(limits) {
    if (!limits || !Number.isSafeInteger(limits.requestBytes) || limits.requestBytes <= 0) throw new TypeError('providerHttp: limits.requestBytes required');
    return limits.requestBytes + BODY_ALLOWANCE;
}

export const STREAM_DEFAULTS = Object.freeze({ pollMs: 200, keepAliveMs: 15000, maxLifetimeMs: 25 * 60 * 1000, maxStreams: 64, maxBytes: 48 * 1024 * 1024 });

// An opened event subscription (M-12): NDJSON, one line per event row `{sequence, at, type, data}`, plus control lines
// `{"keepalive":true}` (also the first line, which flushes the headers through the Router), `{"gap":true,"snapshotSequence":n}`,
// `{"error":"<code>"}` and a closing `{"end":true,"nextAfter":n}` (the reference is terminal and every event was sent) or
// `{"end":false,"nextAfter":n,"reason":"lifetime"}` (reattach with a fresh grant and `after: n`). The stream is authorized once, when
// it opens; it never carries or returns a credential. The Router relays the response as a stream with a 60 s idle timeout, which
// the keep-alive lines reset (ploinky executeHttpPlan.js:430-474), and ends below the Router 64 MiB response cap with reason "bytes".
function streamEvents(res, follow, settings, state) {
    return new Promise((resolve) => {
        let after = follow.first.nextAfter ?? 0;
        let timer = null;
        let closed = false;
        let lastWrite = Date.now();
        let written = 0;
        const started = Date.now();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        const finish = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            state.open -= 1;
            if (!res.writableEnded) res.end();
            resolve();
        };
        const line = (value) => {
            if (closed) return;
            lastWrite = Date.now();
            const text = `${JSON.stringify(value)}\n`;
            written += Buffer.byteLength(text);
            res.write(text);
        };
        const send = (page) => {
            if (page.gap === true) { line({ gap: true, snapshotSequence: page.snapshotSequence }); finish(); return false; }
            // The Router cuts a response at 64 MiB (ploinky proxy/limits.js:5), which would break a line: end below it, reattach with the cursor.
            for (const event of page.events) {
                if (written + Buffer.byteLength(JSON.stringify(event)) + 1 > settings.maxBytes) {
                    line({ end: false, nextAfter: after, reason: 'bytes' });
                    finish();
                    return false;
                }
                line(event);
                after = event.sequence;
            }
            return true;
        };
        res.on('close', finish);
        res.flushHeaders?.();
        line({ keepalive: true });
        if (!send(follow.first)) return;
        let polling = false;
        timer = setInterval(() => {
            if (closed || polling) return;
            polling = true;
            try {
                if (res.writableNeedDrain) return;
                const page = follow.page(after);
                if (!send(page)) return;
                if (page.events.length === 0) {
                    const last = follow.finished();
                    if (last !== null && after >= last) { line({ end: true, nextAfter: after }); finish(); return; }
                    if (Date.now() - started >= settings.maxLifetimeMs) { line({ end: false, nextAfter: after, reason: 'lifetime' }); finish(); return; }
                    if (Date.now() - lastWrite >= settings.keepAliveMs) line({ keepalive: true });
                }
            } catch (error) {
                line({ error: mapRefusal(error).code });
                finish();
            } finally {
                polling = false;
            }
        }, settings.pollMs);
        timer.unref?.();
    });
}

// `resolve(method, path)` returns {route, call(request)} or null (404).
function createHandler({ resolve, maxBody, onRefusal, streaming = {} }) {
    const settings = { ...STREAM_DEFAULTS, ...streaming };
    const streamState = { open: 0 };
    return async function handle(req, res) {
        let route = null;
        try {
            const { path, query } = parseTarget(req.url);
            const method = String(req.method || '').toUpperCase();
            const match = resolve(method, path);
            if (!match) throw new HttpRefusal(404, 'not_found');
            route = match.route;
            const body = await readBody(req, maxBody);
            // An adapter call may be asynchronous (closeTerminals waits for the normal end path of each terminal).
            const result = await match.call({ authInfo: authInfoFrom(req.headers), method, path, query, body });
            if (result && result.follow) {
                if (streamState.open >= settings.maxStreams) throw new HttpRefusal(503, 'capacity_exceeded');
                streamState.open += 1;
                await streamEvents(res, result.follow, settings, streamState);
                return;
            }
            if (result && result.gap === true) {
                send(res, 409, { error: 'retention_gap', snapshotSequence: result.snapshotSequence });
                return;
            }
            send(res, 200, result);
        } catch (error) {
            const refusal = mapRefusal(error);
            if (typeof onRefusal === 'function') {
                try {
                    onRefusal({ route, code: refusal.code, reason: refusal.reason, method: String(req.method || '').slice(0, 16), path: String(req.url || '').split('?')[0].slice(0, 160) });
                } catch {
                    // Diagnostics never change the response.
                }
            }
            send(res, refusal.status, refusal.body);
        }
    };
}

export function createCoordinatorHttpHandler({ adapter, limits, onRefusal, streaming }) {
    const maxBody = validateLimits(limits);
    const exact = new Map([
        [`${COORDINATOR_BASE}/admissions`, 'admit'],
        [`${COORDINATOR_BASE}/lookup`, 'lookup'],
        [`${COORDINATOR_BASE}/bindings`, 'bind'],
        [`${COORDINATOR_BASE}/workflow-catalog/requests`, 'workflowCatalogRequests'],
        [`${COORDINATOR_BASE}/robots/provision`, 'provision'],
        [`${COORDINATOR_BASE}/robots/configure`, 'configure'],
        [`${COORDINATOR_BASE}/robots/delete`, 'delete'],
        [`${COORDINATOR_BASE}/robots/list`, 'listRobots'],
        [`${COORDINATOR_BASE}/robots/get`, 'getRobot'],
        [`${COORDINATOR_BASE}/robots/models`, 'models'],
        [`${COORDINATOR_BASE}/robots/agent-status`, 'agentStatus'],
        [`${COORDINATOR_BASE}/robots/terminals/close`, 'closeTerminals'],
        [`${COORDINATOR_BASE}/operations/get`, 'getOperation'],
        [`${COORDINATOR_BASE}/obligations`, 'admitObligation'],
        [`${COORDINATOR_BASE}/obligations/list`, 'listObligations']
    ]);
    const reference = new RegExp(`^${COORDINATOR_BASE}/references/${REFERENCE_ID}/(read|events|control)$`);
    const referenceRoutes = { read: 'readReference', events: 'referenceEvents', control: 'controlReference' };
    const obligation = new RegExp(`^${COORDINATOR_BASE}/obligations/${REFERENCE_ID}/(accept|reject|outbox)$`);
    const obligationRoutes = { accept: 'acceptObligation', reject: 'rejectObligation', outbox: 'applyOutbox' };
    const catalogReply = new RegExp(`^${COORDINATOR_BASE}/references/${REFERENCE_ID}/workflow-catalog/reply$`);
    const resolve = (method, path) => {
        if (method !== 'POST') return null;
        let name = exact.get(path);
        if (!name && catalogReply.test(path)) name = 'workflowCatalogReply';
        if (!name) {
            const match = reference.exec(path);
            if (match) name = referenceRoutes[match[2]];
        }
        if (!name) {
            const match = obligation.exec(path);
            if (match) name = obligationRoutes[match[2]];
        }
        return name ? { route: name, call: (request) => adapter[name](request) } : null;
    };
    return createHandler({ resolve, maxBody, onRefusal, streaming });
}

export function createTaskReferenceHttpHandler({ adapter, basePath, limits, onRefusal }) {
    const maxBody = validateLimits(limits);
    if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(basePath)) throw new TypeError('providerHttp: canonical basePath required');
    const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const read = new RegExp(`^${escaped}/${REFERENCE_ID}$`);
    const events = new RegExp(`^${escaped}/${REFERENCE_ID}/events$`);
    const control = new RegExp(`^${escaped}/${REFERENCE_ID}/control$`);
    const resolve = (method, path) => {
        if (method === 'POST' && path === `${basePath}/lookup`) return { route: 'lookup', call: (request) => adapter.lookup(request) };
        if (method === 'GET' && read.test(path)) return { route: 'read', call: (request) => adapter.read(request) };
        if (method === 'GET' && events.test(path)) return { route: 'events', call: (request) => adapter.events(request) };
        if (method === 'POST' && control.test(path)) return { route: 'control', call: (request) => adapter.control(request) };
        return null;
    };
    return createHandler({ resolve, maxBody, onRefusal });
}

// Terminal-target inventory on the provider port: exactly `POST <basePath>/targets`, where
// `basePath` is the declared `terminals.path`; anything else is 404 without an adapter call.
export function createTerminalTargetsHttpHandler({ adapter, basePath, limits, onRefusal }) {
    const maxBody = validateLimits(limits);
    if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(basePath)) throw new TypeError('providerHttp: canonical basePath required');
    const targetsPath = `${basePath}/targets`;
    const resolve = (method, path) => (method === 'POST' && path === targetsPath ? { route: 'targets', call: (request) => adapter.targets(request) } : null);
    return createHandler({ resolve, maxBody, onRefusal });
}
