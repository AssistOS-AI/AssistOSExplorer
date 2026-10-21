import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const admission = workflow.match(/# BEGIN QA fresh-install admission\n([\s\S]*?)# END QA fresh-install admission/)[1]
    .replace(/^ {10}/gm, '');

test('deploy dispatch has no inputs and no inputs. reference', () => {
    assert.equal(workflow.match(/^on:\n {2}workflow_dispatch:\n\nconcurrency:/m)?.length, 1);
    assert.doesNotMatch(workflow, /inputs:|inputs\./);
});

test('deployment takes no inputs, updates in place by default and has no recreate fallback', () => {
    const dispatch = workflow.match(/^on:\n([\s\S]*?)\nconcurrency:/m)[1];
    assert.equal(dispatch, '  workflow_dispatch:\n');
    assert.equal(workflow.includes('inputs'), false, 'neither an inputs block nor an inputs reference remains');
    assert.doesNotMatch(workflow, /inputs:|inputs\./);
    assert.match(workflow, /concurrency:\n {2}group: deploy-explorer-qa\n {2}cancel-in-progress: false\n/);
    const header = workflow.match(/\n {2}deploy:\n([\s\S]*?)\n {4}steps:/)[1];
    assert.doesNotMatch(header, /\n {4}if:/, 'no job-level condition selects between deploy and rollback');
    assert.deepEqual(workflow.slice(workflow.indexOf('\njobs:\n')).match(/^ {2}[A-Za-z-]+:$/gm), ['  deploy:'], 'the deploy job is the only job');
    assert.doesNotMatch(workflow, /^ {2}rollback:/m);
    assert.doesNotMatch(workflow, /in_place_only|IN_PLACE_ONLY|qa-in-place-guard/);
    assert.match(workflow, /name: Update the existing Explorer QA installation in place\n\s+id: inplace/);
    assert.match(workflow, /name: Reconcile and start Explorer QA Box\n\s+if: steps\.inplace\.outputs\.updated == 'false'/);
    assert.match(workflow, /if \[ "\$status" -eq 42 \]; then\n\s+echo 'updated=false'/);
    assert.match(workflow, /The deploy workflow will not recreate or destroy this installation/);
    assert.match(workflow, /flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation.lock bash -s -- '\$REMOTE_DIR' '\$EXPECTED_EXPLORER_COMMIT'/);
    assert.match(workflow, /assert_qa_install_admission\n\s+QA_CAPTURE=/);
    assert(workflow.indexOf('# BEGIN QA fresh-install admission') < workflow.indexOf('QA_CONTAINER_RECORDS=()'));
});

// A model of the container engines. Each container is { engine, id, name, running }.
function engineMock(containers, { engineFailure = false } = {}) {
    const table = containers.map(({ engine = 'podman', id, name, running = true }) => `${engine}|${id}|${name}|${running}`).join('\n');
    return `
QA_MOCK_TABLE='${table}'
mock_engine() {
    local engine="$1"; shift
    local row row_engine row_id row_name row_running
    if [ "$1 $2" = 'container ls' ]; then
        ${engineFailure ? 'return 125' : ':'}
        while IFS='|' read -r row_engine row_id row_name row_running; do
            [ "$row_engine" = "$engine" ] && echo "$row_id"
        done <<< "$QA_MOCK_TABLE"
        return 0
    fi
    if [ "$1 $2" = 'container inspect' ]; then
        local subject="$3" format="\${5:-}"
        while IFS='|' read -r row_engine row_id row_name row_running; do
            [ -n "$row_id" ] || continue
            [ "$row_engine" = "$engine" ] || continue
            if [ "$subject" = "$row_id" ] || [ "$subject" = "$row_name" ]; then
                case "$format" in
                    '{{.Name}}|{{.State.Running}}') echo "/$row_name|$row_running" ;;
                    '{{.State.Running}}') echo "$row_running" ;;
                    '{{.Name}}') echo "/$row_name" ;;
                    '{{.Id}}') echo "$row_id" ;;
                    *'path-hash'*) echo 7a31ab7775eb ;;
                    *'.role'*) echo box ;;
                    '') ;;
                    *) echo "unexpected format $format" >&2; exit 99 ;;
                esac
                return 0
            fi
        done <<< "$QA_MOCK_TABLE"
        return 1
    fi
    if [ "$1 $2" = 'container exec' ]; then echo "exec $engine $3" >> "$QA_MOCK_CALLS"; return 0; fi
    if [ "$1 $2" = 'volume ls' ]; then return 0; fi
    if [ "$1 $2" = 'volume inspect' ]; then return 1; fi
    echo "unexpected container mutation: $*" >&2
    exit 99
}
podman() { mock_engine podman "$@"; }
docker() { mock_engine docker "$@"; }
`;
}

const BOX = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
const exact = (extra = {}) => ({ id: '1'.repeat(64), name: BOX, running: true, ...extra });
const retained = (kind, suffix, extra = {}) => {
    const name = `${BOX}-${kind}-redeploy-${suffix}`;
    return { id: crypto.createHash('sha256').update(name).digest('hex'), name, running: false, ...extra };
};

function runAdmission(t, { workspace = 'absent', containers = [], engineFailure = false, operation } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-bootstrap-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    if (workspace === 'file') fs.writeFileSync(target, 'operator data');
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'missing'), target);
    const checked = spawnSync('bash', ['-c', `set -euo pipefail\nQA_MOCK_CALLS=${path.join(root, 'calls')}\n${operation ? `QA_OPERATION=${operation}\n` : ''}${engineMock(containers, { engineFailure })}\n${admission.replaceAll('/home/admin/explorerQaWorkspace', target)}`], {
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

for (const [name, containers] of [
    ['a labelled Box', [exact()]],
    ['a stopped retained predecessor', [retained('rollback', 'AbCd1234')]],
    ['a stopped retained failed replacement', [retained('failed', 'AbCd1234')]],
]) {
    test(`bootstrap refuses a retained QA container (${name})`, t => {
        const checked = runAdmission(t, { containers });
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, /refuses an existing QA Box/);
    });
}

test('bootstrap refuses a Box that is only reachable by name', t => {
    const checked = runAdmission(t, { containers: [{ engine: 'docker', id: '3'.repeat(64), name: BOX }] });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /refuses an existing QA Box/);
});

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

