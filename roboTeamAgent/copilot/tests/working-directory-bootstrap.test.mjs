import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeCliOptions } from '../src/lib/cli/cliOptions.mjs';
import { setPermissionMode } from '../src/lib/config/achillesSettings.mjs';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-directory-bootstrap-'));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    return root;
}

test('first dashboard chat creates achilles-cli before reading permissions and reuses saved settings', async t => {
    const root = await fixture(t);
    const directory = path.join(root, 'achilles-cli');
    const args = [`--dir=${directory}`, '--forward-envelope=1', '--sso-user=test'];
    const first = initializeCliOptions(args);
    assert.equal(first.workingDir, directory);
    assert.equal(first.permissionMode, 'full-access');
    assert.equal((await fs.stat(directory)).isDirectory(), true);
    assert.deepEqual(await fs.readdir(directory), []);
    await fs.writeFile(path.join(directory, 'keep.txt'), 'existing project');
    await setPermissionMode(directory, 'ask-for-approval');
    assert.equal(initializeCliOptions(args).permissionMode, 'ask-for-approval');
    assert.equal(initializeCliOptions([...args, '--permissions=full-access']).permissionMode, 'full-access');
    assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'existing project');
});

test('help and invalid arguments do not create the selected directory', async t => {
    const root = await fixture(t);
    const directory = path.join(root, 'unused');
    initializeCliOptions([`--dir=${directory}`, '--help']);
    assert.throws(() => initializeCliOptions([`--dir=${directory}`, '--unknown']), /Unknown option/);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('directory bootstrap rejects paths outside the workspace before creating files', async t => {
    const root = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-outside-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.mkdir(path.join(outside, 'existing'));
    await fs.symlink(outside, path.join(root, 'link'));
    for (const directory of [path.join(outside, 'new'), path.join(root, 'link', 'existing', 'new')]) {
        assert.throws(() => initializeCliOptions([`--dir=${directory}`]), /outside PLOINKY_WORKSPACE_ROOT/);
    }
    await assert.rejects(fs.stat(path.join(outside, 'new')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(outside, 'existing', 'new')), { code: 'ENOENT' });
});
