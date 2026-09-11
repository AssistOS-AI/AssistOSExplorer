import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { SNAPSHOT_FILE } from '../lib/durable-storage.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserRoles } from '../lib/users.mjs';
import { getInstallationSetup } from '../lib/setup.mjs';
import { claimAdministrator, clearAdministratorPassword, configureAdministratorPassword, registerWithEmailCode, resetAuthLimitsForTests } from './helpers/setup.mjs';
import { grant, getBalance } from '../lib/credits.mjs';

process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
let folder;
async function fixture() {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-durability-'));
    process.env.PERSISTENCE_FOLDER = folder;
    return getStore();
}
afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
});

test('failed business write rejects, cached retries fail closed, and restart retains committed balance', async () => {
    await fixture();
    await ensureSeedData();
    const user = await createUser({ email: 'durable@example.test', roles: ['user'] });
    await grant({ userId: user.id, amount: 10, referenceId: 'seed' });
    const backup = `${folder}-saved`;
    await rename(folder, backup);
    await writeFile(folder, 'not a directory');
    try {
        await assert.rejects(grant({ userId: user.id, amount: 7, referenceId: 'failed-write' }), { code: 'persistence_unavailable' });
        await assert.rejects(grant({ userId: user.id, amount: 7, referenceId: 'failed-write' }), { code: 'persistence_unavailable' });
        await assert.rejects(getBalance(user.id), { code: 'persistence_unavailable' });
    } finally {
        await rm(folder);
        await rename(backup, folder);
    }
    await resetStoreForTests();
    assert.deepEqual(await getBalance(user.id), { balance: 10, reservedBalance: 0 });
    await grant({ userId: user.id, amount: 7, referenceId: 'failed-write' });
    await resetStoreForTests();
    assert.deepEqual(await getBalance(user.id), { balance: 17, reservedBalance: 0 });
});

test('atomic snapshot preserves objects, unique indexes and deletions over restart', async () => {
    const store = await fixture();
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
        await store.createUser({ email: `snapshot-${index}@example.test` });
        if (index % 5 === 0) await flush();
    }));
    await store.deleteUser((await store.getUserByEmail('snapshot-0@example.test')).id);
    await flush();
    await resetStoreForTests();
    const reopened = await getStore();
    assert.equal((await reopened.select('user')).totalCount, 29);
    assert.equal(await reopened.getUserByEmail('snapshot-0@example.test'), undefined);
    assert.equal((await reopened.getUserByEmail('snapshot-29@example.test')).email, 'snapshot-29@example.test');
    await assert.rejects(reopened.createUser({ email: 'snapshot-29@example.test' }));
});

test('rename failure rejects the commit and never acknowledges the staged changes', async () => {
    const store = await fixture();
    await store.createUser({ email: 'committed@example.test' });
    await flush();
    const snapshot = join(folder, SNAPSHOT_FILE);
    const previous = `${snapshot}.previous`;
    await rename(snapshot, previous);
    await mkdir(snapshot);
    await store.createUser({ email: 'uncommitted@example.test' });
    await assert.rejects(flush(), { code: 'persistence_unavailable' });
    await assert.rejects(store.getUserByEmail('uncommitted@example.test'), { code: 'persistence_unavailable' });
    await rm(snapshot, { recursive: true });
    await rename(previous, snapshot);
    await resetStoreForTests();
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
});

test('concurrent flush cannot publish an initial user without its administrator role and setup record', async () => {
    await fixture();
    await ensureSeedData();
    resetAuthLimitsForTests();
    let done = false;
    let samples = 0;
    const [registration] = await Promise.all([
        registerWithEmailCode('atomic-owner@example.test').finally(() => { done = true; }),
        (async () => {
            do {
                await flush();
                const objects = Object.values(JSON.parse(JSON.parse(readFileSync(join(folder, SNAPSHOT_FILE), 'utf8')).payload));
                const user = objects.find((entry) => entry.email === 'atomic-owner@example.test');
                const setupRecord = objects.find((entry) => entry.key === 'installation.setup');
                if (user) {
                    assert.ok(objects.some((entry) => entry.userId === user.id && entry.roleId), 'durable initial user must have a role');
                    assert.equal(setupRecord?.value?.initialAdministratorId, user.id, 'setup completion commits with the owner');
                } else assert.equal(setupRecord, undefined, 'setup never completes without its owner');
                samples += 1;
            } while (!done);
        })(),
    ]);
    assert.ok(samples);
    await resetStoreForTests();
    assert.deepEqual(await getUserRoles(registration.user.id), ['admin']);
});

test('a failure while staging the setup record leaves neither owner nor setup after restart', async () => {
    for (const method of ['emailCode', 'adminPassword']) {
        await fixture();
        await ensureSeedData();
        resetAuthLimitsForTests();
        const password = configureAdministratorPassword();
        setStoreFaultInjectorForTests(async (phase, name, args) => {
            if (phase === 'before' && name === 'createSystemSetting' && args[0]?.key === 'installation.setup') throw new Error('injected setup write failure');
        });
        const attempt = method === 'emailCode' ? registerWithEmailCode('interrupted-owner@example.test') : claimAdministrator(password);
        await assert.rejects(attempt);
        // The staged commit fails closed: nothing more is served from this process.
        await assert.rejects(getInstallationSetup(), { code: 'persistence_unavailable' });
        await resetStoreForTests().catch(() => {});
        const store = await getStore();
        assert.equal((await getInstallationSetup()).complete, false, `${method}: setup stays unclaimed`);
        assert.equal((await store.select('user')).totalCount, 0, `${method}: no ambiguous owner exists`);
        // A later completion claims the installation normally.
        resetAuthLimitsForTests();
        const retried = method === 'emailCode' ? await registerWithEmailCode('interrupted-owner@example.test') : await claimAdministrator(password);
        assert.equal(retried.initialAdministrator, true);
        assert.equal((await getInstallationSetup()).initialAdministratorId, retried.user.id);
        clearAdministratorPassword();
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
    }
});

