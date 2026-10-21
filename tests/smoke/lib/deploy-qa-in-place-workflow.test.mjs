import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');

function shellBlock(name) {
    const match = workflow.match(new RegExp(`# BEGIN QA ${name}\\n([\\s\\S]*?)# END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

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
    assert.match(workflow, /flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation.lock bash -s -- '\$REMOTE_ENV_FILE' '\$\{OPERATION:-update\}'/);
});

// The Reconcile script has exactly two operations: a fresh installation (update) and a rebuild.
test('the Reconcile script accepts only the update and rebuild operations', () => {
    assert.match(workflow, /QA_OPERATION="\$\{2:-update\}"\n\s+case "\$QA_OPERATION" in\n\s+update\|rebuild\) ;;\n/);
    assert.doesNotMatch(workflow, /update\|redeploy|resume\) ;;/);
});

// AC9: the admission is the route re-proof under the Reconcile lock, and it precedes every mutation.
const EXACT = { engine: 'podman', id: 'a'.repeat(64), running: true };
const routed = (route, extra = {}) => ({ output: JSON.stringify({ result: 'routed', route, reason: 'fixture', marker: null, stash: false, exact: null, legacy: [], ...extra }), status: 0 });

function runReproof(t, { operation, answer }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-route-reproof-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(root, 'calls');
    const answerFile = path.join(root, 'answer');
    fs.writeFileSync(answerFile, answer.output);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-teardown.mjs\\ route*)
    echo "$*" >> '${calls}'
    cat '${answerFile}'
    exit ${answer.status} ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `set -euo pipefail
QA_OPERATION=${operation}
QA_HELPERS_DIR=/tmp/helpers
${shellBlock('route re-proof')}
echo "kind=$QA_ROUTE_KIND marker=$QA_MARKER_AT_ROUTE engine=$QA_EXACT_ENGINE id=$QA_EXACT_ID running=$QA_EXACT_RUNNING"
echo MARK_REACHED
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('a fresh installation is admitted only when the route is fresh and names no current Box', t => {
    for (const marker of [null, { operation: 'update' }, { operation: 'rebuild' }, { operation: 'destroy-keep' }]) {
        const { result, calls } = runReproof(t, { operation: 'update', answer: routed('fresh', { marker, stash: marker !== null }) });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(calls, /^\/tmp\/helpers\/qa-teardown\.mjs route --lock-held$/m);
        assert.match(result.stdout, new RegExp(`kind=fresh marker=${marker ? marker.operation : ''} engine= id= running=\\nMARK_REACHED`));
    }
});

test('a rebuild is admitted for a running Box without a marker, for a marker, and for a stopped Box, and carries the exact fields', t => {
    const select = runReproof(t, { operation: 'rebuild', answer: routed('select', { exact: EXACT }) });
    assert.equal(select.result.status, 0, select.result.stdout + select.result.stderr);
    assert.match(select.result.stdout, new RegExp(`kind=select marker= engine=podman id=${EXACT.id} running=true\\n`));
    const marked = runReproof(t, { operation: 'rebuild', answer: routed('rebuild', { exact: EXACT, marker: { operation: 'rebuild' } }) });
    assert.equal(marked.result.status, 0, marked.result.stdout + marked.result.stderr);
    assert.match(marked.result.stdout, new RegExp(`kind=rebuild marker=rebuild engine=podman id=${EXACT.id} running=true\\n`));
    const stopped = runReproof(t, { operation: 'rebuild', answer: routed('rebuild', { exact: { ...EXACT, engine: 'docker', running: false } }) });
    assert.equal(stopped.result.status, 0, stopped.result.stdout + stopped.result.stderr);
    assert.match(stopped.result.stdout, new RegExp(`kind=rebuild marker= engine=docker id=${EXACT.id} running=false\\n`));
});

test('the re-proof refuses every route that does not match the operation, before anything is stopped or removed', t => {
    for (const [name, options] of [
        ['a rebuild whose route became fresh', { operation: 'rebuild', answer: routed('fresh') }],
        ['a fresh installation whose route became select', { operation: 'update', answer: routed('select', { exact: EXACT }) }],
        ['a fresh installation whose route became rebuild', { operation: 'update', answer: routed('rebuild', { exact: EXACT }) }],
        ['a fresh route that names a current Box', { operation: 'update', answer: routed('fresh', { exact: EXACT }) }],
        ['a select route without a Box', { operation: 'rebuild', answer: routed('select') }],
        ['an unknown engine', { operation: 'rebuild', answer: routed('select', { exact: { ...EXACT, engine: 'lxc' } }) }],
        ['an engine that would be run as a command', { operation: 'rebuild', answer: routed('select', { exact: { ...EXACT, engine: 'sh -c id' } }) }],
        ['a short Box id', { operation: 'rebuild', answer: routed('select', { exact: { ...EXACT, id: 'a'.repeat(63) } }) }],
        ['an uppercase Box id', { operation: 'rebuild', answer: routed('select', { exact: { ...EXACT, id: 'A'.repeat(64) } }) }],
        ['a running flag that is not a boolean', { operation: 'rebuild', answer: routed('select', { exact: { ...EXACT, running: 'true' } }) }],
        ['an unknown marker operation', { operation: 'rebuild', answer: routed('rebuild', { exact: EXACT, marker: { operation: 'resume' } }) }],
        ['a refusal', { operation: 'rebuild', answer: { output: '{"result":"refused","code":"QA_ROUTE_STALE_POLICY_STASH"}', status: 1 } }],
        ['a helper that exits 75', { operation: 'rebuild', answer: { output: '', status: 75 } }],
        ['a refusal with a zero status', { operation: 'rebuild', answer: { output: '{"result":"refused","route":"rebuild"}', status: 0 } }],
        ['garbage', { operation: 'update', answer: { output: 'not json', status: 0 } }],
        ['empty output', { operation: 'update', answer: { output: '', status: 0 } }],
    ]) {
        const { result } = runReproof(t, options);
        assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /ERROR: the route (?:does not admit this \w+ run|was refused); nothing was stopped or removed\./, name);
        assert.doesNotMatch(result.stdout, /MARK_REACHED|Route confirmed/, name);
    }
});

test('the route re-proof runs before every mutation of the Reconcile script', () => {
    const at = marker => { const index = workflow.indexOf(marker); assert.ok(index > 0, marker); return index; };
    const reproof = at('# BEGIN QA route re-proof');
    assert.equal(workflow.match(/# BEGIN QA route re-proof/g).length, 1);
    assert(reproof < at('# BEGIN QA install marker'), 'the marker is the first mutation and follows the re-proof');
    for (const later of ['// BEGIN QA preservation admission', '# BEGIN QA preflight quiesce check', '# BEGIN QA read-only plan',
        '// BEGIN QA capacity admission', '# BEGIN QA teardown', 'prepareBoxForCommand']) {
        assert(reproof < at(later), `the re-proof precedes ${later}`);
    }
    const before = workflow.slice(0, at('# BEGIN QA install marker'));
    for (const mutation of ['container stop', 'container rm', ' image rm', 'fs.renameSync', 'cp -a']) {
        assert.equal(before.slice(before.indexOf('<<\'REMOTE\'')).includes(mutation), false, `nothing mutates before the marker: ${mutation}`);
    }
    // The old admission read engines in shell; the route now owns the inventory. Only the in-place step lists containers, and only
    // to prove a host without the QA toolchain is empty; the Reconcile script never does.
    const reconcile = workflow.slice(workflow.indexOf("<<'REMOTE'"));
    assert.equal(/assert_qa_install_admission|container ls -aq/.test(reconcile), false, 'the Reconcile script keeps no shell inventory');
    assert.equal(/assert_qa_install_admission/.test(workflow), false);
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
