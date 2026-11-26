import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { check, inspectRemote, recordCopy } from '../../../.github/scripts/qaPredeploy.mjs';
import { inspectSources } from '../../../.github/scripts/qaSourceInventory.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function tmp(t) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-source-deploy-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function command(dir, binary, ...args) {
    const result = spawnSync(binary, args, { cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function release(runner, folder, file, contents) {
    const checkout = path.join(runner, folder);
    fs.mkdirSync(checkout);
    command(checkout, 'git', 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    fs.writeFileSync(path.join(checkout, file), contents);
    command(checkout, 'git', 'add', '--', file);
    command(checkout, 'git', '-c', 'user.name=Release', '-c', 'user.email=release@example.invalid', 'commit', '-qm', 'Published source');
    return checkout;
}

test('workflow entry checks trusted local release histories and preserves every source before retry', async t => {
    const dir = tmp(t), workspace = path.join(dir, 'workspace'), runner = path.join(dir, 'runner');
    fs.mkdirSync(runner);
    fs.mkdirSync(workspace);
    const releases = [['ScriptaHubAgent', '.qa-scriptahub-source', 'Axiologic/ScriptaHubAgent'],
        ['PromotionScoutV2', '.qa-promotionscout-source', 'AssistOS-AI/PromotionScoutV2']];
    for (const [name, folder, origin] of releases) {
        const source = release(runner, folder, 'agent.txt', 'published\n');
        const target = path.join(workspace, name);
        command(workspace, 'git', 'clone', '-q', source, target);
        command(target, 'git', 'remote', 'set-url', 'origin', 'https://github.com/' + origin + '.git');
    }
    const behind = path.join(workspace, 'ScriptaHubAgent');
    const dirty = path.join(workspace, 'PromotionScoutV2');
    const published = path.join(runner, '.qa-scriptahub-source');
    fs.writeFileSync(path.join(published, 'agent.txt'), 'next release');
    command(published, 'git', '-c', 'user.name=Release', '-c', 'user.email=release@example.invalid', 'commit', '-qam', 'New upstream release');
    fs.writeFileSync(path.join(dirty, 'agent.txt'), 'local commit');
    command(dirty, 'git', '-c', 'user.name=Editor', '-c', 'user.email=editor@example.invalid', 'commit', '-qam', 'QA unpublished fix');
    const localId = command(dirty, 'git', 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dirty, 'agent.txt'), 'staged');
    command(dirty, 'git', 'add', 'agent.txt');
    fs.writeFileSync(path.join(dirty, 'agent.txt'), 'working');
    fs.writeFileSync(path.join(dirty, 'new-file'), 'untracked');
    const biz = release(runner, '.qa-bizanso-source', 'agent.js', 'release');
    release(runner, '.qa-csvmail-source', 'csvMailAgent/a.js', 'mail');
    const copy = path.join(workspace, 'bizanso');
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'agent.js'), 'QA-only edit');
    const baseline = command(biz, 'git', 'rev-parse', 'HEAD');
    const env = { RUNNER_TEMP: dir, GITHUB_WORKSPACE: runner, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), EXPLORER_QA_LAST_BIZANSO_COMMIT: baseline };
    const receipts = {};
    const inspect = scope => ({ inventory: inspectSources({ scope, workspace, tooling: path.join(dir, 'missing') }), receipts: structuredClone(receipts) });
    const snapshot = () => [behind, dirty].map(source => [command(source, 'git', 'show-ref'), fs.readFileSync(path.join(source, '.git/index')),
        fs.readFileSync(path.join(source, 'agent.txt')), command(source, 'git', 'diff', '--cached', '--binary')]);
    const before = snapshot();
    const result = await check('full', env, inspect);
    const gitBlocker = result.blockers.find(item => item.name === 'PromotionScoutV2');
    assert.ok(gitBlocker, JSON.stringify(result));
    assert.deepEqual(gitBlocker.commits, [{ id: localId, subject: 'QA unpublished fix' }]);
    assert.deepEqual(gitBlocker.files.map(item => item.path).sort(), ['agent.txt', 'new-file']);
    assert.deepEqual(result.blockers.find(item => item.name === 'bizanso').files.map(item => item.path), ['agent.js']);
    assert.equal(result.blockers.length, 2);
    assert.deepEqual(snapshot(), before);
    assert.equal(fs.readFileSync(path.join(copy, 'agent.js'), 'utf8'), 'QA-only edit');
    assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), new RegExp(localId));
    assert.equal(fs.existsSync(path.join(dir, 'qa-copy-preflight-state.json')), false);
    // Publish the exact local commit to the runner fixture and reconcile edits.
    const promo = path.join(runner, '.qa-promotionscout-source');
    command(promo, 'git', 'fetch', '-q', dirty, 'main');
    command(promo, 'git', 'merge', '--ff-only', 'FETCH_HEAD');
    command(dirty, 'git', 'restore', '--staged', '--worktree', 'agent.txt');
    fs.unlinkSync(path.join(dirty, 'new-file'));
    fs.writeFileSync(path.join(copy, 'agent.js'), 'release');
    assert.deepEqual((await check('full', env, inspect)).blockers, []);
    assert.deepEqual(snapshot()[0], before[0]);
    // A new published archive may differ from the last installed copy.
    fs.writeFileSync(path.join(biz, 'agent.js'), 'new release');
    command(biz, 'git', '-c', 'user.name=Release', '-c', 'user.email=release@example.invalid', 'commit', '-qam', 'New release');
    assert.deepEqual((await check('bizanso', env, inspect)).blockers, []);
    const save = (_action, _scope, data) => {
        const { version, name, ...receipt } = JSON.parse(data);
        assert.equal(version, 1); receipts[name] = receipt;
    };
    recordCopy('prepare', 'bizanso', env, inspect, save);
    assert.throws(() => recordCopy('installed', 'bizanso', env, inspect, save), /differs/);
    assert.deepEqual((await check('bizanso', env, inspect)).blockers, []);
    fs.writeFileSync(path.join(copy, 'agent.js'), 'new release');
    assert.throws(() => recordCopy('installed', 'bizanso', env, inspect, () => { throw Error('write failed'); }), /write failed/);
    assert.deepEqual((await check('bizanso', env, inspect)).blockers, []);
    recordCopy('installed', 'bizanso', env, inspect, save);
    assert.ok(receipts.bizanso.installed);
    assert.equal(receipts.bizanso.pending, undefined);
});

