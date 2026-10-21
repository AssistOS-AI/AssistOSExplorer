import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');

function block(name) {
    const match = workflow.match(new RegExp(`// BEGIN QA ${name}\\n([\\s\\S]*?)// END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

test('prior selections are classified and logged against the fresh graph, and none is enabled', () => {
    const selection = block('prior selection restoration');
    assert.doesNotMatch(selection, /enable:|restorePriorSelections|enableArguments/);
    assert.match(selection, /classifyPriorSelections\(authority\.agents, registry\)/);
    assert.match(selection, /describeSelectionDispositions\(classification\)/);
    assert.match(selection, /adapters\.ready\(current, \{ \.\.\.authority, agents: \[\] \}\)/);
    assert.match(selection, /Prior agent choices restored and checked against the fresh runtime\./);
    assert.ok(workflow.indexOf('// BEGIN QA prior selection restoration') < workflow.indexOf('Verified $repository_name/$expected_branch at'));
});

// A block's own imports sit above its marker, so the check prepends the ones it uses.
function assertParses(t, name, source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-redeploy-block-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'block.mjs');
    fs.writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
}

test('the rewritten selection block is valid module code', t => {
    assertParses(t, 'prior selection restoration', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${block('prior selection restoration')}`);
});

const verifier = fs.readFileSync(new URL('../../../.github/scripts/verify-explorer-qa-runtime.mjs', import.meta.url), 'utf8');

function step(name) {
    const match = workflow.match(new RegExp(`- name: ${name}\\n([\\s\\S]*?)(?=\\n      - name: |\\n  [a-z]+:\\n|$)`));
    assert.ok(match, `Missing step ${name}`);
    return match[1];
}

function stepScript(name) {
    const run = step(name).match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/);
    assert.ok(run, `Missing script of ${name}`);
    return run[1].replace(/^ {10}/gm, '');
}

