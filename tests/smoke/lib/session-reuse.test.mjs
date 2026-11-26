import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyPreflightFailure, preflightError } from './account-preflight.mjs';
import { signIn, trySignIn } from './auth.mjs';
import { smokeConfig } from './config.mjs';
import {
    SessionStoreError,
    SignInRateLimitedError,
    ensurePrivateDirectory,
    prepareSessionStore,
    restoreSavedSession,
    realSignInRequired,
    requireRealSignIns,
    accountRole,
    defaultSessionDir,
    sessionFile,
    sessionReuseEnabled,
    signInWithSessionReuse,
    watchSignInRateLimit,
} from './session-reuse.mjs';

const ORIGIN = 'https://smoke.example.test';
const config = {
    baseURL: `${ORIGIN}/`,
    primaryUser: { username: 'admin-label', loginEmail: 'admin-person@example.test' },
    secondaryUser: { username: 'member-label', loginEmail: 'member-person@example.test' },
};
const PRINCIPALS = {
    primary: { id: 'u-1', username: 'admin-label', email: 'admin-person@example.test', roles: ['admin'] },
    secondary: { id: 'u-2', username: 'member-label', email: 'member-person@example.test', roles: ['user'] },
};
const validate = (user, account) => user.username === account.username;
const verifyPrincipal = (principal, account) => principal.canonicalUsername === account.username;

// A fake deployment: one live session token per account, and fake browser contexts that hold cookies.
function fixture() {
    const live = new Map();
    const state = { passwordSignIns: 0, tokenChecks: 0 };
    function newPage() {
        const jar = [];
        const context = {
            cookies: async () => jar.map((cookie) => ({ ...cookie })),
            addCookies: async (cookies) => { jar.push(...cookies.map((cookie) => ({ ...cookie }))); },
            clearCookies: async ({ name }) => {
                for (let index = jar.length - 1; index >= 0; index -= 1) if (jar[index].name === name) jar.splice(index, 1);
            },
        };
        const request = {
            get: async () => {
                state.tokenChecks += 1;
                const session = jar.find((cookie) => cookie.name === 'sid');
                const role = live.get(session?.value);
                return {
                    ok: () => Boolean(role),
                    json: async () => ({ user: role ? PRINCIPALS[role] : null }),
                };
            },
        };
        return { context: () => context, request, jar };
    }
    function signInRun(page, role) {
        return async () => {
            const session = page.jar.find((cookie) => cookie.name === 'sid');
            if (!live.has(session?.value)) {
                state.passwordSignIns += 1;
                const value = `secret-session-${role}-${state.passwordSignIns}`;
                live.set(value, role);
                page.jar.push({ name: 'sid', value, domain: 'smoke.example.test', path: '/', secure: true, httpOnly: true, expires: -1 });
            }
            const principal = PRINCIPALS[live.get(page.jar.find((cookie) => cookie.name === 'sid').value)];
            return { canonicalId: principal.id, canonicalUsername: principal.username, email: principal.email, roles: principal.roles };
        };
    }
    return { live, state, newPage, signInRun };
}

function run(page, role, deps, extra = {}) {
    const account = config[`${role}User`];
    return signInWithSessionReuse(page, account, deps.signInRun(page, role), { config, validate, verifyPrincipal, ...extra });
}

function privateRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-session-reuse-'));
}

test('a second preflight in the same run reuses the saved session and makes no password sign-in', async () => {
    const deps = fixture();
    const dir = path.join(privateRoot(), 'sessions');
    const env = {};
    for (const role of ['primary', 'secondary']) await run(deps.newPage(), role, deps, { dir, env });
    assert.equal(deps.state.passwordSignIns, 2, 'the first preflight signs each account in once');
    const second = deps.newPage();
    const principal = await run(second, 'primary', deps, { dir, env });
    await run(deps.newPage(), 'secondary', deps, { dir, env });
    assert.equal(deps.state.passwordSignIns, 2, 'the second preflight and every later context add no password sign-in');
    assert.equal(principal.canonicalUsername, 'admin-label');
    assert.equal(second.jar.some((cookie) => cookie.name === 'sid'), true, 'the saved session is restored into the new context');
});

