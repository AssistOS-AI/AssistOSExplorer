import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-password-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'password-test-settings-key';
delete process.env.USERPERSISTO_AUTH_METHODS;

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser, getUserById, updateUser } = await import('../lib/users.mjs');
const { getStore, commitStagedPersistence, resetStoreForTests } = await import('../lib/store.mjs');
const { serializePersisted } = await import('../lib/serial.mjs');
const { withPersistenceScope } = await import('../lib/persistence-scope.mjs');
const { updateAuthPolicy, usableSignInMethods } = await import('../lib/policy.mjs');
const password = await import('../lib/auth/password.mjs');
const userPassword = await import('../lib/auth/userPassword.mjs');
const { throttleKey } = await import('../lib/auth/throttle.mjs');
const { stageCredentialGenerationAdvance } = await import('../lib/auth/generation.mjs');
const { setAccountPassword } = await import('../lib/auth/passwordManagement.mjs');
const { completeReauthentication } = await import('../lib/auth/operationGrants.mjs');
const setup = await import('./helpers/setup.mjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));
let kdfRuns = 0;

async function freshStore() {
    await resetStoreForTests();
    process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-password-'));
    await ensureSeedData();
}

beforeEach(async () => {
    delete process.env.USERPERSISTO_AUTH_METHODS;
    setup.resetAuthLimitsForTests();
    kdfRuns = 0;
    password.setKdfObserverForTests(() => { kdfRuns += 1; });
    await freshStore();
});

afterEach(() => password.resetKdfForTests());
after(async () => { await resetStoreForTests(); });

function outcome(promise) {
    return promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, code: error.code, retryAfter: error.retryAfter, reason: error.reason }));
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

// Installs a verifier directly, for presentation rules that must not depend
// on the creation policy of the day.
async function setVerifier(userId, secret) {
    const verifier = await password.hashSecret(secret.normalize('NFKC'));
    await serializePersisted('users', async () => commitStagedPersistence(async () => {
        await userPassword.stagePasswordCredential(await getStore(), { userId, verifier });
    }));
}

async function throttleCount(email) {
    const record = await (await getStore()).getAuthThrottleByThrottleKey(throttleKey('userpersisto:throttle:password-login', email));
    return record?.count || 0;
}

const login = (email, secret, extra = {}) => userPassword.loginWithUserPassword({ email, password: secret, ...extra });

