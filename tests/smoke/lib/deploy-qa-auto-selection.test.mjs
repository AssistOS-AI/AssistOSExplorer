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
// The retired route helper is named in pieces: the stub still answers it so that this file also runs against the
// workflow it replaced, where the stopped-Box case fails for the right reason (the selection refuses).
const RETIRED_ROUTE_HELPER = ['qa', 'backups.mjs'].join('-');
const EXACT = { engine: 'podman', id: 'c'.repeat(64), running: true };

const SELECTION = mode => JSON.stringify({ result: 'selected', mode, mutations: false, expectedCommit: COMMIT, previousCommit: 'b'.repeat(40),
    boxImage: { reference: 'docker.io/assistos/ploinky-box:latest', current: 'c'.repeat(64), remote: 'c'.repeat(64) },
    reasons: mode === 'redeploy' ? [{ source: '.runtime/ploinky', kind: 'commit', from: 'd'.repeat(40), to: 'e'.repeat(40) }] : [] });

// The stub stands in for the updater helper. Every other node invocation (the parsers) runs the real node.
const SELECT = {
    'in-place': { output: SELECTION('in-place'), status: 0 },
    redeploy: { output: SELECTION('redeploy'), status: 0 },
    // What the updater answers when no running exact Box exists.
    'no running Box': { output: '{"result":"failed","status":"rejected","code":"QA_EXACT_RUNNING_BOX_REQUIRED"}', status: 1 },
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

const routed = (route, extra = {}) => ({ output: JSON.stringify({ result: 'routed', route, reason: 'fixture', marker: null, stash: false, exact: null, legacy: [], ...extra }), status: 0 });
const refused = code => ({ output: JSON.stringify({ result: 'refused', code }), status: 1 });
// The stub stands in for `qa-teardown.mjs route`; each key is a row of the route table, and the default answer is the steady state.
const ROUTE = {
    'R1 absent workspace': routed('fresh'),
    'R2 containers without a workspace': refused('QA_ROUTE_CONTAINERS_WITHOUT_WORKSPACE'),
    'R3 preserved data and no current Box': routed('fresh', { marker: { operation: 'destroy-keep' }, stash: true }),
    'R4 running Box without a marker': routed('select', { exact: EXACT }),
    'R5 running Box with a marker': routed('rebuild', { exact: EXACT, marker: { operation: 'rebuild' } }),
    'R6 stopped exact Box': routed('rebuild', { exact: { ...EXACT, running: false } }),
    'R7 running legacy Box': refused('QA_ROUTE_LEGACY_BOX_RUNNING'),
    'R8 workspace is not a directory': refused('QA_ROUTE_WORKSPACE_NOT_DIRECTORY'),
    'R9 engine failure': refused('QA_ROUTE_ENGINE_FAILED'),
    'R10 stale policy stash': refused('QA_ROUTE_STALE_POLICY_STASH'),
    'node exit 42': { output: '', status: 42 },
    'node exit 43': { output: '', status: 43 },
    'node exit 44': { output: '', status: 44 },
    'node exit 75': { output: '', status: 75 },
    'exit 0 with a refusal': { output: '{"result":"refused","route":"rebuild"}', status: 0 },
    garbage: { output: 'not json', status: 0 },
    'unknown route': { output: '{"result":"routed","route":"resume"}', status: 0 },
    'routed without a route': { output: '{"result":"routed"}', status: 0 },
    'rebuild-looking text': { output: '"route":"rebuild"', status: 0 },
    'two lines': { output: '{"result":"routed","route":"select"}\n{"result":"routed","route":"rebuild"}', status: 0 },
    'empty output': { output: '', status: 0 },
};

function runLocked(t, { workspace = 'absent', select = 'in-place', route = 'R4 running Box without a marker',
    execute = 0, expected = COMMIT, drop = false, toolchain = 'present', labelled = '', names = '', engineFailure = '' } = {}) {
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
    const engineMarker = path.join(root, 'engine-calls');
    // The route owns the engine inventory. Only a host without the QA toolchain proves absence itself, with these two listings.
    for (const name of ['podman', 'docker']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh
echo "${name} $*" >> '${engineMarker}'
case "$*" in
  'container ls -aq --filter label=io.assistos.ploinky-box.path-hash=7a31ab7775eb')
    [ '${engineFailure}' = ls ] && exit 125
    [ '${name}' = podman ] && printf '%s' '${labelled}'
    exit 0 ;;
  "container ls -a --format {{.Names}}")
    [ '${engineFailure}' = names ] && exit 125
    [ '${name}' = podman ] && printf '%s' '${names}'
    exit 0 ;;
esac
exit 99
`, { mode: 0o755 });
    }
    const selected = SELECT[select];
    const selectionFile = path.join(root, 'selection');
    fs.writeFileSync(selectionFile, selected.output);
    const answer = ROUTE[route];
    const routeFile = path.join(root, 'route');
    const routeMarker = path.join(root, 'route-calls');
    fs.writeFileSync(routeFile, answer.output);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
[ "$1" = '--version' ] && { echo v24.19.0; exit 0; }
case "$*" in
  *qa-teardown.mjs\\ route*)
    echo "route $*" >> '${routeMarker}'
    cat '${routeFile}'
    exit ${answer.status} ;;
  *${RETIRED_ROUTE_HELPER}\\ route*)
    echo "route $*" >> '${routeMarker}'
    echo '{"result":"routed","route":"select"}'
    exit 0 ;;
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
    const script = `id() { echo admin; }\n${locked.replaceAll('/home/admin/explorerQaWorkspace', target).replace(/node_home="[^"]+"/, `node_home='${toolchain === 'present' ? root : path.join(root, 'absent-tools', 'node-v24.19.0-linux-x64')}'`)}`;
    const result = spawnSync('bash', ['-s', '--', updateDir, ...(drop ? [] : [expected])], {
        input: script, encoding: 'utf8', timeout: 20000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/admin' },
    });
    const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return { result, root, calls: read(marker), routes: read(routeMarker), engines: read(engineMarker) };
}

test('R4: a running Box without a marker runs select and then execute with the pinned commit and no operator input', t => {
    const { result, calls, routes, engines } = runLocked(t, { workspace: 'directory' });
    assert.equal(result.status, 0, result.stderr);
    const lines = calls.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`update-explorer-qa.mjs select --expected-commit ${COMMIT} --lock-held$`));
    assert.match(lines[1], new RegExp(`update-explorer-qa.mjs execute --receipt \\S+/update.json --expected-commit ${COMMIT} --lock-held$`));
    assert.equal(engines, '', 'the locked script never calls an engine');
    assert.match(routes, /qa-teardown\.mjs route --lock-held$/m);
    assert.equal(routes.trim().split('\n').length, 1);
    assert.match(result.stdout, /^\[deploy-qa\] Deployment route: \{"result":"routed","route":"select".*\}$/m);
    assert.ok(result.stdout.indexOf('Deployment route:') < result.stdout.indexOf('Deployment selection:'), 'the route is decided before the selection');
    assert.match(result.stdout, /^\[deploy-qa\] Deployment selection: \{"result":"selected","mode":"in-place"/m);
});