// Runs the Resolve step with a stub git. The environment is built from scratch: these tests also run
// inside the deployment workflow, where GITHUB_ENV and EXPECTED_EXPLORER_COMMIT are real.
function runResolve(t, { output = `${'f'.repeat(40)}\trefs/heads/main\n`, status = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resolve-step-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const calls = path.join(dir, 'calls');
    const githubEnv = path.join(dir, 'github-env');
    fs.writeFileSync(githubEnv, '');
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho "git $*" >> '${calls}'\nprintf '%s' '${output}'\nexit ${status}\n`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', stepScript('Resolve the AssistOSExplorer main commit')], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, GITHUB_ENV: githubEnv, GITHUB_REF_NAME: 'feature/x', GITHUB_SHA: '9'.repeat(40) } });
    return { result, env: fs.readFileSync(githubEnv, 'utf8'), git: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

const COMMIT = 'a'.repeat(40);

test('the deploy job has no condition, the raised timeout and no rollback job, and no script reads an input', () => {
    const deploy = workflow.match(/\n  deploy:\n([\s\S]*?)\n    steps:/)[1];
    assert.doesNotMatch(deploy, /\n {4}if:/);
    assert.match(deploy, /timeout-minutes: 90\n/);
    assert.doesNotMatch(workflow, /^ {2}rollback:/m);
    assert.equal(workflow.match(/<<'ROLLBACK'/g), null);
    const scripts = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)];
    assert(scripts.length >= 8);
    for (const [, script] of scripts) assert.doesNotMatch(script, /\$\{\{ *inputs\./);
    assert.doesNotMatch(workflow, /rehearsal/i);
});

test('the Resolve step pins the AssistOSExplorer main commit into GITHUB_ENV and logs the helper ref and SHA', t => {
    const { result, env, git } = runResolve(t, { output: `${COMMIT}\trefs/heads/main\n` });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(env, `EXPECTED_EXPLORER_COMMIT=${COMMIT}\n`);
    assert.equal(git.trim(), 'git ls-remote --exit-code --heads https://github.com/AssistOS-AI/AssistOSExplorer.git refs/heads/main');
    assert.match(result.stdout, new RegExp(`Helpers and tests come from feature/x@${'9'.repeat(40)}\\.`));
    assert.match(result.stdout, new RegExp(`Deploying AssistOSExplorer main at ${COMMIT}\\.`));
    assert.equal(workflow.indexOf('- name: Resolve the AssistOSExplorer main commit') < workflow.indexOf('- name: Validate GitHub configuration'), true);
    assert.equal(workflow.indexOf('- name: Resolve the AssistOSExplorer main commit') < workflow.indexOf('- name: Update the existing Explorer QA installation in place'), true);
});

// AC9: the Resolve step fails before any SSH and never pins an uncertain commit.
for (const [name, options] of Object.entries({
    'zero lines': { output: '' },
    'a blank line': { output: '\n' },
    'git failing with no match': { output: '', status: 2 },
    'git failing with a record': { output: `${COMMIT}\trefs/heads/main\n`, status: 128 },
    'two lines': { output: `${COMMIT}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/main\n` },
    'a 39 character commit': { output: `${'a'.repeat(39)}\trefs/heads/main\n` },
    'an uppercase commit': { output: `${'A'.repeat(40)}\trefs/heads/main\n` },
    'a 41 character commit': { output: `${'a'.repeat(41)}\trefs/heads/main\n` },
    'a different ref': { output: `${COMMIT}\trefs/heads/mainline\n` },
    'a commit without a ref': { output: `${COMMIT}\n` },
    'trailing text': { output: `${COMMIT}\trefs/heads/main extra\n` },
})) {
    test(`the Resolve step fails on ${name} and pins nothing`, t => {
        const { result, env } = runResolve(t, options);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stdout, /::error::/);
        assert.equal(env, '');
    });
}

test('the pinned commit reaches every check: the Reconcile step has no input line of its own and neither pin check is gated', () => {
    assert.doesNotMatch(step('Reconcile and start Explorer QA Box'), /^ {10}EXPECTED_EXPLORER_COMMIT:/m);
    assert.match(step('Reconcile and start Explorer QA Box'), /OPERATION: \$\{\{ steps\.inplace\.outputs\.operation \}\}/);
    assert.doesNotMatch(step('Update the existing Explorer QA installation in place'), /^ {8}env:/m);
    assert.match(stepScript('Update the existing Explorer QA installation in place'), /\$EXPECTED_EXPLORER_COMMIT/);
    const early = workflow.indexOf('if [ "$QA_EXPLORER_HEAD" != "$EXPECTED_EXPLORER_COMMIT" ]; then');
    assert.ok(early > 0);
    const earlyGuard = workflow.slice(workflow.lastIndexOf('QA_EXPLORER_URL=', early) - 400, early);
    assert.doesNotMatch(earlyGuard, /QA_OPERATION/, 'the early pin check is not gated on the mode');
    assert.match(workflow.slice(early, early + 400), /not the expected \$EXPECTED_EXPLORER_COMMIT; nothing was stopped or moved\./);
    assert.ok(early < workflow.indexOf('# BEGIN QA retention helpers'));
    const lateStart = workflow.indexOf('if [ "${EXPECTED_COMMITS[AchillesIDE]}" != "$EXPECTED_EXPLORER_COMMIT" ]; then');
    assert.ok(lateStart > workflow.indexOf('EXPLORER_BRANCH="${EXPECTED_BRANCHES[AchillesIDE]}"') && lateStart < workflow.indexOf("PLOINKY_URL='"));
    const late = workflow.slice(lateStart, workflow.indexOf("PLOINKY_URL='"));
    assert.match(late, /if \[ "\$QA_OPERATION" = redeploy \]; then\n\s+echo "\[deploy-qa\] ERROR: AchillesIDE resolved to .*the retained backup \$QA_BACKUP_DIR can be rolled back\."\n\s+else\n\s+echo "\[deploy-qa\] ERROR: AchillesIDE resolved to .*nothing was started and no prior installation existed\."\n\s+fi\n\s+exit 1/);
    assert.equal(workflow.slice(workflow.lastIndexOf('\n', lateStart) + 1, workflow.indexOf('\n', lateStart)).includes('QA_OPERATION'), false, 'the late pin check is not gated on the mode');
});

// AC26: every helper the Reconcile script uses is transferred through the env file and checked by SHA.
const SOURCES = ['QUIESCE', 'ROLLBACK', 'BACKUPS', 'BACKUPS_PRIVILEGED', 'UPDATE'];

function installSha256sum(bin) {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sha256sum'), `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === '-c') {
    let failed = 0;
    for (const line of fs.readFileSync(0, 'utf8').split('\\n').filter(Boolean)) {
        const match = line.match(/^([a-f0-9]{64})  (.*)$/);
        if (!match || hash(fs.readFileSync(match[2])) !== match[1]) { failed = 1; console.error('FAILED ' + (match ? match[2] : line)); }
        else console.log(match[2] + ': OK');
    }
    process.exit(failed);
}
process.stdout.write(hash(fs.readFileSync(0)) + '  -\\n');
`, { mode: 0o755 });
}

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const sourceEnv = (tamper = '') => Object.fromEntries(SOURCES.flatMap(name => {
    const source = `// ${name} helper\nexport const name = '${name}';\n`;
    return [[`QA_${name}_SOURCE`, name === tamper ? `${source}// changed in transfer\n` : source], [`QA_${name}_SHA`, sha(source)]];
}));

test('the env file carries every helper source with its SHA, read from the reviewed checkout', () => {
    const script = stepScript('Reconcile and start Explorer QA Box');
    for (const [name, file] of [['QUIESCE', 'quiesce-explorer-qa.mjs'], ['ROLLBACK', 'rollback-explorer-qa.mjs'], ['BACKUPS', 'qa-backups.mjs'],
        ['BACKUPS_PRIVILEGED', 'qa-backups-privileged.mjs'], ['UPDATE', 'update-explorer-qa.mjs']]) {
        assert.ok(script.includes(`QA_${name}_SOURCE="$(cat "$GITHUB_WORKSPACE/.github/scripts/${file}")"`), `${name} source`);
        assert.ok(script.includes(`QA_${name}_SHA="$(printf '%s' "$QA_${name}_SOURCE" | sha256sum | awk '{print $1}')"`), `${name} sha`);
        assert.ok(script.includes(`write_shell_var QA_${name}_SOURCE\n`), `${name} source is written`);
        assert.ok(script.includes(`write_shell_var QA_${name}_SHA\n`), `${name} sha is written`);
    }
});

