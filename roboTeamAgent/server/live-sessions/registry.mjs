import crypto from 'node:crypto';
import {
    ENDED_STATUSES, KINDS, LIST_LIMIT, LIVE_STATUSES, MESSAGE_LIMIT, OUTPUT_STYLES, OUTPUT_TEXT_LIMIT, OWNER_STATES, RUN_ID,
    STATUS_TEXT_LIMIT, cleanText, frameViolation, isOwnedUrl, rowViolation, serializeFrame, tailText,
} from './contract.mjs';

// In-memory Live Sessions registry for RoboTeam agent runs. Run metadata is
// kept apart from each run's output ring. The server assigns every id; owner
// identity is only what the caller (an in-process source or the IPC server)
// proved. Nothing here is persisted: a service restart ends every listing.
export const REGISTRY_DEFAULTS = Object.freeze({
    maxLive: 256,
    maxFinished: 256,
    retentionMs: 60 * 60 * 1000,
    ringBytes: 1024 * 1024,
    ringEvents: 8192,
    viewersPerRun: 8,
    viewersTotal: 64,
    viewerQueueBytes: 1024 * 1024 + 256 * 1024,
    drainTimeoutMs: 30 * 1000,
    heartbeatMs: 20 * 1000,
});

// Output text is split so that one encoded frame stays far below the viewer
// queue limit: JSON escaping can grow a UTF-16 code unit to six bytes.
const FRAME_CODE_UNITS = 32 * 1024;

function splitText(text) {
    if (text.length <= FRAME_CODE_UNITS) return [text];
    const parts = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(text.length, start + FRAME_CODE_UNITS);
        // Never split a surrogate pair.
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        parts.push(text.slice(start, end));
        start = end;
    }
    return parts;
}

const NOT_FOUND = Object.freeze({ ok: false, status: 404, error: 'live session not found' });
const PRINCIPAL = /^user:.+/u;
const OWNER_LABELS = Object.freeze({ system: 'system', unverified: 'owner unverified' });
const OUTCOMES = new Set(['delivered', 'queued']);
const FAILED_OUTCOMES = new Set(['rejected', 'run_ended', 'unknown']);

export class LiveSessionsFullError extends Error {
    constructor() {
        super('Live Sessions registry is full');
        this.code = 'LIVE_SESSIONS_FULL';
    }
}

function refusal(status, error) {
    return { ok: false, status, error };
}

function exitRecord(status, exit = {}) {
    const reason = cleanText(String(exit?.reason || status).split(/\r?\n/u)[0], 128).trim() || status;
    const record = { reason };
    if (Number.isSafeInteger(exit?.code)) record.code = exit.code;
    const signal = cleanText(exit?.signal || '', 32).trim();
    if (signal) record.signal = signal;
    return record;
}

export class LiveSessionsRegistry {
    constructor(options = {}) {
        this.limits = { ...REGISTRY_DEFAULTS };
        for (const key of Object.keys(REGISTRY_DEFAULTS)) {
            if (Number.isSafeInteger(options[key]) && options[key] > 0) this.limits[key] = options[key];
        }
        this.now = options.now || Date.now;
        this.log = options.log || ((line) => console.warn(line));
        this.agent = String(options.agent || 'roboTeamAgent');
        this.source = cleanText(options.source || 'RoboTeam', 128) || 'RoboTeam';
        // Path-only prefix that routes to this service, for example
        // /base-agent-additional-server/roboTeamAgent/3001. Row URLs are
        // published only when they satisfy the ownership rule.
        this.urlBase = String(options.urlBase || '').replace(/\/+$/u, '');
        this.runs = new Map();
        this.viewerTotal = 0;
        this.heartbeatTimer = null;
        this.closed = false;
    }

