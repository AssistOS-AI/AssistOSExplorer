import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-code-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getUserByEmail, listUsers, updateUser } = await import('../lib/users.mjs');
const { createLoginRequest, prepareSsoHandoff } = await import('../lib/sso.mjs');
const { getStore, flush, resetStoreForTests } = await import('../lib/store.mjs');
const signIn = await import('../lib/auth/signIn.mjs');
const setup = await import('./helpers/setup.mjs');

after(async () => {
    await resetStoreForTests();
});

beforeEach(async () => {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-code-'));
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

async function parent() {
    const request = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    return { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
}

function mailbox() {
    const messages = [];
    const deliver = async (message) => { messages.push(message); return { delivered: true, providerMessageId: 'fixture' }; };
    return { messages, deliver, last: () => messages.at(-1) };
}

async function member(email) {
    return createUser({ email, roles: ['user'], emailVerified: true });
}

async function start(context, { email, purpose = 'login', browserProof, deliver, resend = false }) {
    return signIn.startEmailSignIn({ parent: context, browserProof, email, purpose, deliver, resend });
}

function complete(context, browserProof, code) {
    return signIn.completeEmailSignIn({ parent: context, browserProof, code, prepareHandoff: () => prepareSsoHandoff(context.id) });
}

function withClock(offsetMs, operation) {
    const realNow = Date.now;
    Date.now = () => realNow() + offsetMs;
    return Promise.resolve().then(operation).finally(() => { Date.now = realNow; });
}

function snapshotText() {
    let text = '';
    const walk = (path) => {
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) walk(full);
            else text += readFileSync(full, 'utf8');
        }
    };
    walk(process.env.PERSISTENCE_FOLDER);
    return text;
}

test('email codes only sign existing accounts in; registration codes are no longer issued', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    for (const purpose of ['register', '', 'signup']) {
        await assert.rejects(start(context, { email: 'new-person@example.test', purpose, browserProof: browser, deliver: mail.deliver }), { code: 'invalid_request' });
    }
    assert.equal(mail.messages.length, 0);
    assert.equal(await getUserByEmail('new-person@example.test'), null);
});

test('credential revocation invalidates pending login codes and completion retries', async () => {
    const { serializePersisted } = await import('../lib/serial.mjs');
    const { commitStagedPersistence } = await import('../lib/store.mjs');
    const { stageCredentialGenerationAdvance } = await import('../lib/auth/generation.mjs');
    const registered = await setup.signUpWithPassword('revoked-proof@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: registered.user.email, browserProof: browser, deliver: mail.deliver });
    await serializePersisted('users', () => commitStagedPersistence(() => stageCredentialGenerationAdvance(registered.user.id)));
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'authentication_failed' });
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_invalid' });
    // A new challenge binds the current account generation and can complete.
    await start(context, { email: registered.user.email, browserProof: browser, deliver: mail.deliver });
    const completed = await complete(context, browser, mail.last().code);
    assert.equal(completed.user.authGeneration, 1);
    await serializePersisted('users', () => commitStagedPersistence(() => stageCredentialGenerationAdvance(registered.user.id)));
    await assert.rejects(signIn.completeEmailSignIn({ parent: context, browserProof: browser, code: '' }), { code: 'authentication_failed' });
});