test('redeploy admits exactly one existing workspace and exact Box', t => {
    const checked = runAdmission(t, { workspace: 'directory', containers: [exact()], operation: 'redeploy' });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /\[deploy-qa\] Preserving redeploy admitted: one existing workspace and exact Box\./);
});

// AC10: a second redeploy is admitted beside the Boxes an earlier redeploy or rollback retained.
for (const [name, extras] of [
    ['a stopped retained predecessor', [retained('rollback', 'AbCd1234')]],
    ['a stopped retained failed replacement', [retained('failed', 'AbCd1234')]],
    ['both retained kinds from two redeploys', [retained('rollback', 'AbCd1234'), retained('failed', 'ZyXw9876'), retained('rollback', 'QqRr5555')]],
]) {
    test(`redeploy is admitted beside ${name}`, t => {
        const checked = runAdmission(t, { workspace: 'directory', containers: [exact(), ...extras], operation: 'redeploy' });
        assert.equal(checked.status, 0, checked.stderr);
        assert.match(checked.stdout, /Preserving redeploy admitted/);
    });
}

test('redeploy refuses a running retained-pattern Box', t => {
    for (const kind of ['rollback', 'failed']) {
        const checked = runAdmission(t, { workspace: 'directory', containers: [exact(), retained(kind, 'AbCd1234', { running: true })], operation: 'redeploy' });
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, /retained predecessor Box is running/);
        assert.doesNotMatch(checked.stdout, /admitted/);
    }
});

for (const [name, containers, message] of [
    ['no Box', [], /exactly one existing QA Box/],
    // The only case where the labelled count passes and the exact-name count alone refuses.
    ['a labelled Box without the exact name', [{ id: '4'.repeat(64), name: 'someone-else', running: true }], /exactly one existing QA Box/],
    ['a retained Box without a current Box',[retained('rollback', 'AbCd1234')], /exactly one existing QA Box/],
    ['two exact Boxes in two engines', [exact(), exact({ engine: 'docker', id: '2'.repeat(64) })], /exactly one existing QA Box/],
    ['a near-miss name with an extra suffix', [exact(), { ...retained('rollback', 'AbCd1234'), name: `${BOX}-rollback-redeploy-AbCd1234-x` }], /exactly one existing QA Box/],
    ['a near-miss name with a short id', [exact(), { ...retained('rollback', 'AbCd1234'), name: `${BOX}-rollback-redeploy-AbCd123` }], /exactly one existing QA Box/],
    ['a near-miss name with a long id', [exact(), { ...retained('rollback', 'AbCd1234'), name: `${BOX}-rollback-redeploy-AbCd12345` }], /exactly one existing QA Box/],
    ['a near-miss kind', [exact(), { ...retained('rollback', 'AbCd1234'), name: `${BOX}-restored-redeploy-AbCd1234` }], /exactly one existing QA Box/],
    ['a stopped current Box beside a labelled stranger', [exact(), { id: '4'.repeat(64), name: 'someone-else', running: false }], /exactly one existing QA Box/],
]) {
    test(`redeploy refuses ${name}`, t => {
        const checked = runAdmission(t, { workspace: 'directory', containers, operation: 'redeploy' });
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, message);
        assert.doesNotMatch(checked.stdout, /admitted/);
    });
}