test('a helper changed in transfer stops the run before the retention block', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-integrity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    installSha256sum(bin);
    const script = `set -euo pipefail\n${shellBlock('transferred helper integrity')}\necho integrity-passed\n`;
    const run = tamper => spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH}`, ...sourceEnv(tamper) } });
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /integrity-passed/);
    for (const name of SOURCES) {
        const tampered = run(name);
        assert.equal(tampered.status, 1, name);
        assert.match(tampered.stdout, /changed in transfer\./, name);
        assert.doesNotMatch(tampered.stdout, /integrity-passed/, name);
    }
    assert.ok(workflow.indexOf('# END QA transferred helper integrity') < workflow.indexOf('# BEGIN QA retention helpers'));
});

// AC25: the retention block runs the transferred selector and its exit decides.
const CURRENT = 'c'.repeat(64);

function runRetention(t, { operation = 'redeploy', records = [`podman|${CURRENT}|ploinky-box-explorerqaworkspace-7a31ab7775eb`], output = '', status = 0, tamper = '' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-retention-block-'));
    const bin = path.join(dir, 'bin');
    const calls = path.join(dir, 'calls');
    installSha256sum(bin);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >> '${calls}'\nprintf '%s\\n' "$QA_STUB_OUTPUT"\nexit "$QA_STUB_STATUS"\n`, { mode: 0o755 });
    const script = `set -euo pipefail
QA_OPERATION=${operation}
declare -a QA_CONTAINER_RECORDS=(${records.map(record => JSON.stringify(record)).join(' ')})
QA_RETENTION_DIR=""
${shellBlock('retention helpers')}
echo "dir=\${QA_RETENTION_DIR:-unset}"
${shellBlock('superseded backup retention')}
echo CAPACITY_STUB_REACHED
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH}`, QA_STUB_OUTPUT: output, QA_STUB_STATUS: String(status), ...sourceEnv(tamper) } });
    const created = result.stdout.match(/^dir=(.*)$/m)?.[1];
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (/^\/tmp\/explorer_qa_retention\.[A-Za-z0-9]{6}$/.test(created || '')) fs.rmSync(created, { recursive: true, force: true });
    });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', created };
}

test('a redeploy transfers four helpers privately and runs prune with the live Box ID under the held lock', t => {
    const skipped = '{"result":"skipped","reason":"QA_BOX_NOT_RUNNING","removedBackups":[],"removedBoxes":[]}';
    const { result, calls, created } = runRetention(t, { output: skipped });
    assert.equal(result.status, 0, result.stderr);
    assert.match(created, /^\/tmp\/explorer_qa_retention\.[A-Za-z0-9]{6}$/);
    assert.equal(calls.trim(), `${created}/qa-backups.mjs prune --current-id ${CURRENT} --lock-held`);
    assert.match(result.stdout, new RegExp(`\\[deploy-qa\\] Retention receipt: ${skipped.replace(/[{}[\]]/g, '\\$&')}`));
    assert.match(result.stdout, /CAPACITY_STUB_REACHED/, 'a skipped retention continues to the capacity gate');
    for (const [file, name] of [['qa-backups.mjs', 'BACKUPS'], ['qa-backups-privileged.mjs', 'BACKUPS_PRIVILEGED'], ['update-explorer-qa.mjs', 'UPDATE'], ['rollback-explorer-qa.mjs', 'ROLLBACK']]) {
        assert.equal(fs.readFileSync(path.join(created, file), 'utf8'), sourceEnv()[`QA_${name}_SOURCE`], file);
        assert.equal(fs.statSync(path.join(created, file)).mode & 0o777, 0o600, file);
    }
    assert.equal(fs.statSync(created).mode & 0o777, 0o700);
});

test('a failed retention stops the run before capacity with nothing stopped and no rollback reference', t => {
    for (const status of [1, 2, 19, 90]) {
        const { result, calls } = runRetention(t, { output: '{"result":"failed","code":"QA_RETENTION_CURRENT_CHANGED"}', status });
        assert.equal(result.status, 1, `node exit ${status}`);
        assert.doesNotMatch(result.stdout, /CAPACITY_STUB_REACHED/);
        assert.doesNotMatch(result.stdout, /Rollback reference/);
        assert.match(result.stdout, /ERROR: backup retention failed; no service was stopped and no workspace file was moved\. Result: .*QA_RETENTION_CURRENT_CHANGED/);
        assert.match(calls, /prune --current-id/);
    }
});

test('a pruned receipt is logged and then capacity runs', t => {
    const pruned = '{"result":"pruned","removedBackups":["redeploy-AbCd1234"],"removedBoxes":[]}';
    const { result } = runRetention(t, { output: pruned });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.indexOf(`Retention receipt: ${pruned}`) < result.stdout.indexOf('CAPACITY_STUB_REACHED'));
});

