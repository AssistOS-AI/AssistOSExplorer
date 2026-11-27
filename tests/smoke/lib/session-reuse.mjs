import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getWithoutKeepAlive } from './api-probe.mjs';

// Password sign-ins are budgeted per source by UserPersisto (20 per 15 minutes
// for the one source every local run shares). This module lets a smoke run
// sign each configured account in once and reuse the session cookies, which
// are secrets: they live only in a private directory (mode 700, files 600)
// under the untracked test-artifact tree, are validated against the live
// deployment before every use and are never printed.

const STATE_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RATE_LIMIT_PATH = /\/auth\//;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

// A misconfigured session store is reported as such, with fixed text that
// holds no path, account or cookie. It must never read as a failed sign-in.
export class SessionStoreError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SessionStoreError';
        this.kind = 'session-store';
    }
}

export function sessionReuseEnabled(env = process.env) {
    return !/^(?:0|false|off|no)$/i.test(String(env.SMOKE_REUSE_SESSIONS ?? '1').trim());
}

export function defaultSessionDir(env = process.env) {
    const override = String(env.SMOKE_SESSION_DIR || '').trim();
    if (override) {
        if (!path.isAbsolute(override)) throw new SessionStoreError('SMOKE_SESSION_DIR must be an absolute path.');
        return path.resolve(override);
    }
    return path.join(repoRoot, '.ploinky', 'test-artifacts', 'headless-smoke', 'sessions');
}

// The role label used in messages and file names: only the two configured
// accounts ever reuse a session. Run-created accounts and accounts a spec
// derives for itself always sign in for real.
export function accountRole(account, config) {
    const same = (candidate) => candidate && account
        && candidate.username === account.username && candidate.loginEmail === account.loginEmail;
    if (same(config.primaryUser)) return 'primary';
    if (same(config.secondaryUser)) return 'secondary';
    return '';
}

export class SignInRateLimitedError extends Error {
    constructor({ role = '', retryAfter = null, now = Date.now() } = {}) {
        const seconds = safeRetryAfter(retryAfter);
        const label = role ? `the ${role} smoke account` : 'a smoke account';
        const wait = seconds === null
            ? ''
            : `; retry after ${seconds} s (about ${new Date(now + seconds * 1000).toISOString()})`;
        super(`Sign-in for ${label} was rate limited by UserPersisto (429)${wait}.`);
        this.name = 'SignInRateLimitedError';
        this.kind = 'rate_limited';
        this.role = role;
        this.retryAfter = seconds;
    }
}

export function safeRetryAfter(value) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,9}$/.test(text)) return null;
    const seconds = Number(text);
    return seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

// Records a 429 from any same-origin /auth/ response while a sign-in runs, so
// the refusal is reported from the network answer and not from alert text.
export function watchSignInRateLimit(page, origin) {
    if (typeof page?.on !== 'function') return { limited: async () => null, dispose() {} };
    const pending = [];
    let hit = null;
    const onResponse = (response) => {
        let url;
        try { url = new URL(response.url()); } catch { return; }
        if (response.status() !== 429 || url.origin !== origin || !RATE_LIMIT_PATH.test(url.pathname)) return;
        hit ||= { retryAfter: safeRetryAfter(response.headers()['retry-after']) };
        if (hit.retryAfter === null) {
            pending.push(response.json().then((body) => {
                if (hit.retryAfter === null) hit.retryAfter = safeRetryAfter(body?.retryAfter);
            }).catch(() => {}));
        }
    };
    page.on('response', onResponse);
    return {
        async limited() {
            await Promise.all(pending);
            return hit;
        },
        dispose() { page.off?.('response', onResponse); },
    };
}

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// Creates (or tightens) the private session directory. Anything that is not a
// real directory owned by the current user is refused before a sign-in.
export function ensurePrivateDirectory(dir, { getuid = currentUid } = {}) {
    let stat = null;
    try { stat = fs.lstatSync(dir); } catch { /* created below */ }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new SessionStoreError('The session directory must be a real directory, not a symlink or file.');
    }
    if (!stat) {
        try { fs.mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE }); } catch {
            throw new SessionStoreError('The session directory cannot be created.');
        }
        stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new SessionStoreError('The session directory must be a real directory, not a symlink or file.');
        }
    }
    const uid = getuid();
    if (uid !== null && stat.uid !== uid) {
        throw new SessionStoreError('The session directory must be owned by the current user.');
    }
    try { fs.chmodSync(dir, DIRECTORY_MODE); } catch {
        throw new SessionStoreError('The session directory permissions cannot be restricted to the owner.');
    }
}

