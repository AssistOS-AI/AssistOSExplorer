// Explorer's user-facing file tools against controller state, agent private
// data and key material, driven end to end through the tool runtime on a real
// workspace. Every case uses only the runtime's public callTool interface.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMarkdownCrdtStore } from '../../utils/server/markdown-crdt/markdown-crdt-store.mjs';
import { createExplorerToolRuntime } from '../../utils/server/tool-runtime.mjs';

const SECRET = 'SECRET-SENTINEL';
const DENIED = /Access denied: protected path/;
const READ_ONLY = /Access denied: managed agent sources under \.ploinky\/repos are read-only/;
const ADMIN = { invocation: { sub: 'user:ops-1', actor: { kind: 'user', id: 'user:ops-1', roles: ['admin'] } } };
const MEMBER = { invocation: { sub: 'user:member-1', actor: { kind: 'user', id: 'user:member-1', roles: ['user'] } } };
const WEBMEET = { invocation: { caller: { id: 'agent:webmeet/webmeetAgent' } } };

// Protected files of every class, each holding the sentinel.
const PROTECTED_FILES = Object.freeze([
    '.env',
    'master-key',
    'github.secrets',
    '.data/userPersistoAgent/users.json',
    '.data/bizansoAgent/customers.json',
    '.data/explorer/plugin-settings.json',
    '.data/userPersistoAgent/notes.md',
    '.ploinky/.secrets',
    '.ploinky/routing.json',
    '.ploinky/data/master-key',
    'project/.env',
    'project/nested/.data/cache.json',
    'project/.ploinky/state.json',
]);
const PROTECTED_DIRECTORIES = Object.freeze([
    '.data',
    '.data/userPersistoAgent',
    '.data/explorer',
    '.ploinky',
    '.ploinky/data',
    'project/nested/.data',
    'project/.ploinky',
]);

async function workspace(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-protected-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const write = async (relative, content) => {
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.writeFile(path.join(root, relative), content);
    };
    for (const relative of PROTECTED_FILES) {
        await write(relative, relative === '.data/explorer/plugin-settings.json'
            ? JSON.stringify({ plugins: {}, marker: SECRET })
            : `${SECRET} ${relative}\n`);
    }
    await write('notes.txt', 'ordinary notes\n');
    await write('docs/readme.md', '# Readme\n\nordinary text\n');
    await write('project/app.js', 'console.log("app");\n');
    await write('scratch/old.txt', 'disposable\n');
    await write('.ploinky/repos/bizanso/bizansoAgent/index.mjs', 'export const source = "bizanso source";\n');
    await write('.ploinky/repos/bizanso/bizansoAgent/README.md', '# Bizanso agent\n\nrepo-only-marker\n');
    await write('.ploinky/repos/bizanso/bizansoAgent/GUIDE.md', '# Guide\n\nNo CRDT state yet.\n');
    await fs.symlink(path.join(root, '.data', 'userPersistoAgent'), path.join(root, 'link-to-users'));
    await fs.symlink('.data/userPersistoAgent/users.json', path.join(root, 'link-to-users-file'));
    await fs.symlink('.env', path.join(root, 'link-to-env'));
    await fs.symlink('.ploinky', path.join(root, 'link-to-controller'));
    await fs.symlink('.ploinky/repos', path.join(root, 'link-to-repos'));
    await fs.symlink('.data/userPersistoAgent/planted.json', path.join(root, 'dangling-into-data'));
    return root;
}

async function runtimeFor(t, root) {
    const runtime = await createExplorerToolRuntime({ env: { ASSISTOS_FS_ROOT: root } });
    t.after(() => runtime.dispose());
    return runtime;
}

const text = (result) => result.content[0].text;
const json = (result) => JSON.parse(text(result));

async function snapshot(root) {
    const files = new Map();
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            const relative = path.relative(root, entryPath);
            if (entry.isSymbolicLink()) files.set(relative, `link:${await fs.readlink(entryPath)}`);
            else if (entry.isDirectory()) { files.set(relative, 'dir'); await walk(entryPath); }
            else files.set(relative, crypto.createHash('sha256').update(await fs.readFile(entryPath)).digest('hex'));
        }
    }
    await walk(root);
    return files;
}