test('lock and receipt failures are actionable before deployment', async t => {
    const dir = tmp(t);
    const env = { RUNNER_TEMP: dir, GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: path.join(dir, 'summary') };
    const result = await check('full', env, () => { throw Error('Another QA operation holds the deployment lock.'); });
    assert.match(result.blockers[0].reason, /lock/);
    const { inventory } = inspectRemote('bizanso', () => JSON.stringify({
        inventory: { repos: [], copies: [], errors: [] }, receipts: { bizanso: 'invalid' },
    }));
    assert.deepEqual(inventory.errors.map(item => item.name), ['bizanso']);
});

test('each workflow gates its first host mutation and brackets each installed source copy', () => {
    for (const [key, scope, deploy] of [['ploinky', 'full', 'Bootstrap the host and deploy'], ['bizanso', 'bizanso', 'Deploy Bizanso through Ploinky'], ['scriptahub', 'scriptahub', 'Deploy ScriptaHub through Ploinky']]) {
        const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-explorer-qa-' + key + '.yml'), 'utf8');
        const gate = workflow.indexOf('run: node .github/scripts/qaPredeploy.mjs check ' + scope);
        assert.ok(gate > workflow.indexOf('- name: Prepare SSH key') && gate < workflow.indexOf('- name: ' + deploy));
        assert.match(workflow.slice(gate), /failure\(\).*source_check\.outcome == 'failure'/);
        const copies = scope === 'full' ? ['bizanso', 'simpleCSVMailSend'] : scope === 'bizanso' ? ['bizanso'] : [];
        for (const name of copies) {
            const prepare = workflow.indexOf('qaPredeploy.mjs prepare ' + name);
            const write = workflow.indexOf(name === 'bizanso' ? '| run_in_box "$COPY_PROGRAM"' : '| run_in_box "$CSVMAIL_PLACE_PROGRAM"', prepare);
            assert.ok(gate < prepare && prepare < write && write < workflow.indexOf('qaPredeploy.mjs installed ' + name));
        }
    }
});
