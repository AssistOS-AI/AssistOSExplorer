import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { appendSessionTurn } from '../src/runtime/update-session.mjs';
import { createWebAssistSandbox, ensureSiteAku } from './helpers.mjs';
import { PRINCIPALS, delegatedGrant, guestGrant, toolEnvelope, userGrant, verifiedGrant } from './fixtures/verified-grant.mjs';

// New product modules are imported per subtest so each subtest fails on its own
// at the pre-change revision (A15).
const SESSION_ACCESS = '../src/runtime/sessionAccess.mjs';
const LIST_SITES = '../src/mcp/list-sites.mjs';
const HISTORY = '../src/mcp/get-session-history.mjs';
const SITE_ID = 'demo-site';
const MARKER = 'VICTIM-HISTORY-MARKER-7f3a';

async function accessFor(grant, tool) {
    const { callerAccessFromEnvelope } = await import(SESSION_ACCESS);
    return callerAccessFromEnvelope(toolEnvelope(grant, {}, tool));
}

async function seedSite(t) {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    await ensureSiteAku({ siteId: SITE_ID });
    return sandbox;
}

async function seedSession(sessionId, message = MARKER) {
    await appendSessionTurn({ siteId: SITE_ID, sessionId, userMessage: message, agentResponse: `reply to ${message}` });
}

function ownerPath(sandbox, sessionId, siteId = SITE_ID) {
    return path.join(sandbox.webAssistDataDir, 'sites', siteId, 'session-owners', `${sessionId}.json`);
}

async function seedOwnedSession(sandbox, sessionId, grant, secret = 'A'.repeat(43)) {
    const { createSessionOwner, hashSessionSecret } = await import(SESSION_ACCESS);
    await seedSession(sessionId);
    const access = await accessFor(grant);
    assert.equal(await createSessionOwner({ siteId: SITE_ID, sessionId, access, secretHash: hashSessionSecret(secret) }), true);
    return { access, secret };
}

function missingShape(sessionId) {
    return { siteId: SITE_ID, sessionId, exists: false, sessionKuId: `ku_sess_${sessionId}`, history: [] };
}

test('list-sites denies non-Explorer callers (A1)', async (t) => {
    await seedSite(t);
    const { listSites } = await import(LIST_SITES);
    const callers = {
        guest: await accessFor(await guestGrant()),
        adminRoleGuest: await accessFor(await guestGrant({ roles: ['admin', 'guest'] })),
        selfRegistered: await accessFor(await userGrant(PRINCIPALS.selfRegistered)),
        delegatedAdmin: await accessFor(await delegatedGrant({ user: { id: 'owner-1', roles: ['admin'] } })),
        missingGrant: null,
    };
    assert.equal(callers.delegatedAdmin, null, 'delegated agent calls resolve to no caller');
    assert.equal(callers.adminRoleGuest.admin, false, 'a guest actor never becomes admin');
    for (const [label, access] of Object.entries(callers)) {
        await assert.rejects(listSites({ access }), /Access denied/, label);
    }
});

test('list-sites returns only sites and count to Explorer users and admins (A2)', async (t) => {
    await seedSite(t);
    const { listSites } = await import(LIST_SITES);
    for (const principal of [PRINCIPALS.explorerUser, PRINCIPALS.admin]) {
        const result = await listSites({ access: await accessFor(await userGrant(principal)) });
        assert.deepEqual(Object.keys(result).sort(), ['count', 'sites']);
        assert.deepEqual(result.sites, [SITE_ID]);
        assert.equal(result.count, 1);
    }
});

test('list-sites denies before touching storage (A3)', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    const { listSites } = await import(LIST_SITES);
    const outside = path.join(sandbox.sandboxRoot, 'outside');
    await fs.mkdir(outside);
    await fs.rm(sandbox.webAssistDataDir, { recursive: true });
    await fs.symlink(outside, sandbox.webAssistDataDir);
    const guest = await accessFor(await guestGrant());
    await assert.rejects(listSites({ access: guest }), (error) => {
        assert.match(error.message, /Access denied: Explorer access is required to list webAssist sites\./);
        assert.doesNotMatch(error.message, /symlink|symbolic|\//);
        return true;
    });
});