function protectedState(files) {
    return [...files].filter(([relative]) => relative === '.env' || relative === 'master-key'
        || relative.endsWith('.secrets') || relative.split(path.sep).some(part => ['.data', '.ploinky', '.env'].includes(part)))
        .filter(([relative]) => !relative.startsWith(`.ploinky${path.sep}repos`))
        // Explorer's own search-job store changes with every text search.
        .filter(([relative]) => !relative.startsWith(path.join('.data', 'explorer', 'search-jobs')))
        .sort();
}

async function assertDenied(runtime, name, args, context, label) {
    let outcome;
    try {
        outcome = { ok: true, value: await runtime.callTool(name, args, context) };
    } catch (error) {
        outcome = { ok: false, error };
    }
    assert.equal(outcome.ok, false, `${label}: expected an explicit denial, got ${outcome.ok ? JSON.stringify(outcome.value).slice(0, 200) : ''}`);
    assert.match(outcome.error.message, DENIED, `${label}: ${outcome.error.message}`);
    assert.doesNotMatch(outcome.error.message, /ENOENT|no such file/i, `${label}: denial must not look like absence`);
}

function fileOperations(target) {
    return [
        ['read_text_file', { path: target }],
        ['read_text_file', { path: target, head: 1 }],
        ['read_text_file', { path: target, tail: 1 }],
        ['read_file', { path: target }],
        ['read_media_file', { path: target }],
        ['read_multiple_files', { paths: ['notes.txt', target] }],
        ['get_file_info', { path: target }],
        ['write_file', { path: target, content: 'overwritten' }],
        ['write_binary_file', { path: target, content: Buffer.from('overwritten').toString('base64') }],
        ['edit_file', { path: target, edits: [{ oldText: SECRET, newText: 'edited' }], dryRun: true }],
        ['edit_file', { path: target, edits: [{ oldText: SECRET, newText: 'edited' }] }],
        ['delete_file', { path: target }],
        ['move_file', { source: target, destination: 'moved-out.txt' }],
        ['move_file', { source: 'notes.txt', destination: target }],
        ['copy_file', { source: target, destination: 'copied-out.txt' }],
        ['copy_file', { source: 'notes.txt', destination: target, overwrite: true }],
        ['search_text', { path: '/', query: SECRET, paths: [target] }],
        ['open_markdown_crdt_document', { path: target }],
        ['sync_markdown_crdt_from_file', { path: target }],
    ];
}

function directoryOperations(target) {
    return [
        ['list_directory', { path: target }],
        ['list_directory_with_sizes', { path: target }],
        ['list_directory_detailed', { path: target }],
        ['directory_tree', { path: target }],
        ['search_files', { path: target, pattern: '*' }],
        ['search_text', { path: target, query: SECRET }],
        ['replace_text', { path: target, query: SECRET, replaceWith: 'replaced' }],
        ['create_directory', { path: `${target}/created` }],
        ['write_file', { path: `${target}/created.txt`, content: 'planted' }],
        ['delete_directory', { path: target }],
        ['move_file', { source: target, destination: 'moved-dir' }],
        ['copy_file', { source: target, destination: 'copied-dir' }],
        ['read_skills_manifest_state', { folderPath: target }, ADMIN],
        ['read_skills_manifest_state', { folderPath: target }, MEMBER],
    ];
}

test('every file operation refuses every protected file class and changes nothing', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const before = protectedState(await snapshot(root));
    for (const target of PROTECTED_FILES) {
        for (const [name, args, context] of fileOperations(target)) {
            await assertDenied(runtime, name, args, context, `${name} ${target}`);
        }
    }
    assert.deepEqual(protectedState(await snapshot(root)), before);
    for (const leaked of ['moved-out.txt', 'copied-out.txt']) {
        await assert.rejects(fs.lstat(path.join(root, leaked)), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'ordinary notes\n');
});

test('every directory operation refuses every protected directory and changes nothing', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const before = protectedState(await snapshot(root));
    for (const target of PROTECTED_DIRECTORIES) {
        for (const [name, args, context] of directoryOperations(target)) {
            if (target === '.ploinky' && name.startsWith('list_directory') || target === '.ploinky' && name === 'directory_tree') continue;
            await assertDenied(runtime, name, args, context, `${name} ${target}`);
        }
    }
    assert.deepEqual(protectedState(await snapshot(root)), before);
    for (const leaked of ['moved-dir', 'copied-dir']) {
        await assert.rejects(fs.lstat(path.join(root, leaked)), { code: 'ENOENT' });
    }
});