test('the vetted scrypt profile is the only stored format and runs asynchronously', async () => {
    password.resetKdfForTests();
    assert.deepEqual(password.SUPPORTED_KDF_PROFILE, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    let ticked = false;
    const hashing = password.hashSecret('a production profile secret');
    setImmediate(() => { ticked = true; });
    const verifier = await hashing;
    assert.equal(ticked, true, 'the event loop keeps running while hashing');
    assert.match(verifier, /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
    assert.equal(await password.verifySecret('a production profile secret', verifier), true);
    assert.equal(await password.verifySecret('another secret', verifier), false);
    const [, , , , salt, hash] = verifier.split('$');
    for (const unsupported of [
        verifier.replace('$32768$', '$16384$'),
        verifier.replace('$8$3$', '$8$1$'),
        `scrypt$32768$8$3$${salt.slice(1)}$${hash}`,
        `scrypt$32768$8$3$${salt}$${hash.slice(2)}`,
        `pbkdf2$32768$8$3$${salt}$${hash}`,
        `scrypt$032768$8$3$${salt}$${hash}`,
        '', null, 42,
    ]) {
        assert.equal(password.parseVerifier(unsupported), null, String(unsupported).slice(0, 40));
        assert.equal(await password.verifySecret('a production profile secret', unsupported), false);
    }
});

test('an unsupported verifier still costs exactly one evaluation', async () => {
    const before = kdfRuns;
    assert.equal(await password.verifySecret('secret', 'scrypt$1$1$1$AAAA$AAAA'), false);
    assert.equal(await password.verifySecret('secret', undefined), false);
    assert.equal(kdfRuns - before, 2);
});

test('the KDF gate runs two evaluations, queues sixteen and refuses more at once', async (t) => {
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    let started = 0;
    password.setKdfObserverForTests(async () => { started += 1; await hold; });
    const queued = Array.from({ length: 18 }, (_, index) => password.hashSecret(`queued secret ${index}`));
    await settle();
    assert.equal(started, 2);
    await assert.rejects(password.hashSecret('one too many'), { code: 'rate_limited', statusCode: 429, retryAfter: 5 });
    release();
    assert.equal((await Promise.all(queued)).length, 18);
    assert.equal(started, 18);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    let releaseAgain;
    const holdAgain = new Promise((resolve) => { releaseAgain = resolve; });
    password.setKdfObserverForTests(async () => holdAgain);
    const running = [password.hashSecret('slot one'), password.hashSecret('slot two')];
    const waiting = outcome(password.hashSecret('waits too long'));
    await settle();
    t.mock.timers.tick(5_000);
    assert.deepEqual(await waiting, { ok: false, code: 'rate_limited', retryAfter: 5, reason: undefined });
    releaseAgain();
    await Promise.all(running);
});

test('new passwords follow the code point rules after NFKC with a bounded raw input and no truncation', () => {
    const valid = (value, email = '') => userPassword.validateNewPassword({ password: value, passwordConfirmation: value, email }).normalized;
    const refused = (value, reason, email = '') => assert.throws(() => valid(value, email), (error) => error.code === 'invalid_password' && error.reason === reason, `${reason}: ${value.slice(0, 20)}`);
    const emoji = Array.from({ length: 128 }, (_, index) => String.fromCodePoint(0x1f600 + (index % 64), 0x1f400 + (index % 50)).slice(0, 2)).join('');
    const supplementary = [...emoji].slice(0, 120).join('');
    assert.equal(supplementary.length > 128, true, 'more than 128 UTF-16 code units');
    assert.equal(valid(supplementary), supplementary, '120 supplementary code points are valid');
    refused([...emoji].slice(0, 100).join('') + 'abcdefghijklmnopqrstuvwxyz0123', 'too_long');
    // Normalization can lengthen or shorten a password before it is measured.
    assert.equal(valid('ﬁ'.repeat(7) + 'x'), 'fi'.repeat(7) + 'x');
    refused('áéíóú'.repeat(2) + 'ybcd', 'too_short');
    refused('ﷺ'.repeat(8), 'too_long');
    refused('', 'too_short');
    refused('fourteen chars', 'too_short');
    refused('x'.repeat(1025), 'too_long');
    refused(`${'long enough password '.repeat(60)}`.slice(0, 1025), 'too_long');
    refused('fifteen characters\ud800', 'invalid_characters');
    refused('fifteen characters', 'invalid_characters');
    refused('owner@example.test', 'equals_email', 'Owner@Example.test');
    refused('zzzzzzzzzzzzzzzzzz', 'too_common');
    refused('PasswordPassword', 'too_common');
    assert.throws(() => userPassword.validateNewPassword({ password: 'correct horse battery', passwordConfirmation: 'correct horse batterx' }), { code: 'password_mismatch' });
    assert.throws(() => userPassword.validateNewPassword({ password: 'correct horse battery', passwordConfirmation: undefined }), { code: 'password_mismatch' });
    assert.equal(userPassword.validateNewPassword({ password: 'ﬁrst long password', passwordConfirmation: 'first long password' }).normalized, 'first long password');
    assert.equal(valid('a password with spaces and ünïcödé ✓'), 'a password with spaces and ünïcödé ✓');
});

test('login accepts a short or over-policy password that matches and applies only presentation bounds', async () => {
    await setup.signUpWithPassword('owner@example.test');
    const short = await createUser({ email: 'short@example.test', roles: ['user'], emailVerified: true });
    const long = await createUser({ email: 'long@example.test', roles: ['user'], emailVerified: true });
    await setVerifier(short.id, 'tiny');
    const longSecret = 'l'.repeat(300);
    await setVerifier(long.id, longSecret);
    assert.equal((await login('short@example.test', 'tiny')).user.id, short.id, 'no minimum length at login');
    assert.equal((await login('long@example.test', longSecret)).user.id, long.id, 'no creation maximum at login');
    kdfRuns = 0;
    for (const candidate of ['x'.repeat(1025), 'ﷺ'.repeat(300), '', null, 42]) {
        assert.equal((await outcome(login('short@example.test', candidate))).code, 'authentication_failed');
    }
    assert.equal(kdfRuns, 0, 'transport, byte and type bounds refuse without a KDF');
    assert.equal(await throttleCount('short@example.test'), 0, 'and without spending the failure budget');
});

test('R10: an unpaired surrogate never matches a password containing U+FFFD and costs neither KDF nor budget', async () => {
    await setup.signUpWithPassword('owner@example.test');
    const genuine = 'replacement � character pass';
    const signed = await setup.signUpWithPassword('fffd@example.test', { password: genuine });
    const malformed = 'replacement \ud800 character pass';
    assert.equal(Buffer.from(malformed).equals(Buffer.from(genuine)), true, 'Node encodes both to the same UTF-8 bytes');
    kdfRuns = 0;
    assert.deepEqual(await outcome(login('fffd@example.test', malformed)), { ok: false, code: 'authentication_failed', retryAfter: undefined, reason: undefined });
    assert.equal(kdfRuns, 0);
    assert.equal(await throttleCount('fffd@example.test'), 0);
    assert.equal((await login('fffd@example.test', genuine)).user.id, signed.user.id);
    assert.equal(kdfRuns, 1);
    assert.throws(() => userPassword.normalizeSecret(malformed), { code: 'invalid_password', reason: 'invalid_characters' });
});

test('wrong, unknown, blocked and password-less accounts fail identically after one KDF', async () => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const member = await setup.signUpWithPassword('member@example.test');
    await createUser({ email: 'no-password@example.test', roles: ['user'], emailVerified: true });
    await updateUser(member.user.id, { status: 'blocked' });
    for (const [email, candidate] of [['owner@example.test', 'not the owner password'], ['unknown@example.test', owner.password],
        ['member@example.test', member.password], ['no-password@example.test', owner.password]]) {
        kdfRuns = 0;
        assert.deepEqual(await outcome(login(email, candidate)), { ok: false, code: 'authentication_failed', retryAfter: undefined, reason: undefined }, email);
        assert.equal(kdfRuns, 1, email);
    }
    const signedIn = await login('OWNER@example.test', owner.password, { parent: { flow: 'sso' } });
    assert.equal(signedIn.user.id, owner.user.id);
    assert.equal(Object.hasOwn(signedIn.user, 'passwordHash'), false);
    const audit = (await (await getStore()).select('auditEvent', {}, { start: 0, pageSize: 500 })).objects.filter((event) => event.action === 'auth.password.login');
    assert.deepEqual(audit.filter((event) => event.result === 'ok').map((event) => [event.actorId, event.reason]), [[owner.user.id, 'sso']]);
    const denied = audit.filter((event) => event.result === 'denied');
    assert.deepEqual(denied.map((event) => event.reason).sort(), ['invalid_credentials', 'invalid_credentials', 'invalid_credentials']);
    assert.equal(denied.some((event) => event.actorId === 'anonymous' || event.target.includes('@')), false, 'unknown addresses are never persisted');
    assert.equal((await getUserById(member.user.id)).loginAttempts, 0, 'password failures never touch TOTP lockout counters');
});

test('R3: a burst never obtains more KDF evaluations than the failure limit, even for the correct password afterwards', async () => {
    await setup.signUpWithPassword('owner@example.test');
    const target = await setup.signUpWithPassword('burst@example.test');
    kdfRuns = 0;
    let refusedWithoutKdf = 0;
    for (let round = 0; round < 6; round += 1) {
        const before = kdfRuns;
        const results = await Promise.all(Array.from({ length: 12 }, (_, index) => outcome(login('burst@example.test', `wrong guess ${round} ${index}`))));
        assert.ok(kdfRuns <= 10, `at most ten evaluations (round ${round}: ${kdfRuns})`);
        assert.ok(kdfRuns - before <= 4, 'at most four waiters per address are admitted');
        refusedWithoutKdf += results.filter((result) => result.code === 'rate_limited').length;
        assert.equal(results.filter((result) => result.ok).length, 0);
    }
    assert.equal(kdfRuns, 10);
    assert.equal(await throttleCount('burst@example.test'), 10);
    assert.ok(refusedWithoutKdf >= 62);
    const correct = await outcome(login('burst@example.test', target.password));
    assert.equal(correct.code, 'rate_limited');
    assert.ok(correct.retryAfter > 0 && correct.retryAfter <= 900);
    assert.equal(kdfRuns, 10, 'no evaluation after exhaustion');
});

test('an address without an account has the same in-memory limit and nothing is persisted for it', async () => {
    await setup.signUpWithPassword('owner@example.test');
    kdfRuns = 0;
    const results = [];
    for (let index = 0; index < 12; index += 1) results.push(await outcome(login('ghost@example.test', `guess number ${index}`)));
    assert.deepEqual(results.map((result) => result.code), [...Array(10).fill('authentication_failed'), 'rate_limited', 'rate_limited']);
    assert.equal(kdfRuns, 10);
    assert.equal((await (await getStore()).select('authThrottle')).objects.length, 0);
});

test('the durable failure budget survives a restart and clears on success', async () => {
    await setup.signUpWithPassword('owner@example.test');
    const member = await setup.signUpWithPassword('durable@example.test');
    for (let index = 0; index < 3; index += 1) await outcome(login('durable@example.test', `wrong ${index}`));
    assert.equal(await throttleCount('durable@example.test'), 3);
    await resetStoreForTests();
    setup.resetAuthLimitsForTests();
    assert.equal(await throttleCount('durable@example.test'), 3);
    assert.equal((await login('durable@example.test', member.password)).user.id, member.user.id);
    assert.equal(await throttleCount('durable@example.test'), 0);
});

test('a trusted rate source is limited to twenty attempts before any KDF', async () => {
    await setup.signUpWithPassword('owner@example.test');
    const member = await setup.signUpWithPassword('source@example.test');
    const rateSource = 'a'.repeat(64);
    for (let index = 0; index < 20; index += 1) {
        const result = await outcome(login(index % 2 ? 'source@example.test' : 'someone@example.test', index % 2 ? member.password : 'wrong one here', { rateSource }));
        assert.notEqual(result.code, 'rate_limited');
    }
    kdfRuns = 0;
    assert.equal((await outcome(login('source@example.test', member.password, { rateSource }))).code, 'rate_limited');
    assert.equal(kdfRuns, 0);
    assert.equal((await login('source@example.test', member.password, { rateSource: 'b'.repeat(64) })).user.id, member.user.id);
});

test('policy, parent and credential state are rechecked inside the lock around the KDF', async () => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const member = await setup.signUpWithPassword('member@example.test');
    await updateAuthPolicy({ enabledAuthMethods: ['emailCode', 'google'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    kdfRuns = 0;
    assert.equal((await outcome(login('member@example.test', member.password))).code, 'auth_method_disabled');
    assert.equal(kdfRuns, 0);
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });

    // A queued request whose parent expired while it waited never reaches the KDF.
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    password.setKdfObserverForTests(async () => { kdfRuns += 1; await hold; });
    kdfRuns = 0;
    const first = outcome(login('member@example.test', 'first wrong guess'));
    await settle();
    let parentAlive = true;
    const second = outcome(login('member@example.test', member.password, {
        validateParent: async () => { if (!parentAlive) throw Object.assign(new Error('expired'), { code: 'login_request_expired', statusCode: 400 }); },
    }));
    await settle();
    parentAlive = false;
    release();
    assert.equal((await first).code, 'authentication_failed');
    assert.equal((await second).code, 'login_request_expired');
    assert.equal(kdfRuns, 1);

    // A generation or credential change during the KDF refuses a matching password.
    for (const change of ['generation', 'credential']) {
        let entered;
        const reached = new Promise((resolve) => { entered = resolve; });
        let unblock;
        const blocked = new Promise((resolve) => { unblock = resolve; });
        password.setKdfObserverForTests(async ({ purpose }) => { if (purpose === 'verify') { entered(); await blocked; } });
        const pending = outcome(login('member@example.test', member.password));
        await reached;
        if (change === 'generation') {
            await serializePersisted('users', () => commitStagedPersistence(() => stageCredentialGenerationAdvance(member.user.id)));
        } else {
            password.setKdfObserverForTests(null);
            await setVerifier(member.user.id, member.password);
        }
        unblock();
        assert.equal((await pending).code, 'authentication_failed', change);
        password.setKdfObserverForTests(null);
        assert.equal((await login('member@example.test', member.password)).user.id, member.user.id, `${change}: the next attempt reads the new state`);
    }
});

test('the KDF runs outside the persistence scope and the users lock', async () => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    let entered;
    const reached = new Promise((resolve) => { entered = resolve; });
    let release;
    const hold = new Promise((resolve) => { release = resolve; });
    password.setKdfObserverForTests(async () => { entered(); await hold; });
    const pending = login('owner@example.test', owner.password);
    await reached;
    const probe = await Promise.race([
        (async () => {
            await withPersistenceScope(async () => (await getStore()).select('user'));
            await serializePersisted('users', async () => true);
            return 'available';
        })(),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 2_000)),
    ]);
    release();
    assert.equal(probe, 'available');
    assert.equal((await pending).user.id, owner.user.id);
});