test('a fresh installation never enters the retention block or creates its helper directory', t => {
    const { result, calls, created } = runRetention(t, { operation: 'update', records: [] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(created, 'unset');
    assert.equal(calls, '');
    assert.match(result.stdout, /CAPACITY_STUB_REACHED/);
    assert.doesNotMatch(result.stdout, /Retention receipt/);
});

test('retention requires exactly one QA Box record and a helper that matches its SHA', t => {
    for (const records of [[], ['podman|' + 'c'.repeat(64) + '|a', 'docker|' + 'd'.repeat(64) + '|a']]) {
        const { result, calls } = runRetention(t, { records });
        assert.equal(result.status, 1);
        assert.match(result.stdout, /backup retention needs exactly one existing QA Box record/);
        assert.equal(calls, '');
    }
    const tampered = runRetention(t, { tamper: 'BACKUPS' });
    assert.notEqual(tampered.result.status, 0);
    assert.equal(tampered.calls, '', 'a helper whose bytes differ from its SHA is never run');
    assert.doesNotMatch(tampered.result.stdout, /CAPACITY_STUB_REACHED/);
});

test('the retention block is redeploy-only, unforgiving, and the only caller of the selector', () => {
    const retention = shellBlock('superseded backup retention');
    assert.match(retention, /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m);
    assert.doesNotMatch(retention, /\|\| true|if ! node|rm -rf|rm -fr/);
    assert.equal(retention.match(/qa-backups\.mjs" prune --current-id/g).length, 1);
    assert.equal(workflow.match(/qa-backups\.mjs" prune/g).length, 1, 'no other step prunes');
    assert.match(shellBlock('retention helpers'), /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m);
});

// AC13 and AC14: admissions, Node, pins, preflight, retention, capacity, then the first backup directory.
test('retention sits after the read-only admissions and the preflight, and before capacity and the first backup directory', () => {
    const at = marker => { const index = workflow.indexOf(marker); assert.ok(index > 0, marker); return index; };
    const order = [
        'Durable-state admission passed',
        'Verified QA-scoped Node v24.19.0',
        'if [ "$QA_EXPLORER_HEAD" != "$EXPECTED_EXPLORER_COMMIT" ]',
        '# BEGIN QA redeploy preflight',
        '# BEGIN QA superseded backup retention',
        '// BEGIN QA capacity admission',
        'mkdir -p "$HOME/.qa-deployment-backups"',
    ].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(at('# END QA redeploy preflight') < at('# BEGIN QA superseded backup retention'));
    assert.ok(at('# END QA superseded backup retention') < at('// BEGIN QA capacity admission'));
    assert.ok(at('// END QA capacity admission') < at('mkdir -p "$HOME/.qa-deployment-backups"'));
    assert.equal(workflow.match(/\/\/ BEGIN QA capacity admission/g).length, 1, 'capacity moved, it was not duplicated');
    // Nothing that stops, renames or captures precedes the retention block.
    const before = workflow.slice(0, at('# BEGIN QA superseded backup retention'));
    for (const mutation of ['container stop', 'container rename', 'fs.renameSync(target, source)', '.qa-deployment-backups"\n', 'capture "$QA_BACKUP_DIR"']) {
        assert.equal(before.includes(mutation), false, mutation);
    }
});

test('capacity admission is always fatal and its diagnostics stay in the log', t => {
    const gib = 1024n ** 3n;
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-capacity-'));
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));
    const run = ({ free, workspace = 30n * gib, duFails = false, extra = [] }) => {
        const logs = [];
        const source = block('capacity admission').replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(target));
        new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
            assert, { ...fs, statfsSync: () => ({ bavail: free, bsize: 1n }) }, path,
            (_command, args) => {
                if (duFails && args.at(-1) === target) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
                return `${args.at(-1) === target ? workspace : 0n}\tx\n`;
            },
            { argv: ['node', '-', target, ...extra] }, { log: (...parts) => logs.push(parts.join(' ')) });
        return logs;
    };
    // A further argument can no longer turn the shortfall into a report.
    for (const extra of [[], ['redeploy'], ['update'], ['anything']]) {
        assert.throws(() => run({ free: 15n * gib, extra }), /Insufficient QA capacity/);
        assert.throws(() => run({ free: 40n * gib, duFails: true, extra }), /Unable to measure QA workspace allocation/);
        const admitted = run({ free: 40n * gib, extra });
        assert.match(admitted[0], /Capacity diagnostics: /);
        assert.match(admitted.at(-1), /Capacity admission passed before stopping the previous runtime\./);
        assert.doesNotMatch(admitted.join('\n'), /verdict/i);
    }
    assert.match(workflow, /sudo -n \/usr\/bin\/node --input-type=module - "\$WORK_DIR" <<'NODE'\n\n?\s+import assert from 'node:assert\/strict';\n[\s\S]*?\/\/ BEGIN QA capacity admission/);
    assert.doesNotMatch(workflow, /QA_CAPACITY_LOG|tee "\$QA_CAPACITY/);
});

// The preflight, run as the shell sees it, against a stub engine and a stub rollback helper.
function runPreflight(t, { operation = 'redeploy', running = 'true', receipt, status = 0, reviewed = true, error = '', records } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-preflight-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'engine.log');
    const real = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    fs.writeFileSync(path.join(dir, 'rollback-explorer-qa.mjs'), `
export { classifyPriorSelections, describeSelectionDispositions, EXPECTED_DEFAULT_GRAPH, QA_SCOPE } from '${real}';
export const accountCapability = () => ${reviewed};
export const productionAdapters = () => ({});
export const createRollbackService = () => ({ previewCapture() {
    ${error ? `throw Object.assign(new Error('x'), { code: '${error}' });` : ''}
    const agent = (repo, name) => ({ name: repo + name, repo, agent: name, alias: '', profile: 'default', auth: 'sso', runMode: 'global' });
    return { sources: [{}, {}], agents: [agent('AchillesIDE', 'explorer'), agent('AchillesIDE', 'soplangAgent'), agent('AchillesCLI', 'promotionScout')] };
} });
`);
    fs.writeFileSync(path.join(bin, 'podman'), [
        '#!/bin/bash',
        'echo "$*" >> "$QA_MOCK_LOG"',
        'if [ "$2" = inspect ]; then echo "$QA_MOCK_RUNNING"; exit 0; fi',
        'if [ "$2" = exec ]; then cat > "$QA_MOCK_LOG.stdin"; printf "%s\\n" "$QA_MOCK_RECEIPT"; exit "$QA_MOCK_STATUS"; fi',
        'exit 99',
    ].join('\n'), { mode: 0o755 });
    const passed = '{"version":1,"kind":"qa-quiesce","result":"preflight-passed","phase":"preflight","stopped":[]}';
    const declared = records ?? `declare -a QA_CONTAINER_RECORDS=("podman|${'a'.repeat(64)}|box")`;
    const script = `set -euo pipefail\nWORK_DIR=/home/admin/explorerQaWorkspace\nQA_OPERATION=${operation}\nQA_RETENTION_DIR=${dir}\nQA_QUIESCE_SOURCE='export const x = 1;'\n${declared}\n${shellBlock('redeploy preflight')}\necho PREFLIGHT_DONE\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir,
        QA_MOCK_LOG: log, QA_MOCK_RUNNING: running, QA_MOCK_RECEIPT: receipt ?? passed, QA_MOCK_STATUS: String(status) } });
    return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', stdin: fs.existsSync(`${log}.stdin`) ? fs.readFileSync(`${log}.stdin`, 'utf8') : null };
}

test('the preflight is fatal before anything stops, and runs the quiesce preflight in the running Box', t => {
    const refused = '{"version":1,"kind":"qa-quiesce","result":"failed","phase":"preflight","stopped":[],"code":"QA_UNREGISTERED_WRITABLE_MOUNT"}';
    const ok = runPreflight(t);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Preflight: prior account runtime reviewed=true/);
    assert.match(ok.stdout, /Preflight: prior selection retained: AchillesIDE\/explorer/);
    assert.match(ok.stdout, /Preflight: prior selection not replayed: AchillesIDE\/soplangAgent \(not in the fresh default graph;/);
    assert.match(ok.stdout, /Preflight: prior selections: 3 total, 1 retained, 0 superseded, 2 not replayed, 0 enabled\./);
    assert.match(ok.stdout, /Redeploy preflight passed; no service was stopped and no workspace file was moved\./);
    assert.match(ok.stdout, /PREFLIGHT_DONE/);
    assert.match(ok.calls, /container exec -i --user podman --workdir \/home\/admin\/explorerQaWorkspace --env PLOINKY_WORKSPACE_ROOT=\/home\/admin\/explorerQaWorkspace .* --env QA_QUIESCE_PREFLIGHT_ONLY=1 a{64} node --input-type=module -/);
    assert.equal(ok.stdin, 'export const x = 1;\n', 'the helper source is streamed on stdin');
    assert.doesNotMatch(ok.calls, /container (?:stop|kill|rename)/);

    for (const [name, options, message] of [
        ['a refused quiesce preflight', { receipt: refused, status: 1 }, /quiesce preflight receipt: .*QA_UNREGISTERED_WRITABLE_MOUNT/],
        ['an empty receipt', { receipt: '', status: 1 }, /receipt: none/],
        ['a receipt that is not a preflight pass', { receipt: '{"result":"passed"}' }, /receipt: \{"result":"passed"\}/],
        ['an unreviewed account runtime', { reviewed: false }, /reviewed=false/],
        ['a refused capture preview', { error: 'QA_UNSELECTED_ACTIVE_BOX' }, /capture preview failed: QA_UNSELECTED_ACTIVE_BOX/],
    ]) {
        const failed = runPreflight(t, options);
        assert.equal(failed.status, 1, name);
        assert.match(failed.stdout, message, name);
        assert.match(failed.stdout, /ERROR: the redeploy preflight failed; no service was stopped and no workspace file was moved\./, name);
        assert.doesNotMatch(failed.stdout, /PREFLIGHT_DONE|preflight passed/, name);
    }
    assert.equal(runPreflight(t, { error: 'EACCES' }).stdout.includes('QA_PREVIEW_FAILED'), true, 'raw errors are not disclosed');
    // Every gate reports even when an earlier one failed.
    const both = runPreflight(t, { reviewed: false, receipt: refused, status: 1 });
    assert.match(both.stdout, /reviewed=false[\s\S]*QA_UNREGISTERED_WRITABLE_MOUNT/);
});

test('the preflight skips the quiesce proof only when there is no running Box, and does nothing for a fresh installation', t => {
    const stopped = runPreflight(t, { running: 'false' });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /skipped; the QA Box is not running/);
    assert.doesNotMatch(stopped.calls, /container exec/);
    const cold = runPreflight(t, { records: 'declare -a QA_CONTAINER_RECORDS=()' });
    assert.equal(cold.status, 0, cold.stderr);
    assert.match(cold.stdout, /skipped; there is no QA Box/);
    assert.equal(cold.calls, '');
    const fresh = runPreflight(t, { operation: 'update', records: 'declare -a QA_CONTAINER_RECORDS=()' });
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.equal(fresh.calls, '');
    assert.doesNotMatch(fresh.stdout, /Preflight/);
});

test('the preflight is a fatal gate without an early exit, with one container exec and no mutation', () => {
    const preflight = shellBlock('redeploy preflight');
    assert.doesNotMatch(preflight, /\bexit 0\b/);
    assert.match(preflight, /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m);
    const quiesce = shellBlock('preflight quiesce check');
    assert.equal((quiesce.match(/container exec/g) || []).length, 1);
    assert.match(quiesce, /--env QA_QUIESCE_PREFLIGHT_ONLY=1/);
    assert.doesNotMatch(preflight, /container (?:stop|rename|kill)|renameSync|cp -a|rm -rf|--lock-held|capture "|mkdir/);
    assert.ok(workflow.indexOf('// BEGIN QA preflight capture preview') > workflow.indexOf('# BEGIN QA redeploy preflight'));
    assert.ok(workflow.indexOf('// END QA preflight capture preview') < workflow.indexOf('# END QA redeploy preflight'));
});

test('the preflight capture preview is valid module code', t => {
    assertParses(t, 'preflight capture preview', block('preflight capture preview'));
});

test('a redeploy never creates a tunnel', () => {
    const refusal = workflow.indexOf('never creates one');
    assert.ok(refusal > 0 && refusal < workflow.indexOf('-X POST'));
    assert.match(workflow.slice(refusal - 200, refusal), /if \[ -n "\$\{OPERATION:-\}" \]/);
    assert.match(step('Reconcile and start Explorer QA Box'), /OPERATION: \$\{\{ steps\.inplace\.outputs\.operation \}\}/);
    assert.match(workflow, /QA_OPERATION="\$\{2:-update\}"\n\s+case "\$QA_OPERATION" in\n\s+update\|redeploy\) ;;/);
});

test('the redeploy logs carry the backup name, the rollback reference and the verifier input', t => {
    const mktemp = workflow.indexOf('QA_BACKUP_DIR="$(mktemp -d "$HOME/.qa-deployment-backups/redeploy-XXXXXXXX")"');
    assert.ok(mktemp > 0);
    assert.ok(workflow.indexOf('echo "[deploy-qa] Redeploy backup: ${QA_BACKUP_DIR##*/}"') > mktemp);
    const reference = workflow.indexOf('echo "[deploy-qa] Rollback reference: backup=${QA_BACKUP_DIR##*/} predecessor=$QA_PREDECESSOR_ID current=$QA_CURRENT_ID"');
    assert.ok(reference > workflow.indexOf("exact Box instance '$BOX_INSTANCE' was not found"));
    assert.ok(reference < workflow.indexOf('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'));
    assert.ok(reference < workflow.indexOf('// BEGIN QA policy restoration'));

    const expectation = block('verification expectation');
    const repositories = [...workflow.matchAll(/^ {12}'([A-Za-z-]+)\|https:\/\/github\.com\/AssistOS-AI\/[A-Za-z-]+\.git'$/gm)].map(match => match[1]);
    assert.equal(repositories.length, 6);
    const records = ['.runtime/ploinky|master|' + 'a'.repeat(40), 'AdvancedLanguageAgent|main|' + 'b'.repeat(40),
        ...repositories.map((name, index) => `.ploinky/repos/${name}|main|${String(index + 1).repeat(40)}`)];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-expectation-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'block.mjs'), expectation);
    const result = spawnSync(process.execPath, [path.join(dir, 'block.mjs'), 'c'.repeat(64), 'd'.repeat(64), '1760000000000', ...records],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one line, so a single grep can take it');
    const json = lines[0].match(/^\[deploy-qa\] Verification expectation: (\{.*\})$/)[1];
    assert.doesNotMatch(json, / /);
    const expected = JSON.parse(json);
    // The shape the verifier asserts (verify-explorer-qa-runtime.mjs).
    assert.match(expected.boxId, /^[a-f0-9]{64}$/);
    assert.match(expected.imageId, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(expected.minimumRunStartedAtMs) && expected.minimumRunStartedAtMs > 0);
    assert.equal(Object.keys(expected.sources).length, 8);
    for (const relative of Object.keys(expected.sources)) {
        assert.ok(verifier.includes(relative.replace('.ploinky/repos/', '')) || relative === '.runtime/ploinky', relative);
        assert.match(expected.sources[relative].commit, /^[a-f0-9]{40}$/);
    }
    assert.ok(verifier.includes("'.runtime/ploinky', 'AdvancedLanguageAgent'"));
    assert.deepEqual(Object.keys(expected.sources).filter(name => name.startsWith('.ploinky/repos/')).map(name => name.slice('.ploinky/repos/'.length)).sort(),
        repositories.sort());
});

test('every redeploy step runs after a redeploy, and the summary names the selection, the pin, the helper SHA and the retention receipt', () => {
    assert.doesNotMatch(step('Verify public URL'), /^ {8}if:/m);
    assert.match(step('Verify dedicated connector and protected Cloudflare topology'), /^ {8}if: always\(\)$/m);
    const summary = step('Create summary');
    assert.match(summary, /DISPATCH_REF: \$\{\{ github\.ref_name \}\}/);
    assert.match(summary, /DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(summary, /Helpers and tests from .*DISPATCH_REF.*DISPATCH_SHA.*pinned at .*EXPECTED_EXPLORER_COMMIT/);
    assert.match(summary, /Deployment selection and reasons/);
    assert.match(summary, /Preserving redeploy: the prior workspace and Box are retained for rollback/);
    assert.match(summary, /Retention receipt: /);
    assert.match(workflow, /<<'REMOTE' \| tee "\$RUNNER_TEMP\/explorer-qa-reconcile\.log"/);
    const cleanup = step('Cleanup');
    assert.match(cleanup, /explorer-qa-update-result\.json/);
    assert.match(cleanup, /explorer-qa-reconcile\.log/);
});

test('the summary renders the recorded selection and receipt lines', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-summary-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'explorer-qa-update-result.json'), `[deploy-qa] Preserving.\n[deploy-qa] Deployment selection: {"result":"selected","mode":"redeploy"}\n`);
    fs.writeFileSync(path.join(dir, 'explorer-qa-reconcile.log'), `[deploy-qa] Retention receipt: {"result":"pruned","removedBackups":["redeploy-AbCd1234"]}\n`);
    const summary = path.join(dir, 'summary.md');
    const result = spawnSync('bash', ['-c', stepScript('Create summary')], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, UPDATED_IN_PLACE: 'false', QA_OPERATION: 'redeploy',
            DISPATCH_REF: 'main', DISPATCH_SHA: '9'.repeat(40), EXPECTED_EXPLORER_COMMIT: COMMIT, SSH_USER: 'admin', SSH_HOST: 'h', WORKSPACE: 'w', ROUTER_PORT: '1',
            CLOUDFLARE_TUNNEL_NAME: 'n', CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: 'p', PUBLIC_URL: 'u' } });
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(summary, 'utf8');
    assert.match(text, new RegExp(`pinned at \`${COMMIT}\``));
    assert.match(text, /Helpers and tests from `main@9{40}`/);
    assert.match(text, /Deployment selection and reasons: `\{"result":"selected","mode":"redeploy"\}`/);
    assert.match(text, /Retention receipt: `\{"result":"pruned","removedBackups":\["redeploy-AbCd1234"\]\}`/);
});