test('a protected path that does not exist is refused with the same denial as one that does', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    for (const target of [
        '.data/userPersistoAgent/missing.json',
        '.data/newAgent/records.json',
        '.ploinky/missing',
        'docs/missing.secrets',
        'docs/.env',
        'docs/master-key',
        'docs/.data/x.json',
    ]) {
        await assertDenied(runtime, 'read_text_file', { path: target }, undefined, `read ${target}`);
        await assertDenied(runtime, 'write_file', { path: target, content: 'planted' }, undefined, `write ${target}`);
        await assertDenied(runtime, 'create_directory', { path: target }, undefined, `mkdir ${target}`);
        await assert.rejects(fs.lstat(path.join(root, target)), { code: 'ENOENT' }, `${target} must not be created`);
    }
});

test('case, Unicode, encoded and odd path forms of protected entries are refused', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const variants = [
        '.DATA/userPersistoAgent/users.json',
        '/.Data/userPersistoAgent/users.json',
        '.data/USERPERSISTOAGENT/USERS.JSON',
        '.ＤＡＴＡ/userPersistoAgent/users.json',
        '．data/userPersistoAgent/users.json',
        '.data./userPersistoAgent/users.json',
        '.data /userPersistoAgent/users.json',
        '.data. ./userPersistoAgent/users.json',
        './docs/../.data/userPersistoAgent/users.json',
        '//.data//userPersistoAgent//users.json',
        '/./.data/./userPersistoAgent/users.json',
        '.data/userPersistoAgent/users.json/',
        '.data/userPersistoAgent/users.json/.',
        `${root}/.data/userPersistoAgent/users.json`,
        `${root}/docs/../.data/userPersistoAgent/users.json`,
        '.ENV',
        '.Env.',
        '/.env/',
        ' .env ',
        'MASTER-KEY',
        'maſter-key',
        'master-key...',
        'GitHub.SECRETS',
        'github.secrets.',
        'github.secretſ',
        '.PLOINKY/routing.json',
        '.ploinKy/routing.json',
        '.ploinky./routing.json',
        '.ploinky/REPOS/../routing.json',
        '.ploinky/Repos/bizanso/bizansoAgent/index.mjs',
        'project/.ENV',
        'project/nested/.Data/cache.json',
    ];
    for (const target of variants) {
        await assertDenied(runtime, 'read_text_file', { path: target }, undefined, `read ${JSON.stringify(target)}`);
        await assertDenied(runtime, 'write_file', { path: target, content: 'overwritten' }, undefined, `write ${JSON.stringify(target)}`);
        await assertDenied(runtime, 'get_file_info', { path: target }, undefined, `stat ${JSON.stringify(target)}`);
    }
    // Tool arguments are not URL-decoded: a percent-encoded name is a distinct,
    // missing entry and never reaches the protected one.
    for (const target of ['%2Edata/userPersistoAgent/users.json', '.data%2FuserPersistoAgent%2Fusers.json']) {
        const error = await runtime.callTool('read_text_file', { path: target }).then(() => null, (failure) => failure);
        assert.ok(error, `${target} must not be readable`);
        assert.doesNotMatch(error.message, new RegExp(SECRET));
    }
    assert.match(await fs.readFile(path.join(root, '.data/userPersistoAgent/users.json'), 'utf8'), new RegExp(SECRET));
});