test('R4: a selected redeploy is handed to Reconcile as a rebuild with exit 43 and never runs execute', t => {
    const { result, calls, engines } = runLocked(t, { workspace: 'directory', select: 'redeploy' });
    assert.equal(result.status, 43, result.stderr);
    assert.match(result.stdout, /Deployment selection: \{"result":"selected","mode":"redeploy".*"kind":"commit"/);
    assert.match(result.stdout, /Rebuild selected automatically; the in-place updater was not run\./);
    assert.match(calls, /select --expected-commit/);
    assert.doesNotMatch(calls, /execute/);
    assert.equal(engines, '');
});

// AC8: the route alone decides these rows; select and execute never run.
for (const [row, workspace, status, mention] of [
    ['R1 absent workspace', 'absent', 42, /No current Box/],
    ['R3 preserved data and no current Box', 'directory', 42, /No current Box/],
    ['R5 running Box with a marker', 'directory', 43, /needs a rebuild/],
    ['R6 stopped exact Box', 'directory', 43, /needs a rebuild/],
]) {
    test(`${row}: the route exits ${status} and the updater never runs`, t => {
        const { result, calls, routes, engines } = runLocked(t, { workspace, route: row });
        assert.equal(result.status, status, result.stdout + result.stderr);
        assert.equal(calls, '', 'neither select nor execute ran');
        assert.equal(engines, '');
        assert.match(result.stdout, mention);
        assert.match(result.stdout, /^\[deploy-qa\] Deployment route: \{"result":"routed"/m);
        assert.equal(routes.trim().split('\n').length, 1);
        assert.doesNotMatch(result.stdout, /Deployment selection:/);
    });
}

for (const row of ['R2 containers without a workspace', 'R7 running legacy Box', 'R8 workspace is not a directory', 'R9 engine failure', 'R10 stale policy stash']) {
    test(`${row}: a refused route exits 1, surfaces the refusal and never reaches select`, t => {
        const { result, calls } = runLocked(t, { workspace: row.startsWith('R2') ? 'absent' : 'directory', route: row });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /"code":"QA_ROUTE_[A-Z_]+"/);
        assert.doesNotMatch(result.stdout, /Deployment route:|Deployment selection:/);
        assert.equal(calls, '');
    });
}

// A helper failure is normalised to exit 1, so no status of the node process can be read as 42 or 43.
for (const route of ['node exit 42', 'node exit 43', 'node exit 44', 'node exit 75', 'exit 0 with a refusal', 'garbage', 'unknown route',
    'routed without a route', 'rebuild-looking text', 'two lines', 'empty output']) {
    test(`a failing route (${route}) exits 1 and never reaches select, 42 or 43`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', route });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(calls, '', 'select and execute never ran');
        assert.doesNotMatch(result.stdout, /No current Box|needs a rebuild|Rebuild selected|Deployment selection:/);
    });
}

