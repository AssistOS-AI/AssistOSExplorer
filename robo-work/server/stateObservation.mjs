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
// its payload (the canonical JSON `{text}` of a `message`, NULL for `stop`, bounded by
// requestBytes before persistence) and its recorded response. The payload is kept for the
// execution engine and is never returned by any read. `delivery` is `applied` (no further
// work) or `pending` (recorded for the S6 execution engine; S6 widens it).
//
// Schema version 5 (S6 source-only subset): `op` admits `pause`, which only an observation
// reference accepts (Part D, step W2); on an execution reference it is `invalid_request`,
// checked after visibility. `source` is `relay` for a relayed user control and `fence` for a
// stop recorded by a pause or cancellation fence; fence stops do not count toward the
// `controls` capacity (Part D).

export const CONTROL_OPS = Object.freeze(['stop', 'message', 'pause']);
export const EVENTS_MAX_LIMIT = 1000;

export const OBSERVATION_SCHEMA_SQL = `
CREATE TABLE reference_event (
    reference_id TEXT NOT NULL REFERENCES reference(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    at INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('state')),
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
    op TEXT NOT NULL CHECK (op IN ('stop', 'message', 'pause')),
    payload TEXT,
    digest TEXT NOT NULL,
    response TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('applied', 'pending')),
    source TEXT NOT NULL CHECK (source IN ('relay', 'fence')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (reference_id, actor_key, operation_id),
    CHECK ((op = 'message') = (payload IS NOT NULL)),
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
    const events = rows.map((row) => ({
        sequence: row.sequence, at: new Date(row.at).toISOString(), type: row.type, data: JSON.parse(row.data)
    }));
    return { events, nextAfter: events.length > 0 ? events[events.length - 1].sequence : after };
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
