import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeWorkspaceDataTool as execute } from '../lib/workspace-data.mjs';

test('workspace data authorizes users, excludes master and aliases, bounds reads and audits', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dpu-data-view-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previous = { ...process.env };
    t.after(() => { for (const key of ['DPU_DATA_ROOT','DPU_WORKSPACE_DATA_ROOT','DPU_MASTER_KEY']) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    } });
    process.env.DPU_DATA_ROOT = path.join(root, 'dpu-data');
    process.env.DPU_WORKSPACE_DATA_ROOT = root;
    process.env.DPU_MASTER_KEY = 'test-only-secret';
    for (const name of ['agents/explorer', 'agents/other', 'robots', 'dpu-data']) await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, 'agents/explorer/note.txt'), 'hello world');
    await fs.writeFile(path.join(root, 'dpu-data/master-key'), 'not-for-download');
    await fs.link(path.join(root, 'dpu-data/master-key'), path.join(root, 'agents/explorer/key-alias'));
    await fs.symlink(path.join(root, 'dpu-data'), path.join(root, 'agents/explorer/link'));
    const admin = { user: { id: 'local:admin', username: 'admin' } };
    const user = { user: { email: 'reader@example.test' } };
    assert.deepEqual((await execute('dpu_data_list', user)).items.map(item => item.name), ['agents']);
    assert.deepEqual((await execute('dpu_data_list', user, { path: 'agents' })).items.map(item => item.name), ['explorer']);
    assert.deepEqual((await execute('dpu_data_list', user, { path: 'agents/explorer' })).items.map(item => item.name), ['note.txt']);
    assert.equal((await execute('dpu_data_list', admin)).items.length, 3);
    for (const actor of [admin, user]) for (const name of ['dpu-data/master-key', 'agents/explorer/key-alias', 'agents/explorer/link/master-key', '../outside', '/etc/passwd']) {
        assert.equal((await execute('dpu_data_read', actor, { path: name })).ok, false, name);
    }
    assert.equal((await execute('dpu_data_stat', user, { path: 'robots', roles: ['admin'] })).ok, false);
    const result = await execute('dpu_data_download', user, { path: 'agents/explorer/note.txt', offset: 6, length: 5 });
    assert.equal(Buffer.from(result.content, 'base64').toString(), 'world');
    assert.equal(result.eof, true);
    assert.equal((await execute('dpu_data_read', user, { path: 'agents/explorer/note.txt', length: 2 ** 30 })).ok, false);
    assert.equal((await execute('dpu_data_list', { ...user, invocation: { scope: ['dpu:research'] } })).ok, false);
    const audits = await fs.readdir(path.join(root, 'dpu-data/audit'));
    assert.ok(audits.length);
});
