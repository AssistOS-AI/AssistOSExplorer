import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-sso-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, updateUser } = await import('../lib/users.mjs');
const sso = await import('../lib/sso.mjs');
const { resetStoreForTests } = await import('../lib/store.mjs');

after(async () => {
    await resetStoreForTests();
});

test('sso auth code round-trip returns user with roles and capabilities', async () => {
    await ensureSeedData();
    const user = await createUser({ email: 's@x.com', displayName: 'S', roles: ['admin'], password: 'pw-123456' });

    const request = await sso.createLoginRequest({ redirectUri: 'http://localhost:8080/auth/callback', clientId: 'explorer' });
    assert.ok(request.providerState);

    const issued = await sso.issueAuthCode({ providerState: request.providerState, userId: user.id });
    assert.ok(issued.code);
    assert.equal(issued.redirectUri, 'http://localhost:8080/auth/callback');

    const consumed = await sso.consumeAuthCode({ providerState: request.providerState, code: issued.code });
    assert.equal(consumed.user.email, 's@x.com');
    assert.ok(consumed.roles.includes('admin'));
    assert.ok(consumed.capabilities.includes('explorer.access'));

    await assert.rejects(() => sso.consumeAuthCode({ providerState: request.providerState, code: issued.code }),
        (error) => error.code === 'auth_code_consumed' && error.statusCode === 400);
    await assert.rejects(() => sso.consumeAuthCode({ providerState: 'other-state', code: 'unknown-code' }),
        (error) => error.code === 'auth_code_invalid' && error.statusCode === 400);
    await assert.rejects(() => sso.issueAuthCode({ providerState: 'not-a-live-request', userId: user.id }),
        (error) => error.code === 'login_request_invalid' && error.statusCode === 400);
});

test('getSsoUser rejects blocked users', async () => {
    const user = await createUser({ email: 'b@x.com', displayName: 'B', roles: ['user'] });
    await updateUser(user.id, { status: 'blocked' });
    await assert.rejects(() => sso.getSsoUser(user.id), (error) => error.code === 'user_not_active' && error.statusCode === 403);
    await assert.rejects(() => sso.getSsoUser('USER.missing'), (error) => error.code === 'user_not_found' && error.statusCode === 404);
});

test('a login request can issue only one auth code under concurrency', async () => {
    const user = await createUser({ email: 'single-code@x.com', roles: ['user'] });
    const request = await sso.createLoginRequest({ redirectUri: 'http://localhost:8080/auth/callback', clientId: 'explorer' });
    const outcomes = await Promise.allSettled([
        sso.issueAuthCode({ providerState: request.providerState, userId: user.id }),
        sso.issueAuthCode({ providerState: request.providerState, userId: user.id }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
});

test('an invalid login request cannot run registration side effects', async () => {
    let called = false;
    await assert.rejects(
        () => sso.issueAuthCode({
            providerState: 'not-a-login-request',
            resolveUserId: async () => {
                called = true;
                return 'should-not-be-used';
            },
        }),
        /unknown or expired/i
    );
    assert.equal(called, false);
});

test('credential revocation fences both a pending handoff and delayed issuance', async () => {
    const { serializePersisted } = await import('../lib/serial.mjs');
    const { commitStagedPersistence } = await import('../lib/store.mjs');
    const { stageCredentialGenerationAdvance } = await import('../lib/auth/generation.mjs');
    const user = await createUser({ email: 'revoked-handoff@example.test', roles: ['user'] });
    const first = await sso.createLoginRequest({ redirectUri: 'http://localhost:8080/auth/callback' });
    const issued = await sso.issueAuthCode({ providerState: first.providerState, userId: user.id, generation: 0 });
    const delayed = await sso.createLoginRequest({ redirectUri: 'http://localhost:8080/auth/callback' });
    await serializePersisted('users', () => commitStagedPersistence(() => stageCredentialGenerationAdvance(user.id)));
    assert.equal(await sso.isAuthCodeLive({ providerState: first.providerState, code: issued.code }), false);
    await assert.rejects(sso.consumeAuthCode({ providerState: first.providerState, code: issued.code }), { code: 'session_revoked' });
    await assert.rejects(sso.issueAuthCode({ providerState: delayed.providerState, userId: user.id, generation: 0 }), { code: 'session_revoked' });
    const fresh = await sso.issueAuthCode({ providerState: delayed.providerState, userId: user.id, generation: 1 });
    assert.equal((await sso.consumeAuthCode({ providerState: delayed.providerState, code: fresh.code })).user.authGeneration, 1);
});