// Resolves and validates the store once, before the first password sign-in.
export function prepareSessionStore(env = process.env, { dir, getuid } = {}) {
    const directory = dir || defaultSessionDir(env);
    ensurePrivateDirectory(directory, { getuid });
    return directory;
}

export function sessionFile(dir, { origin, role, account }) {
    const digest = crypto.createHash('sha256')
        .update(['smoke-session', origin, role, account?.username || '', account?.loginEmail || ''].join('\0'))
        .digest('hex').slice(0, 32);
    return path.join(dir, `${role}-${digest}.json`);
}

export function discardSavedSession(file) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

function readSavedCookies(file, origin, getuid = currentUid) {
    let stat;
    try { stat = fs.lstatSync(file); } catch { return null; }
    const unsafe = !stat.isFile() || (stat.mode & 0o077) !== 0
        || (getuid() !== null && stat.uid !== getuid());
    if (unsafe) { discardSavedSession(file); return null; }
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved?.version !== STATE_VERSION || saved.origin !== origin
            || !Array.isArray(saved.cookies) || !saved.cookies.length
            || !saved.cookies.every((cookie) => cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string')) {
            discardSavedSession(file);
            return null;
        }
        return saved.cookies;
    } catch {
        discardSavedSession(file);
        return null;
    }
}

export function writeSavedCookies(dir, file, { origin, role, cookies }, { getuid } = {}) {
    ensurePrivateDirectory(dir, { getuid });
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: STATE_VERSION, origin, role, savedAt: new Date().toISOString(), cookies }),
        { flag: 'wx', mode: FILE_MODE });
    fs.chmodSync(temporary, FILE_MODE);
    fs.renameSync(temporary, file);
}

async function authenticatedUser(request) {
    const response = await getWithoutKeepAlive(request, '/auth/token').catch(() => null);
    if (!response?.ok()) return null;
    const payload = await response.json().catch(() => null);
    return payload?.user && typeof payload.user === 'object' ? payload.user : null;
}

// Restores the saved session of `account` into `context` only when the live
// deployment accepts it for exactly that account. Anything else leaves the
// context as it was, deletes the saved file and returns false.
export async function restoreSavedSession({ context, request, account, role, origin, dir, validate, getuid }) {
    const file = sessionFile(dir, { origin, role, account });
    const cookies = readSavedCookies(file, origin, getuid);
    if (!cookies) return false;
    await context.addCookies(cookies);
    let accepted = false;
    try {
        const user = await authenticatedUser(request);
        accepted = Boolean(user) && validate(user, account);
    } catch {
        accepted = false;
    }
    if (accepted) return true;
    for (const cookie of cookies) {
        await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path }).catch(() => {});
    }
    discardSavedSession(file);
    return false;
}

export async function saveSession({ context, account, role, origin, dir, getuid }) {
    const cookies = await context.cookies(origin);
    if (!cookies.length) return false;
    writeSavedCookies(dir, sessionFile(dir, { origin, role, account }), { origin, role, cookies }, { getuid });
    return true;
}

// Wraps one sign-in: restore a validated saved session first, otherwise run
// the real sign-in and save the resulting session for the next caller.
// `verifyPrincipal(principal, account)` must prove the signed-in principal is
// the configured account before anything is saved.
export async function signInWithSessionReuse(page, account, run, {
    config,
    env = process.env,
    dir,
    validate,
    verifyPrincipal,
    reuseSession = true,
    getuid,
}) {
    const role = accountRole(account, config);
    const context = typeof page?.context === 'function' ? page.context() : null;
    if (!sessionReuseEnabled(env) || reuseSession === false || !role || !context || !page.request) return run();
    const origin = new URL(config.baseURL).origin;
    // A misconfigured store fails here, before any password sign-in is spent.
    const directory = prepareSessionStore(env, { dir, getuid });
    const existing = await authenticatedUser(page.request);
    const restored = existing ? false : await restoreSavedSession({ context, request: page.request, account, role, origin, dir: directory, validate, getuid });
    const principal = await run();
    if (!restored && verifyPrincipal(principal, account)) {
        await saveSession({ context, account, role, origin, dir: directory, getuid });
    }
    return principal;
}

// Declares that the spec file deliberately signs in or out for real, or needs
// browser contexts with independent sessions. Playwright runs every spec file
// in one worker, so the setting is scoped with hooks instead of a module flag.
let realSignInDepth = 0;
export function realSignInRequired() { return realSignInDepth > 0; }
export function requireRealSignIns(test) {
    test.beforeAll(() => { realSignInDepth += 1; });
    test.afterAll(() => { realSignInDepth -= 1; });
}