for (const [name, options] of [
    ['an absent workspace', { containers: [exact()] }],
    ['a symlinked workspace', { workspace: 'symlink', containers: [exact()] }],
    ['a workspace file', { workspace: 'file', containers: [exact()] }],
]) {
    test(`redeploy refuses ${name}`, t => {
        const checked = runAdmission(t, { ...options, operation: 'redeploy' });
        assert.notEqual(checked.status, 0);
        assert.match(checked.stderr, /requires an existing QA workspace directory/);
    });
}

test('redeploy refuses an engine that cannot prove the Box inventory', t => {
    const checked = runAdmission(t, { workspace: 'directory', engineFailure: true, containers: [exact()], operation: 'redeploy' });
    assert.notEqual(checked.status, 0);
    assert.doesNotMatch(checked.stdout, /admitted/);
});

test('update admission is unchanged when the operation is named explicitly, and still refuses a retained Box', t => {
    assert.equal(runAdmission(t, { operation: 'update' }).status, 0);
    assert.notEqual(runAdmission(t, { operation: 'update', workspace: 'directory' }).status, 0);
    assert.notEqual(runAdmission(t, { operation: 'update', containers: [retained('rollback', 'AbCd1234')] }).status, 0);
});

// The record loop between the canonicalizer and the ambiguity check.
const recordLoop = (() => {
    const start = workflow.indexOf('          canonicalize_container_candidates() {');
    const end = workflow.indexOf('          if [ "${#QA_CONTAINER_RECORDS[@]}" -gt 1 ]; then');
    assert(start > 0 && end > start);
    return workflow.slice(start, end).replace(/^ {10}/gm, '');
})();

function runRecordLoop(t, containers) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-record-loop-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls = path.join(root, 'calls');
    const script = `set -euo pipefail\nQA_MOCK_CALLS=${calls}\nBOX_PATH_HASH=7a31ab7775eb\nBOX_INSTANCE=${BOX}\n${engineMock(containers)}\n${recordLoop}\nprintf 'record=%s\\n' "\${QA_CONTAINER_RECORDS[@]}"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('the record loop logs a stopped retained Box and records only the current Box', t => {
    const old = retained('rollback', 'AbCd1234');
    const { result, calls } = runRecordLoop(t, [exact(), old, retained('failed', 'ZyXw9876')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\[deploy-qa\\] Retained Box: engine=podman id=${old.id} name=${old.name}`));
    assert.match(result.stdout, /Retained Box: .* name=ploinky-box-explorerqaworkspace-7a31ab7775eb-failed-redeploy-ZyXw9876/);
    assert.deepEqual(result.stdout.split('\n').filter(line => line.startsWith('record=')), [`record=podman|${'1'.repeat(64)}|${BOX}`]);
    assert.doesNotMatch(result.stdout, /Rollback Box: .*-redeploy-/);
    assert.equal(calls.includes(old.id), false, 'a retained Box is never exec-ed');
    assert.equal((calls.match(/exec/g) || []).length, 1, 'only the current Box lists its nested storage');
});

test('the record loop refuses a running retained-pattern Box and keeps the ownership check for everything else', t => {
    const running = runRecordLoop(t, [exact(), retained('rollback', 'AbCd1234', { running: true })]);
    assert.equal(running.result.status, 1);
    assert.match(running.result.stdout, /a retained Box is running/);
    assert.equal(running.calls.includes(retained('rollback', 'AbCd1234').id), false);
    // A labelled container with any other name still stops the run at the ownership check.
    const stranger = runRecordLoop(t, [exact(), { id: '5'.repeat(64), name: `${BOX}-rollback-redeploy-AbCd1234-x`, running: false }]);
    assert.equal(stranger.result.status, 1);
    assert.match(stranger.result.stdout, /conflicting ownership labels/);
});
