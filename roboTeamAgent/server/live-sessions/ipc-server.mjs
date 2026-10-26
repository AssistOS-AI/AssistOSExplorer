import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifiedDirectUser } from '../listing-access.mjs';
import { LiveSessionsFullError } from './registry.mjs';
import { OUTPUT_STYLES } from './contract.mjs';

// Same-container IPC for publishers that run outside main.mjs (the copilot CLI
// runtime). The socket lives only on the container's private /dev/shm, which
// P3.0 proved is not reachable from ALA sandboxes. The server assigns every
// id, binds each run to the publisher incarnation that opened it, and takes
// owner identity only from a Router-signed WebChat token it verifies itself.
export const IPC_SOCKET_PATH = '/dev/shm/roboteam-live/registry.sock';
export const IPC_DEFAULTS = Object.freeze({
    lineBytes: 1024 * 1024,
    bufferBytes: 4 * 1024 * 1024,
    connectionLiveRuns: 64,
    handleLiveRuns: 16,
    pendingClaims: 64,
    principalPendingClaims: 16,
    // Every copilot process is one publisher incarnation, kept for the
    // reconnect window after it disconnects. Ploinky runs at most 20 WebChat
    // runtimes per router (all agents together) and 24 WebTTY shells that can
    // run a terminal CLI; the rest is margin for processes replaced within the
    // window.
    maxPublishers: 64,
    reconnectMs: 30 * 1000,
    handleLifetimeMs: 24 * 60 * 60 * 1000,
    controlTimeoutMs: 38 * 1000,
});

const WEBCHAT_TOOL = '__webchat_message__';
const PUBLISHER_KINDS = new Set(['copilot-turn', 'copilot-task']);
const PUBLISHER_END_STATUSES = new Set(['finished', 'failed', 'stopped']);
const CONTROL_OUTCOMES = new Set(['delivered', 'queued', 'rejected', 'unknown', 'run_ended']);
const REF = /^[A-Za-z0-9_.:-]{1,128}$/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The full WebChat "View Thinking" path the copilot builds for a turn.
const TRANSCRIPT_PATH = new RegExp(`^/base-agent-additional-server/[A-Za-z0-9_-]+/[1-9][0-9]{0,4}/webchat-logs/(${UUID})/(${UUID})$`, 'u');
const TOKEN_LIMIT = 16 * 1024;
const ENDED_MEMORY = 1024;

const lstatOrNull = (file) => fs.lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const sameIdentity = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid);
const random = () => crypto.randomBytes(24).toString('base64url');

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function failure(outcome, message) {
    return Object.assign(new Error(message), { liveOutcome: outcome });
}

// The Agent runtime's Router Request verifier. Owner claims are refused when
// it is unavailable or unconfigured; a run then publishes as unverified, and
// startup says so.
export async function loadOwnerVerifier(env = process.env, { log = (line) => console.warn(line) } = {}) {
    const runtimeRoot = env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent';
    const unavailable = (reason) => {
        log(`[live-sessions] owner verification is unavailable (${reason}); IPC runs publish as owner unverified`);
        return null;
    };
    let auth, hash, jwt;
    try {
        const load = (relative) => import(pathToFileURL(path.resolve(runtimeRoot, relative)).href);
        [auth, hash, jwt] = await Promise.all([load('lib/invocationAuth.mjs'), load('lib/requestHash.mjs'), load('lib/jwtVerify.mjs')]);
    } catch {
        return unavailable('Agent verifier modules cannot be loaded');
    }
    if (typeof auth.verifyRouterRequestFromHeaders !== 'function' || typeof hash.computeRchTool !== 'function'
        || typeof jwt.createMemoryReplayCache !== 'function') return unavailable('Agent verifier modules are incomplete');
    if (!String(env.PLOINKY_AGENT_SECRET || '').trim() || !String(env.PLOINKY_AGENT_ID || '').trim()) {
        return unavailable('PLOINKY_AGENT_SECRET and PLOINKY_AGENT_ID are required');
    }
    // Verification accepts a token until exp plus the clock skew, but the
    // library cache forgets a jti at exp. Keep every jti for the whole
    // acceptance window so a replay inside the skew is still refused.
    const skewMs = ((Number.isFinite(jwt.DEFAULT_CLOCK_SKEW_SECONDS) ? jwt.DEFAULT_CLOCK_SKEW_SECONDS : 30) + 1) * 1000;
    const cache = jwt.createMemoryReplayCache({ maxSize: 4096 });
    const replayCache = {
        seen: (jti) => cache.seen(jti),
        remember: (jti, ttlMs) => cache.remember(jti, Math.max(1, Number(ttlMs) || 1) + skewMs),
    };
    return (token, args) => auth.verifyRouterRequestFromHeaders({ authorization: `Bearer ${token}` }, {
        env, replayCache, method: 'POST', path: '/mcp', tool: WEBCHAT_TOOL,
        rch: hash.computeRchTool({ method: 'POST', path: '/mcp', tool: WEBCHAT_TOOL, arguments: args }),
    });
}

