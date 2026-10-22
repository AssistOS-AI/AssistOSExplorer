import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getStore, flush, resetStoreForTests, commitStagedPersistence } from '../lib/store.mjs';
import { createUser, updateUser } from '../lib/users.mjs';
import { hashSecret } from '../lib/auth/password.mjs';
import { stagePasswordCredential } from '../lib/auth/userPassword.mjs';
import * as totp from '../lib/auth/totp.mjs';
import * as roles from '../lib/roles.mjs';
import { GOOGLE_ISSUER, googleIdentityKey } from '../lib/externalIdentities.mjs';
import { runTool, hasTool } from '../tools/registry.mjs';
import { ensureExplorerSeedData } from './helpers/product-permissions.mjs';

// The readiness tool decides whether retiring a sign-in origin may strand an
// account. Every case isolates one cause: the other methods stay available so a
// result cannot come from an unrelated unavailable method.
const ORIGIN = 'https://bizanso.com';
const CALLBACK_PATH = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/google/callback';
const BIZANSO_CALLBACK = `${ORIGIN}${CALLBACK_PATH}`;
const SKILLS_CALLBACK = `https://skills.axiologic.dev${CALLBACK_PATH}`;
const CLIENT_ID = 'readiness-fixture-client.apps.googleusercontent.com';
const SETTINGS_KEY = 'readiness-fixture-settings-key';
const ALL_METHODS = 'password,emailCode,passkey,totp,google';
const ENV_NAMES = ['PERSISTENCE_FOLDER', 'USERPERSISTO_SETTINGS_KEY', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_DEV_BOOTSTRAP',
    'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_REDIRECT_URI'];
const OUTPUT_KEYS = ['activeUsers', 'atRisk', 'atRiskUserIds', 'emailDeliveryAvailable', 'origin', 'passkeyUsers'];

const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
let folder = '';

async function fixture({ methods = ALL_METHODS, emailDelivery = true, googleRedirect = BIZANSO_CALLBACK } = {}) {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-signin-readiness-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = SETTINGS_KEY;
    process.env.USERPERSISTO_AUTH_METHODS = methods;
    if (emailDelivery) process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
    else delete process.env.USERPERSISTO_DEV_BOOTSTRAP;
    if (googleRedirect) {
        process.env.USERPERSISTO_GOOGLE_CLIENT_ID = CLIENT_ID;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = googleRedirect;
    } else {
        delete process.env.USERPERSISTO_GOOGLE_CLIENT_ID;
        delete process.env.USERPERSISTO_GOOGLE_REDIRECT_URI;
    }
    await ensureExplorerSeedData();
    const admin = await createUser({ email: 'readiness-admin@example.test', roles: ['admin'] });
    await setPassword(admin.id, 'readiness administrator password');
    return { admin, context: { actorUserId: admin.id, actorRoles: ['admin'] } };
}

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = '';
});

async function setPassword(userId, secret) {
    const verifier = await hashSecret(secret);
    await commitStagedPersistence(async () => stagePasswordCredential(await getStore(), { userId, verifier }));
}

async function addMethod(userId, type, { suffix = '', enabled = true, credential = {} } = {}) {
    const key = type === 'passkey' ? `${userId}:passkey:${suffix || 'fixture-credential'}` : `${userId}:${type}`;
    await (await getStore()).createAuthMethod({ key, userId, type, enabled, credential });
    await flush();
}

async function bindGoogle(userId, subject) {
    const now = new Date().toISOString();
    await (await getStore()).createExternalIdentity({ identityKey: googleIdentityKey({ issuer: GOOGLE_ISSUER, subject }),
        issuer: GOOGLE_ISSUER, subject, userId, createdAt: now, lastUsedAt: now });
    await flush();
}

async function enrollTotp(userId) {
    const started = await totp.setupStart({ userId, generation: 0 });
    const verified = await totp.setupVerify({ userId, token: totp.generateToken(started.secret), setupId: started.setupId });
    assert.equal(verified.ok, true);
}

function readiness(context, origin = ORIGIN) {
    return runTool('userpersisto_signin_readiness', { origin }, context);
}

