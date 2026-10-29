import { exactObject, fail } from './stateProtocol.mjs';

// Durable Router-token replay keys (S1x). The single module that touches token_replay.
//
// A mutating request's verified token IDs are consumed in the same transaction as its
// receipt-bearing write, so a committed operation's tokens stay refused across a provider
// restart for their whole acceptance window. A key is a digest of the token's `jti` (never
// the token itself); `retain_until_ms` is the end of that window. Consumption is
// all-or-nothing, a full table refuses rather than evicting a live key, and each
// consumption prunes at most PRUNE_BATCH expired keys.

export const PRUNE_BATCH = 256;
export const MAX_REPLAY_ITEMS = 8;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const REPLAY_SCHEMA_SQL = `
CREATE TABLE token_replay (key TEXT PRIMARY KEY, retain_until_ms INTEGER NOT NULL);
CREATE INDEX token_replay_expiry ON token_replay(retain_until_ms);
`;

// `replay` is undefined or {items: [{key, retainUntilMs}]}: 1 to MAX_REPLAY_ITEMS distinct
// 43-character base64url keys (SHA-256 of the jti) and safe-integer retention ends.
export function validateReplay(replay) {
    if (replay === undefined) return null;
    exactObject(replay, ['items']);
    if (!Array.isArray(replay.items) || replay.items.length === 0 || replay.items.length > MAX_REPLAY_ITEMS) fail('invalid_request');
    const items = replay.items.map((item) => {
        exactObject(item, ['key', 'retainUntilMs']);
        if (typeof item.key !== 'string' || !KEY_PATTERN.test(item.key)) fail('invalid_request');
        if (!Number.isSafeInteger(item.retainUntilMs) || item.retainUntilMs <= 0) fail('invalid_request');
        return { key: item.key, retainUntilMs: item.retainUntilMs };
    });
    // Two tokens of one request with the same jti are a replay within the request.
    if (new Set(items.map((item) => item.key)).size !== items.length) fail('forbidden', 'token_replayed');
    return Object.freeze(items);
}

// Inside a write transaction. `limit` is the tokenReplayEntries limit (absent: refused).
export function consumeKeys(db, items, nowMs, limit) {
    if (limit === undefined) fail('capacity_exceeded');
    // A key that would be expired on arrival records nothing durable: refused, never a silent pass.
    if (items.some((item) => item.retainUntilMs <= nowMs)) fail('invalid_request');
    const live = db.prepare('SELECT retain_until_ms FROM token_replay WHERE key = ?');
    for (const item of items) {
        const row = live.get(item.key);
        if (row && row.retain_until_ms > nowMs) fail('forbidden', 'token_replayed');
    }
    db.prepare(`DELETE FROM token_replay WHERE key IN (
        SELECT key FROM token_replay WHERE retain_until_ms <= ? ORDER BY retain_until_ms LIMIT ${PRUNE_BATCH})`).run(nowMs);
    // An expired row for one of these keys that the bounded prune left behind.
    const expired = db.prepare('DELETE FROM token_replay WHERE key = ? AND retain_until_ms <= ?');
    for (const item of items) expired.run(item.key, nowMs);
    const count = db.prepare('SELECT COUNT(*) AS count FROM token_replay').get().count;
    if (count + items.length > limit) fail('capacity_exceeded');
    const insert = db.prepare('INSERT INTO token_replay (key, retain_until_ms) VALUES (?, ?)');
    for (const item of items) insert.run(item.key, item.retainUntilMs);
}