// Creates the socket directory exclusively and binds the socket. Any
// preexisting directory, socket or link is refused; nothing is adopted or
// unlinked to make startup pass. The parent's sticky bit is not checked:
// exclusive creation plus the ownership and mode checks of our own directory
// already exclude another user's entry. If binding fails after listen, the
// listener is closed (Node removes its own socket) and the directory this call
// created is removed only while it is still the same, now empty, directory.
async function bindExclusive(server, socketPath, { chmod = fs.chmod } = {}) {
    const directory = path.dirname(socketPath);
    const parent = path.dirname(directory);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) {
        throw new Error('Live Sessions socket parent must be a real directory');
    }
    await fs.mkdir(directory, { mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    let socketStat = null;
    try {
        if (!directoryStat.isDirectory() || directoryStat.uid !== process.getuid() || (directoryStat.mode & 0o777) !== 0o700) {
            throw new Error('Live Sessions socket directory ownership or mode mismatch');
        }
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => { server.off('error', reject); resolve(); });
        });
        await chmod(socketPath, 0o600);
        socketStat = await fs.lstat(socketPath);
        if (!socketStat.isSocket() || socketStat.uid !== process.getuid() || (socketStat.mode & 0o777) !== 0o600) {
            throw new Error('Live Sessions socket ownership or mode mismatch');
        }
    } catch (error) {
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        else server.unref();
        if (!(await lstatOrNull(socketPath)) && sameIdentity(await lstatOrNull(directory), directoryStat)) await fs.rmdir(directory).catch(() => {});
        throw error;
    }
    return { directory, directoryStat, socketStat };
}

export class LiveSessionsIpcServer {
    constructor({ registry, verifyOwner = null, readTranscript = null, now = Date.now, log = (line) => console.warn(line), chmod, ...limits } = {}) {
        if (!registry) throw new Error('Live Sessions IPC requires a registry');
        this.registry = registry;
        this.verifyOwner = verifyOwner;
        this.readTranscript = typeof readTranscript === 'function' ? readTranscript : null;
        this.now = now;
        this.log = log;
        this.limits = { ...IPC_DEFAULTS };
        for (const key of Object.keys(IPC_DEFAULTS)) if (Number.isSafeInteger(limits[key]) && limits[key] > 0) this.limits[key] = limits[key];
        this.publishers = new Map();
        this.connections = new Set();
        this.controls = new Map();
        this.server = net.createServer((socket) => this._accept(socket));
        this.bound = null;
        this.closed = false;
        this.chmod = chmod;
    }

    async listen(socketPath = IPC_SOCKET_PATH) {
        this.socketPath = socketPath;
        try {
            this.bound = await bindExclusive(this.server, socketPath, this.chmod ? { chmod: this.chmod } : {});
        } catch (error) {
            this.closed = true;
            throw error;
        }
        this.server.on('error', (error) => this.log(`[live-sessions] IPC listener error: ${error.code || error.message}`));
        return this;
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        for (const connection of [...this.connections]) connection.socket.destroy();
        for (const publisher of this.publishers.values()) clearTimeout(publisher.lostTimer);
        for (const control of this.controls.values()) clearTimeout(control.timer);
        this.controls.clear();
        if (!this.bound) return;
        const { directory, directoryStat, socketStat } = this.bound;
        // Node unlinks a Unix listener on close; refuse when the saved pathname
        // identities changed rather than removing a replacement.
        if (!sameIdentity(await lstatOrNull(directory), directoryStat) || !sameIdentity(await lstatOrNull(this.socketPath), socketStat)) {
            this.server.unref();
            throw new Error('Live Sessions IPC cleanup refused a changed socket identity');
        }
        await new Promise((resolve) => this.server.close(() => resolve()));
        if (sameIdentity(await lstatOrNull(directory), directoryStat)) await fs.rmdir(directory).catch(() => {});
    }

