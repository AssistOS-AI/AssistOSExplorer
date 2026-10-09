import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-folders-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, folders: new ScheduleFolders(root) };
}
test('browsing is read-only and lists only visible ordinary directories', async t => {
    const { root, folders } = await fixture(t);
    await fs.mkdir(path.join(root, 'Reports')); await fs.mkdir(path.join(root, '.ploinky'));
    await fs.writeFile(path.join(root, 'file.txt'), 'untouched'); await fs.symlink('Reports', path.join(root, 'link'));
    const listing = await folders.list();
    assert.deepEqual(listing.folders, [{ name: 'Reports', path: 'Reports' }]);
    assert.equal(listing.defaultFolder, path.join(root, 'cron-jobs-results'));
    await assert.rejects(fs.stat(listing.defaultFolder), { code: 'ENOENT' });
    assert.equal((await folders.list('Reports')).path, 'Reports');
});
test('default folder is created on demand and reused without deleting its contents', async t => {
    const { root, folders } = await fixture(t), destination = await folders.defaultFolder();
    assert.equal(destination, path.join(root, 'cron-jobs-results'));
    await fs.writeFile(path.join(destination, 'result.txt'), 'keep');
    assert.equal(await folders.defaultFolder(), destination);
    assert.equal(await fs.readFile(path.join(destination, 'result.txt'), 'utf8'), 'keep');
    assert.equal(folders.label(destination, root), 'Workspace / cron-jobs-results');
});
test('new folders support spaces and Unicode, preserve existing names and remain confined', async t => {
    const { root, folders } = await fixture(t);
    const parent = await folders.create({ name: 'Rapoarte zilnice' });
    const created = await folders.create({ parent: parent.path, name: 'Octombrie · știri' });
    assert.equal(created.folder, path.join(root, 'Rapoarte zilnice', 'Octombrie · știri'));
    await assert.rejects(folders.create({ name: 'Rapoarte zilnice' }), { statusCode: 409 });
    for (const name of ['', '.', '..', '.data', 'a/b', 'a\\b', '/tmp', 'bad\0name', ' name ']) await assert.rejects(folders.create({ name }), { statusCode: 400 });
    for (const parent of ['../outside', '/tmp', '.ploinky', 'a/../b', 'a//b', 'a\\b']) await assert.rejects(folders.create({ parent, name: 'No' }), { statusCode: 400 });
});
test('symlinks, files and destinations outside the workspace cannot be selected', async t => {
    const { root, folders } = await fixture(t);
    await fs.mkdir(path.join(root, 'Reports')); await fs.symlink('Reports', path.join(root, 'link'));
    await fs.symlink(os.tmpdir(), path.join(root, 'outside')); await fs.writeFile(path.join(root, 'file'), 'keep');
    for (const key of ['link', 'outside', 'file']) await assert.rejects(folders.list(key), { statusCode: 400 });
    await assert.rejects(folders.list(os.tmpdir()), { statusCode: 400 });
    await assert.rejects(folders.list('missing'), { statusCode: 404 });
    await fs.symlink('Reports', path.join(root, 'cron-jobs-results'));
    await assert.rejects(folders.defaultFolder(), { statusCode: 400 });
    await assert.rejects(folders.create({ parent: 'outside', name: 'Never-created' }), { statusCode: 400 });
});
