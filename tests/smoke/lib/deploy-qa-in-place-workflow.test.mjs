import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const admission = workflow.match(/# BEGIN QA fresh-install admission\n([\s\S]*?)# END QA fresh-install admission/)[1]
    .replace(/^ {10}/gm, '');

test('deployment updates existing QA in place by default and has no recreate fallback', () => {
    const dispatch = workflow.match(/^on:\n([\s\S]*?)\nconcurrency:/m)[1];
    assert.match(dispatch, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}operation:\n/);
    assert.match(dispatch, /type: choice\n {8}default: update\n {8}options:\n {10}- update\n {10}- redeploy-rehearsal\n {10}- redeploy\n {10}- rollback-plan\n {10}- rollback-execute\n/);
    for (const input of ['expected_explorer_commit', 'rollback_backup', 'rollback_current_id', 'confirm']) {
        assert.match(dispatch, new RegExp(`\\n {6}${input}:\\n {8}description: .*\\n {8}type: string\\n {8}default: ''\\n`));
    }
    assert.doesNotMatch(workflow, /in_place_only|IN_PLACE_ONLY|qa-in-place-guard/);
    assert.match(workflow, /name: Update the existing Explorer QA installation in place\n\s+id: inplace/);
    assert.match(workflow, /name: Reconcile and start Explorer QA Box\n\s+if: steps\.inplace\.outputs\.updated == 'false'/);
    assert.match(workflow, /if \[ "\$status" -eq 42 \]; then\n\s+echo 'updated=false'/);
    assert.match(workflow, /The deploy workflow will not recreate or destroy this installation/);
    assert.match(workflow, /flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation.lock bash -s -- '\$REMOTE_DIR' '\$OPERATION'/);
    assert.match(workflow, /assert_qa_install_admission\n\s+QA_CAPTURE=/);
    assert(workflow.indexOf('# BEGIN QA fresh-install admission') < workflow.indexOf('QA_CONTAINER_RECORDS=()'));
});

function runAdmission(t, { workspace = 'absent', labelled = false, named = false, engineFailure = false,
    operation, dockerBox = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bootstrap-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    if (workspace === 'file') fs.writeFileSync(target, 'operator data');
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'missing'), target);
    // Without an explicit second engine, docker is the same mock as podman (the update tests rely on it);
    // a redeploy case names the engines that hold the Box.
    const mock = `
podman() {
    if [ "$1 $2" = 'container ls' ]; then
        ${engineFailure ? 'return 125' : labelled ? "echo existing-qa-container" : ':'}
        return 0
    fi
    if [ "$1 $2" = 'container inspect' ]; then
        return ${named ? '0' : '1'}
    fi
    echo "unexpected container mutation: $*" >&2
    exit 99
}
${operation ? `docker() {
    if [ "$1 $2" = 'container ls' ]; then ${dockerBox ? 'echo existing-qa-container' : ':'}; return 0; fi
    if [ "$1 $2" = 'container inspect' ]; then return ${dockerBox ? '0' : '1'}; fi
    exit 99
}` : 'docker() { podman "$@"; }'}
`;
    const checked = spawnSync('bash', ['-c', `set -euo pipefail\n${operation ? `QA_OPERATION=${operation}\n` : ''}${mock}\n${admission.replaceAll('/home/admin/explorerQaWorkspace', target)}`], {
        encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(checked.status, 99, checked.stderr);
    return checked;
}

test('bootstrap accepts only absence of both workspace and QA container', t => {
    const checked = runAdmission(t);
    assert.equal(checked.status, 0, checked.stderr);
});

for (const workspace of ['directory', 'file', 'symlink']) {
    test(`bootstrap refuses an existing ${workspace} without inspecting or deleting its contents`, t => {
        const checked = runAdmission(t, { workspace });
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, /requires an absent QA workspace/);
    });
}

for (const options of [{ labelled: true }, { named: true }]) {
    test(`bootstrap refuses a retained QA container ${JSON.stringify(options)}`, t => {
        const checked = runAdmission(t, options);
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, /refuses an existing QA Box/);
    });
}

test('bootstrap fails closed when the container engine cannot prove absence', t => {
    assert.notEqual(runAdmission(t, { engineFailure: true }).status, 0);
});

test('all deployment shell blocks parse after GitHub expression substitution', () => {
    const blocks = [...workflow.matchAll(/^        run: \|\n((?: {10}.*\n|\n)+)/gm)];
    assert(blocks.length >= 8);
    for (const [index, match] of blocks.entries()) {
        const source = match[1].replace(/^ {10}/gm, '').replace(/\$\{\{.*?\}\}/g, 'workflow-value');
        const checked = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8', timeout: 5000 });
        assert.equal(checked.status, 0, `shell block ${index}: ${checked.stderr}`);
    }
});

for (const operation of ['redeploy', 'redeploy-rehearsal']) {
    test(`${operation} admits exactly one existing workspace and exact Box`, t => {
        const checked = runAdmission(t, { workspace: 'directory', labelled: true, named: true, operation });
        assert.equal(checked.status, 0, checked.stderr);
        assert.match(checked.stdout, /\[deploy-qa\] Preserving redeploy admitted: one existing workspace and exact Box\./);
    });

    for (const [name, options, message] of [
        ['no Box', { workspace: 'directory' }, /exactly one existing QA Box/],
        ['a Box that only carries the label', { workspace: 'directory', labelled: true }, /exactly one existing QA Box/],
        ['two Boxes in two engines', { workspace: 'directory', labelled: true, named: true, dockerBox: true }, /exactly one existing QA Box/],
        ['an absent workspace', { labelled: true, named: true }, /requires an existing QA workspace directory/],
        ['a symlinked workspace', { workspace: 'symlink', labelled: true, named: true }, /requires an existing QA workspace directory/],
        ['a workspace file', { workspace: 'file', labelled: true, named: true }, /requires an existing QA workspace directory/],
        ['an engine that cannot prove the Box inventory', { workspace: 'directory', engineFailure: true, named: true }, null],
    ]) {
        test(`${operation} refuses ${name}`, t => {
            const checked = runAdmission(t, { ...options, operation });
            assert.notEqual(checked.status, 0);
            if (message) assert.match(checked.stderr, message);
            assert.doesNotMatch(checked.stdout, /admitted/);
        });
    }
}

test('update admission is unchanged when the operation is named explicitly', t => {
    assert.equal(runAdmission(t, { operation: 'update' }).status, 0);
    assert.notEqual(runAdmission(t, { operation: 'update', workspace: 'directory' }).status, 0);
});
