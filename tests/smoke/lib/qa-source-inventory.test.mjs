import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectSources } from '../../../.github/scripts/qaSourceInventory.mjs';
import { assessSources } from '../../../.github/scripts/qaSourceReport.mjs';

test('only proven default skill projections are removed from untracked inventory', t => {
    const { workspace, tooling, repo } = fixture(t);
    const source = path.join(workspace, 'checkout');
    const catalog = path.join(workspace, 'DocumentationSkills');
    repo(source, 'https://example.invalid/project');
    repo(catalog, 'https://github.com/AssistOS-AI/DocumentationSkills.git');
    fs.mkdirSync(path.join(source, 'agent'));
    fs.writeFileSync(path.join(source, 'agent/manifest.json'), '{}');
    git(source, 'add', 'agent'); git(source, 'commit', '-qm', 'agent');
    fs.mkdirSync(path.join(catalog, 'skills/example'), { recursive: true });
    fs.writeFileSync(path.join(catalog, 'skills/example/SKILL.md'), 'skill');
    git(catalog, 'add', 'skills'); git(catalog, 'commit', '-qm', 'skill');
    fs.mkdirSync(path.join(source, '.agents/skills'), { recursive: true });
    const link = path.join(source, '.agents/skills/example');
    const target = path.relative(path.dirname(link), path.join(catalog, 'skills/example'));
    fs.symlinkSync(target, link);
    fs.symlinkSync('.agents', path.join(source, '.claude'));
    const digest = crypto.createHash('sha256').update(JSON.stringify(['', 'symlink', fs.lstatSync(link).mode & 0o777])).update(JSON.stringify(target)).digest('hex');
    const ledger = { version: 1, entries: { example: { owner: 'defaults:DocumentationSkills', digest, kind: 'symlink', source: { name: 'DocumentationSkills' } } }, consumers: { 'defaults:DocumentationSkills': { selection: 'all', source: 'DocumentationSkills' } }, compatLinks: { '.claude': { target: '.agents' } } };
    const ledgerPath = path.join(source, '.agents/.ploinky-skill-exports.json');
    const write = value => fs.writeFileSync(ledgerPath, `${JSON.stringify(value, null, 2)}\n`);
    write(ledger);
    fs.writeFileSync(path.join(source, '.agents/skills/private'), 'private');
    const files = () => inspectSources({ scope: 'full', workspace, tooling }).repos.find(item => item.name === 'checkout').files;
    assert.deepEqual(files(), [{ status: '??', path: '.agents/skills/private' }]);
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    assert.equal(files().length, 4);
    write({ ...ledger, extra: 'private' });
    assert.equal(files().length, 4);
    write(ledger);
    git(source, 'add', '.agents/.ploinky-skill-exports.json');
    assert.equal(files().length, 4);
    git(source, 'reset', '-q', 'HEAD', '--', '.agents/.ploinky-skill-exports.json');
    fs.unlinkSync(link); fs.symlinkSync('wrong', link);
    assert.equal(files().length, 4);
    fs.unlinkSync(link); fs.symlinkSync(target, link);
    git(catalog, 'rm', '-q', 'skills/example/SKILL.md'); git(catalog, 'commit', '-qm', 'remove skill');
    fs.mkdirSync(path.join(catalog, 'skills/example'), { recursive: true });
    fs.writeFileSync(path.join(catalog, 'skills/example/SKILL.md'), 'untracked');
    assert.equal(files().length, 4);
});

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qa-inventory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const tooling = path.join(root, 'tooling');
    function repo(target, origin) {
        fs.mkdirSync(target, { recursive: true });
        git(target, 'init', '-q', '-b', 'main');
        git(target, 'config', 'user.email', 'fixture@example.invalid');
        git(target, 'config', 'user.name', 'Fixture');
        git(target, 'remote', 'add', 'origin', origin);
        fs.writeFileSync(path.join(target, 'tracked'), 'initial');
        git(target, 'add', '.'); git(target, 'commit', '-qm', 'initial');
    }
    return { root, workspace, tooling, repo };
}

