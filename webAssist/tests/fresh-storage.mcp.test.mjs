import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listSites } from '../src/mcp/list-sites.mjs';
import { getSessionHistory } from '../src/mcp/get-session-history.mjs';
import { registerEvent } from '../src/mcp/register-events.mjs';
import { updateSessionProfile } from '../src/runtime/update-session.mjs';
import { callerAccessFromEnvelope } from '../src/runtime/sessionAccess.mjs';
import { ensureSiteAku } from './helpers.mjs';
import { PRINCIPALS, toolEnvelope, userGrant } from './fixtures/verified-grant.mjs';

// list-sites and admin history reads require a verified Explorer administrator.
const ADMIN_ACCESS = await callerAccessFromEnvelope(toolEnvelope(await userGrant(PRINCIPALS.admin), {}));

async function createFreshStorage(t) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webassist-fresh-mcp-'));
    const persistentRoot = path.join(fixtureRoot, 'workspace', '.data', 'webAssist');
    const dataRoot = path.join(persistentRoot, 'data');
    const previous = process.env.WEBASSIST_DATA_ROOT;
    await fs.mkdir(persistentRoot, { recursive: true });
    process.env.WEBASSIST_DATA_ROOT = dataRoot;
    t.after(async () => {
        if (previous === undefined) delete process.env.WEBASSIST_DATA_ROOT;
        else process.env.WEBASSIST_DATA_ROOT = previous;
        await fs.rm(fixtureRoot, { recursive: true, force: true });
    });
    return { fixtureRoot, persistentRoot, dataRoot };
}

test('site listing and session history work before chat without creating the missing data child', async (t) => {
    const { persistentRoot, dataRoot } = await createFreshStorage(t);

    assert.deepEqual(await listSites({ access: ADMIN_ACCESS }), { sites: [], count: 0 });
    assert.deepEqual(await listSites({ access: ADMIN_ACCESS }), { sites: [], count: 0 });
    assert.deepEqual(await getSessionHistory({ siteId: 'new-site', sessionId: 'new-session', access: ADMIN_ACCESS }), {
        siteId: 'new-site',
        sessionId: 'new-session',
        exists: false,
        sessionKuId: 'ku_sess_new-session',
        history: [],
    });

    assert.deepEqual(await fs.readdir(persistentRoot), []);
    await assert.rejects(fs.lstat(dataRoot), { code: 'ENOENT' });
});

test('standalone event registration creates the data child but still requires a provisioned site', async (t) => {
    const { dataRoot } = await createFreshStorage(t);
    const event = { siteId: 'new-site', visitorId: 'visitor', eventType: 'visit' };

    await assert.rejects(registerEvent(event), /AKU not initialized for site: new-site/);

    assert.deepEqual(await fs.readdir(dataRoot), []);
    await ensureSiteAku({ siteId: 'new-site' });
    assert.equal((await registerEvent(event)).ok, true);
    assert.deepEqual((await listSites({ access: ADMIN_ACCESS })).sites, ['new-site']);
});

test('standalone session writers initialize storage independently of chat and preserve site admission', async (t) => {
    const { dataRoot } = await createFreshStorage(t);

    await assert.rejects(updateSessionProfile({ siteId: 'new-site', sessionId: 'new-session' }), /AKU not initialized for site: new-site/);

    assert.deepEqual(await fs.readdir(dataRoot), []);
});

test('invalid event input does not provision storage', async (t) => {
    const { persistentRoot } = await createFreshStorage(t);

    await assert.rejects(registerEvent({ siteId: '..', visitorId: 'visitor', eventType: 'visit' }), /valid site identifier/);

    assert.deepEqual(await fs.readdir(persistentRoot), []);
});

for (const target of ['persistentRoot', 'dataRoot']) {
    test(`all standalone storage entrypoints reject a symlinked ${target} without outside writes`, async (t) => {
        const fixture = await createFreshStorage(t);
        const outsideRoot = path.join(fixture.fixtureRoot, 'outside');
        await fs.mkdir(outsideRoot);
        await fs.writeFile(path.join(outsideRoot, 'sentinel'), 'untouched');
        if (target === 'persistentRoot') await fs.rmdir(fixture.persistentRoot);
        await fs.symlink(outsideRoot, fixture[target]);

        for (const operation of [
            () => listSites({ access: ADMIN_ACCESS }),
            () => getSessionHistory({ siteId: 'new-site', sessionId: 'session', access: ADMIN_ACCESS }),
            () => registerEvent({ siteId: 'new-site', visitorId: 'visitor', eventType: 'visit' }),
            () => updateSessionProfile({ siteId: 'new-site', sessionId: 'session' }),
        ]) {
            await assert.rejects(operation(), /symlink|symbolic link/);
        }

        assert.deepEqual(await fs.readdir(outsideRoot), ['sentinel']);
        assert.equal(await fs.readFile(path.join(outsideRoot, 'sentinel'), 'utf8'), 'untouched');
        assert.equal((await fs.lstat(fixture[target])).isSymbolicLink(), true);
    });
}