test('policy and parent changes during password hashing refuse completion without recording success', async () => {
    const owner = await setup.signUpWithPassword('completion-owner@example.test');
    const member = await setup.signUpWithPassword('completion-member@example.test');
    await assert.rejects(login(member.user.email, 'a deliberately wrong password'), { code: 'authentication_failed' });
    for (const change of ['policy', 'parent']) {
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        let parentAlive = true;
        password.setKdfObserverForTests(async ({ purpose }) => {
            if (purpose === 'verify') { entered.resolve(); await release.promise; }
        });
        const pending = outcome(login(member.user.email, member.password, { validateParent: async () => {
            if (!parentAlive) throw Object.assign(new Error('Expired request.'), { code: 'login_request_expired', statusCode: 400 });
        } }));
        await entered.promise;
        if (change === 'policy') {
            await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
        } else parentAlive = false;
        release.resolve();
        assert.equal((await pending).code, change === 'policy' ? 'auth_method_disabled' : 'login_request_expired');
        assert.equal(await throttleCount(member.user.email), 1, 'an invalidated request neither clears nor spends the guessing budget');
        const audit = await (await getStore()).select('auditEvent', { action: 'auth.password.login', target: member.user.id, result: 'ok' });
        assert.equal(audit.objects.length, 0, 'no successful authentication is recorded');
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    }
});