    // A new live run. Throws LiveSessionsFullError at the live cap; a live run
    // is never evicted to make room.
    admit(input = {}) {
        if (this.closed) throw new Error('Live Sessions registry is closed');
        this.prune();
        if (!KINDS.includes(input.kind)) throw new Error('invalid live session kind');
        const ownerState = OWNER_STATES.includes(input.ownerState) ? input.ownerState : 'system';
        const ownerPrincipal = ownerState === 'verified' ? input.ownerPrincipal : null;
        if (ownerState === 'verified' && (typeof ownerPrincipal !== 'string' || !PRINCIPAL.test(ownerPrincipal))) {
            throw new Error('a verified live session requires a signed principal');
        }
        if (this.liveCount() >= this.limits.maxLive) throw new LiveSessionsFullError();
        let id;
        do id = `rt_${crypto.randomBytes(18).toString('base64url')}`; while (this.runs.has(id));
        const now = this.now();
        const run = {
            id, kind: input.kind, ownerState, ownerPrincipal,
            title: cleanText(input.title, 256).trim() || input.kind,
            detail: cleanText(input.detail, 256),
            cwdDisplay: cleanText(input.cwdDisplay, 4096),
            access: input.access === 'rw' ? 'rw' : 'ro',
            ownerLabel: ownerState === 'verified'
                ? cleanText(input.ownerLabel || ownerPrincipal.slice(5), 128)
                : OWNER_LABELS[ownerState],
            status: LIVE_STATUSES.includes(input.status) ? input.status : 'running',
            statusText: undefined,
            exit: null,
            startedAt: now, lastActivityAt: now, endedAt: null,
            controls: { message: typeof input.controls?.message === 'function' ? input.controls.message : null,
                stop: typeof input.controls?.stop === 'function' ? input.controls.stop : null },
            transcript: typeof input.transcript === 'function' ? input.transcript : null,
            ring: [], ringBytes: 0, nextSeq: 1, rolled: false,
            viewers: new Set(),
        };
        this.runs.set(id, run);
        return { id };
    }

    liveCount() {
        let count = 0;
        for (const run of this.runs.values()) if (run.endedAt === null) count += 1;
        return count;
    }

    // Output for a live run. Returns false when the run is unknown or ended.
    // Long text becomes several frames, each well under the viewer queue limit.
    output(id, text, style = 'output') {
        const run = this.runs.get(id);
        if (!run || run.endedAt !== null) return false;
        const value = tailText(text, OUTPUT_TEXT_LIMIT);
        if (!value) return true;
        const frameStyle = OUTPUT_STYLES.includes(style) ? style : 'output';
        for (const part of splitText(value)) {
            const data = { text: part, style: frameStyle };
            const violation = frameViolation('output', data);
            if (violation) {
                this.log(`[live-sessions] dropped invalid output frame for ${id}: ${violation}`);
                return false;
            }
            const seq = run.nextSeq;
            run.nextSeq += 1;
            const frame = serializeFrame('output', data, seq);
            const entry = { seq, frame, bytes: Buffer.byteLength(frame) };
            run.ring.push(entry);
            run.ringBytes += entry.bytes;
            while (run.ring.length > 1 && (run.ringBytes > this.limits.ringBytes || run.ring.length > this.limits.ringEvents)) {
                run.ringBytes -= run.ring.shift().bytes;
                run.rolled = true;
            }
            for (const viewer of run.viewers) this._enqueue(viewer, frame);
        }
        run.lastActivityAt = this.now();
        return true;
    }

    status(id, status, text) {
        const run = this.runs.get(id);
        if (!run || run.endedAt !== null || !LIVE_STATUSES.includes(status)) return false;
        run.status = status;
        run.statusText = text === undefined ? undefined : cleanText(text, STATUS_TEXT_LIMIT);
        run.lastActivityAt = this.now();
        const frame = this._statusFrame(run);
        if (frame) for (const viewer of run.viewers) this._enqueue(viewer, frame);
        return true;
    }

