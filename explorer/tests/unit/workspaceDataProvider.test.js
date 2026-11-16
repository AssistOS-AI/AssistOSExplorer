import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeWorkspaceDataTool } from '../../../dpuAgent/lib/workspace-data.mjs';
import { mergeDpuRootEntry, listDpuDirectory, resolveDpuNode, getDpuPathCapabilities, createDpuFile } from '../../web-components/pages/file-exp/file-exp-dpu-provider.js';
import { isDpuVirtualPath } from '../../services/dpu/dpuPaths.js';

test('Explorer virtual data provider uses DPU authorization for navigation and refuses edits', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-data-provider-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const originalWindow = globalThis.window;
    const previous = { ...process.env };
    t.after(() => {
        globalThis.window = originalWindow;
        for (const key of ['DPU_DATA_ROOT','DPU_WORKSPACE_DATA_ROOT','DPU_MASTER_KEY']) {
            if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
        }
    });
    process.env.DPU_DATA_ROOT = path.join(root, 'dpu-data');
    process.env.DPU_WORKSPACE_DATA_ROOT = root;
    process.env.DPU_MASTER_KEY = 'test-only';
    await fs.mkdir(path.join(root, 'agents/explorer'), { recursive: true });
    await fs.mkdir(path.join(root, 'robots'));
    await fs.mkdir(path.join(root, 'dpu-data'));
    await fs.writeFile(path.join(root, 'agents/explorer/note.txt'), 'private note');
    await fs.writeFile(path.join(root, 'dpu-data/master-key'), 'hidden');
    let auth = { user: { email: 'normal@example.test' } };
    globalThis.window = { webSkel: { appServices: { getClient: () => ({ callTool: async (tool, args) => ({ content: [{ type: 'text', text: JSON.stringify(await executeWorkspaceDataTool(tool, auth, args)) }] }) }) } } };
    const fileExp = { normalizePath: value => value };
    assert.equal(isDpuVirtualPath('/.data/agents/explorer'), true);
    assert.equal((await mergeDpuRootEntry(fileExp, [])).filter(item => item.name === '.data').length, 1);
    assert.deepEqual((await listDpuDirectory(fileExp, '/.data')).map(item => item.name), ['agents']);
    assert.deepEqual((await listDpuDirectory(fileExp, '/.data/agents')).map(item => item.path), ['/.data/agents/explorer']);
    const item = await resolveDpuNode(fileExp, '/.data/agents/explorer/note.txt');
    assert.equal(item.kind, 'workspace-data');
    assert.equal(item.type, 'file');
    assert.equal((await getDpuPathCapabilities(fileExp, item.path)).canWrite, false);
    await assert.rejects(createDpuFile(fileExp, '/.data/agents/explorer', 'bad.txt'), /not writable/);
    await assert.rejects(listDpuDirectory(fileExp, '/.data/robots'), /refused/);
    auth = { user: { id: 'local:admin', username: 'admin' } };
    assert.ok((await listDpuDirectory(fileExp, '/.data')).some(item => item.name === 'robots'));
    await assert.rejects(resolveDpuNode(fileExp, '/.data/dpu-data/master-key'), /refused/);
});
