import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspectSources } from '../../../.github/scripts/qaSourceInventory.mjs';

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