async function persistedDigest() {
    await flush();
    const hash = createHash('sha256');
    const walk = async (dir) => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) await walk(path);
            else hash.update(path).update(await readFile(path));
        }
    };
    await walk(folder);
    return hash.digest('hex');
}

test('the readiness tool is registered as an admin-only MCP tool', async () => {
    assert.equal(hasTool('userpersisto_signin_readiness'), true);
    const config = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    const tool = config.tools.find((entry) => entry.name === 'userpersisto_signin_readiness');
    assert.ok(tool, 'mcp-config declares userpersisto_signin_readiness');
    assert.deepEqual(tool.tags, ['admin']);
    assert.deepEqual(tool.env, { TOOL_NAME: 'userpersisto_signin_readiness' });
    assert.deepEqual(tool.inputSchema.required, ['origin']);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['origin']);
    assert.equal(tool.inputSchema.additionalProperties, false);
});

test('accounts without a usable non-passkey method on the origin are at risk', async () => {
    const { context } = await fixture();
    const make = (email, extra = {}) => createUser({ email, roles: ['user'], ...extra });

    const passkeyOnly = await make('passkey-only@example.test');
    await addMethod(passkeyOnly.id, 'passkey');
    const disabledPassword = await make('disabled-password@example.test');
    await setPassword(disabledPassword.id, 'a password that is later disabled');
    const store = await getStore();
    const record = await store.getAuthMethodByKey(`${disabledPassword.id}:password`);
    await store.updateAuthMethod(record.id, { enabled: false });
    await flush();
    // Enabled but not decryptable under its owner's context: reset and login refuse it.
    const undecryptablePassword = await make('undecryptable-password@example.test');
    await addMethod(undecryptablePassword.id, 'password', { credential: { hashEncrypted: 'v1.AAAA.AAAA.AAAA', version: 'x', setAt: '' } });
    // emailCode is enabled and delivery is available, but the mailbox is unverified.
    const unverifiedMailbox = await make('unverified-mailbox@example.test');
    const disabledTotp = await make('disabled-totp@example.test');
    await addMethod(disabledTotp.id, 'totp', { enabled: false, credential: { secretEncrypted: 'unused' } });

    const usablePassword = await make('usable-password@example.test');
    await setPassword(usablePassword.id, 'a usable account password');
    const enrolledTotp = await make('enrolled-totp@example.test');
    await enrollTotp(enrolledTotp.id);
    const verifiedMailbox = await make('verified-mailbox@example.test', { emailVerified: true });
    // A Google-only account whose configured callback origin equals the readiness origin.
    const googleMatching = await make('google-matching@example.test');
    await bindGoogle(googleMatching.id, 'google-matching-subject');
    // Blocked accounts are not active and are excluded entirely.
    const blocked = await make('blocked-passkey@example.test');
    await addMethod(blocked.id, 'passkey');
    await updateUser(blocked.id, { status: 'blocked' }, { actorId: 'test' });

    const result = await readiness(context);
    assert.deepEqual(Object.keys(result).sort(), OUTPUT_KEYS);
    assert.equal(result.origin, ORIGIN);
    assert.equal(result.emailDeliveryAvailable, true);
    assert.deepEqual(result.atRiskUserIds, [passkeyOnly.id, disabledPassword.id, undecryptablePassword.id, unverifiedMailbox.id, disabledTotp.id].sort());
    assert.equal(result.atRisk, 5);
    // Administrator, five at risk and four with a usable method; the blocked account is excluded.
    assert.equal(result.activeUsers, 10);
    assert.equal(result.passkeyUsers, 1);
    for (const user of [usablePassword, enrolledTotp, verifiedMailbox, googleMatching, blocked]) {
        assert.equal(result.atRiskUserIds.includes(user.id), false, user.email);
    }
});