test('listings omit protected entries and project the workspace .ploinky as containing only repos', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const rootNames = json(await runtime.callTool('list_directory_detailed', { path: '/' })).map(entry => entry.name).sort();
    assert.deepEqual(rootNames, ['.ploinky', 'docs', 'link-to-repos', 'notes.txt', 'project', 'scratch'].sort());
    const listed = text(await runtime.callTool('list_directory', { path: '/' }));
    for (const hidden of ['.env', 'master-key', 'github.secrets', '.data', 'link-to-users', 'link-to-env', 'link-to-controller', 'dangling-into-data']) {
        assert.ok(!listed.split('\n').some(line => line.endsWith(` ${hidden}`)), `list_directory shows ${hidden}`);
    }
    const sized = text(await runtime.callTool('list_directory_with_sizes', { path: '/' }));
    assert.doesNotMatch(sized, /\.env|master-key|github\.secrets|\.data|link-to-users|link-to-env|dangling/);
    assert.deepEqual(json(await runtime.callTool('list_directory_detailed', { path: '/.ploinky' })).map(entry => entry.name), ['repos']);
    // A case-insensitive filesystem opens the same directory through `.PLOINKY`.
    if (await fs.stat(path.join(root, '.PLOINKY')).then(() => true, () => false)) {
        assert.deepEqual(json(await runtime.callTool('list_directory_detailed', { path: '.PLOINKY' })).map(entry => entry.name), ['repos']);
    }
    assert.deepEqual(json(await runtime.callTool('list_directory_detailed', { path: 'project' })).map(entry => entry.name).sort(), ['app.js', 'nested']);
    assert.deepEqual(json(await runtime.callTool('list_directory_detailed', { path: 'project/nested' })), []);

    const tree = JSON.parse(text(await runtime.callTool('directory_tree', { path: '/', maxDepth: 10, maxNodes: 1000 })));
    const treePaths = [];
    const visit = (nodes, prefix) => nodes.forEach(node => {
        treePaths.push(`${prefix}${node.name}`);
        if (node.children) visit(node.children, `${prefix}${node.name}/`);
    });
    visit(tree, '');
    assert.deepEqual(treePaths.filter(entry => entry.startsWith('.ploinky')).sort(), [
        '.ploinky', '.ploinky/repos', '.ploinky/repos/bizanso', '.ploinky/repos/bizanso/bizansoAgent',
        '.ploinky/repos/bizanso/bizansoAgent/GUIDE.md', '.ploinky/repos/bizanso/bizansoAgent/README.md',
        '.ploinky/repos/bizanso/bizansoAgent/index.mjs',
    ]);
    for (const entry of treePaths) {
        assert.doesNotMatch(entry, /(^|\/)(\.data|\.env|master-key|[^/]*\.secrets|link-to-users|link-to-env|link-to-controller|dangling-into-data)(\/|$)/, entry);
    }
    assert.ok(treePaths.includes('link-to-repos/bizanso/bizansoAgent/index.mjs'));
});

test('search and replace never return or change protected entries', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const before = protectedState(await snapshot(root));
    for (const pattern of ['*', '*users*', '*.json', '*.secrets', '.env', 'master-key', 'routing', 'data']) {
        const { results } = json(await runtime.callTool('search_files', { path: '/', pattern, maxResults: 1000 }));
        for (const result of results) {
            assert.doesNotMatch(result, /(^|\/)(\.data|\.env|master-key|[^/]*\.secrets|link-to-users|link-to-env|link-to-controller|dangling-into-data)(\/|$)|^\/\.ploinky\/(?!repos(\/|$))/, `${pattern}: ${result}`);
        }
    }
    const typed = json(await runtime.callTool('search_files', { path: '/', pattern: 'index.mjs', includeKind: true }));
    assert.ok(typed.results.some(result => result.path === '/.ploinky/repos/bizanso/bizansoAgent/index.mjs'));

    const { jobId } = json(await runtime.callTool('search_text', { path: '/', query: SECRET }));
    const job = json(await runtime.callTool('search_text_status', { jobId }));
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.results, []);
    const source = json(await runtime.callTool('search_text', { path: '/', query: 'bizanso source' }));
    const sourceJob = json(await runtime.callTool('search_text_status', { jobId: source.jobId }));
    assert.deepEqual(sourceJob.results.map(result => result.path), ['/.ploinky/repos/bizanso/bizansoAgent/index.mjs']);

    const replaced = json(await runtime.callTool('replace_text', { path: '/', query: SECRET, replaceWith: 'replaced' }));
    assert.equal(replaced.summary.filesChanged, 0);
    assert.deepEqual(protectedState(await snapshot(root)), before);
});