test('a login code is stored only encrypted/hashed, completes once and replays only to its browser', async () => {
    const account = await member('round.trip@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const started = await start(context, { email: 'Round.Trip@Example.test', browserProof: browser, deliver: mail.deliver });
    assert.equal(started.challenge.delivery, 'accepted');
    assert.equal(started.challenge.attemptsRemaining, 5);
    assert.equal(mail.last().to, 'round.trip@example.test');
    assert.equal(Object.hasOwn(mail.last(), 'purpose'), false, 'sign-in codes keep the generic message');
    assert.match(mail.last().code, /^\d{6}$/);
    await flush();
    assert.ok(!snapshotText().includes(mail.last().code));
    const completed = await complete(context, browser, mail.last().code);
    assert.equal(completed.created, false);
    assert.equal(completed.user.id, account.id);
    assert.ok(completed.handoff.code);
    const replay = await signIn.completeEmailSignIn({ parent: context, browserProof: browser, code: '000000' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.user.id, completed.user.id);
    assert.equal(replay.handoff.code, completed.handoff.code);
    await assert.rejects(complete(context, setup.newBrowserProof(), mail.last().code), { code: 'attempt_invalid' });
    assert.equal((await listUsers({ search: 'round.trip' })).totalCount, 1);
});

test('wrong codes spend a budget that resend, another address and cancel never reset', async () => {
    await member('budget@example.test');
    await member('budget-other@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: 'budget@example.test', browserProof: browser, deliver: mail.deliver });
    const wrong = mail.last().code === '000000' ? '111111' : '000000';
    await assert.rejects(complete(context, browser, wrong), (error) => error.code === 'code_invalid' && error.attemptsRemaining === 4);
    await assert.rejects(complete(context, browser, 'abc'), (error) => error.code === 'code_invalid' && error.attemptsRemaining === 3);
    await signIn.cancelSignIn({ parent: context, browserProof: browser });
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_invalid' });
    await start(context, { email: 'budget-other@example.test', browserProof: browser, deliver: mail.deliver });
    const wrongOther = mail.last().code === '000000' ? '111111' : '000000';
    await assert.rejects(complete(context, browser, wrongOther), (error) => error.code === 'code_invalid' && error.attemptsRemaining === 2);
    await withClock(61_000, () => start(context, { email: 'budget-other@example.test', browserProof: browser, deliver: mail.deliver, resend: true }));
    const wrongResent = mail.last().code === '000000' ? '111111' : '000000';
    await assert.rejects(complete(context, browser, wrongResent), (error) => error.code === 'code_invalid' && error.attemptsRemaining === 1);
    await assert.rejects(complete(context, browser, wrongResent), { code: 'too_many_attempts' });
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_invalid' });
    await assert.rejects(start(context, { email: 'budget-other@example.test', browserProof: browser, deliver: mail.deliver }), { code: 'too_many_attempts' });
});

test('resend honours the cooldown and invalidates the previous generation', async () => {
    const account = await member('resend@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: 'resend@example.test', browserProof: browser, deliver: mail.deliver });
    const firstCode = mail.last().code;
    await assert.rejects(start(context, { email: 'resend@example.test', browserProof: browser, deliver: mail.deliver, resend: true }),
        (error) => error.code === 'resend_too_soon' && error.retryAfter > 0);
    await assert.rejects(start(context, { email: 'someone-else@example.test', browserProof: browser, deliver: mail.deliver, resend: true }), { code: 'attempt_invalid' });
    await withClock(61_000, () => start(context, { email: 'resend@example.test', browserProof: browser, deliver: mail.deliver, resend: true }));
    const secondCode = mail.last().code;
    if (firstCode !== secondCode) {
        await assert.rejects(complete(context, browser, firstCode), { code: 'code_invalid' });
    }
    assert.equal((await complete(context, browser, secondCode)).user.id, account.id);
});

test('a failed login delivery keeps its 502 contract and may be retried without the cooldown', async () => {
    await member('retry-login@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    let fail = true;
    const sent = [];
    const deliver = async (message) => { sent.push(message); return fail ? { delivered: false } : { delivered: true, providerMessageId: 'fixture' }; };
    await assert.rejects(start(context, { email: 'retry-login@example.test', browserProof: browser, deliver }), { code: 'delivery_failed', statusCode: 502 });
    fail = false;
    const retried = await start(context, { email: 'retry-login@example.test', browserProof: browser, deliver, resend: true });
    assert.equal(retried.challenge.delivery, 'accepted');
    assert.equal(sent.length, 2);
    assert.ok((await complete(context, browser, sent.at(-1).code)).handoff.code);
});

test('codes are bound to their parent and browser, and expire with the parent deadline', async () => {
    await member('existing@example.test');
    await member('deadline@example.test');
    const context = await parent();
    const other = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: 'existing@example.test', browserProof: browser, deliver: mail.deliver });
    const loginCode = mail.last().code;
    await assert.rejects(complete(other, browser, loginCode), { code: 'attempt_invalid' });
    await assert.rejects(complete(context, setup.newBrowserProof(), loginCode), { code: 'attempt_invalid' });
    // The parent deadline caps the code lifetime.
    const store = await getStore();
    const shortRequest = await createLoginRequest({ redirectUri: 'http://127.0.0.1/auth/callback' });
    const record = await store.getSsoLoginRequestByProviderState(shortRequest.providerState);
    const shortExpiry = Date.now() + 30_000;
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(shortExpiry).toISOString() });
    const short = { flow: 'sso', id: shortRequest.providerState, expiresAt: shortExpiry };
    const started = await start(short, { email: 'deadline@example.test', browserProof: browser, deliver: mail.deliver });
    assert.equal(started.challenge.expiresAt, shortExpiry);
    await withClock(31_000, async () => {
        await assert.rejects(complete(short, browser, mail.last().code), { code: 'attempt_expired' });
    });
});

test('an expired code is refused and a new code is required', async () => {
    await member('expired@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const store = await getStore();
    const record = await store.getSsoLoginRequestByProviderState(context.id);
    const longer = Date.now() + 10 * 60_000;
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(longer).toISOString() });
    const extended = { ...context, expiresAt: longer };
    await start(extended, { email: 'expired@example.test', browserProof: browser, deliver: mail.deliver });
    await withClock(5 * 60_000 + 1000, async () => {
        await assert.rejects(complete(extended, browser, mail.last().code), { code: 'code_expired' });
    });
});