test('the retained Boxes and regenerated repository maps are named in the preservation step', () => {
    const preservation = block('durable workspace preservation');
    for (const name of ['enabled_repos.json', 'repo_sources.json', 'unregistered_agent_repos.json']) {
        assert.match(preservation, new RegExp(`'${name}'`));
    }
});

test('the remote deployment and update scripts parse as shell, including their nested heredocs', () => {
    for (const [name, terminator] of [['REMOTE', 'REMOTE'], ['UPDATE', 'UPDATE']]) {
        const match = workflow.match(new RegExp(`<<'${name}'[^\\n]*\\n([\\s\\S]*?)\\n {10}${terminator}\\n`));
        assert.ok(match, `Missing ${name} script`);
        const checked = spawnSync('bash', ['-n'], { input: match[1].replace(/^ {10}/gm, ''), encoding: 'utf8', timeout: 10000 });
        assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
    }
});

function shellBlock(name) {
    const match = workflow.match(new RegExp(`# BEGIN QA ${name}\\n([\\s\\S]*?)# END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

test('a failed redeploy prints the rollback reference from the exit handler, once, without changing the status', t => {
    const handler = shellBlock('failure rollback reference');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-reference-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const predecessor = 'a'.repeat(64);
    const fresh = 'b'.repeat(64);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'podman'), '#!/bin/bash\n[ -n "$QA_MOCK_ID" ] && echo "$QA_MOCK_ID"\n[ -n "$QA_MOCK_ID" ]\n', { mode: 0o755 });
    const run = (setup, mockId) => {
        const script = `set -uo pipefail\n${handler}\nQA_ROLLBACK_REFERENCE_PRINTED=0\nQA_STOP_STARTED=1\nBOX_INSTANCE=box\n${setup}\n`
            + `cleanup() { local status=$?; if [ "$status" -ne 0 ]; then print_rollback_reference_on_failure || true; fi; exit "$status"; }\n`
            + `trap cleanup EXIT\nprint_rollback_reference_on_failure; print_rollback_reference_on_failure; exit 7\n`;
        return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, QA_MOCK_ID: mockId } });
    };
    const runUnset = (setup, mockId) => run(`QA_STOP_STARTED=0\n${setup}`, mockId);
    const records = `declare -a QA_CONTAINER_RECORDS=("x|${predecessor}|y")\nQA_BACKUP_DIR=/home/admin/.qa-deployment-backups/redeploy-AbCd1234`;
    const parse = result => result.stdout.split('\n').filter(line => line.includes('Rollback reference'));
    const withFresh = run(records, fresh);
    assert.equal(withFresh.status, 7);
    assert.deepEqual(parse(withFresh), [`[deploy-qa] Rollback reference: backup=redeploy-AbCd1234 predecessor=${predecessor} current=${fresh}`]);
    assert.deepEqual(parse(run(records, predecessor)), [`[deploy-qa] Rollback reference: backup=redeploy-AbCd1234 predecessor=${predecessor} current=absent`]);
    assert.deepEqual(parse(run(records, '')), [`[deploy-qa] Rollback reference: backup=redeploy-AbCd1234 predecessor=${predecessor} current=absent`]);
    assert.deepEqual(parse(run('QA_BACKUP_DIR=/x/redeploy-AbCd1234\ndeclare -a QA_CONTAINER_RECORDS=()', fresh)), [], 'no predecessor record, no reference');
    assert.deepEqual(parse(run(`${records}\nQA_ROLLBACK_REFERENCE_PRINTED=1`, fresh)), [], 'not printed twice after the normal print');
    assert.deepEqual(parse(run('declare -a QA_CONTAINER_RECORDS=()', fresh)), [], 'no backup directory yet');
    for (const mockId of [fresh, predecessor, '']) {
        const untouched = runUnset(records, mockId);
        assert.equal(untouched.status, 7, 'exit status is preserved');
        assert.deepEqual(parse(untouched), [], 'backup and record without a started stop print nothing');
    }
    assert.equal(parse(run(records, fresh)).length, 1, 'with the flag set the reference prints exactly once');
});

test('the remote script sets the printed flag after the normal reference and wires the handler into the exit trap', () => {
    const script = workflow;
    assert.match(script, /Rollback reference: backup=\$\{QA_BACKUP_DIR##\*\/\} predecessor=\$QA_PREDECESSOR_ID current=\$QA_CURRENT_ID"\n\s+QA_ROLLBACK_REFERENCE_PRINTED=1/);
    assert.match(script, /if \[ "\$status" -ne 0 \]; then\n\s+print_rollback_reference_on_failure \|\| true\n\s+fi\n\s+release_qa_workspace_lock/);
    assert.match(script, /if \[ -n "\$QA_RETENTION_DIR" \]; then\n\s+rm -f "\$QA_RETENTION_DIR\/qa-backups\.mjs" "\$QA_RETENTION_DIR\/qa-backups-privileged\.mjs" \\\n\s+"\$QA_RETENTION_DIR\/update-explorer-qa\.mjs" "\$QA_RETENTION_DIR\/rollback-explorer-qa\.mjs"\n\s+rmdir "\$QA_RETENTION_DIR" 2>\/dev\/null \|\| true/);
    const parsed = spawnSync('bash', ['-n'], { input: shellBlock('failure rollback reference'), encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
});

test('QA_STOP_STARTED is initialised before the trap and set after the backup directory and before the first stop', () => {
    const at = pattern => { const index = workflow.search(pattern); assert.ok(index >= 0, `Missing ${pattern}`); return index; };
    const init = at(/\n\s+QA_STOP_STARTED=0\n/);
    const trap = at(/trap cleanup_remote_files EXIT/);
    const backup = at(/QA_BACKUP_DIR="\$\(mktemp -d/);
    const stopEcho = at(/echo "\[deploy-qa\] Stopping nested QA services/);
    const assignments = [...workflow.matchAll(/\n\s+QA_STOP_STARTED=1\n/g)].map(match => match.index);
    assert.ok(init < trap, 'initialised before the trap');
    assert.equal(assignments.length, 2, 'set before the stop echo and before the preservation step');
    assert.ok(backup < assignments[0] && assignments[0] < stopEcho, 'set after backup creation and before the stop echo');
    assert.match(workflow.slice(assignments[0], stopEcho), /^\n\s+QA_STOP_STARTED=1\n\s+$/);
    assert.match(workflow.slice(assignments[1], assignments[1] + 200), /^\n\s+QA_STOP_STARTED=1\n\s+sudo -n \/usr\/bin\/node/);
    assert.match(workflow, /\[ "\$QA_ROLLBACK_REFERENCE_PRINTED" = 0 \] \|\| return 0\n\s+\[ "\$QA_STOP_STARTED" = 1 \] \|\| return 0/);
});
