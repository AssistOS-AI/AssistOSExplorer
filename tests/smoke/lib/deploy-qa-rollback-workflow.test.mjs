import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/rollback-explorer-qa.yml', import.meta.url), 'utf8');
const deploy = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const locked = workflow.match(/<<'ROLLBACK'\n([\s\S]*?)\n {10}ROLLBACK\n/)[1].replace(/^ {10}/gm, '');

function step(name) {
    const match = workflow.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)(?=\\n      - name: |$)`));
    assert.ok(match, `Missing step ${name}`);
    return match[1];
}

function stepScript(name) {
    const run = step(name).match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/);
    assert.ok(run, `Missing script of ${name}`);
    return run[1].replace(/^ {10}/gm, '');
}

test('the rollback workflow has one plan or execute choice, defaults to plan and shares the deployment lock group', () => {
    const dispatch = workflow.match(/^on:\n([\s\S]*?)\n\n/m)[1];
    assert.equal(dispatch, [
        '  workflow_dispatch:',
        '    inputs:',
        '      action:',
        '        description: plan (default, read-only) or execute the recovery of the newest redeploy backup',
        '        type: choice',
        '        default: plan',
        '        options:',
        '          - plan',
        '          - execute',
    ].join('\n'));
    assert.deepEqual([...dispatch.matchAll(/^ {6}([a-z_]+):/gm)].map(match => match[1]), ['action']);
    assert.match(workflow, /concurrency:\n {2}group: deploy-explorer-qa\n {2}cancel-in-progress: false\n/);
    assert.match(workflow, /timeout-minutes: 120\n/);
    assert.match(workflow, /permissions:\n {6}contents: read\n/);
    assert.match(workflow, /uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false\n/);
    assert.doesNotMatch(workflow, /rollback-plan|rollback-execute|confirm:|expected_explorer_commit|rollback_backup|rollback_current_id/);
    const scripts = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)];
    assert(scripts.length >= 4);
    for (const [, script] of scripts) assert.doesNotMatch(script, /\$\{\{ *inputs\./, 'the input reaches a shell script only through env');
    // The same shared group as the deploy workflow, so the two never overlap.
    assert.match(deploy, /concurrency:\n {2}group: deploy-explorer-qa\n {2}cancel-in-progress: false\n/);
});

test('the rollback workflow pins the same host identity once and compares it before any SSH', () => {
    for (const line of ["SSH_USER: 'admin'", "SSH_HOST: '45.136.70.141'", "SSH_ED25519_FINGERPRINT: 'SHA256:pcVG+7QFbfi3Ojn3LeveNutqCWaTOIlgek1o3GKD/KA'"]) {
        assert.ok(workflow.includes(line) && deploy.includes(line), line);
    }
    assert.equal(workflow.match(/ssh-keyscan/g)?.length, 1);
    const pin = step('Pin the Explorer QA SSH identity');
    assert.match(pin, /ssh-keyscan -T 10 -t ed25519 "\$SSH_HOST" > ~\/\.ssh\/explorer_qa_known_hosts/);
    assert.match(pin, /= "\$SSH_ED25519_FINGERPRINT"/);
    assert.match(pin, /admin@45\.136\.70\.141/);
    assert.ok(workflow.indexOf('ssh-keyscan') < workflow.indexOf('ssh -i') || workflow.indexOf('ssh-keyscan') < workflow.indexOf('"${SSH[@]}"'));
    assert.ok(workflow.indexOf('= "$SSH_ED25519_FINGERPRINT"') < workflow.indexOf('mktemp -d /tmp/explorer-qa-rollback.XXXXXXXX'));
    assert.match(workflow, /StrictHostKeyChecking=yes/);
});

test('one locked SSH session runs the selector and the backup helper, from a private remote directory', () => {
    const run = stepScript('Select the newest backup and run its own recovery helper');
    assert.match(run, /mktemp -d \/tmp\/explorer-qa-rollback\.XXXXXXXX/);
    assert.match(run, /\[\[ "\$REMOTE_DIR" =~ \^\/tmp\/explorer-qa-rollback\\\.\[A-Za-z0-9\]\{8\}\$ \]\]/);
    assert.equal(run.match(/flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation\.lock bash -s -- '\$REMOTE_DIR' '\$ACTION'/g)?.length, 1);
    assert.equal(run.match(/<<'ROLLBACK'/g)?.length, 1, 'a single remote session');
    assert.equal(run.match(/^ {0}"\$\{SSH\[@\]\}" "\$\{SSH_USER\}@\$\{SSH_HOST\}" \\$/gm)?.length, 1, 'one SSH session after the upload');
    for (const helper of ['qa-backups.mjs', 'qa-backups-privileged.mjs', 'update-explorer-qa.mjs', 'rollback-explorer-qa.mjs']) {
        assert.ok(run.includes(helper), helper);
    }
    assert.match(run, /for helper in qa-backups\.mjs qa-backups-privileged\.mjs update-explorer-qa\.mjs rollback-explorer-qa\.mjs; do/);
    assert.match(run, /trap cleanup_rollback EXIT/);
    assert.match(locked, /rollback-target --lock-held\)"; then/);
    assert.match(locked, /"\$node_home\/bin\/node" "\$BACKUP\/helpers\/rollback-explorer-qa\.mjs" plan "\$BACKUP" --current-id "\$current_id" --lock-held\n/);
    assert.match(locked, /if \[ "\$action" = execute \]; then\n[\s\S]*rollback-explorer-qa\.mjs" execute "\$BACKUP" --current-id "\$current_id" --lock-held\nfi/);
});

test('every shell block and the remote session parse as shell', () => {
    const blocks = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)];
    for (const [index, match] of blocks.entries()) {
        const source = match[1].replace(/^ {10}/gm, '').replace(/\$\{\{.*?\}\}/g, 'workflow-value');
        const checked = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8', timeout: 5000 });
        assert.equal(checked.status, 0, `shell block ${index}: ${checked.stderr}`);
    }
    const remote = spawnSync('bash', ['-n'], { input: locked, encoding: 'utf8', timeout: 5000 });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(workflow.match(/^ {10}ROLLBACK$/gm)?.length, 1);
});

test('the runner rejects every action but plan and execute before any SSH', () => {
    const run = action => spawnSync('bash', ['-c', stepScript('Validate the requested action')], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, ...(action === undefined ? {} : { ROLLBACK_ACTION: action }) } });
    for (const action of [undefined, '', 'plan', 'execute']) assert.equal(run(action).status, 0, String(action));
    for (const action of ['rollback-plan', 'rollback-execute', 'Execute', 'plan execute', 'destroy', 'redeploy-AbCd1234']) {
        const result = run(action);
        assert.equal(result.status, 1, action);
        assert.match(result.stdout, /::error::/);
    }
});

// The locked session against stub binaries. The tools Node is one stub that answers the selector and
// the backup helper; any other node invocation (the JSON parser) runs the real node.
function arch() { return os.arch() === 'arm64' ? 'arm64' : 'x64'; }

function runSession(t, { action = 'plan', selection = { result: 'selected', backup: 'redeploy-AbCd1234', currentId: 'absent', predecessorId: 'b'.repeat(64), candidates: [] },
    selectorOutput, selectorStatus = 0, helpers = true, runtimePath, dir } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rollback-session-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = path.join(root, 'tools');
    const nodeHome = path.join(tools, `node-v24.19.0-linux-${arch()}`);
    fs.mkdirSync(path.join(nodeHome, 'bin'), { recursive: true });
    const marker = path.join(root, 'calls');
    const rollbackDir = dir ?? `/tmp/explorer-qa-rollback.${Math.random().toString(36).slice(2, 10).padEnd(8, 'x').replace(/[^A-Za-z0-9]/g, 'x')}`;
    const backups = path.join(root, 'backups');
    const backup = path.join(backups, 'redeploy-AbCd1234');
    fs.mkdirSync(path.join(backup, 'helpers'), { recursive: true });
    if (helpers) fs.writeFileSync(path.join(backup, 'helpers/rollback-explorer-qa.mjs'), '// backup helper\n');
    fs.writeFileSync(path.join(backup, 'helpers/node-runtime-path'), `${runtimePath ?? nodeHome}\n`);
    fs.writeFileSync(path.join(nodeHome, 'bin/node'), `#!/bin/sh