test('symlinks that lead into protected entries are refused, and unresolved links are not written through', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    for (const target of ['link-to-users-file', 'link-to-users/users.json', 'link-to-env', 'link-to-controller/routing.json', 'link-to-controller/data/master-key']) {
        await assertDenied(runtime, 'read_text_file', { path: target }, undefined, `read ${target}`);
        await assertDenied(runtime, 'delete_file', { path: target }, undefined, `delete ${target}`);
        await assertDenied(runtime, 'write_file', { path: target, content: 'overwritten' }, undefined, `write ${target}`);
    }
    for (const target of ['link-to-users', 'link-to-controller']) {
        await assertDenied(runtime, 'list_directory', { path: target }, undefined, `list ${target}`);
        await assertDenied(runtime, 'directory_tree', { path: target }, undefined, `tree ${target}`);
        await assertDenied(runtime, 'search_text', { path: target, query: SECRET }, undefined, `search ${target}`);
    }
    for (const [name, args] of [
        ['write_binary_file', { path: 'dangling-into-data', content: Buffer.from('planted').toString('base64') }],
        ['write_file', { path: 'dangling-into-data', content: 'planted' }],
        ['read_text_file', { path: 'dangling-into-data' }],
        ['copy_file', { source: 'notes.txt', destination: 'dangling-into-data', overwrite: true }],
    ]) {
        await assert.rejects(runtime.callTool(name, args), /Access denied: unresolved symbolic link/, name);
    }
    await assert.rejects(fs.lstat(path.join(root, '.data/userPersistoAgent/planted.json')), { code: 'ENOENT' });
    assert.match(await fs.readFile(path.join(root, '.data/userPersistoAgent/users.json'), 'utf8'), new RegExp(SECRET));
    assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), new RegExp(SECRET));
    // An allowed link target stays reachable.
    assert.match(text(await runtime.callTool('read_text_file', { path: 'link-to-repos/bizanso/bizansoAgent/index.mjs' })), /bizanso source/);
});

