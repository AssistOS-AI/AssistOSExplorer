// Decision M-60: a schedule or run folder is validated component by component without following links, and the
// lexical path is returned. A folder swapped for a link after the check is never replaced by its resolution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScheduleFolders } from '../server/roboflow/schedule-folders.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm60-schedule-folders-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Reports', 'October'), { recursive: true });
    await fs.mkdir(path.join(root, 'Elsewhere'));
    return { root, folders: new ScheduleFolders(root) };
}

test('M-60 schedule folders: a symlinked component is refused at any depth, in both selection and the default folder', async t => {
    const { root, folders } = await fixture(t);
    await fs.symlink(path.join(root, 'Elsewhere'), path.join(root, 'Reports', 'hop'));
    await fs.symlink(path.join(root, 'Reports'), path.join(root, 'alias'));
    for (const key of ['Reports/hop', 'alias', 'alias/October']) await assert.rejects(folders.directory(key), { statusCode: 400 }, key);
    await fs.symlink(path.join(root, 'Elsewhere'), path.join(root, 'workflow-runs'));
    await assert.rejects(folders.defaultFolder(), { statusCode: 400 });
});

test('M-60 schedule folders: the returned folder is the lexical path even if a component is swapped after it was checked', async t => {
    const { root, folders } = await fixture(t);
    const target = path.join(root, 'Reports', 'October');
    assert.equal(await folders.directory('Reports/October'), target);
    const original = fs.lstat;
    let swapped = false;
    fs.lstat = async (candidate, ...rest) => {
        const stat = await original(candidate, ...rest);
        if (candidate === target && !swapped) {
            swapped = true;
            await fs.rename(target, `${target}-moved`);
            await fs.symlink(path.join(root, 'Elsewhere'), target);
        }
        return stat;
    };
    t.after(() => { fs.lstat = original; });
    const result = await folders.directory('Reports/October');
    fs.lstat = original;
    assert.equal(swapped, true);
    assert.equal(result, target, 'the swapped folder is not replaced by where it now points; the worker refuses the link');
});
