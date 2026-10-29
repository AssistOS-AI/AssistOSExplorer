import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DATA_DIR } from '../constants.mjs';

// The private WebChat origin store (design S3c §6.5, E12 §7 E-M1). The WebChat shim persists
// every admission it is about to send, before the first transmission, so a lost reply can be
// recovered by the same user's later envelope. Several copilot processes (one per principal
// runtime) share the file. It holds no token or grant: only the verified user, tab, conversation,
// the canonical admission body and its digest.
//
// States:
//   persisted  inserted; the admitting process is sending it (claimable after the claim window)
//   sent       claimed by a reattaching process (claimable again after the claim window)
//   unknown    sent, outcome unknown (claimable at once)
//   admitted   the worker returned a reference; followed until a terminal snapshot, then deleted
//   refused    a complete refusal; nothing was committed. Kept briefly for diagnostics
// The in-flight states persisted, sent, unknown and admitted count toward the caps; refused rows
// do not, and are deleted after `refusedRetentionMs` or beyond the newest `refusedPerUser`.

export const WEBCHAT_ORIGINS_FILE = path.join(DATA_DIR, 'worker-coordinator', 'webchat-origins.sqlite');
export const ORIGIN_LIMITS = Object.freeze({
    perUser: 64, total: 4096, reattachBatch: 16, followBatch: 16, claimWindowMs: 30 * 1000,
    refusedRetentionMs: 10 * 60 * 1000, refusedPerUser: 16,
});
export const ORIGIN_STATES = Object.freeze(['persisted', 'sent', 'admitted', 'refused', 'unknown']);
const COUNTED = "('persisted','sent','unknown','admitted')";

// SQLite is loaded on first use with Node's experimental-feature warning suppressed (as in
// opencode-model-cache.mjs): a WebChat process's stderr is forwarded into the chat, and most
// copilot processes never open the store.
function loadDatabaseSync() {
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try {
        return process.getBuiltinModule('node:sqlite').DatabaseSync;
    } finally {
        process.emitWarning = emit;
    }
}

export class WebchatOriginStore {
    constructor({ file = WEBCHAT_ORIGINS_FILE, now = Date.now, limits = {} } = {}) {
        this.file = file;
        this.now = now;
        this.limits = { ...ORIGIN_LIMITS, ...limits };
        this.db = null;
    }

