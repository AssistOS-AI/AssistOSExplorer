import { canonicalJson, fail } from './stateProtocol.mjs';

// Reference observation and control records (S1x). The single module that touches the
// reference_event, reference_cursor and reference_control tables.
//
// State events: one per attempt transition (queued, running, stopping, terminal), appended
// in the transaction that makes the transition, so at most four per reference; output events
// and their retention belong to S6 (G5). Events are never updated or deleted here.
// `reference_cursor.first_retained` is the first sequence still retained; it stays 1 until
// S6 adds retention, and a reader asking for events before it gets a retention gap.
//
// Controls: one immutable record per (reference, actor, operation ID) with its request digest,
// its payload (the canonical JSON `{message, displayText?, id?}` of a `message`, NULL for `stop`, bounded by
// requestBytes before persistence) and its recorded response. The payload is kept for the
// execution engine and is never returned by any read. `delivery` is `applied` (no further
// work) or `pending` (recorded for the S6 execution engine; S6 widens it).
//
// Schema version 5 (S6 source-only subset): `op` admits `pause`, which only an observation
// reference accepts (Part D, step W2); on an execution reference it is `invalid_request`,
// checked after visibility. `source` is `relay` for a relayed user control and `fence` for a
// stop recorded by a pause or cancellation fence; fence stops do not count toward the
// `controls` capacity (Part D).

export const CONTROL_OPS = Object.freeze(['stop', 'message', 'pause', 'answer']);
export const EVENTS_MAX_LIMIT = 1000;
// Schema version 7 (RoboWork r10 wiring): output events. `type` is `state` (lifecycle), `ala` (one record that the
// orchestration domain wrote, relayed unchanged as `data: {record}`) or `truncated` (`data: {dropped, reason}`: records
// that were coalesced, cut or dropped, so a gap is never silent). Bounds, all per reference or per page:
//   an `ala` event's canonical JSON is at most OUTPUT_EVENT_MAX_BYTES (a larger record becomes a `truncated` event);
//   at most OUTPUT_EVENTS_PER_REFERENCE `ala` events and TRUNCATED_EVENTS_PER_REFERENCE `truncated` events are stored;
//   an events page holds at most EVENTS_PAGE_MAX_BYTES of event JSON (always at least one event), so a page stays well
//   below the 1 MiB response bound of the RoboTeam hop.
export const OUTPUT_EVENT_MAX_BYTES = 48 * 1024;
export const OUTPUT_EVENTS_PER_REFERENCE = 8192;
export const TRUNCATED_EVENTS_PER_REFERENCE = 16;
// Of those, the last two slots are reserved for the `event_limit` markers (decision M-7: a drop is never silent): the store writes
// the first one at the moment it first refuses an `ala` event, and the relay writes a final one with the total at the end of the
// attempt. Ordinary markers (backlog, oversize record) cannot take them.
export const RESERVED_MARKER_SLOTS = 2;
export const EVENT_LIMIT_REASON = 'event_limit';
export const EVENTS_PAGE_MAX_BYTES = 512 * 1024;
export const OUTPUT_EVENT_TYPES = Object.freeze(['ala', 'truncated']);
// Channel events (RoboWork r10, decision M-14): `task-failed` {message} (the failure channel), `human-input-request` {requestId, question,
// options} (the human-input channel) and `human-input-answered` {requestId, answer} (the `answer` control). Each is recorded durably
// before the channel replies or the answer is acknowledged; they are bounded by CHANNEL_EVENT_MAX_BYTES, one request per attempt.
export const CHANNEL_EVENT_TYPES = Object.freeze(['task-failed', 'human-input-request']);
// The per-reference total (OUTPUT_EVENTS_PER_REFERENCE) counts channel events too. They are few (at most one of each kind per attempt,
// three in all) and must always be recorded, so the last CHANNEL_EVENT_RESERVE places of the total are kept for them: `ala` events stop
// that much earlier, the first refused one is marked (M-7), and a question, an answer or a failure never meets a full stream.
export const CHANNEL_EVENT_RESERVE = 3;
const COUNTED_CHANNEL_TYPES = Object.freeze(['task-failed', 'human-input-request', 'human-input-answered']);
// Approval relay (RoboWork r10 T2, decision M-30, SPEC deltas M4/M5). ALA's `coding-agent-request` (a native permission request of the
// coding agent) becomes an `approval-request` event {requestId, agent, tool, title, message, detail?, options}; its one resolution becomes an
// `approval-resolved` event {requestId, reason, optionId?}. Both count toward the per-reference total (M-31) and neither is ever an `ala`
// event. The `approval` table holds ONE row per (reference, requestId): it is created `open` with the request, or directly `resolved` with
// reason `limit`, and moves to `resolved` exactly once, whichever comes first of the owner's answer, the worker's deadline (`expired`),
// the end of the attempt (`ended`) or ALA's own resolution (`cancelled`, `expired`, `backend-resolved` -> `cancelled`); the primary key and
// the open -> resolved trigger make "first wins" structural. The resolving transaction appends the `approval-resolved` event.
//
// Event room (M5): every OPEN request holds one place of the total for its future `approval-resolved`, and an attempt that may raise
// requests (specification permissions `ask-for-approval`) also keeps APPROVAL_LIMIT_FLOOR places free of `ala` events, so a request refused
// for lack of room can still be recorded as resolved `limit`. With `room` = total - CHANNEL_EVENT_RESERVE - stored stream events - open
// requests: an `ala` event needs room > floor, a recorded request needs room >= 2 + floor (itself, its resolution, the floor), a `limit`
// resolution of an unrecorded request needs room >= 1. At most APPROVALS_PENDING_MAX requests are open at once; a further one is `limit`.
export const APPROVAL_EVENT_TYPES = Object.freeze(['approval-request', 'approval-resolved']);
export const APPROVAL_REASONS = Object.freeze(['answered', 'cancelled', 'expired', 'ended', 'limit']);
export const APPROVALS_PENDING_MAX = 8;
export const APPROVAL_LIMIT_FLOOR = 1;
// Rows per reference: a robot that keeps asking cannot grow the store without bound. Past it a request is cancelled without a row.
export const APPROVALS_PER_REFERENCE = 256;
export const APPROVAL_FIELD_MAX = Object.freeze({ title: 200, message: 2000, detail: 8000, agent: 64, tool: 128, optionId: 128, label: 200, description: 1000 });
export const APPROVAL_OPTIONS_MAX = 8;
// ALA's request ids are crypto.randomUUID() values: lowercase. Only that spelling is accepted, so the id the worker writes back to ALA's stdin
// is always exactly the one ALA advertised.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const isApprovalRequestId = (value) => typeof value === 'string' && UUID.test(value);
// 200 KiB holds the worst case of the largest answer: 32,000 characters that JSON escapes to six bytes each (192,000) plus the envelope.
export const ANSWER_MAX_CHARS = 32000;
export const CHANNEL_EVENT_MAX_BYTES = 200 * 1024;