test('an absent workspace asks the route; a symlink or a file is refused before any helper runs', t => {
    assert.match(runLocked(t, { workspace: 'absent', route: 'R1 absent workspace' }).routes, /route --lock-held/);
    for (const workspace of ['symlink', 'file']) {
        const { result, calls, routes, engines } = runLocked(t, { workspace });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /not a real directory/);
        assert.equal(`${calls}${routes}${engines}`, '', workspace);
    }
});

// AC8 (fails at base): a stopped exact Box has no running Box for the selection to inspect, so the route must decide.
test('R6: a stopped exact Box is rebuilt without calling select, where the selection would refuse it', t => {
    const { result, calls } = runLocked(t, { workspace: 'directory', route: 'R6 stopped exact Box', select: 'no running Box' });
    assert.equal(result.status, 43, result.stdout + result.stderr);
    assert.doesNotMatch(calls, /select/);
});

// A host that never had the QA toolchain: only a host with no QA workspace and no QA container may go on to the
// first installation, which installs the toolchain and proves the route again under the Reconcile lock.
const MISSING = /QA toolchain is missing at \S+absent-tools\/node-v24\.19\.0-linux-x64/;

test('a missing toolchain with no QA workspace and no QA container proceeds to the first installation with exit 42', t => {
    const { result, calls, routes, engines } = runLocked(t, { workspace: 'absent', toolchain: 'missing', names: 'soul-gateway\nsomething-else\n' });
    assert.equal(result.status, 42, result.stdout + result.stderr);
    assert.match(result.stdout, /no QA workspace or container exists; proceeding to the first installation/);
    assert.equal(`${calls}${routes}`, '', 'neither the route nor the updater ran without the QA Node');
    for (const engine of ['podman', 'docker']) {
        assert.match(engines, new RegExp(`${engine} container ls -aq --filter label=io\\.assistos\\.ploinky-box\\.path-hash=7a31ab7775eb`));
        assert.match(engines, new RegExp(`${engine} container ls -a --format \\{\\{\\.Names\\}\\}`));
    }
});

for (const [name, options] of Object.entries({
    'an existing workspace directory': { workspace: 'directory' },
    'a labelled QA container': { labelled: 'f'.repeat(12) },
    'a QA container with the exact name': { names: 'ploinky-box-explorerqaworkspace-7a31ab7775eb\n' },
    'a retained QA container named from the exact name': { names: 'ploinky-box-explorerqaworkspace-7a31ab7775eb-rollback-redeploy-AbCd1234\n' },
    'a container whose name starts with the QA name': { names: 'x\nploinky-box-explorerqaworkspace-7a31ab7775ebZ\n' },
})) {
    test(`a missing toolchain with ${name} exits 1 with the specific message and never reports an update failure`, t => {
        const { result, calls, routes } = runLocked(t, { workspace: 'absent', toolchain: 'missing', ...options });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, MISSING);
        assert.doesNotMatch(result.stdout, /first installation/);
        assert.equal(`${calls}${routes}`, '');
    });
}

for (const failure of ['ls', 'names']) {
    test(`a missing toolchain with a failing engine listing (${failure}) exits 1 and never proceeds`, t => {
        const { result } = runLocked(t, { workspace: 'absent', toolchain: 'missing', engineFailure: failure });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, MISSING);
        assert.doesNotMatch(result.stdout, /first installation/);
    });
}

test('a missing toolchain with an unsafe workspace path is refused before the proof, and a present toolchain never runs the proof', t => {
    for (const workspace of ['symlink', 'file']) {
        const { result, engines } = runLocked(t, { workspace, toolchain: 'missing' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /not a real directory/);
        assert.equal(engines, '');
    }
    const present = runLocked(t, { workspace: 'directory' });
    assert.equal(present.result.status, 0, present.result.stderr);
    assert.equal(present.engines, '', 'with the QA Node installed the route alone decides');
});

// AC7 of the earlier contract: no updater failure can fall through as 42 (fresh) or 43 (rebuild).
for (const select of ['node exit 42', 'node exit 43', 'node exit 1', 'node exit 19', 'garbage', 'unknown mode',
    'redeploy-looking text', 'two lines', 'failed result', 'empty output', 'no running Box']) {
    test(`a failing select (${select}) exits 1 and never reaches execute, 42 or 43`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', select });
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(calls, /execute/);
        assert.doesNotMatch(result.stdout, /Rebuild selected/);
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
        const { result, calls, routes, engines } = runLocked(t, { workspace: 'directory', ...options });
        assert.equal(result.status, 1);
        assert.equal(`${calls}${routes}${engines}`, '');
    });
}

