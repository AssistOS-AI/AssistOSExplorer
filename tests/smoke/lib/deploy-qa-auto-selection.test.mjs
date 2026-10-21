import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const locked = workflow.match(/<<'UPDATE' \|\| status=\$\?\n([\s\S]*?)\n {10}UPDATE\n/)[1].replace(/^ {10}/gm, '');
const dispatch = workflow.match(/          if \[ "\$status" -eq 42 \]; then\n([\s\S]*?)\n          fi\n/)[0].replace(/^ {10}/gm, '');
const COMMIT = 'a'.repeat(40);

const SELECTION = mode => JSON.stringify({ result: 'selected', mode, mutations: false, expectedCommit: COMMIT, previousCommit: 'b'.repeat(40),
    boxImage: { reference: 'docker.io/assistos/ploinky-box:latest', current: 'c'.repeat(64), remote: 'c'.repeat(64) },
    reasons: mode === 'redeploy' ? [{ source: '.runtime/ploinky', kind: 'commit', from: 'd'.repeat(40), to: 'e'.repeat(40) }] : [] });

// The stub stands in for the updater helper. Every other node invocation (the mode parser) runs the real node.
const SELECT = {
    'in-place': { output: SELECTION('in-place'), status: 0 },
    redeploy: { output: SELECTION('redeploy'), status: 0 },
    'node exit 42': { output: '', status: 42 },
    'node exit 43': { output: '', status: 43 },
    'node exit 1': { output: '{"result":"failed","status":"rejected","code":"QA_UPDATE_NOT_FAST_FORWARD"}', status: 1 },
    'node exit 19': { output: '', status: 19 },
    garbage: { output: 'not json', status: 0 },
    'unknown mode': { output: SELECTION('fresh'), status: 0 },
    'redeploy-looking text': { output: '"mode":"redeploy"', status: 0 },
    'two lines': { output: `${SELECTION('redeploy')}\n${SELECTION('redeploy')}`, status: 0 },
    'failed result': { output: JSON.stringify({ result: 'failed', mode: 'redeploy' }), status: 0 },
    'empty output': { output: '', status: 0 },
};

function runLocked(t, { workspace = 'absent', labelled = false, named = false, engineFailure = false, select = 'in-place',
    execute = 0, expected = COMMIT, drop = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-auto-selection-'));
    const updateDir = `/tmp/explorer-qa-update.${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(updateDir, { mode: 0o700 });
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(updateDir, { recursive: true, force: true });
    });
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    if (workspace === 'file') fs.writeFileSync(target, 'operator data');
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'missing'), target);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(root, 'calls');
    for (const name of ['podman', 'docker']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\nif [ "$1 $2" = 'container ls' ]; then\n${engineFailure ? 'exit 125' : labelled ? 'echo retained-box' : ':'}\nexit 0\nfi\n[ "$1 $2" = 'container inspect' ] && exit ${named ? 0 : 1}\nexit 99\n`, { mode: 0o755 });
    }
    const selected = SELECT[select];
    const selectionFile = path.join(root, 'selection');
    fs.writeFileSync(selectionFile, selected.output);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
[ "$1" = '--version' ] && { echo v24.19.0; exit 0; }
case "$*" in
  *update-explorer-qa.mjs\\ select*)
    echo "update $*" >> '${marker}'
    cat '${selectionFile}'
    exit ${selected.status} ;;
  *update-explorer-qa.mjs\\ execute*)
    echo "update $*" >> '${marker}'
    echo '{"result":"updated"}'
    exit ${execute} ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `id() { echo admin; }\n${locked.replaceAll('/home/admin/explorerQaWorkspace', target).replace(/node_home="[^"]+"/, `node_home='${root}'`)}`;
    const result = spawnSync('bash', ['-s', '--', updateDir, ...(drop ? [] : [expected])], {
        input: script, encoding: 'utf8', timeout: 20000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/admin' },
    });
    return { result, calls: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '' };
}

test('locked deployment runs select and then execute with the pinned commit and no operator input', t => {
    const { result, calls } = runLocked(t, { workspace: 'directory' });
    assert.equal(result.status, 0, result.stderr);
    const lines = calls.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`update-explorer-qa.mjs select --expected-commit ${COMMIT} --lock-held$`));
    assert.match(lines[1], new RegExp(`update-explorer-qa.mjs execute --receipt \\S+/update.json --expected-commit ${COMMIT} --lock-held$`));
    assert.doesNotMatch(calls, /podman|docker/);
    assert.match(result.stdout, /^\[deploy-qa\] Deployment selection: \{"result":"selected","mode":"in-place"/m);
});

