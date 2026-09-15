import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-mail-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { getUserByEmail } = await import('../lib/users.mjs');
const { createLoginRequest } = await import('../lib/sso.mjs');
const { getStore, resetStoreForTests } = await import('../lib/store.mjs');
const signIn = await import('../lib/auth/signIn.mjs');
const setup = await import('./helpers/setup.mjs');

after(async () => {
    await resetStoreForTests();
});

beforeEach(async () => {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-mail-'));
    delete process.env.USERPERSISTO_DEV_BOOTSTRAP;
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

async function attempt() {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    return { parent: { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) }, browserProof: setup.newBrowserProof() };
}

async function logs() {
    return (await (await getStore()).select('emailLog', {}, { start: 0, pageSize: 50 })).objects;
}

test('provider acceptance, known failure and unknown outcome are reported distinctly and logged redacted', async () => {
    const accepted = await attempt();
    const result = await signIn.startEmailSignIn({ ...accepted, email: 'accepted@example.test', purpose: 'register',
        deliver: async () => ({ delivered: true, providerMessageId: 'provider-1' }) });
    assert.equal(result.challenge.delivery, 'accepted');

    const failed = await attempt();
    await assert.rejects(signIn.startEmailSignIn({ ...failed, email: 'failed@example.test', purpose: 'register',
        deliver: async () => ({ delivered: false, result: 'rejected' }) }), (error) => error.code === 'delivery_failed' && error.statusCode === 502);
    // A known failure never leaves a verifiable code and allows an immediate retry.
    await assert.rejects(signIn.completeEmailSignIn({ ...failed, code: '123456' }), { code: 'attempt_invalid' });
    const retried = await signIn.startEmailSignIn({ ...failed, email: 'failed@example.test', purpose: 'register',
        deliver: async () => ({ delivered: true }) });
    assert.equal(retried.challenge.delivery, 'accepted');

    const unknown = await attempt();
    const uncertain = await signIn.startEmailSignIn({ ...unknown, email: 'unknown@example.test', purpose: 'register',
        deliver: async () => { throw new Error('transport timeout'); } });
    assert.equal(uncertain.challenge.delivery, 'unknown');

    const results = (await logs()).map((entry) => entry.result).sort();
    assert.deepEqual(results, ['accepted', 'accepted', 'failed', 'unknown']);
    for (const entry of await logs()) {
        assert.ok(!JSON.stringify(entry).includes('@example.test'), 'logs hold only an address digest');
    }
    assert.equal(await getUserByEmail('accepted@example.test'), null);
});

test('the development log fallback is explicit, labelled and never reported as provider acceptance', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => { warnings.push(parts.join(' ')); };
    try {
        const withoutFlag = await attempt();
        await assert.rejects(signIn.startEmailSignIn({ ...withoutFlag, email: 'dev@example.test', purpose: 'register',
            deliver: async () => ({ delivered: false }) }), { code: 'delivery_failed' });
        assert.equal(warnings.length, 0);
        process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
        const development = await attempt();
        const result = await signIn.startEmailSignIn({ ...development, email: 'dev@example.test', purpose: 'register',
            deliver: async () => { throw new Error('no email agent'); } });
        assert.equal(result.challenge.delivery, 'development-log');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /DEVELOPMENT email code/);
    } finally {
        console.warn = originalWarn;
        delete process.env.USERPERSISTO_DEV_BOOTSTRAP;
    }
    assert.ok((await logs()).some((entry) => entry.result === 'development-log'));
});
