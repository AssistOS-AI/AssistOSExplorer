import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL_ID = /^eml_[0-9a-f]{12}$/u;
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
// Deliberately plain: one local part, one dotted domain, no spaces, quotes or angle brackets, so an
// address can be placed in a robot's instructions as-is.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u;
export const EMAIL_IMPORT_LIMIT = 1000;

export function emailPoolFile(dataDir) {
    return path.join(dataDir, 'email-pool', 'email-pool.sqlite');
}

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

export function normalizeEmailAddress(value) {
    const address = String(value ?? '').trim();
    return address.length <= 254 && ADDRESS.test(address) ? address : null;
}

// The instructions a robot receives with its address. The mailbox is signed in by a person in the
// robot's Chromium; RoboTeam never stores or hands out its password.
export function emailInstructions(address) {
    return [
        `Your email address is ${address}. Use it when your work needs an email address, and read or send mail through its webmail in Chromium, where a person signs the mailbox in for you. You never receive its password.`,
        'Do not sign in, recover, verify, reset or change the password or security settings of this mailbox.',
        'If the mailbox is signed out or asks for a password, a code or another verification, stop and ask a person to sign it in.',
    ].join(' ');
}

// Email addresses shared out to robots, one per robot. A robot receives a free address at random the
// first time it starts and keeps it until an administrator releases it, the address is deleted, or
// the robot is deleted. Only addresses are stored; there are no credentials to protect.
export class EmailPool {
    constructor({ file, now = () => new Date(), random = crypto.randomInt } = {}) {
        if (!file) throw new Error('email pool file is required');
        this.file = file;
        this.now = now;
        this.random = random;
    }

    initialize() {
        if (this.db) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        if (fs.lstatSync(path.dirname(this.file)).isSymbolicLink() || (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())) {
            throw new Error('Unsafe email pool database path');
        }
        this.db = new DatabaseSync(this.file);
        fs.chmodSync(this.file, 0o600);
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS emails (
                id TEXT PRIMARY KEY, address TEXT NOT NULL UNIQUE COLLATE NOCASE,
                robot_id TEXT UNIQUE, assigned_at TEXT, created_at TEXT NOT NULL);`);
    }

    close() {
        this.db?.close();
        this.db = null;
    }

    _transaction(operation) {
        this.initialize();
        if (this.db.isTransaction) return operation();
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    // Adds every valid address not already in the pool and reports the rest.
    add(addresses) {
        if (!Array.isArray(addresses) || addresses.length === 0) throw httpError(400, 'addresses must be a non-empty list');
        if (addresses.length > EMAIL_IMPORT_LIMIT) throw httpError(400, `at most ${EMAIL_IMPORT_LIMIT} addresses can be added at once`);
        return this._transaction(() => {
            const result = { added: 0, duplicates: 0, invalid: [] };
            const insert = this.db.prepare('INSERT INTO emails (id, address, created_at) VALUES (?, ?, ?) ON CONFLICT(address) DO NOTHING');
            const createdAt = this.now().toISOString();
            for (const value of addresses) {
                const address = normalizeEmailAddress(value);
                if (!address) { if (result.invalid.length < 20) result.invalid.push(String(value ?? '').slice(0, 80)); continue; }
                if (insert.run(`eml_${crypto.randomBytes(6).toString('hex')}`, address, createdAt).changes) result.added += 1;
                else result.duplicates += 1;
            }
            return result;
        });
    }

    remove(id) {
        if (!EMAIL_ID.test(String(id))) throw httpError(404, 'email not found');
        return this._transaction(() => {
            const row = this.db.prepare('SELECT robot_id FROM emails WHERE id = ?').get(id);
            if (!row) throw httpError(404, 'email not found');
            if (row.robot_id) throw httpError(409, 'release the email from its robot before deleting it');
            this.db.prepare('DELETE FROM emails WHERE id = ?').run(id);
            return true;
        });
    }

    // The robot's address, assigning a random free one when it has none; null when none is free.
    acquire(robotId) {
        if (!ROBOT_ID.test(String(robotId))) throw httpError(400, 'Invalid robot ID.');
        return this._transaction(() => {
            const current = this.db.prepare('SELECT address FROM emails WHERE robot_id = ?').get(robotId);
            if (current) return current.address;
            const free = this.db.prepare('SELECT COUNT(*) AS count FROM emails WHERE robot_id IS NULL').get().count;
            if (!free) return null;
            const candidate = this.db.prepare('SELECT id, address FROM emails WHERE robot_id IS NULL ORDER BY id LIMIT 1 OFFSET ?').get(this.random(free));
            this.db.prepare('UPDATE emails SET robot_id = ?, assigned_at = ? WHERE id = ?').run(robotId, this.now().toISOString(), candidate.id);
            return candidate.address;
        });
    }

    assignedAddress(robotId) {
        this.initialize();
        return this.db.prepare('SELECT address FROM emails WHERE robot_id = ?').get(robotId)?.address || null;
    }

    release(robotId) {
        if (!ROBOT_ID.test(String(robotId))) throw httpError(400, 'Invalid robot ID.');
        this.initialize();
        return this.db.prepare('UPDATE emails SET robot_id = NULL, assigned_at = NULL WHERE robot_id = ?').run(robotId).changes > 0;
    }

    snapshot() {
        this.initialize();
        const emails = this.db.prepare('SELECT * FROM emails ORDER BY address COLLATE NOCASE').all().map(row => ({
            id: row.id, address: row.address, robotId: row.robot_id || null, assignedAt: row.assigned_at || null, createdAt: row.created_at,
        }));
        return { emails, freeCount: emails.filter(email => !email.robotId).length };
    }
}