test('locked deployment hands a selected redeploy to Reconcile with exit 43 and never runs execute', t => {
    const { result, calls } = runLocked(t, { workspace: 'directory', select: 'redeploy' });
    assert.equal(result.status, 43, result.stderr);
    assert.match(result.stdout, /Deployment selection: \{"result":"selected","mode":"redeploy".*"kind":"commit"/);
    assert.match(result.stdout, /Preserving redeploy selected automatically; the in-place updater was not run\./);
    assert.match(calls, /select --expected-commit/);
    assert.doesNotMatch(calls, /execute|podman|docker/);
});

test('locked deployment selects first installation only after both engines prove absence', t => {
    const { result, calls } = runLocked(t);
    assert.equal(result.status, 42, result.stderr);
    for (const engine of ['podman', 'docker']) {
        assert.match(calls, new RegExp(`${engine} container ls`));
        assert.match(calls, new RegExp(`${engine} container inspect`));
    }
    assert.doesNotMatch(calls, /update/);
});

for (const [name, options] of Object.entries({
    'failed engine probe': { engineFailure: true },
    'labelled orphan Box': { labelled: true },
    'named orphan Box': { named: true },
})) {
    test(`locked deployment never selects first installation after ${name}`, t => {
        const { result, calls } = runLocked(t, options);
        assert.notEqual(result.status, 0);
        assert.notEqual(result.status, 42);
        assert.notEqual(result.status, 43);
        assert.doesNotMatch(calls, /update/);
    });
}

for (const workspace of ['symlink', 'file']) {
    test(`locked deployment refuses a ${workspace} workspace before running the updater`, t => {
        const { result, calls } = runLocked(t, { workspace });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /not a real directory/);
        assert.equal(calls, '');
    });
}

// AC7: no updater failure can fall through as 42 (fresh install) or 43 (redeploy).
for (const select of ['node exit 42', 'node exit 43', 'node exit 1', 'node exit 19', 'garbage', 'unknown mode',
    'redeploy-looking text', 'two lines', 'failed result', 'empty output']) {
    test(`a failing select (${select}) exits 1 and never reaches execute, 42 or 43`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', select });
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(calls, /execute/);
        assert.doesNotMatch(result.stdout, /Preserving redeploy selected/);
    });
}

test('a rejected select surfaces the updater answer in the log, so the failure is diagnosable', t => {
    const { result } = runLocked(t, { workspace: 'directory', select: 'node exit 1' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /"code":"QA_UPDATE_NOT_FAST_FORWARD"/);
    assert.doesNotMatch(result.stdout, /Deployment selection:/);
});

for (const execute of [42, 43, 19, 1]) {
    test(`a failing execute (node exit ${execute}) exits 1`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', execute });
        assert.equal(result.status, 1, result.stderr);
        assert.match(calls, /select --expected-commit[\s\S]*execute --receipt/);
    });
}

for (const [name, options] of Object.entries({
    'a missing commit': { drop: true },
    'a 39 character commit': { expected: 'a'.repeat(39) },
    'an uppercase commit': { expected: 'A'.repeat(40) },
    'a commit with a trailing option': { expected: `${COMMIT} --lock-held` },
})) {
    test(`locked deployment refuses ${name} before touching the host`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', ...options });
        assert.equal(result.status, 1);
        assert.equal(calls, '');
    });
}

test('the locked script produces 42 and 43 only from its own proofs and carries no operation argument', () => {
    assert.equal(locked.match(/exit 42/g).length, 1);
    assert.equal(locked.match(/exit 43/g).length, 1);
    assert.match(locked, /redeploy\)\n[\s\S]*?exit 43\n\s+;;/, 'exit 43 sits in the arm of a parsed redeploy selection');
    assert.match(locked, /selection="\$\(node "\$update_dir\/update-explorer-qa\.mjs" select --expected-commit "\$expected_commit" --lock-held\)" \|\| \{ printf '%s\\n' "\$selection"; exit 1; \}/);
    assert.match(locked, /\n\s*node "\$update_dir\/update-explorer-qa\.mjs" execute --receipt "\$update_dir\/update\.json" --expected-commit "\$expected_commit" --lock-held \|\| exit 1(?:\n|$)/);
    assert.doesNotMatch(locked, /operation|OPERATION|rehears/);
});

for (const [status, output, failed] of [
    [0, 'updated=true\n', false],
    [42, 'updated=false\n', false],
    [43, 'updated=false\noperation=redeploy\n', false],
    [19, '', true],
    [75, '', true],
    [1, '', true],
]) {
    test(`workflow result handler maps status ${status} without failure fallthrough`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-result-dispatch-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const outputFile = path.join(root, 'output');
        fs.writeFileSync(outputFile, '');
        // No OPERATION variable exists: status 43 selects the redeploy unconditionally.
        const env = { ...process.env, GITHUB_OUTPUT: outputFile };
        delete env.OPERATION;
        const result = spawnSync('bash', ['-c', `set -euo pipefail\nstatus=${status}\n${dispatch}`], { encoding: 'utf8', timeout: 5000, env });
        assert.equal(result.status, failed ? status : 0, result.stderr);
        assert.equal(fs.readFileSync(outputFile, 'utf8'), output);
        if (failed) {
            assert.match(result.stdout, /will not recreate or destroy/);
            assert.doesNotMatch(result.stdout, /proceeding to/i);
        }
    });
}