test('full inventory collects local history and all working tree states without invoking configured monitor', t => {
    const { root, workspace, tooling, repo } = fixture(t);
    repo(tooling, 'https://example.invalid/tooling.git');
    const checkout = path.join(workspace, 'checkout');
    repo(checkout, 'https://example.invalid/project.git');
    fs.mkdirSync(path.join(checkout, 'agent'));
    fs.writeFileSync(path.join(checkout, 'agent', 'manifest.json'), '{}');
    git(checkout, 'add', 'agent'); git(checkout, 'commit', '-qm', 'add agent');
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    fs.writeFileSync(path.join(workspace, '.ploinky', 'repo_sources.json'), JSON.stringify({ alias: { url: 'https://example.invalid/project.git', branch: 'main' } }));
    fs.writeFileSync(path.join(checkout, 'committed'), 'local'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'local commit');
    fs.writeFileSync(path.join(checkout, 'tracked'), 'changed');
    fs.writeFileSync(path.join(checkout, 'staged'), 'staged'); git(checkout, 'add', 'staged');
    fs.writeFileSync(path.join(checkout, 'untracked'), 'new');
    const marker = path.join(root, 'executed');
    const before = git(checkout, 'rev-parse', 'HEAD');
    const inventory = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(inventory.errors, []);
    const found = inventory.repos.find(entry => entry.name === 'alias');
    assert.deepEqual(found.files, [{ status: 'A ', path: 'staged' }, { status: ' M', path: 'tracked' }, { status: '??', path: 'untracked' }]);
    assert.equal(found.commits[0].subject, 'local commit');
    assert.equal(found.commits[0].id, before);
    git(checkout, 'config', 'core.fsmonitor', `touch ${marker}`);
    assert.equal(inspectSources({ scope: 'full', workspace, tooling }).errors.some(item => item.reason === 'Unsupported repository configuration'), true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), before);
    assert.deepEqual(inventory.copies.map(copy => [copy.name, copy.manifest]), [['bizanso', null], ['simpleCSVMailSend', null]]);
});

test('scopes manifest the correct copies and collect independent layout errors', t => {
    const { workspace, tooling, repo } = fixture(t);
    fs.mkdirSync(path.join(workspace, 'bizanso')); fs.writeFileSync(path.join(workspace, 'bizanso', 'source'), 'content');
    fs.mkdirSync(path.join(workspace, 'simpleCSVMailSend', 'csvMailAgent'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'simpleCSVMailSend', 'csvMailAgent', 'agent'), 'content');
    const product = inspectSources({ scope: 'bizanso', workspace, tooling });
    assert.deepEqual(product.copies.map(copy => [copy.name, copy.manifest[0].path]), [['bizanso', 'source']]);
    assert.deepEqual(inspectSources({ scope: 'csvmail', workspace, tooling }).copies.map(copy => copy.name), ['simpleCSVMailSend']);
    const checkout = path.join(workspace, 'ScriptaHubAgent');
    repo(checkout, 'https://github.com/Axiologic/ScriptaHubAgent.git');
    git(checkout, 'checkout', '--detach', '-q');
    assert.equal(inspectSources({ scope: 'scriptahub', workspace, tooling }).errors[0].name, 'ScriptaHubAgent');
    fs.symlinkSync(checkout, path.join(workspace, 'DocumentationSkills'));
    const full = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(full.errors.map(item => item.name).sort(), ['DocumentationSkills', 'ScriptaHubAgent']);
});

