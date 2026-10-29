// Resource-blocker ledger (Revision 9). The single module that touches the
// resource_blocker and quarantine_audit tables.
//
// Release states and transitions (all enforced again by the resource_blocker_guard trigger):
//   reserved    -> committed | released | quarantined
//   committed   -> released | quarantined
//   quarantined -> released_by_operator   (only through clearQuarantine)
// `released` and `released_by_operator` are terminal. `quarantined` is terminal for
// automatic transitions. The locator is immutable from reservation; the identity tuple is
// written once, together with the `reserved` -> `committed` transition. The library only
// records the outcome it is given by the trusted runtime caller; it does not measure the
// release deadline or inspect /proc itself.

export const RESERVED = 'reserved';
export const COMMITTED = 'committed';
export const RELEASED = 'released';
export const QUARANTINED = 'quarantined';
export const RELEASED_BY_OPERATOR = 'released_by_operator';

export const UNSETTLED_STATES = Object.freeze([RESERVED, COMMITTED]);

export const BLOCKER_SCHEMA_SQL = `
CREATE TABLE resource_blocker (
    resource_id TEXT PRIMARY KEY,
    robot_id TEXT REFERENCES robot(id),
    execution_id TEXT REFERENCES admission(execution_id),
    attempt_id TEXT,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    kind TEXT NOT NULL,
    process_bearing INTEGER NOT NULL CHECK (process_bearing IN (0, 1)),
    locator TEXT NOT NULL,
    locator_base TEXT NOT NULL,
    identity TEXT,
    release_state TEXT NOT NULL CHECK (release_state IN ('reserved', 'committed', 'released', 'quarantined', 'released_by_operator')),
    retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0, 1)),
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    settled_at INTEGER,
    CHECK (release_state != 'reserved' OR identity IS NULL),
    CHECK (release_state != 'committed' OR identity IS NOT NULL)
);
-- A locator is never reused, whatever the state of the earlier blocker (quarantined ones
-- included). locator_base is the caller's locator without the generated marker.
CREATE UNIQUE INDEX resource_blocker_locator ON resource_blocker(kind, locator_base);
CREATE INDEX resource_blocker_robot ON resource_blocker(robot_id, release_state);
CREATE INDEX resource_blocker_attempt ON resource_blocker(attempt_id, release_state);
CREATE INDEX resource_blocker_generation ON resource_blocker(generation_id, release_state);
CREATE TABLE quarantine_audit (
    resource_id TEXT PRIMARY KEY REFERENCES resource_blocker(resource_id),
    operation_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    cleared_at INTEGER NOT NULL
);
CREATE TRIGGER resource_blocker_no_delete BEFORE DELETE ON resource_blocker
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER resource_blocker_guard BEFORE UPDATE ON resource_blocker
WHEN NEW.resource_id IS NOT OLD.resource_id OR NEW.robot_id IS NOT OLD.robot_id
    OR NEW.execution_id IS NOT OLD.execution_id OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.generation_id IS NOT OLD.generation_id OR NEW.kind IS NOT OLD.kind
    OR NEW.process_bearing IS NOT OLD.process_bearing OR NEW.locator IS NOT OLD.locator OR NEW.locator_base IS NOT OLD.locator_base
    OR NEW.created_at IS NOT OLD.created_at OR NEW.retained < OLD.retained
    OR (OLD.identity IS NOT NULL AND NEW.identity IS NOT OLD.identity)
    OR (OLD.release_state = 'reserved' AND NEW.release_state != 'committed' AND NEW.identity IS NOT NULL)
    OR NOT (
        (OLD.release_state = 'reserved' AND NEW.release_state IN ('committed', 'released', 'quarantined'))
        OR (OLD.release_state = 'committed' AND NEW.release_state IN ('released', 'quarantined'))
        OR (OLD.release_state = 'quarantined' AND NEW.release_state = 'released_by_operator')
        OR (NEW.release_state = OLD.release_state AND OLD.release_state IN ('reserved', 'committed') AND NEW.retained > OLD.retained)
    )
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER quarantine_audit_immutable BEFORE UPDATE ON quarantine_audit BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER quarantine_audit_no_delete BEFORE DELETE ON quarantine_audit BEGIN SELECT RAISE(ABORT, 'immutable'); END;
`;