    // Ends a run exactly once. Returns false for an unknown or ended run.
    end(id, status, exit = {}) {
        const run = this.runs.get(id);
        if (!run || run.endedAt !== null) return false;
        run.status = ENDED_STATUSES.includes(status) ? status : 'failed';
        run.exit = exitRecord(run.status, exit);
        run.endedAt = this.now();
        run.lastActivityAt = run.endedAt;
        run.controls = { message: null, stop: null };
        const frame = serializeFrame('exit', { status: run.status, exit: run.exit });
        for (const viewer of run.viewers) {
            this._enqueue(viewer, frame);
            viewer.endAfterFlush = true;
            this._pump(viewer);
        }
        this._enforceFinishedCap();
        return true;
    }

    _enforceFinishedCap() {
        const ended = [...this.runs.values()].filter((run) => run.endedAt !== null).sort((left, right) => left.endedAt - right.endedAt);
        while (ended.length > this.limits.maxFinished) this._remove(ended.shift());
    }

    _remove(run) {
        for (const viewer of [...run.viewers]) this._dropViewer(viewer, false);
        this.runs.delete(run.id);
    }

    // Finished runs stay listed for the retention period, then drop off.
    prune() {
        const now = this.now();
        for (const run of [...this.runs.values()]) {
            if (run.endedAt !== null && now - run.endedAt >= this.limits.retentionMs) this._remove(run);
        }
    }

    _visible(run, viewer) {
        if (!viewer || typeof viewer.principal !== 'string') return false;
        return viewer.canAdmin === true || this._isOwner(run, viewer);
    }

    _isOwner(run, viewer) {
        return run.ownerState === 'verified' && typeof viewer?.principal === 'string' && run.ownerPrincipal === viewer.principal;
    }

    _row(run, viewer) {
        const ended = run.endedAt !== null;
        const isOwner = this._isOwner(run, viewer);
        const row = {
            id: run.id, source: this.source, kind: run.kind, title: run.title, detail: run.detail, cwdDisplay: run.cwdDisplay,
            access: run.access, status: run.status, isOwner, ownerLabel: run.ownerLabel,
            viewerCount: run.viewers.size, startedAt: run.startedAt, lastActivityAt: run.lastActivityAt,
            capabilities: { watch: true, input: false,
                stop: !ended && Boolean(run.controls.stop) && (isOwner || viewer.canAdmin === true),
                message: !ended && Boolean(run.controls.message) && isOwner },
            attach: { mode: 'event-stream' }, ownerState: run.ownerState, exit: ended ? { ...run.exit } : null,
        };
        if (ended) row.endedAt = run.endedAt;
        if (this.urlBase) {
            const viewUrl = `${this.urlBase}/live-sessions/${run.id}`;
            if (isOwnedUrl(viewUrl, this.agent)) row.viewUrl = viewUrl;
            const transcriptUrl = `${this.urlBase}/api/live-sessions/${run.id}/transcript`;
            if (run.transcript && isOwnedUrl(transcriptUrl, this.agent)) row.transcriptUrl = transcriptUrl;
        }
        return row;
    }

    // Validated rows visible to a viewer {principal, canAdmin}. An invalid
    // row is dropped and logged rather than sent.
    list(viewer) {
        this.prune();
        const rows = [];
        const runs = [...this.runs.values()].filter((run) => this._visible(run, viewer))
            .sort((left, right) => right.startedAt - left.startedAt);
        for (const run of runs) {
            const row = this._row(run, viewer);
            const violation = rowViolation(row, this.agent);
            if (violation) {
                this.log(`[live-sessions] dropped invalid row ${run.id}: ${violation}`);
                continue;
            }
            rows.push(row);
            if (rows.length >= LIST_LIMIT) break;
        }
        return rows;
    }

