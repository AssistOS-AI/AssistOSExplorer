import crypto from 'node:crypto';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

// Live Sessions publisher for copilot runs. It speaks the RoboTeam service's
// private IPC protocol (server/live-sessions/ipc-server.mjs) over the
// container-private socket. Publishing never blocks or fails a turn: every
// method is synchronous and returns immediately, and a missing or refusing
// service only means that the run is not listed.
//
// Two queues are kept apart. Lifecycle state (owner claims and releases,
// run-start, run-end) is never evicted. Output is a byte-bounded buffer that
// drops its oldest events; it also keeps events already written so they can be
// sent again after a reconnect, when the service reports what it received.
export const LIVE_SOCKET_PATH = '/dev/shm/roboteam-live/registry.sock';
export const PUBLISHER_DEFAULTS = Object.freeze({
    outputBytes: 256 * 1024,
    // One run-event stays far below the service's 1 MiB line limit even when
    // JSON escaping grows a code unit to six bytes.
    frameCodeUnits: 32 * 1024,
    lineBytes: 1024 * 1024,
    socketHighWater: 256 * 1024,
    claimWaitMs: 10 * 1000,
    claimMaxAgeMs: 60 * 1000,
    controlTimeoutMs: 35 * 1000,
    backoffMinMs: 250,
    backoffMaxMs: 5000,
    refusedBackoffMs: 30 * 1000,
    // The service marks a disconnected publisher's runs lost after 30 s, so
    // an end not confirmed within this window is not sent again.
    resendWindowMs: 30 * 1000,
    endedMemory: 256,
    flushMs: 2000,
});

const STYLES = new Set(['assistant', 'output', 'status', 'user', 'error']);
const END_STATUSES = new Set(['finished', 'failed', 'stopped']);
const OUTCOMES = new Set(['delivered', 'queued', 'rejected', 'unknown', 'run_ended']);
const KINDS = new Set(['copilot-turn', 'copilot-task']);

// Splits text into pieces of at most `limit` UTF-16 code units, never inside
// a surrogate pair.
export function splitOutput(text, limit) {
    if (text.length <= limit) return [text];
    const parts = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(text.length, start + limit);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        parts.push(text.slice(start, end));
        start = end;
    }
    return parts;
}

function oneLine(value, limit = 200) {
    return String(value ?? '').split(/\r?\n/u)[0].slice(0, limit);
}

export class LivePublisher {
    constructor({ socketPath = LIVE_SOCKET_PATH, log = () => {}, connect = net.connect, now = Date.now, ...limits } = {}) {
        this.socketPath = socketPath;
        this.log = log;
        this.connectImpl = connect;
        this.now = now;
        this.limits = { ...PUBLISHER_DEFAULTS };
        for (const key of Object.keys(PUBLISHER_DEFAULTS)) if (Number.isSafeInteger(limits[key]) && limits[key] > 0) this.limits[key] = limits[key];
        this.connection = null;
        this.incarnation = null;
        this.incarnations = 0;
        this.claims = new Map();
        this.runs = new Map();
        this.runIds = new Map();
        this.output = [];
        this.outputBytes = 0;
        this.ended = [];
        this.failures = 0;
        this.reconnectTimer = null;
        this.wakeTimer = null;
        this.refusedUntil = 0;
        this.closed = false;
        this.closing = false;
        this.flushWaiters = [];
    }

    // An owner claim for one WebChat message, sent as soon as the service is
    // reachable. `args` are the exact Router-signed __webchat_message__
    // arguments. Returns an opaque reference to store on the turn context, or
    // null when there is nothing to prove.
    claimOwner(token, args) {
        try {
            if (this.closed || this.closing || typeof token !== 'string' || !token || !args || typeof args !== 'object') return null;
            const claimId = `c_${crypto.randomBytes(12).toString('base64url')}`;
            // A claim whose line would exceed the service's line limit would
            // close the shared connection for every user. It fails here, is
            // never sent, and its runs list as owner unverified.
            const bytes = Buffer.byteLength(JSON.stringify({ type: 'owner-claim', claimId, token, args })) + 1;
            const tooLarge = bytes > this.limits.lineBytes;
            if (tooLarge) this._log('claim.too-large', { bytes, limit: this.limits.lineBytes });
            this.claims.set(claimId, { claimId, token: tooLarge ? null : token, args: tooLarge ? null : args,
                state: tooLarge ? 'failed' : 'queued', handle: null, incarnation: null,
                createdAt: this.now(), sentAt: 0, used: false, released: false });
            this._pump();
            return Object.freeze({ claimId });
        } catch (error) {
            this._log('claim.error', { message: oneLine(error?.message) });
            return null;
        }
    }