test('the per-address guessing budget spans parents and browsers', async () => {
    await member('guessed@example.test');
    const mail = mailbox();
    let failures = 0;
    while (failures < 10) {
        const context = await parent();
        const browser = setup.newBrowserProof();
        await start(context, { email: 'guessed@example.test', browserProof: browser, deliver: mail.deliver });
        const wrong = mail.last().code === '000000' ? '111111' : '000000';
        for (let index = 0; index < 4 && failures < 10; index += 1, failures += 1) {
            await assert.rejects(complete(context, browser, wrong), { code: 'code_invalid' });
        }
        setup.resetAuthLimitsForTests();
    }
    const fresh = await parent();
    const browser = setup.newBrowserProof();
    await assert.rejects(start(fresh, { email: 'guessed@example.test', browserProof: browser, deliver: mail.deliver }), { code: 'rate_limited' });
});

test('concurrent submissions of one code complete once', async () => {
    await member('concurrent@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: 'concurrent@example.test', browserProof: browser, deliver: mail.deliver });
    const outcomes = await Promise.all([complete(context, browser, mail.last().code), complete(context, browser, mail.last().code)]);
    assert.equal(outcomes.filter((outcome) => outcome.replayed).length, 1);
    assert.equal(outcomes.filter((outcome) => !outcome.replayed).length, 1);
    assert.equal(outcomes[0].user.id, outcomes[1].user.id);
    assert.equal(outcomes[0].handoff.code, outcomes[1].handoff.code);
});

test('cancel before commit discards the code, while cancel after a lost response keeps the committed completion', async () => {
    await member('cancelled@example.test');
    const committedAccount = await member('committed@example.test');
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await start(context, { email: 'cancelled@example.test', browserProof: browser, deliver: mail.deliver });
    assert.deepEqual(await signIn.cancelSignIn({ parent: context, browserProof: browser }), { status: 'cancelled' });
    await assert.rejects(complete(context, browser, mail.last().code), { code: 'attempt_invalid' });

    const committed = await parent();
    await start(committed, { email: 'committed@example.test', browserProof: browser, deliver: mail.deliver });
    const done = await complete(committed, browser, mail.last().code);
    // The browser never saw the response and cancels; the completion stays and the handoff replays.
    assert.deepEqual(await signIn.cancelSignIn({ parent: committed, browserProof: browser }), { status: 'completed' });
    const replay = await complete(committed, browser, '000000');
    assert.equal(replay.replayed, true);
    assert.equal(replay.handoff.code, done.handoff.code);
    assert.equal(done.user.id, committedAccount.id);
});

test('login codes go only to active accounts with a verified sign-in mailbox', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    await createUser({ email: 'unverified@example.test', roles: ['user'] });
    const blocked = await createUser({ email: 'blocked@example.test', roles: ['user'], emailVerified: true });
    await updateUser(blocked.id, { status: 'blocked' });
    for (const email of ['unknown@example.test', 'unverified@example.test', 'blocked@example.test']) {
        await assert.rejects(start(context, { email, browserProof: browser, deliver: mail.deliver }), { code: 'account_not_found' });
    }
    await assert.rejects(start(context, { email: 'not-an-email', browserProof: browser, deliver: mail.deliver }), { code: 'invalid_email' });
    assert.equal(mail.messages.length, 0);
});