    // Authorization for one run. Runs the viewer may not see are reported as
    // absent, never as forbidden.
    authorize(id, viewer, need = 'watch') {
        this.prune();
        const run = typeof id === 'string' && RUN_ID.test(id) ? this.runs.get(id) : null;
        if (!run || !this._visible(run, viewer)) return NOT_FOUND;
        if (need === 'watch') return { ok: true, run };
        const ended = run.endedAt !== null;
        const isOwner = this._isOwner(run, viewer);
        if (need === 'message') {
            if (!isOwner) return refusal(403, 'only the owner can message this run');
            if (ended) return refusal(409, 'run_ended');
            if (!run.controls.message) return refusal(403, 'messages are unavailable for this run');
            return { ok: true, run };
        }
        if (need === 'stop') {
            if (!isOwner && viewer.canAdmin !== true) return refusal(403, 'only the owner or an administrator can stop this run');
            if (ended) return refusal(409, 'run_ended');
            if (!run.controls.stop) return refusal(403, 'stop is unavailable for this run');
            return { ok: true, run };
        }
        return refusal(400, 'invalid live session action');
    }

    // Owner message. Resolves {outcome, detail?} with outcome one of
    // delivered, queued, rejected, run_ended or unknown; it is never retried.
    async message(id, viewer, message, options = undefined) {
        if (typeof message !== 'string' || message.length < 1 || message.length > MESSAGE_LIMIT) {
            return refusal(400, `message must contain 1 to ${MESSAGE_LIMIT} characters`);
        }
        const access = this.authorize(id, viewer, 'message');
        if (!access.ok) return access.status === 409 ? { ok: true, outcome: 'run_ended' } : access;
        const send = access.run.controls.message;
        let outcome;
        let detail;
        try {
            outcome = await send(message, options);
        } catch (error) {
            outcome = FAILED_OUTCOMES.has(error?.liveOutcome) ? error.liveOutcome : 'unknown';
            if (outcome === 'rejected') detail = cleanText(error?.message || '', 512) || undefined;
        }
        if (!OUTCOMES.has(outcome) && !FAILED_OUTCOMES.has(outcome)) outcome = 'unknown';
        if (access.run.endedAt === null) access.run.lastActivityAt = this.now();
        return { ok: true, outcome, ...(detail ? { detail } : {}) };
    }

    // Owner or administrator stop. The run ends when its lifecycle reports
    // it, not on this call.
    async stop(id, viewer, options = undefined) {
        const access = this.authorize(id, viewer, 'stop');
        if (!access.ok) return access;
        await access.run.controls.stop(options);
        return { ok: true };
    }

    // Transcript text from server-bound metadata only. null when the run has
    // no transcript yet.
    async transcript(id, viewer) {
        const access = this.authorize(id, viewer, 'watch');
        if (!access.ok) return access;
        const text = access.run.transcript ? await access.run.transcript() : null;
        return { ok: true, text: typeof text === 'string' ? text : null };
    }

