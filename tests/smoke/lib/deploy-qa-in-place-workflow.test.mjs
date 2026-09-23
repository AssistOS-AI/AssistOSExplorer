import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const admission = workflow.match(/# BEGIN QA fresh-install admission\n([\s\S]*?)# END QA fresh-install admission/)[1]
    .replace(/^ {10}/gm, '');

test('deployment automatically updates existing QA without an input or recreate fallback', () => {
    assert.match(workflow, /workflow_dispatch:\s*\n\s*\nconcurrency:/);
    assert.match(workflow, /name: Update the existing Explorer QA installation in place\n\s+id: inplace/);
    assert.match(workflow, /name: Reconcile and start Explorer QA Box\n\s+if: steps\.inplace\.outputs\.updated == 'false'/);
    assert.match(workflow, /if \[ "\$status" -eq 42 \]; then\n\s+echo 'updated=false'/);
    assert.match(workflow, /The deploy workflow will not recreate or destroy this installation/);
    assert.match(workflow, /flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation.lock bash -s -- '\$REMOTE_DIR'/);
    assert.match(workflow, /assert_qa_bootstrap_absent\n\s+QA_CAPTURE=/);
    assert(workflow.indexOf('# BEGIN QA fresh-install admission') < workflow.indexOf('QA_CONTAINER_RECORDS=()'));
});

function runAdmission(t, { workspace = 'absent', labelled = false, named = false, engineFailure = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bootstrap-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    if (workspace === 'file') fs.writeFileSync(target, 'operator data');
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'missing'), target);
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
docker() { podman "$@"; }
`;
    const checked = spawnSync('bash', ['-c', `set -euo pipefail\n${mock}\n${admission.replaceAll('/home/admin/explorerQaWorkspace', target)}`], {
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
