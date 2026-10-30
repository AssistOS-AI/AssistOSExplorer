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
// 200 KiB holds the worst case of the largest answer: 32,000 characters that JSON escapes to six bytes each (192,000) plus the envelope.
export const ANSWER_MAX_CHARS = 32000;
export const CHANNEL_EVENT_MAX_BYTES = 200 * 1024;

export const OBSERVATION_SCHEMA_SQL = `
CREATE TABLE reference_event (
    reference_id TEXT NOT NULL REFERENCES reference(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    at INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('state', 'ala', 'truncated', 'task-failed', 'human-input-request', 'human-input-answered')),
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
    delivery TEXT NOT NULL CHECK (delivery IN ('applied', 'pending')),
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
export function appendOutputEvents(db, referenceId, events, now) {
    let cursor = readCursor(db, referenceId);
    if (!cursor) {
        db.prepare('INSERT INTO reference_cursor (reference_id, last_sequence, first_retained) VALUES (?, 0, 1)').run(referenceId);
        cursor = { last_sequence: 0, first_retained: 1 };
    }
    const counts = Object.fromEntries(db.prepare("SELECT type, COUNT(*) AS count FROM reference_event WHERE reference_id = ? AND type IN ('ala', 'truncated') GROUP BY type").all(referenceId)
        .map((row) => [row.type, row.count]));
    let ala = counts.ala ?? 0;
    let truncated = counts.truncated ?? 0;
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
            if (ala >= OUTPUT_EVENTS_PER_REFERENCE) {
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