test('refused code requests spend the send budget, so they cannot probe addresses without limit', async () => {
    const context = await parent();
    const browser = setup.newBrowserProof();
    const mail = mailbox();
    const rateSource = 'c'.repeat(64);
    for (let index = 0; index < 20; index += 1) {
        await assert.rejects(signIn.startEmailSignIn({ parent: context, browserProof: browser, email: `ghost-${index}@example.test`, purpose: 'login',
            rateSource, deliver: mail.deliver }), { code: 'account_not_found' });
    }
    await assert.rejects(signIn.startEmailSignIn({ parent: context, browserProof: browser, email: 'ghost-20@example.test', purpose: 'login',
        rateSource, deliver: mail.deliver }), { code: 'rate_limited' });
    assert.equal(mail.messages.length, 0);
});

test('discovery returns existence and usable method types only, and a blocked account reports none', async () => {
    const context = await parent();
    await setup.signUpWithPassword('owner@example.test');
    const withPassword = await setup.signUpWithPassword('discover@example.test');
    const store = await getStore();
    await store.createAuthMethod({ key: `${withPassword.user.id}:totp`, userId: withPassword.user.id, type: 'totp', enabled: true, credential: { secretEncrypted: 'x' } });
    await flush();
    const found = await signIn.discoverAccount({ parent: context, email: 'DISCOVER@example.test', emailAvailable: true });
    assert.deepEqual(found, { exists: true, methods: { password: true, emailCode: true, passkey: false, totp: true } });
    assert.equal((await signIn.discoverAccount({ parent: context, email: 'DISCOVER@example.test', emailAvailable: false })).methods.emailCode, false);
    const passwordless = await member('passwordless@example.test');
    assert.deepEqual(await signIn.discoverAccount({ parent: context, email: passwordless.email, emailAvailable: true }),
        { exists: true, methods: { password: false, emailCode: true, passkey: false, totp: false } });
    await updateUser(withPassword.user.id, { status: 'blocked' });
    assert.deepEqual(await signIn.discoverAccount({ parent: context, email: 'discover@example.test', emailAvailable: true }),
        { exists: true, methods: { password: false, emailCode: false, passkey: false, totp: false } });
    assert.deepEqual(await signIn.discoverAccount({ parent: context, email: 'nobody@example.test' }),
        { exists: false, methods: { password: false, emailCode: false, passkey: false, totp: false } });
    await assert.rejects(signIn.discoverAccount({ parent: context, email: 'bad' }), { code: 'invalid_email' });
    let limited = false;
    for (let index = 0; index < 25 && !limited; index += 1) {
        try { await signIn.discoverAccount({ parent: context, email: `probe-${index}@example.test` }); } catch (error) { limited = error.code === 'rate_limited'; }
    }
    assert.equal(limited, true, 'per-parent lookup budget applies');
});