test('recursive delete, move and copy refuse a workspace root or a tree that holds protected entries', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const before = protectedState(await snapshot(root));
    await assert.rejects(runtime.callTool('delete_directory', { path: '/' }), /Access denied: a workspace root cannot be deleted/);
    await assert.rejects(runtime.callTool('delete_directory', { path: root }), /Access denied: a workspace root cannot be deleted/);
    for (const [name, args] of [
        ['delete_directory', { path: 'project' }],
        ['delete_directory', { path: 'project/nested' }],
        ['move_file', { source: 'project', destination: 'project-moved' }],
        ['copy_file', { source: 'project', destination: 'project-copy' }],
        ['copy_file', { source: 'scratch', destination: 'project', overwrite: true }],
    ]) {
        await assert.rejects(runtime.callTool(name, args), /Access denied: the folder contains protected entries/, `${name} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(protectedState(await snapshot(root)), before);
    for (const leaked of ['project-moved', 'project-copy']) {
        await assert.rejects(fs.lstat(path.join(root, leaked)), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(path.join(root, 'project/app.js'), 'utf8'), 'console.log("app");\n');
});

test('ordinary workspace files, .ploinky/repos sources and recursive operations keep working', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    assert.equal(text(await runtime.callTool('read_text_file', { path: 'notes.txt' })), 'ordinary notes\n');
    assert.match(text(await runtime.callTool('read_text_file', { path: '/.ploinky/repos/bizanso/bizansoAgent/index.mjs' })), /bizanso source/);
    assert.match(text(await runtime.callTool('read_text_file', { path: '.ploinky/repos/bizanso/bizansoAgent/index.mjs', head: 1 })), /bizanso source/);
    assert.deepEqual(json(await runtime.callTool('list_directory_detailed', { path: '.ploinky/repos/bizanso' })).map(entry => entry.name), ['bizansoAgent']);
    await runtime.callTool('copy_file', { source: '.ploinky/repos/bizanso/bizansoAgent', destination: 'docs/bizanso-copy' });
    assert.match(await fs.readFile(path.join(root, 'docs/bizanso-copy/index.mjs'), 'utf8'), /bizanso source/);
    await runtime.callTool('copy_file', { source: 'link-to-repos/bizanso/bizansoAgent/README.md', destination: 'docs/bizanso-readme.md' });
    assert.match(await fs.readFile(path.join(root, 'docs/bizanso-readme.md'), 'utf8'), /repo-only-marker/);
    assert.equal(json(await runtime.callTool('get_file_info', { path: '.ploinky/repos/bizanso/bizansoAgent/index.mjs' })).isFile, true);
    await runtime.callTool('write_file', { path: 'docs/new.md', content: 'new doc\n' });
    await runtime.callTool('copy_file', { source: 'docs', destination: 'docs-copy' });
    await runtime.callTool('move_file', { source: 'docs-copy', destination: 'docs-moved' });
    assert.equal(await fs.readFile(path.join(root, 'docs-moved/new.md'), 'utf8'), 'new doc\n');
    await runtime.callTool('delete_directory', { path: 'docs-moved' });
    await runtime.callTool('delete_directory', { path: 'scratch' });
    await assert.rejects(fs.lstat(path.join(root, 'scratch')), { code: 'ENOENT' });
    const opened = json(await runtime.callTool('open_markdown_crdt_document', { path: 'docs/readme.md' }));
    assert.ok(opened.documentId, 'a markdown CRDT document still opens and persists its state privately');
});

test('Explorer private data stays usable through its internal boundary but is not user-browsable', async (t) => {
    const root = await workspace(t);
    const runtime = await runtimeFor(t, root);
    const updated = json(await runtime.callTool('set_plugin_enabled', { key: 'help', enabled: false }));
    assert.equal(updated.ok, true);
    assert.deepEqual(json(await runtime.callTool('get_plugin_settings')).plugins.help, { enabled: false });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, '.data/explorer/plugin-settings.json'), 'utf8')).plugins.help.enabled, false);
    await assertDenied(runtime, 'read_text_file', { path: '.data/explorer/plugin-settings.json' }, undefined, 'read plugin settings');
    await assertDenied(runtime, 'list_directory', { path: '.data/explorer' }, undefined, 'list explorer data');

    const { jobId } = json(await runtime.callTool('search_text', { path: 'docs', query: 'ordinary' }));
    await fs.access(path.join(root, '.data/explorer/search-jobs', `${jobId}.json`));
    assert.equal(json(await runtime.callTool('search_text_status', { jobId })).results.length, 1);
    await assertDenied(runtime, 'read_text_file', { path: `.data/explorer/search-jobs/${jobId}.json` }, undefined, 'read search job');

    // A Router-staged WebMeet blob in Explorer's own `.data/explorer/blobs`
    // still commits into the room asset tree.
    const blobId = 'c'.repeat(48);
    const blobDirectory = path.join(root, '.data', 'explorer', 'blobs');
    await fs.mkdir(blobDirectory, { recursive: true });
    await fs.writeFile(path.join(blobDirectory, blobId), 'plain attachment\n');
    await fs.writeFile(path.join(blobDirectory, `${blobId}.json`), JSON.stringify({
        id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}`, filename: 'note.txt', size: 17,
    }));
    const committed = json(await runtime.callTool('webmeet_media_commit', {
        roomId: 'room_1', roomFolderPath: '/WebMeet/room-1',
        blobRef: { id: blobId, agent: 'explorer', localPath: `.data/explorer/blobs/${blobId}` },
    }, WEBMEET));
    assert.equal(committed.ok, true);
    assert.equal(await fs.readFile(path.join(root, committed.asset.workspaceUrl), 'utf8'), 'plain attachment\n');
    await assert.rejects(fs.lstat(path.join(blobDirectory, blobId)), { code: 'ENOENT' });
});

