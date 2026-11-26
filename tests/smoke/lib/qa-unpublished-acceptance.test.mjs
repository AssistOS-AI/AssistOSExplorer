import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceManifest } from '../../../.github/scripts/qaCopyManifest.mjs';
import { inspectSources } from '../../../.github/scripts/qaSourceInventory.mjs';
import { assessSources, formatSummary } from '../../../.github/scripts/qaSourceReport.mjs';

function run(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
}
function init(root) {
    fs.mkdirSync(root, { recursive: true });
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.name', 'Test');
    run(root, 'config', 'user.email', 'test@example.invalid');
    run(root, 'remote', 'add', 'origin', 'https://example.invalid/repo');
    fs.writeFileSync(path.join(root, 'tracked'), 'original\n');
    run(root, 'add', 'tracked');
    run(root, 'commit', '-qm', 'initial');
    return run(root, 'rev-parse', 'HEAD');
}
function snapshot(root) {
    return {
        head: run(root, 'rev-parse', 'HEAD'),
        refs: run(root, 'show-ref'),
        index: fs.readFileSync(path.join(root, '.git/index')).toString('base64'),
        staged: run(root, 'diff', '--cached', '--binary'),
        status: run(root, 'status', '--porcelain=v1', '-z'),
        tracked: fs.readFileSync(path.join(root, 'tracked'), 'utf8'),
        untracked: fs.existsSync(path.join(root, 'local\nfile')) ? fs.readFileSync(path.join(root, 'local\nfile'), 'utf8') : null,
    };
}

test('aggregate preflight preserves repository and copy state and permits a reconciled retry', async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-source-acceptance-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const tooling = path.join(root, 'tooling');
    const repo = path.join(workspace, 'ScriptaHubAgent');
    const copy = path.join(workspace, 'bizanso');
    const csv = path.join(workspace, 'simpleCSVMailSend', 'csvMailAgent');
    const publishedTool = init(tooling);
    const publishedRepo = init(repo);
    run(repo, 'remote', 'set-url', 'origin', 'https://github.com/Axiologic/ScriptaHubAgent.git');
    const repoRemote = path.join(root, 'repo-published.git');
    run(root, 'clone', '-q', '--bare', repo, repoRemote);
    const repoHistory = () => run(root, '--git-dir', repoRemote, 'rev-list', 'refs/heads/main').split('\n');
    const remote = path.join(root, 'published.git');
    run(root, 'clone', '-q', '--bare', tooling, remote);
    const publishedCheckout = path.join(root, 'published-tool');
    run(root, 'clone', '-q', remote, publishedCheckout);
    run(publishedCheckout, 'config', 'user.name', 'Test');
    run(publishedCheckout, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(publishedCheckout, 'new'), 'later');
    run(publishedCheckout, 'add', 'new');
    run(publishedCheckout, 'commit', '-qm', 'published later');
    run(publishedCheckout, 'push', '-q', 'origin', 'main');
    const publishedToolHistory = run(root, '--git-dir', remote, 'rev-list', 'refs/heads/main').split('\n');
    assert.ok(publishedToolHistory.includes(publishedTool));
    assert.equal(publishedToolHistory.length, 2);
    fs.mkdirSync(copy, { recursive: true });
    fs.mkdirSync(csv, { recursive: true });
    fs.writeFileSync(path.join(copy, 'source'), 'release');
    fs.writeFileSync(path.join(csv, 'source'), 'release');
    const installed = sourceManifest(copy);
    const csvInstalled = sourceManifest(csv);
    fs.writeFileSync(path.join(repo, 'extra'), 'commit');
    run(repo, 'add', 'extra');
    run(repo, 'commit', '-qm', 'unpublished subject');
    const unpublished = run(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'tracked'), 'staged\n');
    run(repo, 'add', 'tracked');
    fs.writeFileSync(path.join(repo, 'tracked'), 'staged and unstaged\n');
    fs.writeFileSync(path.join(repo, 'local\nfile'), 'untracked bytes');
    fs.writeFileSync(path.join(copy, 'source'), 'local edit');
    const beforeTool = snapshot(tooling), beforeRepo = snapshot(repo), beforeCopy = sourceManifest(copy);
    const publication = async item => ({ branch: 'main', commits: new Set(item.name === 'ploinky'
        ? publishedToolHistory : repoHistory()) });
    const options = { publication, receipts: { bizanso: { installed }, simpleCSVMailSend: { installed: csvInstalled } },
        incoming: { bizanso: installed, simpleCSVMailSend: csvInstalled } };
    const inventory = await inspectSources({ scope: 'full', workspace, tooling });
    const result = await assessSources(inventory, options);
    const repoBlock = result.blockers.find(item => item.name === 'ScriptaHubAgent');
    assert.ok(repoBlock, JSON.stringify(result));
    assert.ok(repoBlock.files.some(file => file.path === 'tracked'));
    assert.ok(repoBlock.commits.some(commit => commit.id === unpublished && commit.subject === 'unpublished subject'));
    assert.ok(result.blockers.find(item => item.name === 'bizanso')?.files.some(file => file.path === 'source'));
    assert.deepEqual(snapshot(tooling), beforeTool);
    assert.deepEqual(snapshot(repo), beforeRepo);
    assert.deepEqual(sourceManifest(copy), beforeCopy);
    assert.deepEqual(await assessSources(await inspectSources({ scope: 'full', workspace, tooling }), options), result);
    const sentinel = path.join(root, 'mutation-sentinel');
    if (!result.blockers.length) fs.writeFileSync(sentinel, 'reached');
    assert.equal(fs.existsSync(sentinel), false);
    run(repo, 'reset', '--hard', 'HEAD');
    fs.rmSync(path.join(repo, 'local\nfile'));
    run(repo, 'push', '-q', repoRemote, 'main');
    assert.ok(repoHistory().includes(publishedRepo));
    assert.ok(repoHistory().includes(unpublished));
    fs.writeFileSync(path.join(copy, 'source'), 'release');
    const reconciled = { ...options, publication: async item => ({ branch: 'main', commits: new Set(item.name === 'ploinky'
        ? publishedToolHistory : repoHistory()) }) };
    const clean = await assessSources(await inspectSources({ scope: 'full', workspace, tooling }), reconciled);
    assert.deepEqual(clean.blockers, []);
    if (!clean.blockers.length) fs.writeFileSync(sentinel, 'reached');
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'reached');
});