test('global KDF queue admission rechecks expired parents and disabled policy before evaluating a password', async () => {
    const owner = await setup.signUpWithPassword('queued-owner@example.test');
    const member = await setup.signUpWithPassword('queued-member@example.test');
    for (const change of ['parent', 'policy']) {
        const occupied = Promise.withResolvers();
        const release = Promise.withResolvers();
        const parentChecked = Promise.withResolvers();
        let blockers = 0;
        let verifications = 0;
        let parentAlive = true;
        password.setKdfObserverForTests(async ({ purpose }) => {
            if (purpose === 'hash') {
                if (++blockers === 2) occupied.resolve();
                await release.promise;
            } else verifications += 1;
        });
        const running = [password.hashSecret('one occupied KDF slot'), password.hashSecret('another occupied KDF slot')];
        await occupied.promise;
        const pending = outcome(login(member.user.email, member.password, { validateParent: async () => {
            parentChecked.resolve();
            if (!parentAlive) throw Object.assign(new Error('Expired request.'), { code: 'login_request_expired', statusCode: 400 });
        } }));
        await parentChecked.promise;
        await settle();
        if (change === 'parent') parentAlive = false;
        else await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
        release.resolve();
        await Promise.all(running);
        assert.equal((await pending).code, change === 'parent' ? 'login_request_expired' : 'auth_method_disabled');
        assert.equal(verifications, 0, 'a request invalidated while queued never starts scrypt');
        assert.equal(await throttleCount(member.user.email), 0);
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    }
});

