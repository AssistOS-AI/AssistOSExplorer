// Conversation sessions (S6 source-only subset, Part A). The single module that touches the
// session table.
//
// A session maps one conversation, keyed by the verified scope and the shim's `sessionKey`,
// to one worker logical ID, robot and owner. Every turn of the conversation is admitted under
// that logical ID with `logical_kind = 'session'`. A session row is inserted only together
// with the first turn admission of its conversation, inside that admission's transaction, so
// the existing `admissions` limit bounds sessions. Rows are immutable and never deleted.

export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const SESSION_SCHEMA_SQL = `
CREATE TABLE session (
    scope TEXT NOT NULL,
    session_key TEXT NOT NULL CHECK (length(session_key) BETWEEN 1 AND 128),
    logical_id TEXT NOT NULL UNIQUE,
    robot_id TEXT NOT NULL REFERENCES robot(id),
    owner_id TEXT NOT NULL,
    generation_id TEXT NOT NULL REFERENCES generation(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, session_key)
);
CREATE TRIGGER session_immutable BEFORE UPDATE ON session BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER session_no_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'immutable'); END;
`;

export function isSessionKey(value) {
    return typeof value === 'string' && SESSION_KEY_PATTERN.test(value);
}

export function getSession(db, scope, sessionKey) {
    return db.prepare('SELECT * FROM session WHERE scope = ? AND session_key = ?').get(scope, sessionKey);
}

export function insertSession(db, row) {
    db.prepare('INSERT INTO session (scope, session_key, logical_id, robot_id, owner_id, generation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.scope, row.sessionKey, row.logicalId, row.robotId, row.ownerId, row.generationId, row.now);
}