export function reserveBlocker(db, { resourceId, robotId = null, executionId = null, attemptId = null, generationId, kind, processBearing = false, locator, locatorBase, retained = false, now }) {
    db.prepare(`INSERT INTO resource_blocker (resource_id, robot_id, execution_id, attempt_id, generation_id, kind, process_bearing, locator, locator_base, release_state, retained, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(resourceId, robotId, executionId, attemptId, generationId, kind, processBearing ? 1 : 0, locator, locatorBase, RESERVED, retained ? 1 : 0, now);
}

export function getBlocker(db, resourceId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE resource_id = ?').get(resourceId);
}

export function findByLocator(db, kind, locator) {
    return db.prepare('SELECT resource_id FROM resource_blocker WHERE kind = ? AND locator_base = ?').get(kind, locator);
}

export function commitBlocker(db, resourceId, identityJson, now) {
    db.prepare('UPDATE resource_blocker SET release_state = ?, identity = ?, committed_at = ? WHERE resource_id = ? AND release_state = ?')
        .run(COMMITTED, identityJson, now, resourceId, RESERVED);
}

// outcome: RELEASED or QUARANTINED, from reserved or committed.
export function settleBlocker(db, resourceId, outcome, now) {
    db.prepare('UPDATE resource_blocker SET release_state = ?, settled_at = ? WHERE resource_id = ? AND release_state IN (?, ?)')
        .run(outcome, now, resourceId, RESERVED, COMMITTED);
}

export function clearBlocker(db, resourceId, now) {
    db.prepare('UPDATE resource_blocker SET release_state = ?, settled_at = ? WHERE resource_id = ? AND release_state = ?')
        .run(RELEASED_BY_OPERATOR, now, resourceId, QUARANTINED);
}

export function retainBlocker(db, resourceId) {
    db.prepare('UPDATE resource_blocker SET retained = 1 WHERE resource_id = ? AND release_state IN (?, ?)')
        .run(resourceId, RESERVED, COMMITTED);
}

export function recordClearAudit(db, { resourceId, operationId, actor, evidenceDigest, now }) {
    db.prepare('INSERT INTO quarantine_audit (resource_id, operation_id, actor, evidence_digest, cleared_at) VALUES (?, ?, ?, ?, ?)')
        .run(resourceId, operationId, actor, evidenceDigest, now);
}

export function unsettledForRobot(db, robotId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE robot_id = ? AND release_state IN (?, ?)').all(robotId, RESERVED, COMMITTED);
}

export function quarantinedForRobot(db, robotId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE robot_id = ? AND release_state = ?').all(robotId, QUARANTINED);
}

export function hasRetainedForRobot(db, robotId) {
    return db.prepare('SELECT 1 AS found FROM resource_blocker WHERE robot_id = ? AND release_state IN (?, ?) AND retained = 1 LIMIT 1')
        .get(robotId, RESERVED, COMMITTED) !== undefined;
}

// Blockers an attempt still waits on: unsettled and not transferred to the retained record.
export function unsettledForAttempt(db, attemptId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE attempt_id = ? AND retained = 0 AND release_state IN (?, ?)')
        .all(attemptId, RESERVED, COMMITTED);
}

export function quarantinedForAttempt(db, attemptId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE attempt_id = ? AND release_state = ?').all(attemptId, QUARANTINED);
}

// Worker-scoped (no owning robot) quarantined resource kinds: the `degraded` derivation.
export function degradedKinds(db) {
    return db.prepare('SELECT DISTINCT kind FROM resource_blocker WHERE robot_id IS NULL AND release_state = ? ORDER BY kind')
        .all(QUARANTINED).map((row) => row.kind);
}

// Unsettled blockers owned by any generation other than `currentGenerationId`.
export function unsettledOfPriorGenerations(db, currentGenerationId) {
    return db.prepare('SELECT * FROM resource_blocker WHERE generation_id != ? AND release_state IN (?, ?) ORDER BY created_at, resource_id')
        .all(currentGenerationId, RESERVED, COMMITTED);
}

export function publicBlocker(row) {
    return {
        resourceId: row.resource_id,
        kind: row.kind,
        robotId: row.robot_id,
        executionId: row.execution_id,
        attemptId: row.attempt_id,
        generationId: row.generation_id,
        processBearing: row.process_bearing === 1,
        locator: JSON.parse(row.locator),
        identity: row.identity === null ? null : JSON.parse(row.identity),
        state: row.release_state,
        retained: row.retained === 1
    };
}