test('managed agent sources under .ploinky/repos are readable but never written', async (t) => {
    const root = await workspace(t);
    const sourceFile = '.ploinky/repos/bizanso/bizansoAgent/index.mjs';
    const sourceDoc = '.ploinky/repos/bizanso/bizansoAgent/README.md';
    // A document whose CRDT state already exists, for example from an open
    // made before this rule: later writes address it by id only.
    const seeded = createMarkdownCrdtStore({
        fs, path, workspaceRoot: root,
        validatePath: async (value) => path.resolve(root, String(value).replace(/^\/+/, '')),
        writeFileContent: (target, content) => fs.writeFile(target, content),
        invalidateCachesForPath: () => {},
    });
    const { documentId } = await seeded.open(sourceDoc);
    const runtime = await runtimeFor(t, root);
    const managed = async () => [...await snapshot(root)].filter(([relative]) => relative.startsWith(path.join('.ploinky', 'repos'))).sort();
    const before = await managed();
    for (const base of ['.ploinky/repos/bizanso/bizansoAgent', '.PLOINKY/repos/bizanso/bizansoAgent', 'link-to-repos/bizanso/bizansoAgent']) {
        for (const [name, args, context] of [
            ['write_file', { path: `${base}/index.mjs`, content: 'export const source = "injected";' }],
            ['write_file', { path: `${base}/planted.mjs`, content: 'export const planted = true;' }],
            ['write_binary_file', { path: `${base}/index.mjs`, content: Buffer.from('injected').toString('base64') }],
            ['edit_file', { path: `${base}/index.mjs`, edits: [{ oldText: 'bizanso source', newText: 'injected' }] }],
            ['create_directory', { path: `${base}/planted` }],
            ['delete_file', { path: `${base}/index.mjs` }],
            ['delete_directory', { path: base }],
            ['move_file', { source: `${base}/index.mjs`, destination: 'docs/moved.mjs' }],
            ['move_file', { source: 'notes.txt', destination: `${base}/notes.txt` }],
            ['copy_file', { source: 'notes.txt', destination: `${base}/notes.txt` }],
            ['copy_file', { source: 'project/app.js', destination: `${base}/index.mjs`, overwrite: true }],
            ['replace_text', { path: base, query: 'bizanso source', replaceWith: 'injected' }],
            ['save_markdown_crdt_document', { documentId, path: `${base}/README.md` }],
            ['add_skills_manifest_repo', { folderPath: base, url: 'https://example.invalid/skills.git' }, ADMIN],
        ]) {
            await assert.rejects(runtime.callTool(name, args, context), READ_ONLY, `${name} ${JSON.stringify(args)}`);
        }
    }
    for (const repository of ['.ploinky/repos', '.ploinky/repos/bizanso']) {
        await assert.rejects(runtime.callTool('delete_directory', { path: repository }), READ_ONLY, `delete ${repository}`);
        await assert.rejects(runtime.callTool('move_file', { source: repository, destination: 'moved-repos' }), READ_ONLY, `move ${repository}`);
    }
    await assert.rejects(runtime.callTool('create_directory', { path: '.ploinky/repos/new-repo' }), READ_ONLY);
    // Opening a managed document that has no CRDT state yet would rewrite it;
    // the refusal is the explicit denial, with nothing to roll back.
    for (const name of ['open_markdown_crdt_document', 'sync_markdown_crdt_from_file']) {
        const error = await runtime.callTool(name, { path: '.ploinky/repos/bizanso/bizansoAgent/GUIDE.md' }).then(() => null, (failure) => failure);
        assert.ok(error, `${name} must be refused`);
        assert.match(error.message, READ_ONLY, `${name}: ${error.message}`);
    }
    // A write to a document addressed only by its id reaches the shared
    // writer, which refuses the managed target.
    await assert.rejects(runtime.callTool('save_markdown_crdt_document', { documentId }), READ_ONLY, 'save by documentId');
    // Replace never reports or makes a change in managed sources.
    for (const dryRun of [true, false]) {
        const replaced = json(await runtime.callTool('replace_text', { path: '/', query: 'repo-only-marker', replaceWith: 'injected', dryRun }));
        assert.equal(replaced.summary.filesChanged, 0, `replace dryRun=${dryRun}`);
        assert.deepEqual(replaced.changedFiles, []);
    }
    assert.deepEqual(await managed(), before);
    await assert.rejects(fs.lstat(path.join(root, 'docs/moved.mjs')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(root, 'moved-repos')), { code: 'ENOENT' });
    // Reads stay available.
    assert.match(text(await runtime.callTool('read_text_file', { path: sourceFile })), /bizanso source/);
    const search = json(await runtime.callTool('search_text', { path: '/.ploinky/repos', query: 'repo-only-marker' }));
    assert.deepEqual(json(await runtime.callTool('search_text_status', { jobId: search.jobId })).results.map(result => result.path),
        ['/.ploinky/repos/bizanso/bizansoAgent/README.md']);
    assert.equal(json(await runtime.callTool('open_markdown_crdt_document', { path: sourceDoc })).documentId, documentId);
});
