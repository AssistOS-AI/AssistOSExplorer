// Coordinator obligations and their outbox (plan §7.2; S6 source-only subset, Part D). The
// single module that touches the obligation and outbox_revision tables.
//
// Schema version 5 introduced these tables and version 6 re-keyed the open-continuation index
// per coordinator and added the acceptance sequence (R18, delta K-1; no migration). The obligation, accept, reject, list, outbox
// and fence behavior lives in workerState.mjs (Part D); this module holds the SQL, the row
// helpers and the observation-state mapping. The default runtime refuses obligation
// admission, so a default store holds no obligation row.
//
// An obligation is the worker half of a §7.2 acceptance obligation, observed through an
// observation reference (`reference.kind = 'observation'`, `reference.obligation_id`). It
// records the admitting coordinator principal (from the verified coordinator hop), the
// owner, the normalized request and its acceptance deadline. Its decision state moves only
// from `pending` to `accepted`, `rejected`, `expired` or `cancelled`, and from `accepted`
// to `paused` or `cancelled`. A `flow-continuation` names the binding it continues and the
// binding fence revision it was admitted under. `bound` records that outbox revision 1 was
// applied; at most one continuation of a binding is open (pending, or accepted and unbound),
// per coordinator, because bindings are per coordinator. `accepted_seq` is a strictly
// increasing sequence assigned in the accept transaction: the reconciliation list pages in
// acceptance order on it, never on the wall clock.
// Outbox revisions are immutable, applied once, and carry the fence revision they were
// computed under.

export const OBLIGATION_KINDS = Object.freeze(['flow-launch', 'flow-continuation', 'generation']);
export const OBLIGATION_STATES = Object.freeze(['pending', 'accepted', 'rejected', 'expired', 'cancelled', 'paused']);
export const OUTBOX_KINDS = Object.freeze(['bound', 'progress', 'terminal']);

export const OBLIGATION_SCHEMA_SQL = `
CREATE TABLE obligation (
    obligation_id TEXT PRIMARY KEY,
    coordinator TEXT NOT NULL,
    obligation_kind TEXT NOT NULL CHECK (obligation_kind IN ('flow-launch', 'flow-continuation', 'generation')),
    scope TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request TEXT NOT NULL,
    continuation_of TEXT,
    expected_fence_revision INTEGER CHECK (expected_fence_revision IS NULL OR expected_fence_revision >= 0),
    accept_by INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected', 'expired', 'cancelled', 'paused')),
    reason TEXT,
    domain_record_id TEXT,
    bound INTEGER NOT NULL CHECK (bound IN (0, 1)),
    last_revision INTEGER NOT NULL CHECK (last_revision >= 0),
    result TEXT,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    accepted_seq INTEGER UNIQUE CHECK (accepted_seq IS NULL OR accepted_seq >= 1),
    updated_at INTEGER NOT NULL,
    CHECK ((obligation_kind = 'flow-continuation') = (continuation_of IS NOT NULL)),
    CHECK ((continuation_of IS NULL) = (expected_fence_revision IS NULL)),
    CHECK (obligation_kind != 'flow-continuation' OR domain_record_id IS NULL OR domain_record_id = continuation_of),
    CHECK ((state = 'pending') = (decided_at IS NULL)),
    CHECK (state != 'pending' OR domain_record_id IS NULL),
    CHECK (state NOT IN ('accepted', 'paused') OR domain_record_id IS NOT NULL),
    CHECK (bound = 0 OR domain_record_id IS NOT NULL),
    CHECK ((accepted_seq IS NULL) = (domain_record_id IS NULL))
);
CREATE UNIQUE INDEX obligation_open_continuation ON obligation(coordinator, continuation_of)
    WHERE continuation_of IS NOT NULL AND (state = 'pending' OR (state = 'accepted' AND bound = 0));
CREATE INDEX obligation_coordinator_state ON obligation(coordinator, state, bound, accepted_seq);
CREATE TRIGGER obligation_no_delete BEFORE DELETE ON obligation BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER obligation_immutable BEFORE UPDATE ON obligation
WHEN NEW.obligation_id IS NOT OLD.obligation_id OR NEW.coordinator IS NOT OLD.coordinator
    OR NEW.obligation_kind IS NOT OLD.obligation_kind OR NEW.scope IS NOT OLD.scope OR NEW.owner_id IS NOT OLD.owner_id
    OR NEW.operation_id IS NOT OLD.operation_id OR NEW.request IS NOT OLD.request
    OR NEW.continuation_of IS NOT OLD.continuation_of OR NEW.expected_fence_revision IS NOT OLD.expected_fence_revision
    OR NEW.accept_by IS NOT OLD.accept_by OR NEW.generation_id IS NOT OLD.generation_id OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.domain_record_id IS NOT NULL AND NEW.domain_record_id IS NOT OLD.domain_record_id)
    OR (OLD.reason IS NOT NULL AND NEW.reason IS NOT OLD.reason)
    OR (OLD.result IS NOT NULL AND NEW.result IS NOT OLD.result)
    OR (OLD.decided_at IS NOT NULL AND NEW.decided_at IS NOT OLD.decided_at)
    OR (OLD.accepted_seq IS NOT NULL AND NEW.accepted_seq IS NOT OLD.accepted_seq)
    OR NEW.bound < OLD.bound OR NEW.last_revision < OLD.last_revision
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER obligation_transition BEFORE UPDATE ON obligation
WHEN NEW.state IS NOT OLD.state AND NOT (
        (OLD.state = 'pending' AND NEW.state IN ('accepted', 'rejected', 'expired', 'cancelled'))
        OR (OLD.state = 'accepted' AND NEW.state IN ('paused', 'cancelled'))
    )
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TABLE outbox_revision (
    obligation_id TEXT NOT NULL REFERENCES obligation(obligation_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('bound', 'progress', 'terminal')),
    fence_revision INTEGER NOT NULL CHECK (fence_revision >= 0),
    digest TEXT NOT NULL,
    data TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (obligation_id, revision),
    CHECK (kind != 'bound' OR revision = 1)
);
CREATE TRIGGER outbox_revision_immutable BEFORE UPDATE ON outbox_revision BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER outbox_revision_no_delete BEFORE DELETE ON outbox_revision BEGIN SELECT RAISE(ABORT, 'immutable'); END;
`;