test('inventories managed repositories and blocks a registered branch mismatch', t => {
    const { workspace, tooling, repo } = fixture(t);
    const managed = path.join(workspace, '.ploinky', 'repos', 'managed');
    repo(managed, 'https://example.invalid/managed.git');
    fs.writeFileSync(path.join(workspace, '.ploinky', 'repo_sources.json'), JSON.stringify({ managed: { url: 'https://example.invalid/managed.git', branch: 'release' } }));
    fs.unlinkSync(path.join(managed, 'tracked'));
    let result = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(result.errors, [{ name: '.ploinky/repos/managed', reason: 'Checkout is on a different deployment branch' }]);
    fs.writeFileSync(path.join(workspace, '.ploinky', 'repo_sources.json'), JSON.stringify({ managed: { url: 'https://example.invalid/managed.git', branch: 'main' } }));
    result = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.repos[0].files, [{ status: ' D', path: 'tracked' }]);
});

test('fails closed on hidden index state, shallow history and configuration includes', t => {
    const { workspace, tooling, repo } = fixture(t);
    repo(tooling, 'https://example.invalid/tooling.git');
    const inspect = () => inspectSources({ scope: 'full', workspace, tooling });
    git(tooling, 'update-index', '--assume-unchanged', 'tracked');
    assert.equal(inspect().errors.some(item => item.reason === 'Unsupported index flags'), true);
    git(tooling, 'update-index', '--no-assume-unchanged', 'tracked');
    fs.writeFileSync(path.join(tooling, '.git', 'shallow'), `${git(tooling, 'rev-parse', 'HEAD')}\n`);
    assert.equal(inspect().errors.some(item => item.reason === 'Unsupported checkout layout'), true);
    fs.unlinkSync(path.join(tooling, '.git', 'shallow'));
    git(tooling, 'config', 'include.path', '/tmp/not-read');
    assert.equal(inspect().errors.some(item => item.reason === 'Unsupported repository configuration'), true);
});

test('workspace discovery reports a linked repository under an unregistered alias', t => {
    const { root, workspace, tooling } = fixture(t);
    const target = path.join(root, 'external');
    fs.mkdirSync(path.join(target, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(target, 'agent/manifest.json'), '{}');
    fs.symlinkSync(target, path.join(workspace, 'editor-dev'));
    const result = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(result.errors, [{ name: 'editor-dev', reason: 'Unsafe source path' }]);
});

test('ambiguous fetch origins are reported before looking up publication', t => {
    const { workspace, tooling, repo } = fixture(t);
    repo(tooling, 'https://example.invalid/first');
    git(tooling, 'config', '--add', 'remote.origin.url', 'https://example.invalid/second');
    assert.deepEqual(inspectSources({ scope: 'full', workspace, tooling }).errors,
        [{ name: 'ploinky', reason: 'Ambiguous or missing checkout origin' }]);
});

test('an unreadable alias cannot be skipped as an unregistered directory', t => {
    const { workspace, tooling, repo } = fixture(t);
    const source = path.join(workspace, 'old-name');
    repo(source, 'https://example.invalid/old');
    fs.mkdirSync(path.join(source, 'agent'));
    fs.writeFileSync(path.join(source, 'agent/manifest.json'), '{}');
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    fs.writeFileSync(path.join(workspace, '.ploinky/repo_sources.json'), JSON.stringify({ active: 'https://example.invalid/active' }));
    fs.writeFileSync(path.join(workspace, '.ploinky/unregistered_agent_repos.json'), '["old-name"]');
    git(source, 'config', '--add', 'remote.origin.url', 'https://example.invalid/active');
    assert.deepEqual(inspectSources({ scope: 'full', workspace, tooling }).errors,
        [{ name: 'old-name', reason: 'Ambiguous or missing checkout origin' }]);
});

test('origin identity selects an active alias despite a retired registration using the directory name', t => {
    const { workspace, tooling, repo } = fixture(t);
    const source = path.join(workspace, 'retired');
    repo(source, 'https://example.invalid/active');
    fs.mkdirSync(path.join(source, 'agent'));
    fs.writeFileSync(path.join(source, 'agent/manifest.json'), '{}');
    fs.mkdirSync(path.join(workspace, '.ploinky'));
    fs.writeFileSync(path.join(workspace, '.ploinky/repo_sources.json'), JSON.stringify({
        retired: 'https://example.invalid/retired', active: 'https://example.invalid/active',
    }));
    fs.writeFileSync(path.join(workspace, '.ploinky/unregistered_agent_repos.json'), '["retired"]');
    const result = inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.repos.map(item => item.name), ['active']);
    assert.ok(result.repos[0].files.some(file => file.path === 'agent/manifest.json'));
});