test('copy receipts fail closed and summaries neutralize hostile text', async () => {
    const hash = 'a'.repeat(64);
    const base = [{ path: 'old', type: 'file', sha256: hash, executable: false }];
    const newer = [{ path: 'new', type: 'file', sha256: hash, executable: false }];
    const inventory = { repos: [], copies: [{ name: 'bizanso', manifest: base }], errors: [] };
    const options = { publication: async () => { throw Error('secret'); }, incoming: { bizanso: newer }, receipts: { bizanso: { installed: base } } };
    assert.deepEqual((await assessSources(inventory, options)).blockers, []);
    assert.match((await assessSources(inventory, { ...options, receipts: {} })).blockers[0].reason, /baseline unavailable/);
    assert.deepEqual((await assessSources(inventory, { ...options, receipts: { bizanso: { installed: base, pending: newer } } })).blockers, []);
    assert.deepEqual((await assessSources({ ...inventory, copies: [{ name: 'bizanso', manifest: newer }] },
        { ...options, receipts: { bizanso: { installed: base, pending: newer } } })).blockers, []);
    const modified = [{ ...base[0], sha256: 'b'.repeat(64) }];
    assert.deepEqual((await assessSources({ ...inventory, copies: [{ name: 'bizanso', manifest: modified }] },
        { ...options, receipts: { bizanso: { installed: base, pending: newer } } })).blockers[0].files,
    [{ status: 'M', path: 'old' }]);
    assert.ok((await assessSources(inventory, { ...options, receipts: { bizanso: { installed: {} } } })).blockers.length);
    assert.deepEqual((await assessSources({ ...inventory, copies: [{ name: 'bizanso', manifest: null }] },
        { ...options, receipts: {} })).blockers, []);
    assert.deepEqual((await assessSources({ ...inventory, copies: [{ name: 'bizanso', manifest: null }] }, options)).blockers[0].files,
        [{ status: 'D', path: 'old' }]);
    const failed = await assessSources({ ...inventory, repos: [{ name: 'repo', origin: 'origin', branch: 'main',
        files: [{ status: ' M', path: 'changed' }], commits: [{ id: 'b'.repeat(40), subject: 'local' }] }] }, options);
    assert.equal(failed.blockers[0].files[0].path, 'changed');
    assert.deepEqual(failed.blockers[0].commits, []);
    assert.doesNotMatch(JSON.stringify(failed), /secret/);
    assert.ok((await assessSources(inventory, null)).blockers.length);
    const id = 'a'.repeat(40);
    const hostile = { blockers: [{ name: 'x\n::error::<script>', files: [{ status: '??', path: '`[x](javascript:bad)' }],
        commits: [{ id, subject: '<img>\n::warning::bad' }] }] };
    const summary = formatSummary(hostile);
    assert.doesNotMatch(summary, /<script>|<img>|::error::|::warning::|javascript:bad/);
    assert.match(summary, /&#60;/);
});

test('interrupted first placement accepts the still-absent copy and reports a partially installed copy', async () => {
    const target = [{ path: 'release', type: 'file', sha256: 'a'.repeat(64), executable: false }];
    const options = { incoming: { bizanso: target }, receipts: { bizanso: { pending: target } }, publication: async () => assert.fail() };
    const inventory = manifest => ({ copies: [{ name: 'bizanso', manifest }], repos: [], errors: [] });
    assert.deepEqual((await assessSources(inventory(null), options)).blockers, []);
    assert.deepEqual((await assessSources(inventory(target), options)).blockers, []);
    assert.equal((await assessSources(inventory([]), options)).blockers[0].files[0].path, 'release');
});