    _accept(socket) {
        const connection = { socket, publisher: null, buffer: '', bufferBytes: 0, replaced: false };
        this.connections.add(connection);
        socket.setEncoding('utf8');
        socket.on('error', () => {});
        socket.on('data', (chunk) => this._data(connection, chunk));
        socket.once('close', () => this._closed(connection));
        if (this.closed) socket.destroy();
    }

    _drop(connection, reason) {
        if (reason) this.log(`[live-sessions] IPC connection closed: ${reason}`);
        connection.socket.destroy();
    }

    // Returns false when the message could not be queued for the publisher.
    _send(connection, message) {
        if (connection.socket.destroyed) return false;
        if (connection.socket.writableLength > this.limits.bufferBytes) {
            this._drop(connection, 'publisher is not reading');
            return false;
        }
        connection.socket.write(`${JSON.stringify(message)}\n`);
        return true;
    }

    _data(connection, chunk) {
        connection.buffer += chunk;
        connection.bufferBytes += Buffer.byteLength(chunk);
        if (connection.bufferBytes > this.limits.bufferBytes) return this._drop(connection, 'input buffer limit');
        let newline = connection.buffer.indexOf('\n');
        while (newline >= 0 && !connection.socket.destroyed) {
            const line = connection.buffer.slice(0, newline);
            connection.buffer = connection.buffer.slice(newline + 1);
            if (Buffer.byteLength(line) > this.limits.lineBytes) return this._drop(connection, 'line limit');
            let message;
            try { message = JSON.parse(line); } catch { return this._drop(connection, 'malformed JSON'); }
            if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
                return this._drop(connection, 'malformed message');
            }
            this._message(connection, message);
            newline = connection.buffer.indexOf('\n');
        }
        connection.bufferBytes = Buffer.byteLength(connection.buffer);
        if (connection.bufferBytes > this.limits.lineBytes) this._drop(connection, 'line limit');
    }

    _message(connection, message) {
        if (!connection.publisher) {
            if (message.type === 'hello') return this._hello(connection, message);
            if (message.type === 'resume') return this._resume(connection, message);
            return this._drop(connection, 'hello or resume required');
        }
        switch (message.type) {
            case 'owner-claim': return this._ownerClaim(connection, message);
            case 'owner-release': return this._ownerRelease(connection, message);
            case 'run-start': return this._runStart(connection, message);
            case 'run-event': return this._runEvent(connection, message);
            case 'run-end': return this._runEnd(connection, message);
            case 'control-result': return this._controlResult(connection, message);
            default: return this._drop(connection, 'unknown message type');
        }
    }

    _hello(connection, message) {
        const fields = ['pid', 'start', 'boot'];
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0
            || fields.slice(1).some((key) => message[key] !== undefined && (typeof message[key] !== 'string' || message[key].length > 128))) {
            return this._drop(connection, 'invalid hello');
        }
        // Same-uid publishers are bounded so they cannot crowd out in-process
        // sources. At the bound, the incarnation that has been disconnected
        // longest gives way: its reconnect window ends now and its runs are
        // lost. A new hello is refused only when every incarnation is connected.
        if (this.publishers.size >= this.limits.maxPublishers) {
            let oldest = null;
            for (const candidate of this.publishers.values()) {
                if (!candidate.connection && (!oldest || candidate.disconnectedAt < oldest.disconnectedAt)) oldest = candidate;
            }
            if (!oldest) {
                this._send(connection, { type: 'hello-refused', reason: 'publisher-limit' });
                return this._drop(connection, 'publisher limit, every publisher is connected');
            }
            this.log(`[live-sessions] publisher limit: disconnected publisher ${oldest.publisherId} evicted; its runs are lost`);
            this._lose(oldest);
        }
        const publisher = { publisherId: random(), resumeToken: random(), connection, runs: new Map(), localRefs: new Map(),
            handles: new Map(), lostTimer: null, disconnectedAt: null };
        this.publishers.set(publisher.publisherId, publisher);
        connection.publisher = publisher;
        this._send(connection, { type: 'welcome', publisherId: publisher.publisherId, resumeToken: publisher.resumeToken });
    }

    // Rebinds a disconnected (or still connected) incarnation to this
    // connection. The old connection loses every run and owner handle.
    _resume(connection, message) {
        const publisher = typeof message.publisherId === 'string' ? this.publishers.get(message.publisherId) : null;
        if (!publisher || typeof message.resumeToken !== 'string' || !safeEqual(message.resumeToken, publisher.resumeToken)) {
            this._send(connection, { type: 'resume-rejected' });
            return this._drop(connection, 'stale or unknown publisher incarnation');
        }
        const previous = publisher.connection;
        if (previous && previous !== connection) {
            previous.publisher = null;
            previous.replaced = true;
            previous.socket.destroy();
            // Controls sent to the replaced connection are never answered.
            this._settleControls(publisher, 'unknown', 'publisher connection replaced');
        }
        clearTimeout(publisher.lostTimer);
        publisher.lostTimer = null;
        publisher.connection = connection;
        publisher.disconnectedAt = null;
        connection.publisher = publisher;
        const runs = [];
        for (const run of publisher.runs.values()) {
            if (run.ended) continue;
            this.registry.status(run.runId, 'running');
            runs.push({ runId: run.runId, lastSeq: run.lastSeq });
        }
        this._send(connection, { type: 'resumed', runs });
        // Acceptances whose run-id may have been lost in the outage.
        for (const [localRef, runId] of publisher.localRefs) {
            if (!publisher.runs.get(runId)?.ended) this._send(connection, { type: 'run-id', localRef, runId });
        }
    }

    _closed(connection) {
        this.connections.delete(connection);
        const publisher = connection.publisher;
        connection.publisher = null;
        if (!publisher || connection.replaced || publisher.connection !== connection) return;
        publisher.connection = null;
        publisher.disconnectedAt = this.now();
        for (const run of publisher.runs.values()) if (!run.ended) this.registry.status(run.runId, 'reconnecting');
        this._settleControls(publisher, 'unknown', 'publisher disconnected');
        if (this.closed) return;
        publisher.lostTimer = setTimeout(() => this._lose(publisher), this.limits.reconnectMs);
        publisher.lostTimer.unref?.();
    }

    _lose(publisher) {
        if (publisher.connection) return;
        clearTimeout(publisher.lostTimer);
        publisher.lostTimer = null;
        for (const run of publisher.runs.values()) {
            if (run.ended) continue;
            run.ended = true;
            this.registry.end(run.runId, 'lost', { reason: 'publisher disconnected' });
        }
        publisher.handles.clear();
        this.publishers.delete(publisher.publisherId);
    }

    _ownerClaim(connection, message) {
        const publisher = connection.publisher;
        const claimId = typeof message.claimId === 'string' && REF.test(message.claimId) ? message.claimId : null;
        if (!claimId) return this._drop(connection, 'invalid owner claim');
        const reject = (reason) => this._send(connection, { type: 'owner-rejected', claimId, reason });
        this._expireHandles(publisher);
        if (typeof message.token !== 'string' || !message.token || message.token.length > TOKEN_LIMIT
            || !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) return reject('invalid');
        if (!this.verifyOwner) return reject('unavailable');
        let result;
        try { result = this.verifyOwner(message.token, message.args); } catch { result = null; }
        if (!result?.ok || !verifiedDirectUser(result.payload)) return reject('unverified');
        const roles = Array.isArray(result.payload.actor.roles) ? result.payload.actor.roles.filter((role) => typeof role === 'string') : [];
        // Unused handles are bounded per principal and per incarnation. A new
        // proof evicts the oldest unused handle, so claims whose turns never
        // started cannot block owner proof for anyone else.
        const principal = result.payload.actor.id;
        const unused = [...publisher.handles].filter(([, handle]) => !handle.used);
        const own = unused.filter(([, handle]) => handle.principal === principal);
        const evicted = own.length >= this.limits.principalPendingClaims ? own[0]
            : unused.length >= this.limits.pendingClaims ? unused[0] : null;
        if (evicted) publisher.handles.delete(evicted[0]);
        const ownerHandle = random();
        publisher.handles.set(ownerHandle, { principal, roles: Object.freeze([...roles]),
            publisherId: publisher.publisherId, expiresAt: this.now() + this.limits.handleLifetimeMs, used: false });
        this._send(connection, { type: 'owner-handle', claimId, ownerHandle });
    }

    // The publisher drops a handle whose turn never started.
    _ownerRelease(connection, message) {
        if (typeof message.ownerHandle === 'string') connection.publisher.handles.delete(message.ownerHandle);
    }

    // A used handle is kept only while one of its runs is live.
    _releaseUsedHandle(publisher, ownerHandle) {
        const handle = ownerHandle ? publisher.handles.get(ownerHandle) : null;
        if (!handle?.used) return;
        for (const run of publisher.runs.values()) if (!run.ended && run.ownerHandle === ownerHandle) return;
        publisher.handles.delete(ownerHandle);
    }

    _expireHandles(publisher) {
        const now = this.now();
        for (const [handle, record] of publisher.handles) if (record.expiresAt <= now) publisher.handles.delete(handle);
    }

    _runStart(connection, message) {
        const publisher = connection.publisher;
        const localRef = typeof message.localRef === 'string' && REF.test(message.localRef) ? message.localRef : null;
        if (!localRef) return this._drop(connection, 'invalid run-start');
        const known = publisher.localRefs.get(localRef);
        if (known) return this._send(connection, { type: 'run-id', localRef, runId: known });
        const refuse = (reason) => this._send(connection, { type: 'run-refused', localRef, reason });
        if (!PUBLISHER_KINDS.has(message.kind)) return refuse('kind');
        const live = [...publisher.runs.values()].filter((run) => !run.ended);
        if (live.length >= this.limits.connectionLiveRuns) return refuse('connection-limit');
        this._expireHandles(publisher);
        // Only a handle this incarnation obtained proves an owner. Any other
        // value, and every publisher-declared identity field, is ignored.
        const handle = typeof message.ownerHandle === 'string' ? publisher.handles.get(message.ownerHandle) : null;
        if (handle && live.filter((run) => run.ownerHandle === message.ownerHandle).length >= this.limits.handleLiveRuns) {
            return refuse('owner-limit');
        }
        const transcript = this._transcript(message.transcriptUrl);
        const ref = { runId: null };
        let admitted;
        try {
            admitted = this.registry.admit({
                kind: message.kind,
                title: typeof message.title === 'string' ? message.title : message.kind,
                detail: typeof message.robot === 'string' ? `Robot ${message.robot}` : '',
                cwdDisplay: typeof message.cwd === 'string' ? message.cwd : '',
                ownerState: handle ? 'verified' : 'unverified',
                ownerPrincipal: handle?.principal,
                controls: this._controlsFor(publisher, ref, message.kind),
                transcript,
            });
        } catch (error) {
            return refuse(error instanceof LiveSessionsFullError ? 'registry-full' : 'invalid');
        }
        ref.runId = admitted.id;
        if (handle) handle.used = true;
        const run = { runId: admitted.id, localRef, ownerHandle: handle ? message.ownerHandle : null, lastSeq: 0, ended: false };
        publisher.runs.set(run.runId, run);
        publisher.localRefs.set(localRef, run.runId);
        this._send(connection, { type: 'run-id', localRef, runId: run.runId });
    }

    _transcript(value) {
        if (!this.readTranscript || typeof value !== 'string' || value.length > 512) return null;
        const match = value.match(TRANSCRIPT_PATH);
        if (!match) return null;
        const [, sessionId, messageId] = match;
        return () => this.readTranscript(sessionId, messageId);
    }

    _ownedRun(connection, runId) {
        const run = typeof runId === 'string' ? connection.publisher.runs.get(runId) : null;
        if (!run) this._send(connection, { type: 'rejected', runId: typeof runId === 'string' ? runId.slice(0, 128) : null, reason: 'not-owner' });
        return run;
    }

    _runEvent(connection, message) {
        const run = this._ownedRun(connection, message.runId);
        if (!run || run.ended) return;
        if (!Number.isSafeInteger(message.seq) || message.seq < 1 || typeof message.text !== 'string') return this._drop(connection, 'invalid run-event');
        if (message.seq <= run.lastSeq) return;
        if (message.seq > run.lastSeq + 1) {
            this.registry.output(run.runId, `\n[${message.seq - run.lastSeq - 1} output event(s) were lost]\n`, 'status');
        }
        run.lastSeq = message.seq;
        this.registry.output(run.runId, message.text, OUTPUT_STYLES.includes(message.style) ? message.style : 'output');
    }

    _runEnd(connection, message) {
        const run = this._ownedRun(connection, message.runId);
        if (!run || run.ended) return;
        const status = PUBLISHER_END_STATUSES.has(message.status) ? message.status : 'failed';
        run.ended = true;
        this.registry.end(run.runId, status, { reason: typeof message.reason === 'string' ? message.reason : status,
            ...(Number.isSafeInteger(message.code) ? { code: message.code } : {}) });
        this._settleControls(connection.publisher, 'run_ended', 'run ended', run.runId);
        this._releaseUsedHandle(connection.publisher, run.ownerHandle);
        this._forgetEnded(connection.publisher);
    }

    // Ended runs stay known (so a repeated run-start keeps its id) up to a
    // bound per incarnation; the oldest ended records go first.
    _forgetEnded(publisher) {
        if (publisher.runs.size <= ENDED_MEMORY) return;
        for (const run of publisher.runs.values()) {
            if (publisher.runs.size <= ENDED_MEMORY) break;
            if (!run.ended) continue;
            publisher.runs.delete(run.runId);
            if (publisher.localRefs.get(run.localRef) === run.runId) publisher.localRefs.delete(run.localRef);
        }
    }

    // Sends one control to the incarnation's current connection. A control is
    // sent once and never replayed after a disconnect. The control kind is
    // carried in `action`, because `type` is the JSONL message discriminator.
    // Returns { sent, result }: whether the frame was queued for the
    // publisher, and the publisher's answer.
    _control(publisher, runId, action, message) {
        let sent = false;
        const result = new Promise((resolve, reject) => {
            const connection = publisher.connection;
            if (!connection || connection.socket.destroyed) return reject(failure('unknown', 'publisher is reconnecting'));
            const requestId = random();
            const timer = setTimeout(() => {
                this.controls.delete(requestId);
                reject(failure('unknown', 'control timed out'));
            }, this.limits.controlTimeoutMs);
            timer.unref?.();
            this.controls.set(requestId, { publisher, runId, resolve, reject, timer });
            sent = this._send(connection, { type: 'control', requestId, runId, action, ...(message === undefined ? {} : { message }) });
            if (!sent && this.controls.delete(requestId)) {
                clearTimeout(timer);
                reject(failure('unknown', 'control could not be delivered'));
            }
        });
        return { sent, result };
    }

    // Delegated copilot tasks take no messages; their only control is Stop.
    _controlsFor(publisher, ref, kind) {
        return {
            ...(kind === 'copilot-task' ? {} : { message: (text) => this._control(publisher, ref.runId, 'message', text).result }),
            // Stop is accepted once it reaches the publisher; the run ends when
            // the publisher reports run-end.
            stop: async () => {
                const { sent, result } = this._control(publisher, ref.runId, 'stop');
                result.catch(() => {});
                if (!sent) throw Object.assign(new Error('the run publisher is reconnecting; try again'), { statusCode: 409 });
            },
        };
    }

    _controlResult(connection, message) {
        const control = typeof message.requestId === 'string' ? this.controls.get(message.requestId) : null;
        if (!control || control.publisher !== connection.publisher) return;
        this.controls.delete(message.requestId);
        clearTimeout(control.timer);
        const outcome = CONTROL_OUTCOMES.has(message.outcome) ? message.outcome : 'unknown';
        if (outcome === 'delivered' || outcome === 'queued') control.resolve(outcome);
        else control.reject(failure(outcome, typeof message.detail === 'string' ? message.detail.slice(0, 512) : outcome));
    }

    _settleControls(publisher, outcome, reason, runId = null) {
        for (const [requestId, control] of this.controls) {
            if (control.publisher !== publisher || (runId && control.runId !== runId)) continue;
            this.controls.delete(requestId);
            clearTimeout(control.timer);
            control.reject(failure(outcome, reason));
        }
    }
}

// Production entrypoint: verifier from the Agent runtime, the fixed socket path.
export async function startLiveSessionsIpc({ registry, socketPath = IPC_SOCKET_PATH, env = process.env, ...options } = {}) {
    const verifyOwner = await loadOwnerVerifier(env, options.log ? { log: options.log } : {});
    const server = new LiveSessionsIpcServer({ registry, verifyOwner, ...options });
    return server.listen(socketPath);
}