test('Google qualifies only when available and its configured callback origin is the readiness origin', async (t) => {
    const scenarios = [
        { name: 'matching callback origin', redirect: BIZANSO_CALLBACK, methods: ALL_METHODS, atRisk: false },
        { name: 'skills callback origin', redirect: SKILLS_CALLBACK, methods: ALL_METHODS, atRisk: true },
        { name: 'local default callback origin', redirect: '', methods: ALL_METHODS, atRisk: true },
        { name: 'Google disabled by policy', redirect: BIZANSO_CALLBACK, methods: 'password,emailCode,passkey,totp', atRisk: true },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
            try {
                const { context } = await fixture({ googleRedirect: scenario.redirect, methods: scenario.methods });
                const bound = await createUser({ email: 'google-only@example.test', roles: ['user'] });
                await bindGoogle(bound.id, 'google-only-subject');
                const result = await readiness(context);
                assert.equal(result.atRiskUserIds.includes(bound.id), scenario.atRisk);
                assert.equal(result.atRisk, scenario.atRisk ? 1 : 0);
                // The same binding is never usable for a different readiness origin.
                if (!scenario.atRisk) assert.deepEqual((await readiness(context, 'https://skills.axiologic.dev')).atRiskUserIds, [bound.id]);
            } finally {
                await resetStoreForTests().catch(() => {});
                await rm(folder, { recursive: true, force: true });
            }
        });
    }
});

test('a Google binding is required even when Google is available', async () => {
    const { context } = await fixture();
    const unbound = await createUser({ email: 'no-binding@example.test', roles: ['user'] });
    const foreign = await createUser({ email: 'foreign-binding@example.test', roles: ['user'] });
    // A binding owned by another account does not qualify this one.
    await bindGoogle(foreign.id, 'foreign-subject');
    const store = await getStore();
    const binding = (await store.getExternalIdentitiesObjectsByUserId(foreign.id))[0];
    await store.updateExternalIdentity(binding.id, { subject: 'tampered-subject' });
    await flush();
    const result = await readiness(context);
    assert.deepEqual(result.atRiskUserIds, [unbound.id, foreign.id].sort());
});

test('method policy and email delivery decide whether a credential counts', async (t) => {
    await t.test('password disabled by policy', async () => {
        try {
            const { admin, context } = await fixture({ methods: 'emailCode,passkey,totp,google' });
            const result = await readiness(context);
            // The administrator holds only a usable password, which the policy disables.
            assert.deepEqual(result.atRiskUserIds, [admin.id]);
        } finally {
            await resetStoreForTests().catch(() => {});
            await rm(folder, { recursive: true, force: true });
        }
    });
    await t.test('TOTP disabled by policy', async () => {
        try {
            const { context } = await fixture({ methods: 'password,emailCode,passkey,google' });
            const user = await createUser({ email: 'totp-policy@example.test', roles: ['user'] });
            await enrollTotp(user.id);
            assert.deepEqual((await readiness(context)).atRiskUserIds, [user.id]);
        } finally {
            await resetStoreForTests().catch(() => {});
            await rm(folder, { recursive: true, force: true });
        }
    });
    await t.test('verified mailbox without email delivery', async () => {
        try {
            const { context } = await fixture({ emailDelivery: false });
            const user = await createUser({ email: 'mailbox-no-delivery@example.test', roles: ['user'], emailVerified: true });
            const result = await readiness(context);
            assert.equal(result.emailDeliveryAvailable, false);
            assert.deepEqual(result.atRiskUserIds, [user.id]);
        } finally {
            await resetStoreForTests().catch(() => {});
            await rm(folder, { recursive: true, force: true });
        }
    });
    await t.test('verified mailbox with emailCode disabled by policy', async () => {
        try {
            const { context } = await fixture({ methods: 'password,passkey,totp,google' });
            const user = await createUser({ email: 'mailbox-no-method@example.test', roles: ['user'], emailVerified: true });
            assert.deepEqual((await readiness(context)).atRiskUserIds, [user.id]);
        } finally {
            await resetStoreForTests().catch(() => {});
            await rm(folder, { recursive: true, force: true });
        }
    });
});

test('every page of active users is inspected', async () => {
    const { context } = await fixture();
    for (let index = 0; index < 120; index += 1) {
        const user = await createUser({ email: `filler-${index}@example.test`, roles: ['user'] });
        await addMethod(user.id, 'totp', { credential: { secretEncrypted: 'unused' } });
    }
    const late = await createUser({ email: 'late-passkey-only@example.test', roles: ['user'] });
    await addMethod(late.id, 'passkey');
    const result = await readiness(context);
    assert.equal(result.activeUsers, 122);
    assert.deepEqual(result.atRiskUserIds, [late.id]);
});