test('invalid saved state falls back to exactly one fresh sign-in and is replaced', async () => {
    const deps = fixture();
    const dir = path.join(privateRoot(), 'sessions');
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    deps.live.clear();
    const stale = deps.newPage();
    await run(stale, 'primary', deps, { dir, env: {} });
    assert.equal(deps.state.passwordSignIns, 2, 'one fresh sign-in after the saved session was refused');
    assert.deepEqual(stale.jar.map((cookie) => cookie.name), ['sid'], 'the refused cookie is cleared before the fresh one is set');
    const third = deps.newPage();
    await run(third, 'primary', deps, { dir, env: {} });
    assert.equal(deps.state.passwordSignIns, 2, 'the replacement state is valid');
});

test('saved state for a different account, a loose file or another deployment is never used', async () => {
    const deps = fixture();
    const dir = path.join(privateRoot(), 'sessions');
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    const file = sessionFile(dir, { origin: ORIGIN, role: 'primary', account: config.primaryUser });
    fs.chmodSync(file, 0o644);
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    assert.equal(deps.state.passwordSignIns, 2, 'a group- or world-readable state file is discarded');
    // State saved by another deployment is refused by the live check and replaced; roles never share a file.
    const other = fixture();
    await run(other.newPage(), 'primary', other, { dir, env: {} });
    await run(other.newPage(), 'secondary', other, { dir, env: {} });
    assert.equal(other.state.passwordSignIns, 2, 'each role signs in once against a deployment that did not issue the saved state');
    assert.equal(fs.readdirSync(dir).length, 2, 'one file per role');
    // A saved secondary file holding a session that is live for the primary account is refused by the principal check.
    const swapped = fixture();
    const primaryPage = swapped.newPage();
    await run(primaryPage, 'primary', swapped, { dir: path.join(privateRoot(), 'p'), env: {} });
    const crossDir = path.join(privateRoot(), 'cross');
    fs.mkdirSync(crossDir, { mode: 0o700 });
    fs.writeFileSync(sessionFile(crossDir, { origin: ORIGIN, role: 'secondary', account: config.secondaryUser }),
        JSON.stringify({ version: 1, origin: ORIGIN, role: 'secondary', cookies: primaryPage.jar }), { mode: 0o600 });
    const crossPage = swapped.newPage();
    const principal = await run(crossPage, 'secondary', swapped, { dir: crossDir, env: {} });
    assert.equal(principal.canonicalUsername, 'member-label');
    assert.equal(swapped.state.passwordSignIns, 2, 'the primary session is not accepted for the secondary account');
    // Accounts the run created itself never reuse and never write state.
    const before = fs.readdirSync(dir).length;
    const stranger = { username: 'run-created', loginEmail: 'run-created@example.test' };
    let signIns = 0;
    await signInWithSessionReuse(deps.newPage(), stranger, async () => { signIns += 1; return { canonicalUsername: 'run-created' }; },
        { config, validate, verifyPrincipal, dir, env: {} });
    assert.equal(signIns, 1);
    assert.equal(fs.readdirSync(dir).length, before);
    assert.equal(accountRole(stranger, config), '');
});