test('web_cli_history owner binding (A4)', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const ownerGrant = await guestGrant();
    const { access: owner } = await seedOwnedSession(sandbox, 'owned-1', ownerGrant);

    const own = await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-1', access: owner });
    assert.equal(own.exists, true);
    assert.match(JSON.stringify(own.history), new RegExp(MARKER));

    const sameGuestNewGrant = await accessFor(await guestGrant({ guestId: ownerGrant.actor.id.slice('user:guest:'.length) }));
    assert.equal((await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-1', access: sameGuestNewGrant })).exists, true);

    for (const other of [await accessFor(await guestGrant()), await accessFor(await userGrant(PRINCIPALS.explorerUser))]) {
        const result = await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-1', access: other });
        assert.deepEqual(result, missingShape('owned-1'));
        assert.doesNotMatch(JSON.stringify(result), new RegExp(MARKER));
    }

    const admin = await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-1', access: await accessFor(await userGrant(PRINCIPALS.admin)) });
    assert.equal(admin.exists, true);
    assert.match(JSON.stringify(admin.history), new RegExp(MARKER));

    await assert.rejects(getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-1', access: null }), /Access denied: a verified webAssist caller is required\./);
});

test('legacy sessions fail closed (A5)', async (t) => {
    await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    await seedSession('legacy-1');
    for (const other of [await accessFor(await guestGrant()), await accessFor(await userGrant(PRINCIPALS.explorerUser))]) {
        assert.deepEqual(await getSessionHistory({ siteId: SITE_ID, sessionId: 'legacy-1', access: other }), missingShape('legacy-1'));
    }
    const admin = await getSessionHistory({ siteId: SITE_ID, sessionId: 'legacy-1', access: await accessFor(await userGrant(PRINCIPALS.admin)) });
    assert.equal(admin.exists, true);
    assert.match(JSON.stringify(admin.history), new RegExp(MARKER));
});

test('web_cli_history secret continuity across principals (A17 history)', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const { generateSessionSecret } = await import(SESSION_ACCESS);
    const secret = generateSessionSecret();
    await seedOwnedSession(sandbox, 'owned-secret', await guestGrant(), secret);
    const rotatedGuest = await accessFor(await guestGrant());
    const result = await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-secret', sessionSecret: secret, access: rotatedGuest });
    assert.equal(result.exists, true);
    assert.match(JSON.stringify(result.history), new RegExp(MARKER));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('web_cli_history wrong, malformed or absent secret gives the missing-session shape (A18 history)', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const { generateSessionSecret } = await import(SESSION_ACCESS);
    const secret = generateSessionSecret();
    await seedOwnedSession(sandbox, 'owned-wrong', await guestGrant(), secret);
    const other = await accessFor(await guestGrant());
    for (const candidate of [undefined, '', generateSessionSecret(), secret.slice(0, -1), `${secret}x`, 'x'.repeat(5000), 42, { secret }]) {
        const result = await getSessionHistory({ siteId: SITE_ID, sessionId: 'owned-wrong', sessionSecret: candidate, access: other });
        assert.deepEqual(result, missingShape('owned-wrong'));
    }
});

test('owner records are schema 2, private, hash-only, and first-writer-wins', async (t) => {
    const sandbox = await seedSite(t);
    const { createSessionOwner, readSessionOwner, hashSessionSecret, generateSessionSecret } = await import(SESSION_ACCESS);
    const secret = generateSessionSecret();
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hashSessionSecret(secret), createHash('sha256').update(Buffer.from(secret, 'utf8')).digest('hex'));
    const first = await accessFor(await guestGrant());
    const second = await accessFor(await guestGrant());
    const results = await Promise.all([
        createSessionOwner({ siteId: SITE_ID, sessionId: 'race-1', access: first, secretHash: hashSessionSecret(secret) }),
        createSessionOwner({ siteId: SITE_ID, sessionId: 'race-1', access: second, secretHash: hashSessionSecret(secret) }),
    ]);
    assert.deepEqual(results.filter(Boolean).length, 1, 'exactly one concurrent writer wins');
    const winner = results[0] ? first : second;
    const bytes = await fs.readFile(ownerPath(sandbox, 'race-1'), 'utf8');
    const record = JSON.parse(bytes);
    assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'id', 'kind', 'schema', 'secretHash']);
    assert.equal(record.schema, 2);
    assert.equal(record.kind, 'guest');
    assert.equal(record.id, winner.id);
    assert.equal(record.secretHash, hashSessionSecret(secret));
    assert.doesNotMatch(bytes, new RegExp(secret));
    assert.equal((await fs.stat(ownerPath(sandbox, 'race-1'))).mode & 0o777, 0o600);

    assert.equal(await createSessionOwner({ siteId: SITE_ID, sessionId: 'race-1', access: winner, secretHash: hashSessionSecret(secret) }), false);
    assert.equal(await fs.readFile(ownerPath(sandbox, 'race-1'), 'utf8'), bytes, 'replay leaves the record unchanged');
    assert.equal((await readSessionOwner({ siteId: SITE_ID, sessionId: 'race-1' })).id, winner.id);
});