test('queued My Account password changes revalidate policy and grant expiry before hashing', async () => {
    const owner = await setup.signUpWithPassword('management-owner@example.test');
    const original = await userPassword.readPasswordCredential(await getStore(), owner.user.id);
    for (const change of ['policy', 'grant-expiry']) {
        password.setKdfObserverForTests(null);
        const proof = await completeReauthentication({ userId: owner.user.id, operation: 'password.set', method: 'password', password: owner.password });
        const occupied = Promise.withResolvers();
        const release = Promise.withResolvers();
        let evaluations = 0;
        password.setKdfObserverForTests(async () => {
            if (++evaluations === 2) occupied.resolve();
            await release.promise;
        });
        const running = [password.hashSecret('first management blocker'), password.hashSecret('second management blocker')];
        await occupied.promise;
        const secret = setup.newTestPassword();
        const pending = outcome(setAccountPassword({ userId: owner.user.id, grant: proof.grant, password: secret, passwordConfirmation: secret }));
        await settle();
        const realNow = Date.now;
        try {
            if (change === 'policy') await updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, {
                actorId: owner.user.id, emailStatus: async () => ({ available: true }),
            });
            else Date.now = () => realNow() + 6 * 60_000;
            release.resolve();
            await Promise.all(running);
            assert.equal((await pending).code, change === 'policy' ? 'auth_method_disabled' : 'operation_grant_required');
            assert.equal(evaluations, 2, 'no invalidated management request reaches its hashing operation');
        } finally {
            Date.now = realNow;
            release.resolve();
            await Promise.all(running);
        }
        assert.equal((await userPassword.readPasswordCredential(await getStore(), owner.user.id)).record.credential.version,
            original.record.credential.version, 'the account password is unchanged');
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: true }) });
    }
});