export const OBSERVATION_SCHEMA_SQL = `
CREATE TABLE reference_event (
    reference_id TEXT NOT NULL REFERENCES reference(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    at INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('state', 'ala', 'truncated', 'task-failed', 'human-input-request', 'human-input-answered', 'approval-request', 'approval-resolved')),
    data TEXT NOT NULL,
    PRIMARY KEY (reference_id, sequence)
);
CREATE TABLE reference_cursor (
    reference_id TEXT PRIMARY KEY REFERENCES reference(id),
    last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
    first_retained INTEGER NOT NULL CHECK (first_retained >= 1)
);
CREATE TABLE reference_control (
    reference_id TEXT NOT NULL REFERENCES reference(id),
    actor_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('stop', 'message', 'pause', 'answer')),
    payload TEXT,
    digest TEXT NOT NULL,
    response TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('applied', 'pending', 'rejected', 'ended')),
    source TEXT NOT NULL CHECK (source IN ('relay', 'fence')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (reference_id, actor_key, operation_id),
    CHECK ((op IN ('message', 'answer')) = (payload IS NOT NULL)),
    CHECK (source = 'relay' OR op = 'stop')
);
CREATE TRIGGER reference_event_immutable BEFORE UPDATE ON reference_event BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_event_no_delete BEFORE DELETE ON reference_event BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_cursor_no_delete BEFORE DELETE ON reference_cursor BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_cursor_forward BEFORE UPDATE ON reference_cursor
WHEN NEW.reference_id IS NOT OLD.reference_id OR NEW.last_sequence < OLD.last_sequence OR NEW.first_retained < OLD.first_retained
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_control_no_delete BEFORE DELETE ON reference_control BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_control_delivery BEFORE UPDATE ON reference_control
WHEN NEW.delivery IS NOT OLD.delivery AND NOT (
        (OLD.delivery = 'pending' AND NEW.delivery IN ('applied', 'rejected', 'ended'))
        OR (OLD.delivery = 'applied' AND NEW.delivery = 'rejected' AND OLD.op = 'answer')
    )
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TABLE approval (
    reference_id TEXT NOT NULL REFERENCES reference(id),
    request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    reason TEXT CHECK (reason IN ('answered', 'cancelled', 'expired', 'ended', 'limit')),
    option_id TEXT,
    options TEXT NOT NULL,
    answer_actor TEXT,
    answer_operation_id TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY (reference_id, request_id),
    CHECK ((state = 'open') = (reason IS NULL)),
    CHECK ((state = 'open') = (resolved_at IS NULL)),
    CHECK (option_id IS NULL OR reason = 'answered'),
    CHECK ((answer_operation_id IS NULL) = (answer_actor IS NULL))
);
CREATE TRIGGER approval_no_delete BEFORE DELETE ON approval BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER approval_once BEFORE UPDATE ON approval
WHEN OLD.state != 'open' OR NEW.reference_id IS NOT OLD.reference_id OR NEW.request_id IS NOT OLD.request_id
    OR NEW.options IS NOT OLD.options OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER reference_control_immutable BEFORE UPDATE ON reference_control
WHEN NEW.reference_id IS NOT OLD.reference_id OR NEW.actor_key IS NOT OLD.actor_key OR NEW.operation_id IS NOT OLD.operation_id
    OR NEW.op IS NOT OLD.op OR NEW.payload IS NOT OLD.payload OR NEW.digest IS NOT OLD.digest OR NEW.response IS NOT OLD.response
    OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
`;