test('history orphan and missing-storage probes create nothing', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const { createSessionOwner, hashSessionSecret } = await import(SESSION_ACCESS);
    const owner = await accessFor(await guestGrant());
    assert.equal(await createSessionOwner({ siteId: SITE_ID, sessionId: 'orphan-1', access: owner, secretHash: hashSessionSecret('B'.repeat(43)) }), true);
    assert.deepEqual(await getSessionHistory({ siteId: SITE_ID, sessionId: 'orphan-1', access: owner }), missingShape('orphan-1'));

    const missingSite = await getSessionHistory({ siteId: 'no-such-site', sessionId: 'any-1', access: owner });
    assert.equal(missingSite.exists, false);
    await assert.rejects(fs.lstat(path.join(sandbox.webAssistDataDir, 'sites', 'no-such-site')), { code: 'ENOENT' });

    await fs.rm(sandbox.webAssistDataDir, { recursive: true });
    const fresh = await getSessionHistory({ siteId: SITE_ID, sessionId: 'any-1', access: owner });
    assert.equal(fresh.exists, false);
    await assert.rejects(fs.lstat(sandbox.webAssistDataDir), { code: 'ENOENT' });
});

test('history rejects invalid session ids before storage', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const owner = await accessFor(await guestGrant());
    for (const sessionId of ['', 'a'.repeat(129), '../x', 'a.b', 'sess-ü', '-x']) {
        await assert.rejects(getSessionHistory({ siteId: SITE_ID, sessionId, access: owner }), (error) => {
            assert.ok(error.webAssistPublic === true, sessionId);
            assert.match(error.message, /requires sessionId|Invalid sessionId\./);
            return true;
        });
    }
    assert.deepEqual(await fs.readdir(path.join(sandbox.webAssistDataDir, 'sites', SITE_ID)).then((names) => names.includes('session-owners')), false);
});

test('malformed or unreadable owner records fail closed', async (t) => {
    const sandbox = await seedSite(t);
    const { getSessionHistory } = await import(HISTORY);
    const { readSessionOwner } = await import(SESSION_ACCESS);
    const guestGrantValue = await guestGrant();
    const guest = await accessFor(guestGrantValue);
    const admin = await accessFor(await userGrant(PRINCIPALS.admin));
    const ownersDir = path.join(sandbox.webAssistDataDir, 'sites', SITE_ID, 'session-owners');
    await fs.mkdir(ownersDir);
    const validRecord = { schema: 2, kind: 'guest', id: guest.id, secretHash: 'a'.repeat(64), createdAt: new Date().toISOString() };
    const cases = {
        'bad-json': '{not json',
        'schema-1': JSON.stringify({ schema: 1, kind: 'guest', id: guest.id, createdAt: validRecord.createdAt }),
        'bad-kind': JSON.stringify({ ...validRecord, kind: 'admin' }),
        'bad-hash': JSON.stringify({ ...validRecord, secretHash: 'zz' }),
        'bad-id': JSON.stringify({ ...validRecord, id: 'user:guest:../../x' }),
    };
    for (const [sessionId, content] of Object.entries(cases)) {
        await seedSession(sessionId);
        await fs.writeFile(path.join(ownersDir, `${sessionId}.json`), content, { mode: 0o600 });
        assert.equal(await readSessionOwner({ siteId: SITE_ID, sessionId }), null, sessionId);
        assert.deepEqual(await getSessionHistory({ siteId: SITE_ID, sessionId, access: guest }), missingShape(sessionId));
        assert.equal((await getSessionHistory({ siteId: SITE_ID, sessionId, access: admin })).exists, true);
    }

    await seedSession('linked-1');
    const elsewhere = path.join(sandbox.sandboxRoot, 'elsewhere.json');
    await fs.writeFile(elsewhere, JSON.stringify(validRecord));
    await fs.symlink(elsewhere, path.join(ownersDir, 'linked-1.json'));
    assert.equal(await readSessionOwner({ siteId: SITE_ID, sessionId: 'linked-1' }), null, 'symlinked owner file is not followed');
    assert.deepEqual(await getSessionHistory({ siteId: SITE_ID, sessionId: 'linked-1', access: guest }), missingShape('linked-1'));

    if (process.getuid?.() !== 0) {
        await seedSession('unreadable-1');
        await fs.writeFile(path.join(ownersDir, 'unreadable-1.json'), JSON.stringify(validRecord), { mode: 0o000 });
        assert.equal(await readSessionOwner({ siteId: SITE_ID, sessionId: 'unreadable-1' }), null, 'EACCES fails closed');
        assert.deepEqual(await getSessionHistory({ siteId: SITE_ID, sessionId: 'unreadable-1', access: guest }), missingShape('unreadable-1'));
    }
});