[ "$1" = '--version' ] && { echo v24.19.0; exit 0; }
case "$*" in
  *qa-backups.mjs\\ rollback-target*)
    echo "node $*" >> '${marker}'
    printf '%s\\n' "$QA_STUB_SELECTION"
    exit ${selectorStatus} ;;
  *rollback-explorer-qa.mjs\\ plan*|*rollback-explorer-qa.mjs\\ execute*)
    echo "node $*" >> '${marker}'
    exit 0 ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `id() { echo admin; }\n${locked
        .replaceAll('/home/admin/.qa-deployment-backups', backups)
        .replaceAll('/home/admin/.qa-deployment-tools', tools)
        .replaceAll('/home/admin/\\.qa-deployment-tools', tools)}`;
    const result = spawnSync('bash', ['-s', '--', rollbackDir, action], { input: script, encoding: 'utf8', timeout: 20000,
        env: { PATH: process.env.PATH, HOME: '/home/admin', QA_STUB_SELECTION: selectorOutput ?? JSON.stringify(selection) } });
    return { result, calls: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [], backup };
}

test('plan runs the selector and then only the backup helper plan, under the held lock', t => {
    const { result, calls, backup } = runSession(t);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /qa-backups\.mjs rollback-target --lock-held$/);
    assert.equal(calls[1].endsWith(`${backup}/helpers/rollback-explorer-qa.mjs plan ${backup} --current-id absent --lock-held`), true, calls[1]);
    assert.match(result.stdout, /\[deploy-qa\] Rollback selection: \{"result":"selected","backup":"redeploy-AbCd1234","currentId":"absent"/);
    assert.doesNotMatch(calls.join('\n'), / execute /);
});