export function referenceForExecution(db, executionId) {
    return db.prepare('SELECT * FROM reference WHERE execution_id = ?').get(executionId);
}

export function readCursor(db, referenceId) {
    return db.prepare('SELECT * FROM reference_cursor WHERE reference_id = ?').get(referenceId);
}

// Appends one state event: `data` is {state} plus `cleanup` while stopping or once terminal.
export function appendStateEvent(db, referenceId, data, now) {
    let cursor = readCursor(db, referenceId);
    if (!cursor) {
        db.prepare('INSERT INTO reference_cursor (reference_id, last_sequence, first_retained) VALUES (?, 0, 1)').run(referenceId);
        cursor = { last_sequence: 0, first_retained: 1 };
    }
    const sequence = cursor.last_sequence + 1;
    db.prepare("INSERT INTO reference_event (reference_id, sequence, at, type, data) VALUES (?, ?, ?, 'state', ?)")
        .run(referenceId, sequence, now, canonicalJson(data));
    db.prepare('UPDATE reference_cursor SET last_sequence = ? WHERE reference_id = ?').run(sequence, referenceId);
    return sequence;
}

// Events after `after`, at most `limit`. `after` beyond the last sequence is invalid_request;
// `after` earlier than the retained window is a retention gap.
export function listEvents(db, referenceId, after, limit) {
    const cursor = readCursor(db, referenceId) ?? { last_sequence: 0, first_retained: 1 };
    if (after > cursor.last_sequence) fail('invalid_request');
    if (after < cursor.first_retained - 1) return { gap: true, snapshotSequence: cursor.last_sequence };
    const rows = db.prepare('SELECT * FROM reference_event WHERE reference_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
        .all(referenceId, after, limit);
    const events = [];
    let bytes = 0;
    for (const row of rows) {
        bytes += Buffer.byteLength(row.data, 'utf8') + 64;
        if (events.length > 0 && bytes > EVENTS_PAGE_MAX_BYTES) break;
        events.push({ sequence: row.sequence, at: new Date(row.at).toISOString(), type: row.type, data: JSON.parse(row.data) });
    }
    return { events, nextAfter: events.length > 0 ? events[events.length - 1].sequence : after };
}

// Appends relayed output events (`ala`, `truncated`) of one reference in one transaction, enforcing the per-event and
// per-reference bounds. An event that does not fit is not stored; the number of events refused is returned as `dropped`
// (an oversize `ala` record is first replaced by a `truncated` event of reason `record_too_large` when that kind still has room).
// Returns {stored, dropped}.
// The stream events of a reference that count toward the per-reference total: relayed `ala` records, channel events and approval events.
function streamCounts(db, referenceId) {
    const counts = Object.fromEntries(db.prepare(`SELECT type, COUNT(*) AS count FROM reference_event WHERE reference_id = ?
        AND type IN ('ala', 'truncated', 'task-failed', 'human-input-request', 'human-input-answered', 'approval-request', 'approval-resolved') GROUP BY type`)
        .all(referenceId).map((row) => [row.type, row.count]));
    const stream = (counts.ala ?? 0) + [...COUNTED_CHANNEL_TYPES, ...APPROVAL_EVENT_TYPES].reduce((sum, type) => sum + (counts[type] ?? 0), 0);
    return { stream, truncated: counts.truncated ?? 0 };
}

export function openApprovalCount(db, referenceId) {
    return db.prepare("SELECT COUNT(*) AS count FROM approval WHERE reference_id = ? AND state = 'open'").get(referenceId).count;
}

// The places of the total still free for stream events once every open request's resolution is held (see APPROVAL_LIMIT_FLOOR above).
export function approvalRoom(db, referenceId) {
    return OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE - streamCounts(db, referenceId).stream - openApprovalCount(db, referenceId);
}

// `approvalFloor` is APPROVAL_LIMIT_FLOOR for an attempt that may raise approval requests, else 0 (the total of other attempts is unchanged).
export function appendOutputEvents(db, referenceId, events, now, { approvalFloor = 0 } = {}) {
    let cursor = readCursor(db, referenceId);
    if (!cursor) {
        db.prepare('INSERT INTO reference_cursor (reference_id, last_sequence, first_retained) VALUES (?, 0, 1)').run(referenceId);
        cursor = { last_sequence: 0, first_retained: 1 };
    }
    const counted = streamCounts(db, referenceId);
    // `ala` counts the stream events of the total: the relayed records plus the channel and approval events already recorded. Every open
    // approval request holds one more place (for its resolution), and an approval-capable attempt keeps the floor free.
    let ala = counted.stream + openApprovalCount(db, referenceId) + approvalFloor;
    let truncated = counted.truncated;
    let limitMarked = db.prepare("SELECT COUNT(*) AS count FROM reference_event WHERE reference_id = ? AND type = 'truncated' AND data LIKE ?")
        .get(referenceId, `%"reason":"${EVENT_LIMIT_REASON}"%`).count > 0;
    let sequence = cursor.last_sequence;
    let stored = 0;
    let dropped = 0;
    const insert = db.prepare('INSERT INTO reference_event (reference_id, sequence, at, type, data) VALUES (?, ?, ?, ?, ?)');
    const put = (type, data) => {
        sequence += 1;
        insert.run(referenceId, sequence, now, type, canonicalJson(data));
        stored += 1;
    };
    const ordinaryRoom = () => truncated < TRUNCATED_EVENTS_PER_REFERENCE - RESERVED_MARKER_SLOTS;
    for (const event of events) {
        if (!OUTPUT_EVENT_TYPES.includes(event.type)) fail('invalid_request');
        let data;
        try { data = canonicalJson(event.data); } catch { dropped += 1; continue; } // too deep or not JSON: never stored
        if (event.type === 'ala') {
            if (ala >= OUTPUT_EVENTS_PER_REFERENCE - CHANNEL_EVENT_RESERVE) {
                dropped += 1;
                // The first refusal is marked where it happens, in the reserved room.
                if (!limitMarked && truncated < TRUNCATED_EVENTS_PER_REFERENCE) {
                    put('truncated', { dropped: 1, reason: EVENT_LIMIT_REASON });
                    truncated += 1;
                    limitMarked = true;
                }
                continue;
            }
            if (Buffer.byteLength(data, 'utf8') > OUTPUT_EVENT_MAX_BYTES) {
                if (ordinaryRoom()) { put('truncated', { dropped: 1, reason: 'record_too_large' }); truncated += 1; } else dropped += 1;
                continue;
            }
            put('ala', event.data);
            ala += 1;
        } else {
            const isLimit = event.data?.reason === EVENT_LIMIT_REASON;
            if (Buffer.byteLength(data, 'utf8') > 1024 || (isLimit ? truncated >= TRUNCATED_EVENTS_PER_REFERENCE : !ordinaryRoom())) { dropped += 1; continue; }
            put('truncated', event.data);
            truncated += 1;
            if (isLimit) limitMarked = true;
        }
    }
    if (stored > 0) db.prepare('UPDATE reference_cursor SET last_sequence = ? WHERE reference_id = ?').run(sequence, referenceId);
    return { stored, dropped };
}

// Appends one channel or answer event (no bound beyond its size: the callers allow at most one per kind per attempt).
export function appendChannelEvent(db, referenceId, type, data, now) {
    const text = canonicalJson(data);
    if (Buffer.byteLength(text, 'utf8') > CHANNEL_EVENT_MAX_BYTES) fail('invalid_request');
    let cursor = readCursor(db, referenceId);
    if (!cursor) {
        db.prepare('INSERT INTO reference_cursor (reference_id, last_sequence, first_retained) VALUES (?, 0, 1)').run(referenceId);
        cursor = { last_sequence: 0, first_retained: 1 };
    }
    const sequence = cursor.last_sequence + 1;
    db.prepare('INSERT INTO reference_event (reference_id, sequence, at, type, data) VALUES (?, ?, ?, ?, ?)').run(referenceId, sequence, now, type, text);
    db.prepare('UPDATE reference_cursor SET last_sequence = ? WHERE reference_id = ?').run(sequence, referenceId);
    return sequence;
}

// The first event of `type` of a reference whose data names `requestId`, or undefined.
export function findChannelEvent(db, referenceId, type, requestId) {
    for (const row of db.prepare('SELECT sequence, data FROM reference_event WHERE reference_id = ? AND type = ? ORDER BY sequence').all(referenceId, type)) {
        const data = JSON.parse(row.data);
        if (requestId === undefined || data.requestId === requestId) return { sequence: row.sequence, data };
    }
    return undefined;
}

// Controls still pending delivery for a reference, oldest first, with their payloads (never returned by a read).
export function listPendingControls(db, referenceId) {
    return db.prepare("SELECT actor_key, operation_id, op, payload, source FROM reference_control WHERE reference_id = ? AND delivery = 'pending' ORDER BY created_at, rowid")
        .all(referenceId).map((row) => ({
            actorKey: row.actor_key, operationId: row.operation_id, op: row.op, source: row.source,
            payload: row.payload === null ? null : JSON.parse(row.payload)
        }));
}

// A pending control that will never be written: final `ended` (its target is gone, for example ALA resolved the request first) or
// `rejected` (malformed). Never `applied`, which would claim a delivery that did not happen.
export function markControlFinal(db, referenceId, actorKey, operationId, delivery) {
    if (delivery !== 'ended' && delivery !== 'rejected') throw new TypeError('Invalid final delivery');
    return db.prepare("UPDATE reference_control SET delivery = ? WHERE reference_id = ? AND actor_key = ? AND operation_id = ? AND delivery = 'pending'")
        .run(delivery, referenceId, actorKey, operationId).changes;
}

export function markControlApplied(db, referenceId, actorKey, operationId) {
    return db.prepare("UPDATE reference_control SET delivery = 'applied' WHERE reference_id = ? AND actor_key = ? AND operation_id = ? AND delivery = 'pending'")
        .run(referenceId, actorKey, operationId).changes;
}

export function getControl(db, referenceId, actorKey, operationId) {
    return db.prepare('SELECT * FROM reference_control WHERE reference_id = ? AND actor_key = ? AND operation_id = ?')
        .get(referenceId, actorKey, operationId);
}

// A recorded stop still pending delivery for this reference (one attempt per reference).
export function hasPendingStop(db, referenceId) {
    return db.prepare("SELECT 1 AS found FROM reference_control WHERE reference_id = ? AND op = 'stop' AND delivery = 'pending' LIMIT 1").get(referenceId) !== undefined;
}

// Relayed controls only: stops recorded by a fence are exempt from the `controls` capacity.
export function countControls(db) {
    return db.prepare("SELECT COUNT(*) AS count FROM reference_control WHERE source = 'relay'").get().count;
}

export function insertControl(db, row) {
    db.prepare(`INSERT INTO reference_control (reference_id, actor_key, operation_id, op, payload, digest, response, delivery, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'relay', ?)`)
        .run(row.referenceId, row.actorKey, row.operationId, row.op, row.payload === null ? null : canonicalJson(row.payload), row.digest,
            canonicalJson(row.response), row.delivery, row.now);
}

// A stop recorded by a pause or cancellation fence for a running execution (Part D): pending
// for the execution engine and exempt from the `controls` capacity.
export function insertFenceStop(db, row) {
    db.prepare(`INSERT INTO reference_control (reference_id, actor_key, operation_id, op, payload, digest, response, delivery, source, created_at)
        VALUES (?, 'fence', ?, 'stop', NULL, ?, ?, 'pending', 'fence', ?)`)
        .run(row.referenceId, row.operationId, row.digest, canonicalJson(row.response), row.now);
}

// ---- Approval relay (T2) -------------------------------------------------------------------------------------------------------------

// Robot-controlled text, made plain: C0 and C1 control characters (and DEL) removed, except a line feed and a tab where `multiline`
// (a single-line field turns a tab or line break into a space); cut to `max` code points. The text is never interpreted; WebChat shows it as text (decision M-52 addition 1).
export function plainApprovalText(value, max, { multiline = false } = {}) {
    const text = typeof value === 'string' ? value : (value === undefined || value === null ? '' : (() => { try { return JSON.stringify(value); } catch { return ''; } })());
    // Bidirectional overrides and isolates, and the line and paragraph separators, are removed with the control characters.
    // eslint-disable-next-line no-control-regex
    const stripped = text.replace(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu, '');
    // eslint-disable-next-line no-control-regex
    const cleaned = multiline ? stripped.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '')
        // eslint-disable-next-line no-control-regex
        : stripped.replace(/[\t\n\r]/gu, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
    const points = [...cleaned];
    return points.length > max ? points.slice(0, max).join('') : cleaned;
}

// The bounded `approval-request` data for ALA's `coding-agent-request` record, or null when it cannot be relayed (not a permission
// request, a malformed id, no or too many options, duplicate or malformed option ids). Never throws.
export function approvalRequestData(record) {
    if (!record || typeof record !== 'object' || record.type !== 'coding-agent-request' || record.kind !== 'permission') return null;
    if (!isApprovalRequestId(record.id)) return null;
    const options = Array.isArray(record.options) ? record.options : null;
    if (!options || options.length === 0 || options.length > APPROVAL_OPTIONS_MAX) return null;
    const ids = new Set();
    const cleaned = [];
    for (const option of options) {
        const id = option?.id;
        // eslint-disable-next-line no-control-regex
        if (typeof id !== 'string' || id.length === 0 || id.length > APPROVAL_FIELD_MAX.optionId || /[\u0000-\u001f\u007f-\u009f]/u.test(id) || ids.has(id)) return null;
        if (typeof option.label !== 'string') return null;
        ids.add(id);
        const entry = { id, label: plainApprovalText(option.label, APPROVAL_FIELD_MAX.label) };
        if (typeof option.description === 'string' && option.description.length > 0) entry.description = plainApprovalText(option.description, APPROVAL_FIELD_MAX.description, { multiline: true });
        cleaned.push(entry);
    }
    const data = {
        requestId: record.id,
        agent: plainApprovalText(record.agent, APPROVAL_FIELD_MAX.agent),
        tool: plainApprovalText(record.method ?? record.tool, APPROVAL_FIELD_MAX.tool),
        title: plainApprovalText(record.title, APPROVAL_FIELD_MAX.title),
        message: plainApprovalText(record.message, APPROVAL_FIELD_MAX.message, { multiline: true }),
        options: cleaned
    };
    if (record.detail !== undefined && record.detail !== null) data.detail = plainApprovalText(record.detail, APPROVAL_FIELD_MAX.detail, { multiline: true });
    return data;
}

export function getApproval(db, referenceId, requestId) {
    const row = db.prepare('SELECT * FROM approval WHERE reference_id = ? AND request_id = ?').get(referenceId, requestId);
    if (!row) return undefined;
    return { ...row, options: JSON.parse(row.options) };
}

export function countApprovals(db, referenceId) {
    return db.prepare('SELECT COUNT(*) AS count FROM approval WHERE reference_id = ?').get(referenceId).count;
}

export function listOpenApprovals(db, referenceId) {
    return db.prepare("SELECT request_id FROM approval WHERE reference_id = ? AND state = 'open' ORDER BY created_at, rowid").all(referenceId).map((row) => row.request_id);
}

// Records ALA's request once: `open` with its `approval-request` event when there is room and fewer than APPROVALS_PENDING_MAX are open;
// otherwise resolved `limit` at once with only its `approval-resolved` event (when even that has no room, the row alone records it). Past
// APPROVALS_PER_REFERENCE rows nothing is recorded. Returns {outcome: 'open' | 'limit' | 'duplicate' | 'unrecorded', ...}.
export function recordApprovalRequest(db, referenceId, data, now, { approvalFloor = APPROVAL_LIMIT_FLOOR, forceLimit = false } = {}) {
    const existing = getApproval(db, referenceId, data.requestId);
    if (existing) return { outcome: 'duplicate', state: existing.state, reason: existing.reason };
    if (countApprovals(db, referenceId) >= APPROVALS_PER_REFERENCE) return { outcome: 'unrecorded' };
    const options = JSON.stringify(data.options.map((option) => option.id));
    const room = approvalRoom(db, referenceId);
    if (!forceLimit && openApprovalCount(db, referenceId) < APPROVALS_PENDING_MAX && room >= 2 + approvalFloor) {
        db.prepare("INSERT INTO approval (reference_id, request_id, state, reason, option_id, options, created_at) VALUES (?, ?, 'open', NULL, NULL, ?, ?)")
            .run(referenceId, data.requestId, options, now);
        appendChannelEvent(db, referenceId, 'approval-request', data, now);
        return { outcome: 'open' };
    }
    db.prepare("INSERT INTO approval (reference_id, request_id, state, reason, option_id, options, created_at, resolved_at) VALUES (?, ?, 'resolved', 'limit', NULL, ?, ?, ?)")
        .run(referenceId, data.requestId, options, now, now);
    const recorded = room >= 1;
    if (recorded) appendChannelEvent(db, referenceId, 'approval-resolved', { requestId: data.requestId, reason: 'limit' }, now);
    return { outcome: 'limit', eventRecorded: recorded };
}

// Moves an open request to `resolved` with `reason` and appends its `approval-resolved` event in the caller's transaction (its place was
// held since the request was recorded). Returns true when this call resolved it, false when it was already resolved.
export function resolveApprovalRow(db, referenceId, requestId, { reason, optionId = null, answerActor = null, answerOperationId = null }, now) {
    if (!APPROVAL_REASONS.includes(reason) || reason === 'limit') throw new TypeError('Invalid approval resolution');
    const changed = db.prepare(`UPDATE approval SET state = 'resolved', reason = ?, option_id = ?, answer_actor = ?, answer_operation_id = ?, resolved_at = ?
        WHERE reference_id = ? AND request_id = ? AND state = 'open'`).run(reason, optionId, answerActor, answerOperationId, now, referenceId, requestId).changes;
    if (changed === 0) return false;
    appendChannelEvent(db, referenceId, 'approval-resolved', { requestId, reason, ...(optionId !== null ? { optionId } : {}) }, now);
    return true;
}

// The end of an attempt (M4): every open request resolves `ended`, and an answer still waiting for delivery is final `ended`.
export function endApprovals(db, referenceId, now) {
    for (const requestId of listOpenApprovals(db, referenceId)) resolveApprovalRow(db, referenceId, requestId, { reason: 'ended' }, now);
    db.prepare("UPDATE reference_control SET delivery = 'ended' WHERE reference_id = ? AND op = 'answer' AND delivery = 'pending'").run(referenceId);
}

// ALA refused the answer that was written for `requestId` (`interaction-response-rejected`): its control is final `rejected`.
export function rejectApprovalAnswer(db, referenceId, requestId) {
    const row = getApproval(db, referenceId, requestId);
    if (!row || row.answer_operation_id === null) return false;
    return db.prepare("UPDATE reference_control SET delivery = 'rejected' WHERE reference_id = ? AND actor_key = ? AND operation_id = ? AND op = 'answer' AND delivery IN ('pending', 'applied')")
        .run(referenceId, row.answer_actor, row.answer_operation_id).changes > 0;
}