test('credentials are encrypted, owner-bound and absent from snapshots and logs', async () => {
    const lines = [];
    const originals = ['log', 'warn', 'error', 'info', 'debug'].map((name) => [name, console[name]]);
    for (const [name] of originals) console[name] = (...parts) => { lines.push(parts.map(String).join(' ')); };
    let owner;
    let member;
    try {
        owner = await setup.signUpWithPassword('owner@example.test');
        member = await setup.signUpWithPassword('member@example.test');
        await login('member@example.test', member.password);
        await outcome(login('member@example.test', owner.password));
    } finally {
        for (const [name, original] of originals) console[name] = original;
    }
    const store = await getStore();
    const ownerCredential = await store.getAuthMethodByKey(`${owner.user.id}:password`);
    assert.equal(ownerCredential.type, 'password');
    assert.match(ownerCredential.credential.hashEncrypted, /^v1\./);
    assert.match(ownerCredential.credential.version, /^[a-f0-9]{32}$/);
    const text = snapshotText();
    for (const secret of [owner.password, member.password]) {
        assert.equal(text.includes(secret), false, 'no plaintext in the snapshot');
        assert.equal(lines.some((line) => line.includes(secret)), false, 'no plaintext in logs');
    }
    assert.equal(text.includes('scrypt$'), false, 'the verifier is stored only encrypted');
    // A verifier copied to another account does not decrypt under that owner's context.
    const memberCredential = await store.getAuthMethodByKey(`${member.user.id}:password`);
    await serializePersisted('users', () => commitStagedPersistence(async () => {
        await store.updateAuthMethod(memberCredential.id, { credential: { ...memberCredential.credential, hashEncrypted: ownerCredential.credential.hashEncrypted } });
    }));
    assert.equal((await userPassword.readPasswordCredential(store, member.user.id)).usable, false);
    assert.equal((await userPassword.readPasswordCredential(store, owner.user.id)).usable, true);
    assert.equal((await outcome(login('member@example.test', owner.password))).code, 'authentication_failed');
    assert.equal((await outcome(login('member@example.test', member.password))).code, 'authentication_failed');
    const profileKeys = Object.keys(owner.user);
    assert.equal(profileKeys.some((key) => /password|hash/i.test(key)), false);
});

test('the administrator guard and account proof count an enabled password credential', async () => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const user = await getUserById(owner.user.id);
    assert.deepEqual(await usableSignInMethods(user, { emailAvailable: false }), ['password']);
    assert.deepEqual(await usableSignInMethods(user, { emailAvailable: true }), ['password', 'emailCode']);
    // Password-only administrators satisfy the policy guard without email delivery.
    await updateAuthPolicy({ enabledAuthMethods: ['password'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: false }) });
    await assert.rejects(updateAuthPolicy({ enabledAuthMethods: ['emailCode'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: false }) }),
        { code: 'administrator_auth_method_required' });
    const proof = await userPassword.verifyAccountPassword({ userId: owner.user.id, password: owner.password }, { includeCredentialProof: true });
    assert.equal(proof.credentialKey, `${owner.user.id}:password`);
    const store = await getStore();
    assert.equal(await userPassword.assertPasswordProof(store, { userId: owner.user.id, credentialVersion: proof.credentialVersion, generation: 0 }), true);
    assert.equal(await userPassword.assertPasswordProof(store, { userId: owner.user.id, credentialVersion: proof.credentialVersion, generation: 1 }), false);
    await setVerifier(owner.user.id, owner.password);
    assert.equal(await userPassword.assertPasswordProof(store, { userId: owner.user.id, credentialVersion: proof.credentialVersion, generation: 0 }), false,
        'a rewritten credential rotates its version');
});