    // Streams one run to an SSE response. lastEventId is the raw
    // Last-Event-ID header value, if any.
    attach(id, viewer, res, lastEventId) {
        const access = this.authorize(id, viewer, 'watch');
        if (!access.ok) return access;
        const run = access.run;
        if (run.viewers.size >= this.limits.viewersPerRun || this.viewerTotal >= this.limits.viewersTotal) {
            return refusal(429, 'too many viewers for this live session');
        }
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
            'x-content-type-options': 'nosniff',
        });
        const target = { res, queue: [], queuedBytes: 0, waiting: false, drainTimer: null, closed: false, endAfterFlush: false, run };
        target.onDrain = () => {
            target.waiting = false;
            clearTimeout(target.drainTimer);
            target.drainTimer = null;
            this._pump(target);
        };
        target.onClose = () => this._dropViewer(target, false);
        res.on('close', target.onClose);
        res.on('error', target.onClose);
        run.viewers.add(target);
        this.viewerTotal += 1;
        for (const frame of this._replay(run, lastEventId)) this._enqueue(target, frame);
        if (run.endedAt === null) {
            const status = this._statusFrame(run);
            if (status) this._enqueue(target, status);
        } else {
            this._enqueue(target, serializeFrame('exit', { status: run.status, exit: run.exit }));
            target.endAfterFlush = true;
            this._pump(target);
        }
        this._startHeartbeat();
        return { ok: true };
    }

    _replay(run, lastEventId) {
        const frames = run.ring.map((entry) => entry.frame);
        if (lastEventId === undefined || lastEventId === null || lastEventId === '') {
            return run.rolled ? [serializeFrame('replay-truncated', {}), ...frames] : frames;
        }
        const raw = String(lastEventId).trim();
        const cursor = /^\d{1,15}$/u.test(raw) ? Number(raw) : NaN;
        const last = run.nextSeq - 1;
        const first = run.ring.length ? run.ring[0].seq : run.nextSeq;
        // A cursor this run never issued, or one older than the ring, restarts
        // the replay: the client clears its view and receives the whole ring.
        if (!Number.isSafeInteger(cursor) || cursor > last || cursor < first - 1) {
            return [serializeFrame('resync', {}), ...frames];
        }
        return run.ring.filter((entry) => entry.seq > cursor).map((entry) => entry.frame);
    }

    _statusFrame(run) {
        const data = { status: run.status, ...(run.statusText ? { text: run.statusText } : {}) };
        if (frameViolation('status', data)) return null;
        return serializeFrame('status', data);
    }

    _enqueue(target, chunk) {
        if (target.closed) return;
        target.queue.push(chunk);
        target.queuedBytes += Buffer.byteLength(chunk);
        if (target.queuedBytes > this.limits.viewerQueueBytes) {
            this._dropViewer(target, true);
            return;
        }
        this._pump(target);
    }

    _pump(target) {
        while (!target.closed && !target.waiting && target.queue.length) {
            const chunk = target.queue.shift();
            target.queuedBytes -= Buffer.byteLength(chunk);
            let written;
            try { written = target.res.write(chunk); } catch { this._dropViewer(target, true); return; }
            if (!written) {
                target.waiting = true;
                target.res.once('drain', target.onDrain);
                target.drainTimer = setTimeout(() => this._dropViewer(target, true), this.limits.drainTimeoutMs);
                target.drainTimer.unref?.();
            }
        }
        if (!target.closed && !target.waiting && !target.queue.length && target.endAfterFlush) this._dropViewer(target, false);
    }

    // Removes a viewer. A slow viewer is cut off; any other ends cleanly. The
    // run itself keeps going.
    _dropViewer(target, slow) {
        if (target.closed) return;
        target.closed = true;
        clearTimeout(target.drainTimer);
        target.res.removeListener('drain', target.onDrain);
        target.res.removeListener('close', target.onClose);
        target.queue = [];
        target.queuedBytes = 0;
        if (target.run.viewers.delete(target)) this.viewerTotal -= 1;
        try {
            if (slow) target.res.destroy();
            else target.res.end();
        } catch { /* The response may already be closed. */ }
        if (this.viewerTotal === 0) this._stopHeartbeat();
    }

    heartbeat() {
        for (const run of this.runs.values()) {
            for (const viewer of [...run.viewers]) this._enqueue(viewer, ': keepalive\n\n');
        }
    }

    _startHeartbeat() {
        if (this.closed || this.heartbeatTimer || this.viewerTotal === 0) return;
        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.limits.heartbeatMs);
        this.heartbeatTimer.unref?.();
    }

    _stopHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    // Private record access for sources; never sent to clients.
    get(id) {
        const run = this.runs.get(id);
        return run ? { id: run.id, kind: run.kind, status: run.status, ended: run.endedAt !== null,
            ownerState: run.ownerState, viewerCount: run.viewers.size } : null;
    }

    close() {
        this.closed = true;
        for (const run of this.runs.values()) for (const viewer of [...run.viewers]) this._dropViewer(viewer, false);
        this._stopHeartbeat();
    }
}
