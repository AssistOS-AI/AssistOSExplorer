// Decision M-60 (with M-58): the session working folder is stored as given, never as a resolution of it. A working folder
// whose path holds a link is refused where it is first read (the CLI bootstrap and the session store), so no link-free path
// into another project can reach the worker admission `cwd`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeCliOptions } from '../src/lib/cli/cliOptions.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'm60-session-cwd-')));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'projects', 'app');
    const other = path.join(root, 'other');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(other);
    return { root, project, other };
}

test('M-60 session store: the working folder is stored lexically and a folder that resolves elsewhere is refused', async t => {
    const f = await fixture(t);
    const store = new ConversationSessionStore({ workingDir: f.project });
    assert.equal(store.workingDir, f.project);
    const session = await store.createSession({ sessionId: randomUUID(), select: false });
    assert.equal(session.cwd, f.project);
    await fs.symlink(f.other, path.join(f.root, 'hop'));
    await fs.symlink(path.join(f.root, 'projects'), path.join(f.root, 'alias'));
    for (const workingDir of [path.join(f.root, 'hop'), path.join(f.root, 'alias', 'app')]) {
        assert.throws(() => new ConversationSessionStore({ workingDir }), { code: 'cwd_symlinked', statusCode: 400 }, workingDir);
    }
    await assert.rejects(fs.stat(path.join(f.other, '.roboteam')), { code: 'ENOENT' }, 'nothing is written through the link');
});

test('M-60 CLI bootstrap: --dir with a swapped component is refused before anything is created, and a plain or new folder is kept lexical', async t => {
    const f = await fixture(t);
    assert.equal(initializeCliOptions([`--dir=${f.project}`]).workingDir, f.project);
    const fresh = path.join(f.root, 'projects', 'new', 'deeper');
    assert.equal(initializeCliOptions([`--dir=${fresh}`]).workingDir, fresh, 'a missing tail is created, not resolved');
    await fs.symlink(f.other, path.join(f.root, 'hop'));
    await fs.symlink(path.join(f.root, 'projects'), path.join(f.root, 'alias'));
    for (const directory of [path.join(f.root, 'hop', 'inner'), path.join(f.root, 'alias', 'app'), path.join(f.root, 'alias', 'app', 'later')]) {
        assert.throws(() => initializeCliOptions([`--dir=${directory}`]), { code: 'cwd_symlinked', statusCode: 400 }, directory);
    }
    await assert.rejects(fs.stat(path.join(f.other, 'inner')), { code: 'ENOENT' });
    assert.throws(() => initializeCliOptions([`--dir=${path.join(os.tmpdir(), 'm60-elsewhere-never')}`]), /outside PLOINKY_WORKSPACE_ROOT/u);
});

test('M-60 root alias: --dir spelled with the unresolved configured workspace root yields the path below the resolved root', async t => {
    const f = await fixture(t);
    const aliasRoot = `${f.root}-alias`;
    await fs.symlink(f.root, aliasRoot);
    t.after(() => fs.rm(aliasRoot, { force: true }));
    process.env.PLOINKY_WORKSPACE_ROOT = aliasRoot;
    assert.equal(initializeCliOptions([`--dir=${path.join(aliasRoot, 'projects', 'app')}`]).workingDir, f.project);
    await fs.mkdir(path.join(f.other, 'inner'));
    await fs.symlink(f.other, path.join(f.root, 'hop'));
    assert.throws(() => initializeCliOptions([`--dir=${path.join(aliasRoot, 'hop', 'inner')}`]), { code: 'cwd_symlinked' });
});