    // Opened on first use, so a process that never admits or reattaches never touches /data.
    open() {
        if (this.db) return this.db;
        const directory = path.dirname(this.file);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const directoryStat = fs.lstatSync(directory);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Unsafe WebChat origin store path');
        if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error('Unsafe WebChat origin store path');
        fs.chmodSync(directory, 0o700);
        const DatabaseSync = loadDatabaseSync();
        const db = new DatabaseSync(this.file);
        fs.chmodSync(this.file, 0o600);
        db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS webchat_origin (
                origin_request_id TEXT PRIMARY KEY,
                user_principal TEXT NOT NULL,
                tab_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                request_digest TEXT NOT NULL,
                admission_body TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('persisted','sent','admitted','refused','unknown')),
                task_ref TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS webchat_origin_user_state ON webchat_origin(user_principal, state, updated_at);`);
        this.db = db;
        return db;
    }

    transaction(operation) {
        const db = this.open();
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = operation(db);
            db.exec('COMMIT');
            return result;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    prune(db, principal, now) {
        db.prepare("DELETE FROM webchat_origin WHERE state = 'refused' AND updated_at < ?").run(now - this.limits.refusedRetentionMs);
        db.prepare(`DELETE FROM webchat_origin WHERE origin_request_id IN (SELECT origin_request_id FROM webchat_origin
            WHERE user_principal = ? AND state = 'refused' ORDER BY updated_at DESC, origin_request_id LIMIT -1 OFFSET ?)`)
            .run(principal, this.limits.refusedPerUser);
    }

    // Inserts a `persisted` row, or refuses with capacity_exceeded; nothing is evicted.
    insertPersisted({ originRequestId, principal, tabId, conversationId, digest, body }) {
        return this.transaction((db) => {
            const now = this.now();
            this.prune(db, principal, now);
            const user = db.prepare(`SELECT COUNT(*) AS n FROM webchat_origin WHERE user_principal = ? AND state IN ${COUNTED}`).get(principal).n;
            const total = db.prepare(`SELECT COUNT(*) AS n FROM webchat_origin WHERE state IN ${COUNTED}`).get().n;
            if (user >= this.limits.perUser || total >= this.limits.total) return { ok: false, code: 'capacity_exceeded' };
            db.prepare(`INSERT INTO webchat_origin (origin_request_id, user_principal, tab_id, conversation_id, request_digest, admission_body,
                state, task_ref, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'persisted', NULL, NULL, ?, ?)`)
                .run(originRequestId, principal, tabId, conversationId, digest, body, now, now);
            return { ok: true };
        });
    }

    get(originRequestId) {
        return this.open().prepare('SELECT * FROM webchat_origin WHERE origin_request_id = ?').get(originRequestId) || null;
    }

    // Moves a row to `state` only from one of `from`. Returns whether it changed.
    settle(originRequestId, state, from, { taskRef = null, error = null } = {}) {
        if (!ORIGIN_STATES.includes(state) || !from.every((value) => ORIGIN_STATES.includes(value))) throw new TypeError('unknown origin state');
        const db = this.open();
        const now = this.now();
        const row = this.get(originRequestId);
        if (!row || !from.includes(row.state)) return false;
        const result = db.prepare(`UPDATE webchat_origin SET state = ?, task_ref = COALESCE(?, task_ref), error = ?, updated_at = ?
            WHERE origin_request_id = ? AND state = ? AND updated_at = ?`)
            .run(state, taskRef === null ? null : JSON.stringify(taskRef), error, Math.max(now, row.updated_at + 1), originRequestId, row.state, row.updated_at);
        return result.changes === 1;
    }

    // One user's rows a reattach may work on, in two bounded batches so admitted follow-ups never
    // crowd out recovery: first the recovery rows (unknown rows, and persisted or sent rows whose
    // admission or claim is older than the claim window) up to `reattachBatch`, then admitted rows
    // up to `followBatch`. Both oldest first. A row that moves between the two reads is guarded by
    // the compare-and-set of claim() and touch().
    candidates(principal) {
        const db = this.open();
        const stale = this.now() - this.limits.claimWindowMs;
        const recovery = db.prepare(`SELECT * FROM webchat_origin WHERE user_principal = ?
            AND (state = 'unknown' OR (state IN ('persisted','sent') AND updated_at <= ?))
            ORDER BY updated_at, origin_request_id LIMIT ?`).all(principal, stale, this.limits.reattachBatch);
        const follow = db.prepare(`SELECT * FROM webchat_origin WHERE user_principal = ? AND state = 'admitted'
            ORDER BY updated_at, origin_request_id LIMIT ?`).all(principal, this.limits.followBatch);
        return [...recovery, ...follow];
    }

    // Compare-and-set re-stamp of an admitted row that was read and kept, so the next follow-up
    // batch starts with the rows read least recently. A row removed or re-stamped since it was
    // read is left alone. Returns whether it changed.
    touch(row) {
        const result = this.open().prepare(`UPDATE webchat_origin SET updated_at = ?
            WHERE origin_request_id = ? AND state = 'admitted' AND updated_at = ?`)
            .run(Math.max(this.now(), row.updated_at + 1), row.origin_request_id, row.updated_at);
        return result.changes === 1;
    }

    // Compare-and-set claim of a row read by candidates(): only the first process to claim
    // it wins; a loser sees no change and skips the row.
    claim(row) {
        const result = this.open().prepare(`UPDATE webchat_origin SET state = 'sent', updated_at = ?
            WHERE origin_request_id = ? AND state = ? AND updated_at = ?`)
            .run(Math.max(this.now(), row.updated_at + 1), row.origin_request_id, row.state, row.updated_at);
        return result.changes === 1;
    }

    remove(originRequestId, state) {
        return this.open().prepare('DELETE FROM webchat_origin WHERE origin_request_id = ? AND state = ?').run(originRequestId, state).changes === 1;
    }

    rows() {
        return this.open().prepare('SELECT * FROM webchat_origin ORDER BY created_at, origin_request_id').all();
    }

    close() {
        this.db?.close();
        this.db = null;
    }
}
