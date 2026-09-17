import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, updateUser } from '../lib/users.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { setKdfObserverForTests } from '../lib/auth/password.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

async function fixture(fn) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-password-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'password-http-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const mail = [];
    let server;
    const kdf = { runs: 0 };
    try {
        await ensureSeedData();
        const owner = await setup.signUpWithPassword('owner@example.test');
        const member = await setup.signUpWithPassword('member@example.test');
        mail.length = 0;
        setKdfObserverForTests(() => { kdf.runs += 1; });
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'fixture' }; } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const login = async (body, { headers = {}, requestId } = {}) => {
            const id = requestId || (await createLoginRequest({ redirectUri: `${base}/auth/callback` })).providerState;
            const response = await new CookieBrowser().fetch(`${base}/service/auth/password/login`, {
                method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers },
                body: JSON.stringify({ requestId: id, state: 'password-http', ...body }),
            });
            return { status: response.status, body: await response.json(), retryAfter: response.headers.get('retry-after'), requestId: id };
        };
        await fn({ base, mail, kdf, login, owner, member });
    } finally {
        setKdfObserverForTests(null);
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

const NEUTRAL = { status: 401, body: { ok: false, error: 'authentication_failed' }, retryAfter: null };
const shape = ({ status, body, retryAfter }) => ({ status, body, retryAfter });

test('password login returns a single-use Router handoff and never sends a code or replays', () => fixture(async ({ base, mail, login, member }) => {
    const attemptsBefore = (await (await getStore()).select('authAttempt')).objects.length;
    const signedIn = await login({ email: ' Member@Example.test ', password: member.password });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.deepEqual(Object.keys(signedIn.body).sort(), ['code', 'ok', 'redirectUri', 'state']);
    assert.deepEqual([signedIn.body.redirectUri, signedIn.body.state], [`${base}/auth/callback`, 'password-http']);
    const consumed = await consumeAuthCode({ providerState: signedIn.requestId, code: signedIn.body.code });
    assert.deepEqual([consumed.user.id, consumed.roles], [member.user.id, ['selfRegistered']]);
    await assert.rejects(consumeAuthCode({ providerState: signedIn.requestId, code: signedIn.body.code }), { code: 'auth_code_consumed' });
    const again = await login({ email: member.user.email, password: member.password }, { requestId: signedIn.requestId });
    assert.deepEqual([again.status, again.body.error], [400, 'login_request_invalid'], 'no lost-response replay for password login');
    assert.equal(mail.length, 0, 'password login never sends an email code');
    assert.equal((await (await getStore()).select('authAttempt')).objects.length, attemptsBefore, 'no attempt tombstone is staged');
}));

test('unknown, blocked, password-less and wrong-password logins are indistinguishable after one KDF each', () => fixture(async ({ kdf, login, owner, member }) => {
    await createUser({ email: 'no-password@example.test', roles: ['user'], emailVerified: true });
    await updateUser(member.user.id, { status: 'blocked' });
    for (const [email, password] of [['owner@example.test', 'the wrong password here'], ['unknown@example.test', owner.password],
        ['member@example.test', member.password], ['no-password@example.test', owner.password]]) {
        kdf.runs = 0;
        assert.deepEqual(shape(await login({ email, password })), NEUTRAL, email);
        assert.equal(kdf.runs, 1, email);
    }
    kdf.runs = 0;
    for (const body of [{ email: 'owner@example.test' }, { email: 'owner@example.test', password: 42 }, { email: 'owner@example.test', password: 'p'.repeat(1025) },
        { email: 'owner@example.test', password: 'surrogate \ud800 password' }, { email: 'not-an-email', password: owner.password }]) {
        assert.deepEqual(shape(await login(body)), NEUTRAL, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(kdf.runs, 0, 'malformed presentations run no KDF');
}));

test('ten failures throttle the address durably, including the correct password, with Retry-After', () => fixture(async ({ kdf, login, owner }) => {
    for (let failure = 0; failure < 10; failure += 1) {
        assert.equal((await login({ email: owner.user.email, password: `wrong password number ${failure}` })).status, 401);
    }
    kdf.runs = 0;
    const throttled = await login({ email: owner.user.email, password: owner.password });
    assert.deepEqual([throttled.status, throttled.body.error], [429, 'rate_limited']);
    assert.ok(Number(throttled.retryAfter) > 0 && Number(throttled.retryAfter) <= 900);
    assert.equal(throttled.body.retryAfter, Number(throttled.retryAfter));
    assert.equal(kdf.runs, 0);
}));

test('trusted rate sources are partitioned while untrusted or absent partitions share one bucket', () => fixture(async ({ login, owner }) => {
    const first = { 'x-ploinky-rate-source': '1'.repeat(64) };
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const email = attempt % 2 ? owner.user.email : `someone-${attempt}@example.test`;
        assert.notEqual((await login({ email, password: attempt % 2 ? owner.password : 'a wrong guess' }, { headers: first })).status, 429);
    }
    const limited = await login({ email: owner.user.email, password: owner.password }, { headers: first });
    assert.deepEqual([limited.status, limited.body.error], [429, 'rate_limited']);
    assert.equal((await login({ email: owner.user.email, password: owner.password }, { headers: { 'x-ploinky-rate-source': '2'.repeat(64) } })).status, 200);
    // A malformed partition is not trusted: it lands in the shared bucket with requests that carry none.
    for (const headers of [{ 'x-ploinky-rate-source': 'not-a-router-partition' }, {}]) {
        assert.equal((await login({ email: owner.user.email, password: owner.password }, { headers })).status, 200);
    }
}));

test('policy, parent and origin are enforced before any KDF', () => fixture(async ({ base, kdf, login, owner }) => {
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode', 'google'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    kdf.runs = 0;
    const disabled = await login({ email: owner.user.email, password: owner.password });
    assert.deepEqual([disabled.status, disabled.body.error], [404, 'auth_method_disabled']);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode', 'google'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    const dead = await login({ email: owner.user.email, password: owner.password }, { requestId: 'not-a-live-request' });
    assert.deepEqual([dead.status, dead.body.error], [400, 'login_request_invalid']);
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const store = await getStore();
    const record = await store.getSsoLoginRequestByProviderState(request.providerState);
    await store.updateSsoLoginRequest(record.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await login({ email: owner.user.email, password: owner.password }, { requestId: request.providerState });
    assert.deepEqual([expired.status, expired.body.error], [400, 'login_request_expired']);
    for (const origin of ['https://foreign.example', 'null']) {
        const foreign = await login({ email: owner.user.email, password: owner.password }, { headers: { origin } });
        assert.deepEqual([foreign.status, foreign.body.error], [403, 'invalid_origin']);
    }
    assert.equal(kdf.runs, 0);
}));