test('the locked script produces 42 and 43 only from its own proofs, has no third outcome and carries no operation argument', () => {
    assert.equal(locked.match(/exit 42/g).length, 2, 'one in the arm of a parsed fresh route, one after the absence proof of a host without the QA toolchain');
    assert.equal(locked.match(/exit 43/g).length, 2, 'one in the arm of a parsed rebuild route, one in the arm of a parsed redeploy selection');
    assert.doesNotMatch(locked, /exit 44/);
    assert.match(locked, /fresh\)\n[^\n]*\n\s+exit 42\n\s+;;/, 'exit 42 sits in the arm of a parsed fresh route');
    assert.match(locked, /rebuild\)\n[^\n]*\n\s+exit 43\n\s+;;/, 'exit 43 sits in the arm of a parsed rebuild route');
    assert.match(locked, /route="\$\(node "\$update_dir\/qa-teardown\.mjs" route --lock-held\)" \|\| \{ printf '%s\\n' "\$route"; exit 1; \}/);
    assert.match(locked, /\["fresh", "rebuild", "select"\]\.includes\(route\.route\)/);
    assert.ok(locked.indexOf('qa-teardown.mjs" route') < locked.indexOf('update-explorer-qa.mjs" select'), 'the route runs before the selection');
    assert.match(locked, /redeploy\)\n[\s\S]*?exit 43\n\s+;;/, 'exit 43 sits in the arm of a parsed redeploy selection');
    assert.match(locked, /selection="\$\(node "\$update_dir\/update-explorer-qa\.mjs" select --expected-commit "\$expected_commit" --lock-held\)" \|\| \{ printf '%s\\n' "\$selection"; exit 1; \}/);
    assert.match(locked, /\n\s*node "\$update_dir\/update-explorer-qa\.mjs" execute --receipt "\$update_dir\/update\.json" --expected-commit "\$expected_commit" --lock-held \|\| exit 1(?:\n|$)/);
    assert.doesNotMatch(locked, /operation|OPERATION|rehears|resume/);
    const withoutToolchainProof = locked.replace(/if \[ ! -x "\$node_home\/bin\/node" \]; then[\s\S]*?\n(?=export PATH)/, '');
    assert.notEqual(withoutToolchainProof, locked, 'the toolchain absence proof is present');
    assert.doesNotMatch(withoutToolchainProof, /container ls|container inspect/, 'the engine inventory belongs to the route');
    assert.ok(locked.indexOf('exit 42', locked.indexOf('first installation')) < locked.indexOf('export PATH'), 'the proof ends before the QA Node is put on the PATH');
});

// The handler: 43 writes the rebuild operation, and the removed status 44 is an ordinary failure.
for (const [status, output, failed] of [
    [0, 'updated=true\n', false],
    [42, 'updated=false\n', false],
    [43, 'updated=false\noperation=rebuild\n', false],
    [44, '', true],
    [19, '', true],
    [75, '', true],
    [1, '', true],
]) {
    test(`workflow result handler maps status ${status} without failure fallthrough`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-result-dispatch-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const outputFile = path.join(root, 'output');
        fs.writeFileSync(outputFile, '');
        // No OPERATION variable exists: status 43 selects the rebuild unconditionally.
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

test('the in-place step uploads, runs and cleans up the route helpers beside the updater', () => {
    const step = workflow.match(/- name: Update the existing Explorer QA installation in place\n([\s\S]*?)(?=\n      - name: )/)[1];
    assert.match(step, /for helper in update-explorer-qa\.mjs rollback-explorer-qa\.mjs qa-teardown\.mjs; do/);
    assert.match(step, /rm -f '\$REMOTE_DIR\/update-explorer-qa\.mjs' '\$REMOTE_DIR\/rollback-explorer-qa\.mjs' '\$REMOTE_DIR\/qa-teardown\.mjs' '\$REMOTE_DIR\/update\.json'/);
    assert.doesNotMatch(step, new RegExp(`${RETIRED_ROUTE_HELPER.replace('.', '\\.')}|-privileged`), 'only the three reviewed helpers travel to the route step');
});