test('a 429 sign-in is classified as a rate limit with the role and Retry-After and no private input', async () => {
    const page = new EventEmitter();
    page.off = page.removeListener;
    const watch = watchSignInRateLimit(page, ORIGIN);
    page.emit('response', {
        url: () => `${ORIGIN}/base-agent-additional-server/userPersistoAgent/7000/service/auth/password/login`,
        status: () => 429,
        headers: () => ({ 'retry-after': '487' }),
        json: async () => ({ ok: false, error: 'rate_limited' }),
    });
    page.emit('response', { url: () => `${ORIGIN}/explorer/x`, status: () => 429, headers: () => ({}), json: async () => ({}) });
    const limited = await watch.limited();
    watch.dispose();
    assert.deepEqual(limited, { retryAfter: 487 });
    const error = new SignInRateLimitedError({ role: 'secondary', retryAfter: limited.retryAfter, now: 0 });
    assert.match(error.message, /secondary smoke account was rate limited by UserPersisto \(429\); retry after 487 s \(about 1970-01-01T00:08:07\.000Z\)/);
    assert.equal(error.kind, 'rate_limited');
    const raised = preflightError(error);
    assert.match(raised.message, /^Smoke account preflight failed \(rate_limited\): .*rate limited by UserPersisto \(429\).*Private inputs are withheld\.$/);
    for (const secret of ['admin-person', 'member-person', 'example.test', 'admin-label']) assert.equal(raised.message.includes(secret), false);

    const body = new EventEmitter();
    body.off = body.removeListener;
    const bodyWatch = watchSignInRateLimit(body, ORIGIN);
    body.emit('response', { url: () => `${ORIGIN}/x/auth/password/login`, status: () => 429, headers: () => ({}), json: async () => ({ retryAfter: 61 }) });
    assert.deepEqual(await bodyWatch.limited(), { retryAfter: 61 });
    assert.equal(new SignInRateLimitedError({ role: 'primary', retryAfter: '12; drop' }).retryAfter, null, 'a non-numeric Retry-After is never printed');
    const quiet = new EventEmitter();
    quiet.off = quiet.removeListener;
    const none = watchSignInRateLimit(quiet, ORIGIN);
    quiet.emit('response', { url: () => `${ORIGIN}/auth/x`, status: () => 401, headers: () => ({}), json: async () => ({}) });
    assert.equal(await none.limited(), null);
});

test('preflight failures keep a safe class and never forward private messages', () => {
    const privateText = 'Login did not leave /auth/login for admin-person@example.test with password hunter2';
    assert.equal(classifyPreflightFailure(new Error(privateText)).kind, 'sign-in');
    assert.equal(preflightError(new Error(privateText)).message.includes('hunter2'), false);
    assert.equal(preflightError(new Error(privateText)).message.includes('admin-person'), false);
    assert.equal(classifyPreflightFailure(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x')).kind, 'network');
    assert.equal(preflightError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080 admin-person@example.test'), { code: 'ECONNREFUSED' }))
        .message.includes('admin-person'), false);
    const roles = Object.assign(new Error('Smoke account preflight requires a distinct verified ordinary user.'), { kind: 'roles' });
    assert.match(preflightError(roles).message, /\(roles\): Smoke account preflight requires a distinct verified ordinary user\./);
});

test('saved state is created mode 600 inside a mode 700 directory, even when the directory already exists wider', async () => {
    const deps = fixture();
    const root = privateRoot();
    const dir = path.join(root, 'nested', 'sessions');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, 'no temporary file is left behind');
    assert.match(files[0], /^primary-[0-9a-f]{32}\.json$/, 'the file name carries the role and a hash, not the account');
    assert.equal(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
    const fresh = path.join(root, 'created', 'sessions');
    await run(deps.newPage(), 'secondary', deps, { dir: fresh, env: {} });
    assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(fresh, fs.readdirSync(fresh)[0])).mode & 0o777, 0o600);
});

test('SMOKE_REUSE_SESSIONS=0 and reuseSession false disable reuse and write nothing', async () => {
    for (const disable of [{ env: { SMOKE_REUSE_SESSIONS: '0' } }, { env: {}, reuseSession: false }]) {
        const deps = fixture();
        const dir = path.join(privateRoot(), 'sessions');
        await run(deps.newPage(), 'primary', deps, { dir, ...disable });
        await run(deps.newPage(), 'primary', deps, { dir, ...disable });
        assert.equal(deps.state.passwordSignIns, 2, 'every context signs in for real');
        assert.equal(fs.existsSync(dir), false, 'nothing is saved');
    }
    assert.equal(sessionReuseEnabled({}), true);
    assert.equal(sessionReuseEnabled({ SMOKE_REUSE_SESSIONS: '0' }), false);
    assert.equal(sessionReuseEnabled({ SMOKE_REUSE_SESSIONS: 'false' }), false);
    assert.equal(sessionReuseEnabled({ SMOKE_REUSE_SESSIONS: '1' }), true);
});

