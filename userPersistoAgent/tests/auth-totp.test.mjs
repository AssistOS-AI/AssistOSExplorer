import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncResource } from 'node:async_hooks';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-totp-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getUserById } = await import('../lib/users.mjs');
const totp = await import('../lib/auth/totp.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

const PERIOD_MS = 30_000;
const nextWindowToken = (secret) => totp.generateToken(secret, Math.floor(Date.now() / PERIOD_MS) + 1);

test('totp setup, verify, and login round-trip', async () => {
    await ensureSeedData();
    const user = await createUser({ email: 't@x.com', displayName: 'T', roles: ['user'] });
    const setup = await totp.setupStart({ userId: user.id });
    assert.ok(setup.secret);
    assert.ok(setup.setupId);
    assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);

    const confirmed = await totp.setupVerify({ userId: user.id, token: totp.generateToken(setup.secret), setupId: setup.setupId });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.replaced, false);
    assert.equal((await getUserById(user.id)).authGeneration, 0, 'a first enrollment replaces nothing');

    const login = await totp.loginVerify({ email: 't@x.com', token: totp.generateToken(setup.secret) });
    assert.equal(login.ok, true);
    assert.equal(login.user.id, user.id);
    assert.equal(Object.hasOwn(login.user, 'passwordHash'), false);

    const replay = await totp.loginVerify({ email: 't@x.com', token: totp.generateToken(setup.secret) });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'replayed_token');

    const bad = await totp.loginVerify({ email: 't@x.com', token: '000000' });
    assert.equal(bad.ok, false);
});

test('totp failures share the persistent account lockout boundary', async () => {
    const user = await createUser({ email: 'totp-lock@x.com', roles: ['user'] });
    const setup = await totp.setupStart({ userId: user.id });
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(setup.secret), setupId: setup.setupId })).ok, true);
    for (let index = 0; index < 5; index += 1) {
        assert.equal((await totp.loginVerify({ email: user.email, token: 'not-a-token' })).ok, false);
    }
    const locked = await totp.loginVerify({ email: user.email, token: totp.generateToken(setup.secret) });
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'account_locked');
});

test('staged replacement keeps the old authenticator until the new one is proven and rejects stale setups', async () => {
    const user = await createUser({ email: 'totp-replace@x.com', roles: ['user'] });
    const first = await totp.setupStart({ userId: user.id });
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(first.secret), setupId: first.setupId })).ok, true);

    const stale = await totp.setupStart({ userId: user.id });
    const replacement = await totp.setupStart({ userId: user.id });
    assert.notEqual(stale.setupId, replacement.setupId);
    // An older, superseded setup cannot finish even with a valid code for its own secret.
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(stale.secret), setupId: stale.setupId })).reason, 'setup_superseded');
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(replacement.secret) })).reason, 'setup_superseded');
    // Until the replacement is verified, the enrolled authenticator keeps working.
    assert.equal((await totp.loginVerify({ email: user.email, token: totp.generateToken(first.secret) })).ok, true);
    assert.equal((await totp.setupVerify({ userId: user.id, token: '000000', setupId: replacement.setupId })).reason, 'invalid_token');

    const replaced = await totp.setupVerify({ userId: user.id, token: totp.generateToken(replacement.secret), setupId: replacement.setupId });
    assert.deepEqual(replaced, { ok: true, replaced: true });
    assert.equal((await getUserById(user.id)).authGeneration, 1, 'replacement advances the account generation');
    // A fresh, in-window code from the old secret no longer signs in; the new secret does.
    assert.equal((await totp.loginVerify({ email: user.email, token: nextWindowToken(first.secret) })).reason, 'invalid_token');
    assert.equal((await totp.loginVerify({ email: user.email, token: nextWindowToken(replacement.secret) })).ok, true);
});

test('a staged setup allows five wrong codes and expires with a generation change', async () => {
    const user = await createUser({ email: 'totp-attempts@x.com', roles: ['user'] });
    const setup = await totp.setupStart({ userId: user.id });
    for (let index = 0; index < 4; index += 1) {
        assert.equal((await totp.setupVerify({ userId: user.id, token: '000000', setupId: setup.setupId })).reason, 'invalid_token');
    }
    assert.equal((await totp.setupVerify({ userId: user.id, token: '000000', setupId: setup.setupId })).reason, 'too_many_attempts');
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(setup.secret), setupId: setup.setupId })).reason, 'setup_not_found');

    const bound = await totp.setupStart({ userId: user.id, generation: 0 });
    const { getStore } = await import('../lib/store.mjs');
    await (await getStore()).updateUser(user.id, { authGeneration: 3 });
    assert.equal((await totp.setupVerify({ userId: user.id, token: totp.generateToken(bound.secret), setupId: bound.setupId })).reason, 'setup_expired');
});

test('a login racing replacement cannot restore the old authenticator or authenticate at the new generation', async () => {
    const { setStoreFaultInjectorForTests } = await import('../lib/store.mjs');
    const user = await createUser({ email: 'totp-interleaved@x.com', roles: ['user'] });
    const first = await totp.setupStart({ userId: user.id });
    await totp.setupVerify({ userId: user.id, token: totp.generateToken(first.secret), setupId: first.setupId });
    const replacement = await totp.setupStart({ userId: user.id });
    const independent = new AsyncResource('concurrent-totp-replacement');
    let replacing;
    setStoreFaultInjectorForTests((phase, method, args) => {
        if (!replacing && phase === 'after' && method === 'getAuthMethodByKey' && args[0] === `${user.id}:totp`) {
            replacing = independent.runInAsyncScope(() => totp.setupVerify({ userId: user.id,
                token: totp.generateToken(replacement.secret), setupId: replacement.setupId }));
        }
    });
    try {
        const login = await totp.loginVerify({ email: user.email, token: totp.generateToken(first.secret) });
        assert.equal(login.ok, true);
        assert.equal(login.user.authGeneration, 0, 'the old proof may authenticate only before replacement');
        assert.deepEqual(await replacing, { ok: true, replaced: true });
        assert.equal((await getUserById(user.id)).authGeneration, 1);
        assert.equal((await totp.loginVerify({ email: user.email, token: nextWindowToken(first.secret) })).reason, 'invalid_token');
        assert.equal((await totp.loginVerify({ email: user.email, token: nextWindowToken(replacement.secret) })).ok, true);
    } finally {
        setStoreFaultInjectorForTests();
        independent.emitDestroy();
    }
});
