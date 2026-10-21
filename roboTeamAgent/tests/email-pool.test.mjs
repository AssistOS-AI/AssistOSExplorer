import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EmailPool, emailInstructions, normalizeEmailAddress } from '../server/email-pool.mjs';

async function openPool(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-email-pool-'));
    const pool = new EmailPool({ file: path.join(root, 'email-pool', 'email-pool.sqlite'), ...options });
    pool.initialize();
    t.after(async () => { pool.close(); await fs.rm(root, { recursive: true, force: true }); });
    return pool;
}

test('accepts plain addresses only', () => {
    assert.equal(normalizeEmailAddress(' robot.one+tag@mail.example.com '), 'robot.one+tag@mail.example.com');
    for (const value of ['', 'robot', 'a@b', 'a b@example.com', '<a@example.com>', '"a"@example.com', `${'a'.repeat(65)}@example.com`]) {
        assert.equal(normalizeEmailAddress(value), null, value);
    }
});

test('adds addresses once, ignoring case, and reports invalid ones', async (t) => {
    const pool = await openPool(t);
    assert.deepEqual(pool.add(['one@example.com', 'ONE@example.com', 'two@example.com', 'not-an-email']),
        { added: 2, duplicates: 1, invalid: ['not-an-email'] });
    assert.deepEqual(pool.add(['two@example.com']), { added: 0, duplicates: 1, invalid: [] });
    assert.throws(() => pool.add([]), error => error.statusCode === 400);
    assert.equal(pool.snapshot().freeCount, 2);
});

test('gives each robot one random free address and keeps it until release', async (t) => {
    let pick = 1;
    const pool = await openPool(t, { random: (count) => { assert.ok(count > 0); return Math.min(pick, count - 1); } });
    assert.equal(pool.acquire('robot-one'), null, 'an empty pool assigns nothing and does not fail');
    pool.add(['a@example.com', 'b@example.com', 'c@example.com']);
    const first = pool.acquire('robot-one');
    assert.ok(first);
    pick = 0;
    assert.equal(pool.acquire('robot-one'), first, 'the assignment is sticky');
    const second = pool.acquire('robot-two');
    assert.notEqual(second, first);
    assert.equal(pool.assignedAddress('robot-two'), second);

    const held = pool.snapshot().emails.find(email => email.address === first);
    assert.equal(held.robotId, 'robot-one');
    assert.throws(() => pool.remove(held.id), error => error.statusCode === 409);
    assert.equal(pool.release('robot-one'), true);
    assert.equal(pool.release('robot-one'), false);
    assert.equal(pool.remove(held.id), true);
    assert.equal(pool.snapshot().emails.length, 2);
});

test('runs out of addresses without blocking robots', async (t) => {
    const pool = await openPool(t);
    pool.add(['only@example.com']);
    assert.equal(pool.acquire('robot-one'), 'only@example.com');
    assert.equal(pool.acquire('robot-two'), null);
});

test('instructions name the address and forbid handling credentials', () => {
    const text = emailInstructions('robot@example.com');
    assert.match(text, /robot@example\.com/u);
    assert.match(text, /never receive its password/u);
    assert.match(text, /Do not sign in, recover, verify, reset/u);
    assert.match(text, /ask a person/u);
});