test('non-administrators and unauthenticated callers are refused', async () => {
    const { context } = await fixture();
    const member = await createUser({ email: 'readiness-member@example.test', roles: ['user'] });
    await assert.rejects(readiness({ actorUserId: member.id, actorRoles: ['admin'] }),
        (error) => error.code === 'admin_required' && error.statusCode === 403);
    await assert.rejects(readiness({}), (error) => error.code === 'authentication_required' && error.statusCode === 401);
    // Each administrator capability alone is insufficient.
    for (const capability of ['admin.users.manage', 'admin.agentSettings.manage']) {
        const roleName = `readiness-${capability.split('.')[1].toLowerCase()}`;
        await roles.createRole({ name: roleName, capabilities: [capability] }, { actorId: context.actorUserId });
        const partial = await createUser({ email: `${roleName}@example.test`, roles: [roleName] });
        await assert.rejects(readiness({ actorUserId: partial.id, actorRoles: ['admin'] }),
            (error) => error.code === 'admin_required' && error.statusCode === 403, capability);
    }
    // A blocked administrator is refused; another active administrator keeps the installation administrable.
    await createUser({ email: 'readiness-second-admin@example.test', roles: ['admin'] });
    await updateUser(context.actorUserId, { status: 'blocked' }, { actorId: 'test' });
    await assert.rejects(readiness(context), (error) => error.code === 'invalid_session' && error.statusCode === 401);
});

test('the origin must be an exact HTTP(S) origin', async () => {
    const { context } = await fixture();
    for (const origin of [undefined, '', 'bizanso.com', 'https://bizanso.com/', 'https://bizanso.com/explorer', 'https://bizanso.com?x=1',
        'https://user@bizanso.com', 'ftp://bizanso.com', 'HTTPS://BIZANSO.COM', 'x'.repeat(3000)]) {
        await assert.rejects(runTool('userpersisto_signin_readiness', origin === undefined ? {} : { origin }, context),
            (error) => error.code === 'invalid_origin' && error.statusCode === 400, String(origin).slice(0, 40));
    }
    assert.equal((await readiness(context, 'http://localhost:8080')).origin, 'http://localhost:8080');
});

test('readiness is read-only and returns no secret or identifying fields', async () => {
    const { admin, context } = await fixture();
    const google = await createUser({ email: 'secret-scan-google@example.test', roles: ['user'] });
    await bindGoogle(google.id, 'secret-scan-subject');
    const passkeyOnly = await createUser({ email: 'secret-scan-passkey@example.test', roles: ['user'], emailVerified: false });
    await addMethod(passkeyOnly.id, 'passkey', { suffix: 'secret-scan-credential' });
    const store = await getStore();
    const counts = async () => Object.fromEntries(await Promise.all(['auditEvent', 'authMethod', 'externalIdentity', 'user', 'authChallenge', 'systemSetting']
        .map(async (type) => [type, (await store.select(type, {}, { start: 0, pageSize: 1000 })).objects.length])));
    const beforeCounts = await counts();
    const beforeDigest = await persistedDigest();

    const result = await readiness(context);

    assert.deepEqual(await counts(), beforeCounts);
    assert.equal(await persistedDigest(), beforeDigest);
    assert.deepEqual(Object.keys(result).sort(), OUTPUT_KEYS);
    const serialized = JSON.stringify(result);
    for (const forbidden of [admin.email, google.email, passkeyOnly.email, 'secret-scan-subject', 'secret-scan-credential', CLIENT_ID, SETTINGS_KEY,
        BIZANSO_CALLBACK, 'hashEncrypted', 'secretEncrypted', 'credential', 'password', 'redirect']) {
        assert.equal(serialized.includes(forbidden), false, `output contains ${forbidden}`);
    }
    assert.deepEqual(result.atRiskUserIds, [passkeyOnly.id]);
});