    // Drops a claim whose turn published no run. A claim that started a run is
    // released by the service when its last run ends; runs still waiting to
    // start keep the claim until they do.
    releaseOwner(reference) {
        try {
            const claim = reference?.claimId ? this.claims.get(reference.claimId) : null;
            if (!claim) return;
            claim.released = true;
            if (this._awaitingStart(claim)) return;
            if (claim.used) { this.claims.delete(claim.claimId); return; }
            if (claim.state === 'queued' || claim.state === 'rejected' || claim.state === 'failed') { this.claims.delete(claim.claimId); return; }
            this._pump();
        } catch (error) {
            this._log('release.error', { message: oneLine(error?.message) });
        }
    }

    // Opens a run. `owner` is a reference from claimOwner (or null);
    // `onControl({action, requestId, message})` answers service controls with
    // an outcome. Returns a run handle whose methods never throw.
    startRun({ kind, title, cwd = '', robot = '', owner = null, transcriptUrl = '', onControl = null } = {}) {
        const inert = { output() {}, status() {}, end() {}, get ended() { return true; } };
        try {
            if (this.closed || this.closing || !KINDS.has(kind)) return inert;
            const localRef = `r_${crypto.randomBytes(12).toString('base64url')}`;
            const run = { localRef, kind, title: String(title || kind), cwd: String(cwd || ''), robot: String(robot || ''),
                claimId: owner?.claimId || null, transcriptUrl: typeof transcriptUrl === 'string' ? transcriptUrl : '',
                onControl: typeof onControl === 'function' ? onControl : null, createdAt: this.now(),
                runId: null, startIncarnation: null, startSent: false, refused: false, nextSeq: 1,
                end: null, endSent: false, dropped: false };
            this.runs.set(localRef, run);
            this._pump();
            const publisher = this;
            return {
                output(text, style = 'output') { publisher._output(run, text, style); },
                status(text) { publisher._output(run, `${String(text ?? '').replace(/\n+$/u, '')}\n`, 'status'); },
                end(result = {}) { publisher._end(run, result); },
                get ended() { return Boolean(run.end) || run.dropped; },
            };
        } catch (error) {
            this._log('run.error', { message: oneLine(error?.message) });
            return inert;
        }
    }