test('inventories Ploinky worktree configuration without hiding managed excludes', async t => {
    const { workspace, tooling, repo } = fixture(t);
    const source = path.join(workspace, 'checkout');
    repo(source, 'https://example.invalid/project');
    fs.mkdirSync(path.join(source, 'agent'));
    fs.writeFileSync(path.join(source, 'agent/manifest.json'), '{}');
    git(source, 'add', 'agent'); git(source, 'commit', '-qm', 'agent');
    git(source, 'config', 'extensions.worktreeConfig', 'true');
    const excludes = path.join(source, '.git/ploinky-skill-exports.exclude');
    fs.writeFileSync(excludes, 'hidden\n');
    git(source, 'config', '--worktree', 'core.excludesFile', excludes);
    const inspect = () => inspectSources({ scope: 'full', workspace, tooling });
    assert.deepEqual(inspect().errors, []);
    fs.writeFileSync(path.join(source, 'hidden'), 'unpublished');
    const inventory = inspect();
    assert.deepEqual(inventory.repos[0].files, [{ status: '??', path: 'hidden' }]);
    const assessment = await assessSources({ ...inventory, copies: [] }, {
        publication: async entry => ({ branch: entry.branch, commits: new Set(entry.commits.map(commit => commit.id)) }),
        receipts: {}, incoming: {},
    });
    assert.deepEqual(assessment.blockers[0].files, [{ status: '??', path: 'hidden' }]);
    fs.writeFileSync(path.join(source, '.gitignore'), 'ignored\n');
    fs.writeFileSync(path.join(source, 'ignored'), 'ignored');
    assert.deepEqual(inspect().repos[0].files.map(file => file.path), ['.gitignore', 'hidden']);
});

test('rejects unsupported or incomplete worktree configuration during alias discovery', t => {
    const { workspace, tooling, repo } = fixture(t);
    const source = path.join(workspace, 'checkout');
    repo(source, 'https://example.invalid/project');
    fs.mkdirSync(path.join(source, 'agent'));
    fs.writeFileSync(path.join(source, 'agent/manifest.json'), '{}');
    const config = path.join(source, '.git/config');
    const worktree = path.join(source, '.git/config.worktree');
    fs.appendFileSync(config, '\n[remote "Origin"]\nurl = https://example.invalid/other\n');
    const base = fs.readFileSync(config, 'utf8');
    const extension = '\n[extensions]\nworktreeConfig = true\n';
    const expected = path.join(source, '.git/ploinky-skill-exports.exclude');
    const inspect = () => inspectSources({ scope: 'full', workspace, tooling });
    const rejected = () => assert.equal(inspect().errors.length, 1);
    assert.deepEqual(inspect().errors, [], 'remote names that differ in case remain distinct');
    fs.writeFileSync(config, base + extension);
    rejected();
    fs.writeFileSync(worktree, `[core]\nexcludesFile = ${expected}\nother = true\n`);
    rejected();
    fs.writeFileSync(worktree, '[core]\nexcludesFile = /tmp/other\n');
    rejected();
    fs.writeFileSync(worktree, `[core]\nexcludesFile = ${expected}\nexcludesFile = ${expected}\n`);
    rejected();
    fs.writeFileSync(worktree, `[core]\nexcludesFile = ${expected}\n`);
    fs.writeFileSync(config, base);
    rejected();
    fs.writeFileSync(config, base + extension + extension);
    rejected();
    fs.writeFileSync(config, base + extension);
    fs.unlinkSync(worktree);
    fs.symlinkSync(config, worktree);
    rejected();
});