test('a corrupt snapshot fails startup without falling back to legacy data', async () => {
    await fixture();
    await flush();
    await resetStoreForTests();
    await writeFile(join(folder, SNAPSHOT_FILE), '{broken');
    await assert.rejects(getStore(), { code: 'persistence_unavailable' });
    assert.equal(await readFile(join(folder, SNAPSHOT_FILE), 'utf8'), '{broken');
});

test('legacy files import once and the snapshot becomes authoritative', async () => {
    const store = await fixture();
    const user = await store.createUser({ email: 'legacy@example.test' });
    await flush();
    await resetStoreForTests();
    const objects = JSON.parse(JSON.parse(await readFile(join(folder, SNAPSHOT_FILE), 'utf8')).payload);
    for (const [id, object] of Object.entries(objects)) await writeFile(join(folder, id), JSON.stringify(object));
    await rm(join(folder, SNAPSHOT_FILE));
    assert.equal((await (await getStore()).getUserByEmail('legacy@example.test')).id, user.id);
    await flush();
    await resetStoreForTests();
    await writeFile(join(folder, user.id), '{corrupt obsolete legacy object');
    assert.equal((await (await getStore()).getUserByEmail('legacy@example.test')).id, user.id);
});

test('a Ploinky replacement generation reclaims a legacy lock from its predecessor container', async () => {
    const store = await fixture();
    const user = await store.createUser({ email: 'box-restart@example.test' });
    await flush();
    await resetStoreForTests();
    await writeFile(join(folder, '.userpersisto.writer.json'), JSON.stringify({
        pid: 21,
        hostname: `${hostname()}-predecessor-container`,
        token: 'legacy-predecessor-token',
    }));
    const previousInstanceId = process.env.PLOINKY_AGENT_INSTANCE_ID;
    const previousGeneration = process.env.PLOINKY_AGENT_ENABLE_GENERATION;
    process.env.PLOINKY_AGENT_INSTANCE_ID = 'replacement-instance';
    process.env.PLOINKY_AGENT_ENABLE_GENERATION = 'replacement-generation';
    try {
        const reopened = await getStore();
        assert.equal((await reopened.getUserByEmail('box-restart@example.test')).id, user.id);
        const owner = JSON.parse(await readFile(join(folder, '.userpersisto.writer.json'), 'utf8'));
        assert.equal(owner.version, 2);
        assert.equal(owner.instanceId, 'replacement-instance');
        assert.equal(owner.enableGeneration, 'replacement-generation');
    } finally {
        if (previousInstanceId === undefined) delete process.env.PLOINKY_AGENT_INSTANCE_ID;
        else process.env.PLOINKY_AGENT_INSTANCE_ID = previousInstanceId;
        if (previousGeneration === undefined) delete process.env.PLOINKY_AGENT_ENABLE_GENERATION;
        else process.env.PLOINKY_AGENT_ENABLE_GENERATION = previousGeneration;
    }
});

test('current-generation and malformed foreign locks remain fail-closed', async () => {
    await fixture();
    await flush();
    await resetStoreForTests();
    const previousInstanceId = process.env.PLOINKY_AGENT_INSTANCE_ID;
    const previousGeneration = process.env.PLOINKY_AGENT_ENABLE_GENERATION;
    process.env.PLOINKY_AGENT_INSTANCE_ID = 'current-instance';
    process.env.PLOINKY_AGENT_ENABLE_GENERATION = 'current-generation';
    try {
        const lockPath = join(folder, '.userpersisto.writer.json');
        await writeFile(lockPath, JSON.stringify({
            version: 2,
            pid: 21,
            hostname: `${hostname()}-foreign-container`,
            token: 'current-generation-owner',
            instanceId: 'current-instance',
            enableGeneration: 'current-generation',
        }));
        await assert.rejects(getStore(), { code: 'persistence_locked' });
        await resetStoreForTests().catch(() => {});
        await writeFile(lockPath, '{"pid":"not-an-owner"}');
        await assert.rejects(getStore(), { code: 'persistence_locked' });
        assert.equal(await readFile(lockPath, 'utf8'), '{"pid":"not-an-owner"}');
    } finally {
        if (previousInstanceId === undefined) delete process.env.PLOINKY_AGENT_INSTANCE_ID;
        else process.env.PLOINKY_AGENT_INSTANCE_ID = previousInstanceId;
        if (previousGeneration === undefined) delete process.env.PLOINKY_AGENT_ENABLE_GENERATION;
        else process.env.PLOINKY_AGENT_ENABLE_GENERATION = previousGeneration;
    }
});

test('a second process cannot open the same store for writing', async () => {
    await fixture();
    await flush();
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        const { getStore } = await import(${JSON.stringify(new URL('../lib/store.mjs', import.meta.url).href)});
        try { await getStore(); process.exit(2); }
        catch (error) { if (error.code !== 'persistence_locked') throw error; }
    `], { env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
});
