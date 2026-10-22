// The protected-path predicate shared by Explorer's file tools: parity with
// the Ploinky Router's `/workspace-files` rules, the projected `.ploinky` root,
// and the descriptor-bound open.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { importFromSibling } from '../../../tests/helpers/sibling-roots.mjs';
import {
    classifyCanonicalWorkspaceTarget,
    classifyWorkspacePath,
    foldWorkspaceName,
    isProtectedWorkspaceSegments,
    openClassifiedWorkspaceFile,
    withClassifiedWorkspaceFile
} from '../../utils/server/protected-workspace-paths.mjs';

const ploinky = await importFromSibling('ploinky', 'cli/server/utils/protectedWorkspacePaths.js');

const NAMES = [
    '.ploinky', '.PLOINKY', '.ploinKy', '.ploinky.', '.ploinky ', 'ploinky', '.ploinky2',
    '.data', '.DATA', '.Data. .', '．data', '.ＤＡＴＡ', 'data', '.database',
    '.env', '.ENV', '.env.', '.env.local', 'env', 'master-key', 'MASTER-KEY', 'maſter-key', 'master-key.txt',
    '.secrets', 'github.secrets', 'GitHub.SECRETS', 'github.secrets.', 'github.secretſ', 'github.secrets.txt',
    'repos', 'REPOS', 'notes.txt', 'docs', 'café', 'café',
];

const RELATIVE_PATHS = [
    '', 'notes.txt', 'docs/readme.md', '.env', 'docs/.env', '.env.local', 'master-key', 'x/master-key',
    'github.secrets', 'x/y.secrets', '.data', '.data/userPersistoAgent/users.json', 'x/.data/y', '.DATA/x',
    '.ploinky', '.ploinky/', '.ploinky/routing.json', '.ploinky/data/master-key', '.ploinky/.secrets',
    '.ploinky/repos', '.ploinky/repos/', '.ploinky/repos/bizanso/bizansoAgent/index.mjs',
    '.ploinky/repos/bizanso/.env', '.ploinky/repos/bizanso/.data/x', '.ploinky/repos/x/.ploinky/y',
    '.ploinky/REPOS/x', '.ploinky/Repos/x', '.PLOINKY/repos/x', 'x/.ploinky/repos/y', './.ploinky/repos/x',
    'docs/../.data/x', '.ploinky/repos/../data/x', '．data/x', '.ploinKy/repos/x',
];

test('name folding matches the Ploinky Router byte for byte', () => {
    for (const name of NAMES) {
        assert.equal(foldWorkspaceName(name), ploinky.foldWorkspaceName(name), JSON.stringify(name));
    }
});

test('segment rules match the Ploinky Router for every name in every position', () => {
    const cases = [];
    for (const first of NAMES) {
        cases.push([first]);
        for (const second of NAMES) {
            cases.push([first, second], [first, second, 'file.txt'], ['docs', first, second]);
        }
    }
    for (const segments of cases) {
        assert.equal(isProtectedWorkspaceSegments(segments), ploinky.isProtectedWorkspaceSegments(segments), JSON.stringify(segments));
    }
});

test('path classification matches the Ploinky Router, with only the root .ploinky projected for listings', () => {
    const root = path.resolve('/workspace');
    for (const relative of RELATIVE_PATHS) {
        const kind = classifyWorkspacePath([root], path.join(root, relative));
        assert.equal(['protected', 'controller'].includes(kind), ploinky.isProtectedWorkspaceRequestPath(relative), JSON.stringify(relative));
        const normalized = path.posix.normalize(relative).replace(/\/+$/, '');
        // Readable but never written: exactly the leading `.ploinky/repos` tree.
        const segments = normalized.split('/');
        const leadingRepos = segments.length >= 2 && foldWorkspaceName(segments[0]) === '.ploinky' && segments[1] === 'repos';
        assert.equal(kind === 'managed', leadingRepos && !ploinky.isProtectedWorkspaceRequestPath(relative), `${JSON.stringify(relative)} is ${kind}`);
        assert.equal(kind === 'controller', ['.ploinky', '.PLOINKY', '.ploinKy'].includes(normalized), `${JSON.stringify(relative)} is ${kind}`);
    }
    assert.equal(classifyWorkspacePath([root], path.resolve('/elsewhere/file')), 'protected');
    // A nested root cannot lift the outer root's rules.
    const nested = path.join(root, 'project');
    assert.equal(classifyWorkspacePath([root, nested], path.join(nested, '.ploinky', 'repos', 'x')), 'protected');
    assert.equal(classifyWorkspacePath([root, nested], path.join(nested, 'src', 'x')), 'allowed');
});

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-bound-open-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'users.json'), 'ordinary\n');
    await fs.mkdir(path.join(root, '.data', 'userPersistoAgent'), { recursive: true });
    await fs.writeFile(path.join(root, '.data', 'userPersistoAgent', 'users.json'), 'SECRET-SENTINEL\n');
    return root;
}

test('the descriptor-bound open reads a classified canonical file and refuses a path through a symlink', async (t) => {
    const root = await fixture(t);
    const canonical = path.join(root, 'docs', 'users.json');
    assert.equal(await withClassifiedWorkspaceFile(canonical, (handle) => handle.readFile({ encoding: 'utf8' })), 'ordinary\n');
    await fs.symlink(path.join(root, '.data', 'userPersistoAgent'), path.join(root, 'linked'));
    assert.equal(await openClassifiedWorkspaceFile(path.join(root, 'linked', 'users.json')), null);
});

test('a directory swapped for a symlink after classification cannot redirect the read', async (t) => {
    const root = await fixture(t);
    const classified = path.join(root, 'docs', 'users.json');
    // A writer replaces the classified file's directory with a link into
    // protected data between validation and the open.
    await fs.rename(path.join(root, 'docs'), path.join(root, 'docs-before'));
    await fs.symlink(path.join(root, '.data', 'userPersistoAgent'), path.join(root, 'docs'));
    assert.equal(await fs.readFile(classified, 'utf8'), 'SECRET-SENTINEL\n', 'a plain path open would follow the swap');
    await assert.rejects(
        withClassifiedWorkspaceFile(classified, (handle) => handle.readFile({ encoding: 'utf8' })),
        /Access denied: protected path/
    );
});

test('a top-level entry that resolves to .ploinky or .data is classified as that directory', async (t) => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, '.ploinky', 'repos', 'bizanso'), { recursive: true });
    // A symlink models a name the filesystem resolves to the same directory
    // without matching it after folding (for example a bind mount).
    await fs.symlink(path.join(root, '.ploinky'), path.join(root, '.alias'));
    await fs.symlink(path.join(root, '.data'), path.join(root, '.alias-data'));
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, '.alias', 'repos', 'bizanso', 'x.mjs')), 'managed');
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, '.alias', 'routing.json')), 'protected');
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, '.alias')), 'protected');
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, '.alias-data', 'userPersistoAgent', 'users.json')), 'protected');
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, '.ploinky')), 'controller');
    assert.equal(await classifyCanonicalWorkspaceTarget([root], path.join(root, 'docs', 'users.json')), 'allowed');
});