test('the default session directory is under the untracked test-artifact tree', () => {
    assert.match(defaultSessionDir({}), /[\\/]\.ploinky[\\/]test-artifacts[\\/]headless-smoke[\\/]sessions$/);
    assert.equal(defaultSessionDir({ SMOKE_SESSION_DIR: '/private/sessions-x' }), '/private/sessions-x');
    assert.throws(() => defaultSessionDir({ SMOKE_SESSION_DIR: 'relative/dir' }), /absolute/);
});

test('requireRealSignIns raises the depth for two calls and returns it to zero', async () => {
    const hooks = { beforeAll: [], afterAll: [] };
    const fakeTest = { beforeAll: (fn) => hooks.beforeAll.push(fn), afterAll: (fn) => hooks.afterAll.push(fn) };
    assert.equal(realSignInRequired(), false);
    requireRealSignIns(fakeTest);
    requireRealSignIns(fakeTest);
    assert.equal(realSignInRequired(), false, 'registering hooks changes nothing until the file runs');
    for (const hook of hooks.beforeAll) await hook();
    assert.equal(realSignInRequired(), true);
    await hooks.afterAll[0]();
    assert.equal(realSignInRequired(), true, 'one file still requires real sign-ins');
    await hooks.afterAll[1]();
    assert.equal(realSignInRequired(), false);
});

test('trySignIn rethrows a rate limit or a session-store error and returns false for other failures', async () => {
    const failing = (error) => async () => { throw error; };
    await assert.rejects(trySignIn({}, config.primaryUser, '/', failing(new SignInRateLimitedError({ role: 'primary' }))), { kind: 'rate_limited' });
    await assert.rejects(trySignIn({}, config.primaryUser, '/', failing(new SessionStoreError('fixed'))), { kind: 'session-store' });
    assert.equal(await trySignIn({}, config.primaryUser, '/', failing(new Error('cannot log in'))), false);
    assert.equal(await trySignIn({}, config.primaryUser, '/', async () => ({})), true);
});

test('signIn converts a 429 seen during the sign-in into the classified rate-limit error', async () => {
    const page = new EventEmitter();
    page.off = page.removeListener;
    page.request = { get: async () => ({ ok: () => false }) };
    page.url = () => 'about:blank';
    page.goto = async () => {
        page.emit('response', {
            url: () => new URL('/base-agent-additional-server/userPersistoAgent/7000/service/auth/password/login',
                new URL(smokeConfig.baseURL).origin).href,
            status: () => 429,
            headers: () => ({ 'retry-after': '90' }),
            json: async () => ({}),
        });
        throw new Error('Login failed for admin-person@example.test with hunter2');
    };
    const account = { username: 'run-created', loginEmail: 'run-created@example.test', signInMethod: 'password' };
    await assert.rejects(signIn(page, account, '/'), (error) => {
        assert.equal(error.kind, 'rate_limited');
        assert.equal(error.retryAfter, 90);
        assert.match(error.message, /rate limited by UserPersisto \(429\); retry after 90 s/);
        assert.equal(/hunter2|admin-person|run-created/.test(error.message), false);
        return true;
    });
    const plain = new EventEmitter();
    plain.off = plain.removeListener;
    plain.request = page.request;
    plain.url = () => 'about:blank';
    plain.goto = async () => { throw new Error('plain failure'); };
    await assert.rejects(signIn(plain, account, '/'), /plain failure/);
});