    // Stops accepting work, gives queued lifecycle messages a short time to
    // reach the service, then disconnects. Runs still live become lost on the
    // service after its reconnect window.
    async close({ flushMs = this.limits.flushMs } = {}) {
        if (this.closed) return;
        this.closing = true;
        if (this._lifecyclePending() && (this.connection || this._shouldConnect())) {
            this._pump();
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, flushMs);
                timer.unref?.();
                this.flushWaiters.push(() => { clearTimeout(timer); resolve(); });
                this._settleFlush();
            });
        }
        this.closed = true;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.wakeTimer);
        const connection = this.connection;
        this.connection = null;
        if (connection) {
            connection.socket.end();
            connection.socket.destroySoon?.();
            setTimeout(() => connection.socket.destroy(), 1000).unref?.();
        }
    }

    // Test and diagnostic view of the queues.
    snapshot() {
        return {
            connected: Boolean(this.connection?.ready),
            incarnation: this.incarnation?.id ?? null,
            claims: [...this.claims.values()].map(({ claimId, state, used, released }) => ({ claimId, state, used, released })),
            runs: [...this.runs.values()].map(({ localRef, runId, startSent, end, endSent, refused }) => ({ localRef, runId, startSent, ended: Boolean(end), endSent, refused })),
            outputEvents: this.output.length,
            outputBytes: this.outputBytes,
        };
    }

    _log(event, fields = {}) {
        try { this.log(`live.${event}`, fields); } catch { /* logging never affects publishing */ }
    }

    _output(run, text, style) {
        try {
            if (this.closed || run.end || run.dropped || run.refused) return;
            const value = typeof text === 'string' ? text : String(text ?? '');
            if (!value) return;
            const frameStyle = STYLES.has(style) ? style : 'output';
            let parts = splitOutput(value, this.limits.frameCodeUnits);
            // Pieces that the byte budget would evict at once are skipped; the
            // sequence gap tells the service and its viewers they were lost.
            let budget = this.limits.outputBytes;
            let keep = parts.length;
            while (keep > 0 && budget - Buffer.byteLength(parts[keep - 1]) >= 0) { budget -= Buffer.byteLength(parts[keep - 1]); keep -= 1; }
            if (keep > 0) { run.nextSeq += keep; parts = parts.slice(keep); }
            for (const part of parts) {
                const bytes = Buffer.byteLength(part);
                this.output.push({ run, seq: run.nextSeq, text: part, style: frameStyle, bytes, sent: false });
                run.nextSeq += 1;
                this.outputBytes += bytes;
            }
            while (this.outputBytes > this.limits.outputBytes && this.output.length) {
                const evicted = this.output.shift();
                this.outputBytes -= evicted.bytes;
            }
            this._pump();
        } catch (error) {
            this._log('output.error', { message: oneLine(error?.message) });
        }
    }

    _end(run, { status = 'finished', code, reason } = {}) {
        try {
            if (run.end || run.dropped) return;
            run.endedAt = this.now();
            run.end = { status: END_STATUSES.has(status) ? status : 'failed',
                ...(Number.isSafeInteger(code) ? { code } : {}),
                ...(typeof reason === 'string' && reason.trim() ? { reason: oneLine(reason, 512) } : {}) };
            if (!this.connection) this._dropUnannounced();
            this._pump();
        } catch (error) {
            this._log('end.error', { message: oneLine(error?.message) });
        }
    }

    // A run that ended before it reached the service is simply not listed.
    _dropUnannounced() {
        for (const run of [...this.runs.values()]) if (run.end && !run.startSent) this._drop(run);
    }

    _drop(run) {
        run.dropped = true;
        this.runs.delete(run.localRef);
        if (run.runId && this.runIds.get(run.runId) === run) this.runIds.delete(run.runId);
        this._dropOutput(run);
    }

    _dropOutput(run, keep = () => false) {
        const remaining = [];
        for (const entry of this.output) {
            if (entry.run === run && !keep(entry)) this.outputBytes -= entry.bytes;
            else remaining.push(entry);
        }
        this.output = remaining;
    }

    _awaitingStart(claim) {
        for (const run of this.runs.values()) if (run.claimId === claim.claimId && !run.startSent && !run.dropped && !run.refused) return true;
        return false;
    }

    _lifecyclePending() {
        for (const claim of this.claims.values()) if (claim.state === 'queued' || (claim.released && !claim.used && claim.state === 'sent')) return true;
        for (const run of this.runs.values()) if (!run.dropped && !run.refused && (!run.startSent || (run.end && !run.endSent))) return true;
        return false;
    }

    _shouldConnect() {
        if (this.closed) return false;
        if (this._lifecyclePending()) return true;
        for (const run of this.runs.values()) if (run.startSent && !run.end) return true;
        return false;
    }

    _settleFlush() {
        if (!this.flushWaiters.length) return;
        if (this._lifecyclePending() && (this.connection || this._shouldConnect())) return;
        for (const waiter of this.flushWaiters.splice(0)) waiter();
    }

    // While disconnected, ends older than the service's reconnect window are
    // given up: their runs are already lost or ended there.
    _expireEnds() {
        if (this.connection?.ready) return;
        const now = this.now();
        for (const run of [...this.runs.values()]) {
            if (run.end && !run.endSent && now - run.endedAt > this.limits.resendWindowMs) this._drop(run);
        }
    }

    _scheduleReconnect() {
        this._expireEnds();
        if (this.closed || this.reconnectTimer || this.connection || !this._shouldConnect()) return;
        const exponent = Math.min(this.failures, 10);
        let delay = Math.min(this.limits.backoffMaxMs, this.limits.backoffMinMs * 2 ** exponent);
        delay = Math.max(delay, this.refusedUntil - this.now());
        this.failures += 1;
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, Math.max(0, delay));
        this.reconnectTimer.unref?.();
    }

    _connect() {
        if (this.closed || this.connection || this.reconnectTimer) return;
        if (this.refusedUntil > this.now()) return this._scheduleReconnect();
        let socket;
        try {
            socket = this.connectImpl(this.socketPath);
        } catch (error) {
            this._connectionFailed(error);
            return this._scheduleReconnect();
        }
        const connection = { socket, ready: false, buffer: '', resuming: Boolean(this.incarnation) };
        this.connection = connection;
        socket.setEncoding?.('utf8');
        socket.on('connect', () => {
            if (this.connection !== connection) return;
            if (this.incarnation) {
                const runs = [...this.runs.values()].filter((run) => run.runId && run.startIncarnation === this.incarnation.id)
                    .map((run) => ({ runId: run.runId, lastSeq: Math.max(0, run.nextSeq - 1) }));
                this._write(connection, { type: 'resume', publisherId: this.incarnation.publisherId, resumeToken: this.incarnation.resumeToken, runs });
            } else {
                this._write(connection, { type: 'hello', pid: process.pid, start: String(Math.round(performance.timeOrigin)) });
            }
        });
        socket.on('data', (chunk) => this._data(connection, chunk));
        socket.on('drain', () => { if (this.connection === connection) this._pump(); });
        socket.on('error', (error) => { if (!connection.ready) this._connectionFailed(error); });
        socket.once('close', () => this._closed(connection));
    }

    _connectionFailed(error) {
        // One record per failure streak; a missing service is an expected state.
        if (this.failures === 0) this._log('connect.failed', { code: error?.code || null, message: oneLine(error?.message) });
    }

    _closed(connection) {
        if (this.connection !== connection) return;
        this.connection = null;
        // A claim whose answer was lost cannot be sent again: its token is
        // single-use. Its turn publishes without an owner (owner unverified).
        for (const claim of this.claims.values()) if (claim.state === 'sent') claim.state = 'failed';
        this._dropUnannounced();
        // Ends written to a connection that then closed may never have
        // arrived; a resume reports which runs are still live.
        for (const run of this.runs.values()) if (run.endSent) run.endSent = false;
        if (this.closed) return;
        this._scheduleReconnect();
        this._settleFlush();
    }

    _write(connection, message) {
        if (connection.socket.destroyed) return false;
        connection.socket.write(`${JSON.stringify(message)}\n`);
        return true;
    }

    _data(connection, chunk) {
        if (this.connection !== connection) return;
        connection.buffer += chunk;
        let newline = connection.buffer.indexOf('\n');
        while (newline >= 0 && this.connection === connection) {
            const line = connection.buffer.slice(0, newline);
            connection.buffer = connection.buffer.slice(newline + 1);
            let message;
            try { message = JSON.parse(line); } catch { message = null; }
            if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
                this._log('protocol.error', { reason: 'malformed service message' });
                connection.socket.destroy();
                return;
            }
            this._message(connection, message);
            newline = connection.buffer.indexOf('\n');
        }
        if (Buffer.byteLength(connection.buffer) > this.limits.lineBytes) {
            this._log('protocol.error', { reason: 'service line limit' });
            connection.socket.destroy();
        }
    }

    _message(connection, message) {
        switch (message.type) {
            case 'welcome': return this._welcome(connection, message);
            case 'resumed': return this._resumed(connection, message);
            case 'resume-rejected':
                this._log('resume.rejected');
                this._forgetIncarnation();
                return;
            case 'hello-refused':
                this._log('hello.refused', { reason: oneLine(message.reason, 64) });
                this.refusedUntil = this.now() + this.limits.refusedBackoffMs;
                return;
            case 'owner-handle': return this._ownerHandle(message);
            case 'owner-rejected': {
                const claim = this.claims.get(message.claimId);
                if (claim && claim.state === 'sent') {
                    claim.state = 'rejected';
                    this._log('claim.rejected', { reason: oneLine(message.reason, 64) });
                    if (claim.released) this.claims.delete(claim.claimId);
                }
                return this._pump();
            }
            case 'run-id': return this._runId(message);
            case 'run-refused': {
                const run = this.runs.get(message.localRef);
                if (run && !run.runId) {
                    run.refused = true;
                    this._log('run.refused', { reason: oneLine(message.reason, 64) });
                    this._drop(run);
                }
                return this._pump();
            }
            case 'rejected':
                this._log('run.rejected', { reason: oneLine(message.reason, 64) });
                return;
            case 'control': return this._control(connection, message);
            default: return;
        }
    }

    _forgetIncarnation() {
        this.incarnation = null;
        // Runs announced by a gone incarnation are not announced again; only
        // runs that never reached the service are published by the next one.
        for (const run of [...this.runs.values()]) if (run.startSent) this._drop(run);
        this.ended = [];
    }

    _welcome(connection, message) {
        if (typeof message.publisherId !== 'string' || typeof message.resumeToken !== 'string') return connection.socket.destroy();
        if (this.incarnation) this._forgetIncarnation();
        this.incarnations += 1;
        this.incarnation = { id: this.incarnations, publisherId: message.publisherId, resumeToken: message.resumeToken };
        this._ready(connection);
    }

    _resumed(connection, message) {
        const listed = new Map();
        for (const entry of Array.isArray(message.runs) ? message.runs : []) {
            if (typeof entry?.runId === 'string' && Number.isSafeInteger(entry.lastSeq)) listed.set(entry.runId, entry.lastSeq);
        }
        for (const run of [...this.runs.values()]) {
            if (!run.startSent || run.startIncarnation !== this.incarnation?.id) continue;
            if (!run.runId) { run.startSent = false; continue; }
            if (!listed.has(run.runId)) { this._drop(run); continue; }
            // Send again what the service did not record, then the end.
            const lastSeq = listed.get(run.runId);
            this._dropOutput(run, (entry) => entry.seq > lastSeq);
            for (const entry of this.output) if (entry.run === run) entry.sent = false;
            run.endSent = false;
        }
        this._ready(connection);
    }

    _ready(connection) {
        connection.ready = true;
        this.failures = 0;
        this.refusedUntil = 0;
        this._log('connected', { incarnation: this.incarnation?.id ?? null, resumed: connection.resuming });
        this._pump();
    }

    _ownerHandle(message) {
        const claim = this.claims.get(message.claimId);
        if (!claim || claim.state !== 'sent' || typeof message.ownerHandle !== 'string') return this._pump();
        claim.state = 'granted';
        claim.handle = message.ownerHandle;
        claim.incarnation = this.incarnation?.id ?? null;
        this._pump();
    }

    _runId(message) {
        const run = this.runs.get(message.localRef);
        if (!run || typeof message.runId !== 'string' || run.runId === message.runId) return this._pump();
        if (run.runId || !run.startSent || run.startIncarnation !== this.incarnation?.id) return this._pump();
        run.runId = message.runId;
        this.runIds.set(run.runId, run);
        this._pump();
    }

    _control(connection, message) {
        const requestId = typeof message.requestId === 'string' ? message.requestId : null;
        if (!requestId) return;
        const incarnation = this.incarnation?.id;
        const reply = (outcome, detail) => {
            if (this.connection !== connection || this.incarnation?.id !== incarnation || !connection.ready) return;
            this._write(connection, { type: 'control-result', requestId, outcome: OUTCOMES.has(outcome) ? outcome : 'unknown',
                ...(typeof detail === 'string' && detail ? { detail: oneLine(detail, 512) } : {}) });
        };
        const run = typeof message.runId === 'string' ? this.runIds.get(message.runId) : null;
        if (!run || run.end || run.dropped) return reply('run_ended');
        if (!run.onControl || !['message', 'stop'].includes(message.action)) return reply('rejected', 'unsupported control');
        let result;
        try {
            result = run.onControl({ action: message.action, requestId, message: typeof message.message === 'string' ? message.message : undefined });
        } catch (error) {
            return reply('unknown', error?.message);
        }
        Promise.resolve(result).then((value) => {
            const outcome = typeof value === 'string' ? value : value?.outcome;
            reply(outcome, typeof value === 'object' ? value?.detail : undefined);
        }, (error) => reply(OUTCOMES.has(error?.liveOutcome) ? error.liveOutcome : 'unknown', error?.message));
    }

    _expireClaims() {
        const now = this.now();
        for (const claim of this.claims.values()) {
            // A token this old is expired; the service would refuse it.
            if (claim.state === 'queued' && now - claim.createdAt > this.limits.claimMaxAgeMs) claim.state = 'failed';
            if (claim.released && claim.state === 'failed' && !this._awaitingStart(claim)) this.claims.delete(claim.claimId);
        }
    }

    _wake(delay) {
        if (this.wakeTimer) return;
        this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this._pump(); }, Math.max(1, delay));
        this.wakeTimer.unref?.();
    }

    _pump() {
        if (this.closed) return;
        this._expireClaims();
        this._expireEnds();
        const connection = this.connection;
        if (!connection) {
            if (this._shouldConnect()) this._connect();
            return this._settleFlush();
        }
        if (!connection.ready) return;
        const incarnation = this.incarnation.id;
        for (const claim of this.claims.values()) {
            if (claim.state === 'queued') {
                claim.state = 'sent';
                claim.sentAt = this.now();
                this._write(connection, { type: 'owner-claim', claimId: claim.claimId, token: claim.token, args: claim.args });
                // The token is single-use; it is never kept after sending.
                claim.token = null;
                claim.args = null;
            } else if (claim.state === 'granted' && claim.released && !claim.used && !this._awaitingStart(claim)) {
                if (claim.incarnation === incarnation) this._write(connection, { type: 'owner-release', ownerHandle: claim.handle });
                this.claims.delete(claim.claimId);
            }
        }
        let wait = 0;
        for (const run of this.runs.values()) {
            if (run.startSent || run.refused || run.dropped) continue;
            const claim = run.claimId ? this.claims.get(run.claimId) : null;
            const pending = claim && (claim.state === 'queued' || claim.state === 'sent');
            const waited = this.now() - run.createdAt;
            if (pending && waited < this.limits.claimWaitMs) { wait = wait ? Math.min(wait, this.limits.claimWaitMs - waited) : this.limits.claimWaitMs - waited; continue; }
            const handle = claim?.state === 'granted' ? claim.handle : null;
            if (claim && handle) claim.used = true;
            run.startSent = true;
            run.startIncarnation = incarnation;
            this._write(connection, { type: 'run-start', localRef: run.localRef, kind: run.kind, title: run.title, cwd: run.cwd, robot: run.robot,
                ...(handle ? { ownerHandle: handle } : {}), ...(run.transcriptUrl ? { transcriptUrl: run.transcriptUrl } : {}) });
            if (claim?.released && claim.used && !this._awaitingStart(claim)) this.claims.delete(claim.claimId);
        }
        if (wait) this._wake(wait);
        let blocked = false;
        for (const entry of this.output) {
            if (entry.sent) continue;
            const run = entry.run;
            if (!run.runId || run.startIncarnation !== incarnation) continue;
            if (connection.socket.writableLength > this.limits.socketHighWater) { blocked = true; break; }
            entry.sent = this._write(connection, { type: 'run-event', runId: run.runId, seq: entry.seq, text: entry.text, style: entry.style });
        }
        for (const run of [...this.runs.values()]) {
            if (!run.end || run.endSent || !run.runId || run.startIncarnation !== incarnation) continue;
            if (blocked && this.output.some((entry) => entry.run === run && !entry.sent)) continue;
            run.endSent = this._write(connection, { type: 'run-end', runId: run.runId, status: run.end.status,
                ...(run.end.code !== undefined ? { code: run.end.code } : {}), ...(run.end.reason ? { reason: run.end.reason } : {}) });
            if (run.endSent) this._remember(run);
        }
        this._settleFlush();
    }

    // Ended runs stay known, up to a bound, so late controls answer run_ended
    // and a reconnect can resend what the service missed. Their output stays
    // in the shared byte budget.
    _remember(run) {
        this.ended.push(run);
        while (this.ended.length > this.limits.endedMemory) {
            const old = this.ended.shift();
            if (this.runs.get(old.localRef) === old) this._drop(old);
        }
    }
}

// The publisher of a copilot process started by server/robot-cli.mjs. Every
// other process (robot tasks, tests, standalone CLIs) gets none.
export function createCopilotPublisher(env = process.env, options = {}) {
    return env.ROBOTEAM_LIVE_PUBLISH === 'copilot' ? new LivePublisher(options) : null;
}