test('execute runs the same backup helper plan first and then execute, with the selected Box ID', t => {
    const currentId = 'c'.repeat(64);
    const { result, calls, backup } = runSession(t, { action: 'execute', selection: { result: 'selected', backup: 'redeploy-AbCd1234', currentId, predecessorId: 'b'.repeat(64), candidates: [] } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].endsWith(`rollback-explorer-qa.mjs plan ${backup} --current-id ${currentId} --lock-held`), true, calls[1]);
    assert.equal(calls[2].endsWith(`rollback-explorer-qa.mjs execute ${backup} --current-id ${currentId} --lock-held`), true, calls[2]);
});

test('a refused or failed selector prints its answer and runs no recovery', t => {
    const refused = JSON.stringify({ result: 'refused', backup: 'redeploy-AbCd1234', reason: 'rollback-already-attempted', candidates: [] });
    for (const action of ['plan', 'execute']) {
        const { result, calls } = runSession(t, { action, selectorOutput: refused, selectorStatus: 1 });
        assert.equal(result.status, 1);
        assert.match(result.stdout, /"result":"refused".*"reason":"rollback-already-attempted"/);
        assert.match(result.stderr, /no redeploy backup is eligible/);
        assert.equal(calls.length, 1);
    }
});

test('a malformed selector answer exits non-zero before any backup helper runs', t => {
    const good = { result: 'selected', backup: 'redeploy-AbCd1234', currentId: 'absent', predecessorId: 'b'.repeat(64), candidates: [] };
    for (const [name, selection] of [
        ['a seven character backup', { ...good, backup: 'redeploy-AbCd123' }],
        ['a nine character backup', { ...good, backup: 'redeploy-AbCd12345' }],
        ['a path traversal backup', { ...good, backup: '../redeploy-AbCd1234' }],
        ['a backup with a shell fragment', { ...good, backup: "redeploy-AbCd1234'; touch x; '" }],
        ['a missing backup', { ...good, backup: undefined }],
        ['a 63 character Box ID', { ...good, currentId: 'c'.repeat(63) }],
        ['an uppercase Box ID', { ...good, currentId: 'C'.repeat(64) }],
        ['an empty Box ID', { ...good, currentId: '' }],
        ['a missing Box ID', { ...good, currentId: undefined }],
        ['a Box ID with a trailing option', { ...good, currentId: `${'c'.repeat(64)} --extra` }],
        ['a result that is not selected', { ...good, result: 'planned' }],
    ]) {
        const { result, calls } = runSession(t, { action: 'execute', selection });
        assert.notEqual(result.status, 0, name);
        assert.equal(calls.length, 1, `${name}: only the selector ran`);
    }
    const garbage = runSession(t, { selectorOutput: 'not json' });
    assert.notEqual(garbage.result.status, 0);
    assert.equal(garbage.calls.length, 1);
});

test('the backup must carry its own regular helpers and a pinned Node runtime', t => {
    assert.notEqual(runSession(t, { helpers: false }).result.status, 0);
    assert.equal(runSession(t, { helpers: false }).calls.length, 1);
    for (const runtimePath of ['/usr/bin', '/home/admin/.qa-deployment-tools/node-v20.0.0-linux-x64', '/tmp/evil']) {
        const { result, calls } = runSession(t, { runtimePath });
        assert.notEqual(result.status, 0, runtimePath);
        assert.equal(calls.length, 1, runtimePath);
    }
});

test('the session refuses a wrong action or directory before touching the host', t => {
    for (const options of [{ action: 'rollback-plan' }, { action: 'Execute' }, { action: '' }, { dir: '/tmp/explorer-qa-rollback.short' }, { dir: '/etc' }]) {
        const { result, calls } = runSession(t, options);
        assert.notEqual(result.status, 0, JSON.stringify(options));
        assert.deepEqual(calls, []);
    }
});