test('signInWithSessionReuse works with the real principal closures from auth.mjs', async () => {
    // Real closures: principal matching goes through validateAuthenticatedPrincipal, as in signIn.
    const { validateAuthenticatedPrincipal } = await import('./auth.mjs');
    const matches = (principal, account) => {
        try {
            validateAuthenticatedPrincipal(principal, { expectedUsername: account?.username, expectedEmail: account?.loginEmail });
            return true;
        } catch { return false; }
    };
    const realValidate = (user, account) => matches(user, account);
    const realVerify = (principal, account) => matches({
        id: principal?.canonicalId, username: principal?.canonicalUsername, email: principal?.email, roles: principal?.roles,
    }, account);
    const deps = fixture();
    const dir = path.join(privateRoot(), 'sessions');
    const options = { config, validate: realValidate, verifyPrincipal: realVerify, dir, env: {} };
    const first = deps.newPage();
    await signInWithSessionReuse(first, config.primaryUser, deps.signInRun(first, 'primary'), options);
    const second = deps.newPage();
    const principal = await signInWithSessionReuse(second, config.primaryUser, deps.signInRun(second, 'primary'), options);
    assert.equal(deps.state.passwordSignIns, 1);
    assert.equal(principal.canonicalUsername, 'admin-label');
    // A guest principal is never saved.
    const guest = deps.newPage();
    await signInWithSessionReuse(guest, config.secondaryUser, async () => ({ canonicalId: 'guest', canonicalUsername: 'member-label', email: 'member-person@example.test', roles: ['guest'] }), options);
    assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('secondary-')), false);
});

test('state saved for another origin is refused, deleted and replaced by one fresh sign-in', async () => {
    const deps = fixture();
    const dir = path.join(privateRoot(), 'sessions');
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    const file = sessionFile(dir, { origin: ORIGIN, role: 'primary', account: config.primaryUser });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, origin: 'https://other.example.test' }), { mode: 0o600 });
    const checksBefore = deps.state.tokenChecks;
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    assert.equal(deps.state.passwordSignIns, 2, 'a foreign-origin file is not restored');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).origin, ORIGIN, 'the replacement is for the current origin');
    assert.ok(deps.state.tokenChecks > checksBefore);
});

test('a symlinked or foreign-owned session store is a session-store error before any sign-in', async () => {
    const deps = fixture();
    const root = privateRoot();
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    let signIns = 0;
    const attempt = (options) => signInWithSessionReuse(deps.newPage(), config.primaryUser, async () => { signIns += 1; return {}; },
        { config, validate, verifyPrincipal, env: {}, ...options });
    await assert.rejects(attempt({ dir: link }), { kind: 'session-store', message: /real directory/ });
    await assert.rejects(attempt({ dir: real, getuid: () => (process.getuid?.() ?? 0) + 1 }), { kind: 'session-store', message: /owned by the current user/ });
    assert.equal(signIns, 0, 'a misconfiguration costs no sign-in');
    assert.throws(() => prepareSessionStore({ SMOKE_SESSION_DIR: 'relative' }), { kind: 'session-store' });
    assert.throws(() => ensurePrivateDirectory(link), SessionStoreError);
    // A foreign-owned saved file is discarded unread and never restored.
    const dir = path.join(root, 'sessions');
    await run(deps.newPage(), 'primary', deps, { dir, env: {} });
    const file = sessionFile(dir, { origin: ORIGIN, role: 'primary', account: config.primaryUser });
    const page = deps.newPage();
    const restored = await restoreSavedSession({
        context: page.context(), request: page.request, account: config.primaryUser, role: 'primary', origin: ORIGIN, dir, validate,
        getuid: () => (process.getuid?.() ?? 0) + 1,
    });
    assert.equal(restored, false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(page.jar.length, 0, 'no cookie of a foreign-owned file reaches the context');
});

test('preflight keeps the session-store class and its fixed text', () => {
    const error = new SessionStoreError('SMOKE_SESSION_DIR must be an absolute path.');
    assert.equal(classifyPreflightFailure(error).kind, 'session-store');
    assert.match(preflightError(error).message, /^Smoke account preflight failed \(session-store\): SMOKE_SESSION_DIR must be an absolute path\. Private inputs are withheld\.$/);
});