// Published results of the decision states (interface note 2.1). A terminal outbox revision
// publishes its own result while the decision state stays `accepted`.
export const EXPIRED_RESULT = Object.freeze({ status: 'failed', outputText: '', reason: 'acceptance_expired' });
export const REJECTED_RESULT = Object.freeze({ status: 'failed', outputText: '', reason: 'coordinator_rejected' });
export const CANCELLED_RESULT = Object.freeze({ status: 'cancelled', outputText: '' });
export const PAUSED_RESULT = Object.freeze({ status: 'paused', outputText: '' });
// Stored reasons: the accept-time fence refusal, or the coordinator's own reject reason under a
// prefix, so a coordinator reason spelled `fence_changed` cannot alias the fence refusal.
export const FENCE_CHANGED = 'fence_changed';
export const COORDINATOR_REASON_PREFIX = 'coordinator:';

export function getObligation(db, obligationId) {
    return db.prepare('SELECT rowid AS seq, * FROM obligation WHERE obligation_id = ?').get(obligationId);
}

export function countObligations(db) {
    return db.prepare('SELECT COUNT(*) AS count FROM obligation').get().count;
}

export function countOutboxRevisions(db) {
    return db.prepare('SELECT COUNT(*) AS count FROM outbox_revision').get().count;
}

export function insertObligation(db, row) {
    db.prepare(`INSERT INTO obligation (obligation_id, coordinator, obligation_kind, scope, owner_id, operation_id, request, continuation_of,
        expected_fence_revision, accept_by, state, reason, domain_record_id, bound, last_revision, result, generation_id, created_at, decided_at,
        accepted_seq, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, NULL, ?, ?, NULL, NULL, ?)`)
        .run(row.obligationId, row.coordinator, row.obligationKind, row.scope, row.ownerId, row.operationId, row.request, row.continuationOf,
            row.expectedFenceRevision, row.acceptBy, row.generationId, row.now, row.now);
}

// Moves a decision state once. `domainRecordId`, `reason` and `result` are written only
// when given; the immutability trigger refuses rewriting any of them. Accepting (a
// `domainRecordId`) also assigns the next acceptance sequence, inside the caller's
// BEGIN IMMEDIATE transaction, so it is strictly increasing whatever the clock does.
export function decideObligation(db, obligationId, { state, reason = null, result = null, domainRecordId = null, now }) {
    const acceptedSeq = domainRecordId === null ? null : db.prepare('SELECT COALESCE(MAX(accepted_seq), 0) + 1 AS next FROM obligation').get().next;
    db.prepare(`UPDATE obligation SET state = ?, reason = COALESCE(?, reason), result = COALESCE(?, result),
        domain_record_id = COALESCE(?, domain_record_id), accepted_seq = COALESCE(accepted_seq, ?), decided_at = COALESCE(decided_at, ?), updated_at = ?
        WHERE obligation_id = ?`)
        .run(state, reason, result === null ? null : JSON.stringify(result), domainRecordId, acceptedSeq, now, now, obligationId);
}

export function getOutboxRevision(db, obligationId, revision) {
    return db.prepare('SELECT * FROM outbox_revision WHERE obligation_id = ? AND revision = ?').get(obligationId, revision);
}

export function insertOutboxRevision(db, row) {
    db.prepare(`INSERT INTO outbox_revision (obligation_id, revision, kind, fence_revision, digest, data, response, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.obligationId, row.revision, row.kind, row.fenceRevision, row.digest, row.data, row.response, row.now);
}

// Records an applied revision on the obligation: the last revision, `bound` from revision 1,
// and the terminal result once.
export function markRevisionApplied(db, obligationId, { revision, result = null, now }) {
    db.prepare(`UPDATE obligation SET last_revision = ?, bound = CASE WHEN ? >= 1 THEN 1 ELSE bound END, result = COALESCE(?, result),
        updated_at = ? WHERE obligation_id = ?`)
        .run(revision, revision, result === null ? null : JSON.stringify(result), now, obligationId);
}

// The binding an obligation names: the accepted domain record, else the continued binding.
export function namedBindingId(obligation) {
    return obligation.domain_record_id ?? obligation.continuation_of ?? null;
}

// Was this obligation ever accepted (a fence may have paused or cancelled it since)?
export function wasAccepted(obligation) {
    return obligation.domain_record_id !== null && ['accepted', 'paused', 'cancelled'].includes(obligation.state);
}

// The observation view of an obligation at `now` (interface note 2.1). A pending obligation
// read at or after `acceptBy` reports `expired` before it is committed.
export function observationView(obligation, now) {
    let obligationState = obligation.state;
    let result = obligation.result === null ? null : JSON.parse(obligation.result);
    if (obligationState === 'pending' && now >= obligation.accept_by) {
        obligationState = 'expired';
        result = { ...EXPIRED_RESULT };
    }
    let state;
    switch (obligationState) {
        case 'pending': state = 'pending-coordinator'; break;
        case 'accepted': state = result === null ? 'accepted' : result.status; break;
        case 'expired':
        case 'rejected': state = 'failed'; break;
        default: state = obligationState;
    }
    return { state, obligationState, result };
}