test('a symlinked session-owners directory is refused for writes and reads', async (t) => {
    const sandbox = await seedSite(t);
    const { createSessionOwner, readSessionOwner, hashSessionSecret } = await import(SESSION_ACCESS);
    const guest = await accessFor(await guestGrant());
    const outside = path.join(sandbox.sandboxRoot, 'outside-owners');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(sandbox.webAssistDataDir, 'sites', SITE_ID, 'session-owners'));
    await assert.rejects(createSessionOwner({ siteId: SITE_ID, sessionId: 'link-1', access: guest, secretHash: hashSessionSecret('C'.repeat(43)) }));
    assert.deepEqual(await fs.readdir(outside), []);
    await fs.writeFile(path.join(outside, 'link-2.json'), JSON.stringify({ schema: 2, kind: 'guest', id: guest.id, secretHash: 'a'.repeat(64), createdAt: 'x' }));
    assert.equal(await readSessionOwner({ siteId: SITE_ID, sessionId: 'link-2' }), null);
});

test('grants are read only from envelope.metadata (A8) and malformed grants are denied', async () => {
    const { callerAccessFromEnvelope } = await import(SESSION_ACCESS);
    const adminGrant = await userGrant(PRINCIPALS.admin);
    const guest = await guestGrant();
    assert.equal(await callerAccessFromEnvelope({ input: { metadata: { invocation: adminGrant } } }), null);
    assert.equal(await callerAccessFromEnvelope({ input: { siteId: SITE_ID, metadata: { invocation: adminGrant } }, metadata: {} }), null);
    const mixed = await callerAccessFromEnvelope({ input: { metadata: { invocation: adminGrant } }, metadata: { invocation: guest } });
    assert.equal(mixed.kind, 'guest');
    assert.equal(mixed.admin, false);

    const malformed = [
        'not-an-object',
        await verifiedGrant({ sub: 'agent:AchillesIDE/explorer', actor: { kind: 'agent', id: 'agent:AchillesIDE/explorer', roles: [] } }),
        await delegatedGrant({ user: { id: 'owner-1', roles: ['admin'] } }),
        await verifiedGrant({ sub: 'user:member-1', actor: { kind: 'user', id: 'user:someone-else', roles: ['admin'] } }),
        await verifiedGrant({ sub: 'user:guest:abc', actor: { kind: 'guest', id: 'user:guest:abc', roles: [] } }),
        await verifiedGrant({ sub: 'user:guest:a/b', actor: { kind: 'guest', id: 'user:guest:a/b', roles: ['guest'] } }),
    ];
    for (const invocation of malformed) {
        assert.equal(await callerAccessFromEnvelope({ input: {}, metadata: { invocation } }), null);
    }
    const { listSites } = await import(LIST_SITES);
    const { getSessionHistory } = await import(HISTORY);
    await assert.rejects(listSites({ access: null }), /Access denied/);
    await assert.rejects(getSessionHistory({ siteId: SITE_ID, sessionId: 'x', access: null }), /Access denied/);
});

test('tool errors are generic for non-admin callers and full for admins', async () => {
    const { formatToolError, publicError } = await import(SESSION_ACCESS);
    const guest = await accessFor(await guestGrant());
    const admin = await accessFor(await userGrant(PRINCIPALS.admin));
    const previous = process.env.ACHILLES_DEBUG;
    delete process.env.ACHILLES_DEBUG;
    try {
        const storage = new Error('webAssist data directory must be a non-symlink directory: /workspace/secret/path');
        assert.equal(formatToolError(storage, guest), 'webAssist request failed.');
        assert.equal(formatToolError(storage, null), 'webAssist request failed.');
        assert.equal(formatToolError(storage, admin), storage.message);
        assert.equal(formatToolError(publicError('Invalid sessionId.'), guest), 'Invalid sessionId.');
    } finally {
        if (previous === undefined) delete process.env.ACHILLES_DEBUG;
        else process.env.ACHILLES_DEBUG = previous;
    }
});

test('register-events tool output hides storage paths from guests (R3)', async (t) => {
    const sandbox = await createWebAssistSandbox();
    t.after(async () => sandbox.cleanup());
    const { spawn } = await import('node:child_process');
    const script = new URL('../src/mcp/register-events.mjs', import.meta.url);
    const run = (grant) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script.pathname], { env: { ...process.env, ACHILLES_DEBUG: '', WEBASSIST_DATA_ROOT: sandbox.webAssistDataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify(toolEnvelope(grant, { siteId: SITE_ID, visitorId: 'visitor-1', eventType: 'visit' }, 'register-events')));
    });
    const outside = path.join(sandbox.sandboxRoot, 'outside');
    await fs.mkdir(outside);
    await fs.rm(sandbox.webAssistDataDir, { recursive: true });
    await fs.symlink(outside, sandbox.webAssistDataDir);

    const guest = await run(await guestGrant());
    assert.equal(guest.code, 1);
    assert.equal(guest.stderr.trim(), 'webAssist request failed.');
    const admin = await run(await userGrant(PRINCIPALS.admin));
    assert.equal(admin.code, 1);
    assert.match(admin.stderr, /symbolic link/);
});
