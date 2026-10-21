import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

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

test('the pinned commit reaches every check: the Reconcile step has no input line of its own and neither check is gated on the mode', () => {
    assert.doesNotMatch(step('Reconcile and start Explorer QA Box'), /^ {10}EXPECTED_EXPLORER_COMMIT:/m);
    assert.match(step('Reconcile and start Explorer QA Box'), /OPERATION: \$\{\{ steps\.inplace\.outputs\.operation \}\}/);
    assert.doesNotMatch(step('Update the existing Explorer QA installation in place'), /^ {8}env:/m);
    assert.match(stepScript('Update the existing Explorer QA installation in place'), /\$EXPECTED_EXPLORER_COMMIT/);
    // Reconcile accepts the pin or a proven fast-forward descendant of it; the in-place path keeps the exact pin.
    const earlyCall = 'prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "$QA_EXPLORER_HEAD" early || exit 1';
    const early = workflow.indexOf(earlyCall);
    assert.ok(early > 0);
    const earlyGuard = workflow.slice(workflow.lastIndexOf('QA_EXPLORER_URL=', early) - 400, early + earlyCall.length);
    assert.doesNotMatch(earlyGuard, /QA_OPERATION/, 'the early check is not gated on the mode');
    assert.ok(early < workflow.indexOf('# BEGIN QA retention helpers'));
    assert.ok(early > workflow.indexOf('# END QA explorer fast-forward proof'));
    assert.match(workflow.slice(early, early + 400), /QA_RESOLVED_EXPLORER_COMMIT="\$QA_EXPLORER_HEAD"/);
    const lateCall = 'prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "${EXPECTED_COMMITS[AchillesIDE]}" late || exit 1';
    const lateStart = workflow.indexOf(lateCall);
    assert.ok(lateStart > workflow.indexOf('EXPLORER_BRANCH="${EXPECTED_BRANCHES[AchillesIDE]}"') && lateStart < workflow.indexOf("PLOINKY_URL='"));
    assert.equal(workflow.slice(workflow.lastIndexOf('\n', lateStart) + 1, workflow.indexOf('\n', lateStart)).includes('QA_OPERATION'), false, 'the late check is not gated on the mode');
    // AC3: no exact comparison with the pin remains in Reconcile.
    assert.doesNotMatch(workflow, /"\$\{EXPECTED_COMMITS\[AchillesIDE\]\}" != "\$EXPECTED_EXPLORER_COMMIT"|"\$QA_EXPLORER_HEAD" != "\$EXPECTED_EXPLORER_COMMIT"/);
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
    // The helpers are also transferred for a resume, which runs the route, the lock holder and the tail from them.
    assert.match(shellBlock('retention helpers'), /^if \[ "\$QA_OPERATION" = redeploy \] \|\| \[ "\$QA_OPERATION" = resume \]; then\n/m);
    assert.match(shellBlock('redeploy preflight'), /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m, 'the preflight stays redeploy-only');
});

// AC13 and AC14: admissions, Node, pins, preflight, retention, capacity, then the first backup directory.
test('retention sits after the read-only admissions and the preflight, and before capacity and the first backup directory', () => {
    const at = marker => { const index = workflow.indexOf(marker); assert.ok(index > 0, marker); return index; };
    const order = [
        'Durable-state admission passed',
        'Verified QA-scoped Node v24.19.0',
        'prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "$QA_EXPLORER_HEAD" early',
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
    assert.match(workflow, /sudo -n \/usr\/bin\/node --input-type=module - "\$WORK_DIR" "\$QA_OPERATION" "\$QA_RESUME_BACKUP_DIR" <<'NODE'\n\n?\s+import assert from 'node:assert\/strict';\n[\s\S]*?\/\/ BEGIN QA capacity admission/);
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
    assert.match(workflow, /QA_OPERATION="\$\{2:-update\}"\n\s+case "\$QA_OPERATION" in\n\s+update\|redeploy\|resume\) ;;/);
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
    assert.match(script, /if \[ -n "\$QA_RETENTION_DIR" \]; then\n\s+rm -f "\$QA_RETENTION_DIR\/qa-backups\.mjs" "\$QA_RETENTION_DIR\/qa-backups-privileged\.mjs" \\\n\s+"\$QA_RETENTION_DIR\/update-explorer-qa\.mjs" "\$QA_RETENTION_DIR\/rollback-explorer-qa\.mjs" \\\n\s+"\$QA_RETENTION_DIR\/hold-workspace-lock\.mjs"\n\s+rmdir "\$QA_RETENTION_DIR" 2>\/dev\/null \|\| true\n\s+fi\n\s+remove_qa_ancestry_dir \|\| true\n\s+exit "\$status"/);
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
    assert.equal(assignments.length, 3, 'set before the stop echo and before the preservation step, and once at the end of the resume setup');
    assert.ok(assignments[2] > at(/# BEGIN QA resume setup/) && assignments[2] < at(/# END QA resume setup/), 'the third assignment is the resume setup\'s');
    assert.ok(assignments[2] > at(/BEGIN QA resume stale runtime removal/), 'a resume declares the stop only after it holds the lock and removed the stale clones');
    assert.ok(backup < assignments[0] && assignments[0] < stopEcho, 'set after backup creation and before the stop echo');
    assert.match(workflow.slice(assignments[0], stopEcho), /^\n\s+QA_STOP_STARTED=1\n\s+$/);
    assert.match(workflow.slice(assignments[1], assignments[1] + 200), /^\n\s+QA_STOP_STARTED=1\n\s+sudo -n \/usr\/bin\/node/);
    assert.match(workflow, /\[ "\$QA_ROLLBACK_REFERENCE_PRINTED" = 0 \] \|\| return 0\n\s+\[ "\$QA_STOP_STARTED" = 1 \] \|\| return 0/);
});

// ---------------------------------------------------------------------------------------------
// Fast-forward acceptance (AC2), the post-start rule (AC4), the resume path (AC8-AC11).
// ---------------------------------------------------------------------------------------------

const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const gitEnv = {
    GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.test', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd, ...args) => {
    const result = spawnSync(realGit, args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
};

// A real origin that serves partial clones: main is c1 <- c2 <- c3, and "side" branches off c1.
// It is built once and shared, because every git call is slow on a loaded machine.
let sharedOrigin = null;
const originRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ancestry-origin-'));
after(() => fs.rmSync(originRoot, { recursive: true, force: true }));
function makeOrigin() {
    if (sharedOrigin) return sharedOrigin;
    const root = originRoot;
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'config', 'uploadpack.allowFilter', 'true');
    const commit = name => { fs.writeFileSync(path.join(origin, name), name); git(origin, 'add', name); git(origin, 'commit', '-q', '-m', name); return git(origin, 'rev-parse', 'HEAD'); };
    const c1 = commit('one');
    git(origin, 'checkout', '-q', '-b', 'side');
    const side = commit('side');
    git(origin, 'checkout', '-q', 'main');
    const c2 = commit('two');
    const c3 = commit('three');
    sharedOrigin = { root, url: `file://${origin}`, c1, c2, c3, side };
    return sharedOrigin;
}

// `timeout` is GNU; the shim only fills a gap and never shadows a real one. The git wrapper records
// how the ancestry clone was made, and can force the status of merge-base.
function ancestryTools(root) {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
real='${realGit}'
log='${path.join(root, 'git.log')}'
echo "git $* [lazy=\${GIT_NO_LAZY_FETCH:-}]" >> "$log"
case " $* " in
  *' merge-base '*) if [ -n "\${QA_FORCE_MERGE_BASE:-}" ]; then exit "$QA_FORCE_MERGE_BASE"; fi ;;
esac
"$real" "$@"
status=$?
if [ "$1" = clone ] && [ "$status" -eq 0 ]; then
  for last; do :; done
  echo "promisor=$("$real" -C "$last" config --get remote.origin.promisor) filter=$("$real" -C "$last" config --get remote.origin.partialclonefilter)" >> "$log"
fi
exit "$status"
`, { mode: 0o755 });
    return bin;
}

function runProof(t, { origin, expected, resolved, phase = 'early', operation = 'redeploy', url, merge } = {}) {
    const tools = ancestryTools(origin.root);
    fs.rmSync(path.join(origin.root, 'git.log'), { force: true });
    const script = `set -uo pipefail
QA_ANCESTRY_DIR=""
QA_OPERATION=${operation}
QA_BACKUP_DIR=/home/admin/.qa-deployment-backups/redeploy-AbCd1234
QA_EXPLORER_URL='${url ?? origin.url}'
QA_EXPLORER_BRANCH=main
${shellBlock('ancestry directory removal')}
${shellBlock('explorer fast-forward proof')}
prove_explorer_fast_forward '${expected}' '${resolved}' ${phase}
echo "status=$?"
echo "dir=\${QA_ANCESTRY_DIR:-unset}"
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000,
        env: { ...process.env, ...gitEnv, PATH: `${tools}:${process.env.PATH}`, ...(merge === undefined ? {} : { QA_FORCE_MERGE_BASE: String(merge) }) } });
    const log = fs.existsSync(path.join(origin.root, 'git.log')) ? fs.readFileSync(path.join(origin.root, 'git.log'), 'utf8') : '';
    return { result, log, status: Number(result.stdout.match(/^status=(\d+)$/m)?.[1]), dir: result.stdout.match(/^dir=(.*)$/m)?.[1] };
}

test('P == R is accepted without any fetch', t => {
    const origin = makeOrigin();
    const { status, result, log } = runProof(t, { origin, expected: origin.c3, resolved: origin.c3, url: 'file:///nonexistent/never-fetched' });
    assert.equal(status, 0, result.stdout + result.stderr);
    assert.equal(log, '', 'git never ran');
    assert.doesNotMatch(result.stdout, /moved from/);
});

test('a fast-forward descendant is proven in a partial clone, logged, and its temporary directory is removed', t => {
    const origin = makeOrigin();
    const { status, result, log, dir } = runProof(t, { origin, expected: origin.c1, resolved: origin.c3, phase: 'late' });
    assert.equal(status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`\\[deploy-qa\\] AssistOSExplorer main moved from ${origin.c1} to ${origin.c3} \\(fast-forward, late\\); deploying ${origin.c3}\\.`));
    assert.equal(dir, 'unset');
    assert.match(log, /git clone --bare --filter=tree:0 --single-branch --branch main --no-tags file:\/\/\S+ \/tmp\/explorer_qa_ancestry\.[A-Za-z0-9]{6}\/history \[lazy=1\]/);
    assert.match(log, /promisor=true filter=tree:0/, 'the clone is partial, so the filter path is the one exercised');
    assert.match(log, /cat-file -e [a-f0-9]{40}\^\{commit\}/);
    assert.match(log, /merge-base --is-ancestor /);
    assert.equal(fs.readdirSync('/tmp').some(name => /^explorer_qa_ancestry\./.test(name) && log.includes(name)), false, 'the clone directory is gone');
});

const MESSAGES = {
    'early redeploy': { operation: 'redeploy', phase: 'early', text: /nothing was stopped or moved\.$/m },
    'early update': { operation: 'update', phase: 'early', text: /nothing was stopped or moved\.$/m },
    'early resume': { operation: 'resume', phase: 'early', text: /QA stays down on its retained backup; dispatch again or roll back\.$/m },
    'late redeploy': { operation: 'redeploy', phase: 'late', text: /the retained backup redeploy-AbCd1234 can be rolled back, or dispatch again to resume it\.$/m },
    'late resume': { operation: 'resume', phase: 'late', text: /the retained backup redeploy-AbCd1234 can be rolled back, or dispatch again to resume it\.$/m },
    'late fresh install': { operation: 'update', phase: 'late', text: /not the expected [a-f0-9]{40}; nothing was started and no prior installation existed\.$/m },
};

for (const [name, mode] of Object.entries(MESSAGES)) {
    for (const [kind, pick] of Object.entries({
        'a sibling branch head': o => [o.c1, o.side],
        'a rewound parent': o => [o.c3, o.c2],
    })) {
        test(`${kind} is refused with the ${name} text`, t => {
            const origin = makeOrigin();
            const [expected, resolved] = pick(origin);
            const { status, result, dir } = runProof(t, { origin, expected, resolved, ...mode });
            assert.equal(status, 1, result.stdout + result.stderr);
            assert.match(result.stdout, mode.text);
            assert.match(result.stdout, /^\[deploy-qa\] ERROR: /m);
            assert.doesNotMatch(result.stdout, /moved from/);
            assert.equal(dir, 'unset');
        });
    }
    test(`a fetch failure is refused with the ${name} text`, t => {
        const origin = makeOrigin();
        const { status, result, dir } = runProof(t, { origin, expected: origin.c1, resolved: origin.c3, url: 'file:///nonexistent/origin', ...mode });
        assert.equal(status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, mode.text);
        assert.equal(dir, 'unset');
    });
}

test('every non-zero merge-base status (1 and 128) fails closed, and malformed inputs never reach git', t => {
    const origin = makeOrigin();
    for (const merge of [1, 128]) {
        const { status, result } = runProof(t, { origin, expected: origin.c1, resolved: origin.c3, merge });
        assert.equal(status, 1, `merge-base status ${merge}`);
        assert.doesNotMatch(result.stdout, /moved from/);
    }
    for (const [expected, resolved, phase] of [[origin.c1, 'A'.repeat(40), 'early'], ['b'.repeat(39), origin.c3, 'early'], [origin.c1, '', 'late'], [origin.c1, origin.c3, 'middle']]) {
        const { status, log } = runProof(t, { origin, expected, resolved, phase });
        assert.equal(status, 1, `${expected} ${resolved} ${phase}`);
        assert.equal(log, '', 'nothing was fetched');
    }
});

test('the ancestry directory removal only deletes the exact mktemp shape of a real directory of this user', t => {
    const removal = shellBlock('ancestry directory removal');
    const run = path_ => spawnSync('bash', ['-c', `set -uo pipefail\nQA_ANCESTRY_DIR='${path_}'\n${removal}\nremove_qa_ancestry_dir\necho "status=$?"\necho "dir=\${QA_ANCESTRY_DIR:-unset}"\n`], { encoding: 'utf8', timeout: 20000 });
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-not-ancestry-'));
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-ancestry-victim-'));
    const link = `/tmp/explorer_qa_ancestry.${crypto.randomBytes(3).toString('hex').slice(0, 6)}`;
    const real = fs.mkdtempSync('/tmp/explorer_qa_ancestry.');
    t.after(() => { for (const item of [stray, victim, real]) fs.rmSync(item, { recursive: true, force: true }); fs.rmSync(link, { force: true }); });
    fs.writeFileSync(path.join(victim, 'keep'), 'data');
    fs.symlinkSync(victim, link);
    for (const refused of [stray, link, '/tmp/explorer_qa_ancestry.abc', '/tmp/explorer_qa_ancestry.abcdefg', `${real}/..`]) {
        assert.match(run(refused).stdout, /status=1/, refused);
    }
    assert.equal(fs.existsSync(stray), true);
    assert.equal(fs.existsSync(path.join(victim, 'keep')), true, 'a symlink is never followed');
    assert.match(run(real).stdout, /status=0\ndir=unset/);
    assert.equal(fs.existsSync(real), false);
    assert.match(run('/tmp/explorer_qa_ancestry.GONE00').stdout, /status=0/, 'an already removed directory is fine');
});

// AC4: the post-start rule, run against a stub engine. `merge-base` answers with a forced status.
// The deployment script uses associative arrays, so these runs need bash 4 (the host and CI have it; macOS ships 3.2).
const bashMajor = Number(spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).stdout.trim());
const bash4 = bashMajor >= 4 ? {} : { skip: `Requires bash 4 associative arrays (found bash ${bashMajor}); run these on Linux.` };
const GRAPH = ['AchillesIDE', 'UmamiAgent', 'OnlyOfficeAgent', 'AchillesCLI', 'copilot-agents', 'webmeet'];

function runDeployedVerification(t, { deployed = {}, mergeBase = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-post-start-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const calls = path.join(dir, 'calls');
    const expected = Object.fromEntries(GRAPH.map((name, index) => [name, String(index + 1).repeat(40)]));
    const script = `set -euo pipefail
WORK_DIR=/home/admin/explorerQaWorkspace
BOX_INSTANCE=ploinky-box-explorerqaworkspace-7a31ab7775eb
BOX_ENGINE=podman
GRAPH_REPOSITORIES=(${GRAPH.map(name => `'${name}|https://github.com/AssistOS-AI/${name}.git'`).join(' ')})
declare -A EXPECTED_BRANCHES=(${GRAPH.map(name => `[${name}]=main`).join(' ')})
declare -A EXPECTED_COMMITS=(${GRAPH.map(name => `[${name}]=${expected[name]}`).join(' ')})
verify_ala_checkout() { :; }
podman() {
    # container exec --user podman BOX git -C DIR <subcommand> ...
    local directory="$8" name sub="$9"
    name="\${directory##*/}"
    echo "$name $sub $*" >> '${calls}'
    case "$sub" in
        rev-parse)
            if [ "\${10}" = HEAD ]; then
                local override="DEPLOYED_$(printf '%s' "$name" | tr -c 'A-Za-z0-9\\n' _)"
                printf '%s\\n' "\${!override:-$(printf '%s' "\${EXPECTED_COMMITS[$name]}")}"
            else echo origin/main; fi ;;
        branch) echo main ;;
        status) ;;
        merge-base) return ${mergeBase} ;;
        *) echo "unexpected git $sub" >&2; return 99 ;;
    esac
}
${shellBlock('deployed source verification')}
printf 'final=%s\\n' "\${EXPECTED_COMMITS[@]}" | sort
`;
    const env = { ...process.env };
    for (const [name, commit] of Object.entries(deployed)) env[`DEPLOYED_${name.replace(/[^A-Za-z0-9]/g, '_')}`] = commit;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000, env });
    return { result, expected, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('a deployed commit equal to the resolved one passes without an ancestry check', bash4, t => {
    const { result, calls, expected } = runDeployedVerification(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(calls, /merge-base/);
    assert.match(result.stdout, new RegExp(`Deployed AssistOSExplorer commit: ${expected.AchillesIDE}`));
    assert.equal(result.stdout.match(/Verified \S+ at [a-f0-9]{40}\./g).length, 6);
});

test('a deployed commit that is a fast-forward of the resolved one passes for every graph repository and is carried forward', bash4, t => {
    for (const name of GRAPH) {
        const moved = 'f'.repeat(40);
        const { result, calls, expected } = runDeployedVerification(t, { deployed: { [name]: moved }, mergeBase: 0 });
        assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, new RegExp(`\\[deploy-qa\\] ${name}/main moved from ${expected[name]} to ${moved} between source resolution and start \\(fast-forward\\); verifying ${moved}\\.`));
        assert.match(result.stdout, new RegExp(`Verified ${name}/main at ${moved}\\.`));
        assert.match(calls, new RegExp(`${name} merge-base .* merge-base --is-ancestor ${expected[name]} ${moved}`));
        assert.ok(result.stdout.includes(`final=${moved}`), 'EXPECTED_COMMITS carries the deployed commit into the verification expectation');
        assert.equal(result.stdout.includes(`final=${expected[name]}`), false);
    }
    const explorer = runDeployedVerification(t, { deployed: { AchillesIDE: 'e'.repeat(40) } });
    assert.match(explorer.result.stdout, /Deployed AssistOSExplorer commit: e{40}/);
});

for (const status of [1, 128, 2]) {
    test(`a deployed commit whose ancestry check exits ${status} is a mismatch`, bash4, t => {
        const { result, expected } = runDeployedVerification(t, { deployed: { UmamiAgent: 'f'.repeat(40) }, mergeBase: status });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, new RegExp(`ERROR: deployed UmamiAgent commit ${'f'.repeat(40)}\\n.*does not match main at ${expected.UmamiAgent}\\.`));
        assert.doesNotMatch(result.stdout, /moved from|Deployed AssistOSExplorer/);
    });
}

test('a malformed deployed commit is a mismatch without asking git', bash4, t => {
    const { result, calls } = runDeployedVerification(t, { deployed: { webmeet: 'not-a-commit' } });
    assert.equal(result.status, 1);
    assert.doesNotMatch(calls, /merge-base/);
});

test('the verification expectation takes the commits after the deployed-source loop, and the loop carries them', () => {
    const loopEnd = workflow.indexOf('# END QA deployed source verification');
    const sources = workflow.indexOf('QA_EXPECTED_SOURCES=(');
    assert.ok(loopEnd > 0 && sources > loopEnd);
    assert.match(workflow.slice(sources, sources + 700), /\$\{EXPECTED_COMMITS\[\$repository_name\]\}/);
    assert.match(shellBlock('deployed source verification'), /EXPECTED_COMMITS\["\$repository_name"\]="\$deployed_commit"/);
});

// AC8, AC11 and the resume order (decision B3, notes N3 and N5).
const resumeSetup = () => shellBlock('resume setup');

test('the resume setup never stops, renames, backs up, prunes or removes through the shell, and sits in the guarded else-branch', () => {
    const setup = resumeSetup();
    for (const forbidden of ['container stop', 'container rename', 'mktemp -d "$HOME/.qa-deployment-backups', 'qa-backups.mjs" prune', 'rm -rf', 'rm -fr', 'mkdir -p "$WORK_DIR"',
        'capture "$QA_BACKUP_DIR"', 'renameSync', 'cp -a']) {
        assert.equal(setup.includes(forbidden), false, forbidden);
    }
    const wrapper = workflow.indexOf('if [ "$QA_OPERATION" != resume ]; then\n          mkdir -p "$HOME/.qa-deployment-backups"');
    const backup = workflow.indexOf('QA_BACKUP_DIR="$(mktemp -d "$HOME/.qa-deployment-backups/redeploy-XXXXXXXX")"');
    const stop = workflow.indexOf('"$engine" container stop --time 30');
    const retired = workflow.indexOf('Exact prior Explorer QA runtime retired and retained stopped for rollback');
    const elseBranch = workflow.indexOf('          else\n          # BEGIN QA resume setup');
    const fi = workflow.indexOf('          # END QA resume setup\n          fi\n');
    assert.ok(wrapper > 0 && wrapper < backup && backup < stop && stop < retired && retired < elseBranch && elseBranch < fi,
        'the whole stop, backup and move segment is the if-branch of the resume guard');
    // The segment is only skipped by a resume; preflight and retention stay redeploy-only.
    assert.match(shellBlock('redeploy preflight'), /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m);
    assert.match(shellBlock('superseded backup retention'), /^if \[ "\$QA_OPERATION" = redeploy \]; then\n/m);
    assert.match(workflow, /\[ "\$QA_OPERATION" = resume \] \|\| assert_qa_preservation_admission/);
});

test('the resume setup follows the reviewed order: archive receipts, hold the lock, remove stale clones, declare the stop', () => {
    const setup = resumeSetup();
    const at = text => { const index = setup.indexOf(text); assert.ok(index >= 0, text); return index; };
    const order = [
        'QA_BACKUP_DIR="$QA_RESUME_BACKUP_DIR"',
        'QA_CONTAINER_RECORDS=("$QA_RESUME_RECORD")',
        'mkdir -m 700 "$QA_INTERRUPTED_DIR"',
        'mv -n ',
        'node "$QA_RETENTION_DIR/hold-workspace-lock.mjs" "$QA_BACKUP_DIR/workspace" "$QA_BACKUP_DIR"',
        'QA_WORKSPACE_LOCK_PID=$!',
        'assert_qa_workspace_lock_held\n',
        'BEGIN QA resume stale runtime removal',
        'fs.rmSync(directory, { recursive: true })',
        'END QA resume stale runtime removal',
        'QA_STOP_STARTED=1',
        'Resuming the preserving redeploy from',
    ].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(setup, /"\$QA_TAIL_HELPER" "\$\$" > "\$QA_BACKUP_DIR-lock\.log"/);
    assert.match(setup, /QA_TAIL_HELPER="\$QA_RETENTION_DIR\/rollback-explorer-qa\.mjs"/);
});

test('the resume lock holder is byte-identical to the archive lock holder, so the lock tests cover both', () => {
    const holders = [...workflow.matchAll(/cat > "\$(?:QA_HELPER_DIR|QA_RETENTION_DIR)\/hold-workspace-lock\.mjs" <<'NODE'\n([\s\S]*?)\n {10}NODE\n/g)].map(match => match[1]);
    assert.equal(holders.length, 2);
    assert.equal(holders[0], holders[1]);
    assert.match(holders[0], /BEGIN QA archive lock holder/);
});

test('the tail runs the helper chosen by each branch and no tail step reads the frozen copy directly (AC11)', () => {
    assert.ok(workflow.match(/QA_TAIL_HELPER/g).length >= 4);
    assert.equal(workflow.match(/^ {10}QA_TAIL_HELPER=/gm).length, 2, 'one definition per branch');
    const tail = workflow.slice(workflow.indexOf('\n          mkdir -p "$WORK_DIR"\n'));
    assert.doesNotMatch(tail, /"\$QA_HELPER_DIR\/rollback-explorer-qa\.mjs"/);
    assert.equal(tail.match(/"\$QA_TAIL_HELPER"/g).length, 2);
    // The frozen copy stays the rollback authority: the non-resume branch still points at it.
    assert.match(workflow, /QA_HELPER_DIR="\$QA_BACKUP_DIR\/helpers"\n {10}QA_TAIL_HELPER="\$QA_HELPER_DIR\/rollback-explorer-qa\.mjs"/);
});

test('every edited heredoc of this change is valid module code', t => {
    assertParses(t, 'resume stale runtime removal', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${block('resume stale runtime removal')}`);
    assertParses(t, 'capacity admission', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
${block('capacity admission')}`);
    const removal = workflow.match(/remove_qa_ancestry_dir\(\) \{\n[^\n]*\n[^\n]*<<'NODE' \|\| return 1\n([\s\S]*?)\n {10}NODE\n/)[1].replace(/^ {10}/gm, '');
    assertParses(t, 'ancestry directory removal', removal);
    assertParses(t, 'archive lock holder', block('archive lock holder'));
    for (const name of ['REMOTE', 'UPDATE']) {
        const script = workflow.match(new RegExp(`<<'${name}'[^\\n]*\\n([\\s\\S]*?)\\n {10}${name}\\n`))[1].replace(/^ {10}/gm, '');
        assert.equal(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status, 0, name);
    }
    for (const name of ['resume setup', 'resume admission', 'explorer fast-forward proof', 'ancestry directory removal', 'deployed source verification']) {
        assert.equal(spawnSync('bash', ['-n'], { input: shellBlock(name), encoding: 'utf8' }).status, 0, name);
    }
});

// Resume admission: the route is asked again under the Reconcile lock, and only `resume` proceeds.
const RESUME_BOX = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';
const PREDECESSOR = 'd'.repeat(64);
const RESUME_BACKUP = 'redeploy-AbCd1234';
const resumeAnswer = (extra = {}) => JSON.stringify({ result: 'routed', route: 'resume', backup: RESUME_BACKUP, predecessorId: PREDECESSOR, engine: 'podman', ...extra });

function runResumeAdmission(t, { operation = 'resume', answer = resumeAnswer(), status = 0, record = `podman|${PREDECESSOR}|${RESUME_BOX}\n`, backupExists = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resume-admission-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const home = path.join(dir, 'home');
    const backup = path.join(home, '.qa-deployment-backups', RESUME_BACKUP);
    if (backupExists) fs.mkdirSync(backup, { recursive: true });
    if (backupExists && record !== null) fs.writeFileSync(path.join(backup, 'prior-containers.txt'), record);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-backups.mjs\\ route*) echo "$*" >> '${calls}'; printf '%s\\n' "$QA_STUB_ANSWER"; exit "$QA_STUB_STATUS" ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `set -euo pipefail
QA_OPERATION=${operation}
QA_RETENTION_DIR=${dir}
BOX_INSTANCE=${RESUME_BOX}
${shellBlock('resume admission')}
echo "backup=$QA_RESUME_BACKUP dir=$QA_RESUME_BACKUP_DIR record=$QA_RESUME_RECORD"
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 20000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, QA_STUB_ANSWER: answer, QA_STUB_STATUS: String(status) } });
    return { result, home, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('a proven resume route is admitted again under the Reconcile lock and its identifiers are kept', t => {
    const { result, home, calls } = runResumeAdmission(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(calls, /qa-backups\.mjs route --lock-held$/m);
    assert.match(result.stdout, /Resume route confirmed under the Reconcile lock: \{"result":"routed","route":"resume"/);
    assert.match(result.stdout, new RegExp(`backup=${RESUME_BACKUP} dir=${home}/.qa-deployment-backups/${RESUME_BACKUP} record=podman\\|${PREDECESSOR}\\|${RESUME_BOX}`));
});

for (const [name, options, message] of [
    ['a select answer', { answer: '{"result":"routed","route":"select"}' }, /did not prove a resumable redeploy/],
    ['a refusal', { answer: '{"result":"refused","code":"QA_REDEPLOY_UNFINISHED"}', status: 1 }, /resume route was refused.*QA_REDEPLOY_UNFINISHED/],
    ['a route helper that exits 75', { answer: '', status: 75 }, /resume route was refused/],
    ['garbage', { answer: 'not json' }, /did not prove a resumable redeploy/],
    ['a short predecessor id', { answer: resumeAnswer({ predecessorId: 'd'.repeat(63) }) }, /did not prove a resumable redeploy/],
    ['an uppercase predecessor id', { answer: resumeAnswer({ predecessorId: 'D'.repeat(64) }) }, /did not prove a resumable redeploy/],
    ['a malformed backup name', { answer: resumeAnswer({ backup: 'redeploy-../x' }) }, /did not prove a resumable redeploy/],
    ['an unknown engine', { answer: resumeAnswer({ engine: 'lxc' }) }, /did not prove a resumable redeploy/],
    ['a missing backup directory', { backupExists: false }, /does not record the retained predecessor Box/],
    ['a prior-containers record of another Box', { record: `podman|${'e'.repeat(64)}|${RESUME_BOX}\n` }, /does not record the retained predecessor Box/],
    ['a prior-containers record with a trailing space', { record: `podman|${PREDECESSOR}|${RESUME_BOX} \n` }, /does not record the retained predecessor Box/],
    ['a prior-containers record of another engine', { record: `docker|${PREDECESSOR}|${RESUME_BOX}\n` }, /does not record the retained predecessor Box/],
]) {
    test(`resume admission refuses ${name} before anything is stopped or moved`, t => {
        const { result } = runResumeAdmission(t, options);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stdout, message);
        assert.doesNotMatch(result.stdout, /Resume admitted|backup=/);
    });
}

test('resume admission does nothing for the other operations', t => {
    for (const operation of ['redeploy', 'update']) {
        const { result, calls } = runResumeAdmission(t, { operation });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(calls, '');
        assert.match(result.stdout, /backup= dir= record=\n/);
    }
});

// AC10: a resume measures only what the tail regenerates; every other mode keeps the 25 GiB rule.
const GIB = 1024n ** 3n;
const RETAINED = '/home/admin/.qa-deployment-backups/redeploy-AbCd1234';

function runCapacity(t, { free, argv = [], sizes = {}, failing = [], liveWorkspace = 30n * GIB } = {}) {
    const logs = [];
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resume-capacity-'));
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));
    const source = block('capacity admission').replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(target));
    const realLstat = fs.lstatSync;
    const directory = realLstat(target);
    const fake = { ...fs, statfsSync: () => ({ bavail: free, bsize: 1n }),
        lstatSync: item => String(item).startsWith(RETAINED) ? directory : realLstat(item) };
    const du = (_command, args) => {
        const location = args.at(-1);
        if (failing.some(item => location.endsWith(item))) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        if (location === target) return `${liveWorkspace}\tx\n`;
        const relative = location.startsWith(`${RETAINED}/workspace`) ? location.slice(`${RETAINED}/workspace`.length).replace(/^\//, '') : null;
        return `${relative === null ? 0n : (sizes[relative] ?? 0n)}\tx\n`;
    };
    // Stubs for the du probe and statfs only; the block itself is the one in the workflow.
    const run = () => new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
        assert, fake, path, du, { argv: ['node', '-', target, ...argv] }, { log: (...parts) => logs.push(parts.join(' ')) });
    return { run, logs };
}

const RESUME_SIZES = { '': 14n * GIB, '.ploinky/box': 2n * GIB, '.runtime': 1n * GIB, '.ploinky/repos': 1n * GIB, AdvancedLanguageAgent: GIB / 2n };

test('a resume needs 4 GiB plus the regenerated components, not the 25 GiB floor, and logs the rollback headroom', t => {
    // 2 + 1 + 1 + 0.5 = 4.5 GiB regenerated, so 8.5 GiB are required.
    const enough = runCapacity(t, { free: 9n * GIB, argv: ['resume', RETAINED], sizes: RESUME_SIZES });
    enough.run();
    const report = JSON.parse(enough.logs[0].slice('[deploy-qa] Capacity diagnostics: '.length));
    assert.equal(report.requiredFreeBytes, String(8n * GIB + GIB / 2n));
    assert.equal(report.shortfallBytes, '0');
    assert.equal(report.resume.regeneratedBytes, String(4n * GIB + GIB / 2n));
    assert.equal(report.resume.durableBytes, String(14n * GIB - 4n * GIB - GIB / 2n));
    assert.equal(report.resume.rollbackHeadroomBytes, String(9n * GIB - (14n * GIB - 4n * GIB - GIB / 2n)), 'logged, and negative when a rollback would not fit');
    assert.equal(report.resume.retainedBackup, 'redeploy-AbCd1234');
    assert.match(enough.logs.at(-1), /Capacity admission passed/);
    const short = runCapacity(t, { free: 8n * GIB, argv: ['resume', RETAINED], sizes: RESUME_SIZES });
    assert.throws(() => short.run(), /Insufficient QA capacity/);
    assert.equal(JSON.parse(short.logs[0].slice('[deploy-qa] Capacity diagnostics: '.length)).shortfallBytes, String(GIB / 2n));
});

test('a resume measurement is fatal: an unreadable component cannot lower the requirement', t => {
    for (const failing of ['.ploinky/box', '.runtime', '.ploinky/repos', 'AdvancedLanguageAgent', 'workspace']) {
        const { run } = runCapacity(t, { free: 100n * GIB, argv: ['resume', RETAINED], sizes: RESUME_SIZES, failing: [failing] });
        assert.throws(() => run(), /Unable to measure QA workspace allocation/, failing);
    }
});

test('the resume rule applies only to the exact retained backup of a resume', t => {
    for (const argv of [['resume'], ['resume', ''], ['resume', '/home/admin/.qa-deployment-backups/redeploy-../x'], ['resume', '/tmp/redeploy-AbCd1234'],
        ['resume', `${RETAINED}/workspace`]]) {
        assert.throws(() => runCapacity(t, { free: 100n * GIB, argv, sizes: RESUME_SIZES }).run(), /exact retained backup/, argv.join(' '));
    }
    // Any other mode keeps the 25 GiB floor and the prior-workspace rule, whatever else is passed.
    for (const argv of [[], ['redeploy', ''], ['update', RETAINED], ['anything', RETAINED]]) {
        assert.throws(() => runCapacity(t, { free: 15n * GIB, argv, sizes: RESUME_SIZES }).run(), /Insufficient QA capacity/, argv.join(' '));
        const admitted = runCapacity(t, { free: 40n * GIB, argv, sizes: RESUME_SIZES });
        admitted.run();
        const report = JSON.parse(admitted.logs[0].slice('[deploy-qa] Capacity diagnostics: '.length));
        assert.equal(report.requiredFreeBytes, String(34n * GIB));
        assert.equal(report.resume, null);
        assert.equal(report.minimumFreeBytes, String(25n * GIB));
    }
});

// AC9: the resume setup, run for real against a fixture workspace, a fixture backup and a stand-in lock manager.
const lockFunctions = () => workflow.slice(workflow.indexOf('          assert_qa_workspace_lock_held() {'), workflow.indexOf('          # BEGIN QA failure rollback reference'))
    .replace(/^ {10}/gm, '');

function resumeFixture(t, { origins = {} } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-resume-setup-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const backup = path.join(home, '.qa-deployment-backups', RESUME_BACKUP);
    const workspace = path.join(root, 'explorerQaWorkspace');
    const retention = path.join(root, 'retention');
    for (const dir of [path.join(backup, 'helpers'), path.join(backup, 'workspace'), path.join(workspace, '.runtime'), retention]) fs.mkdirSync(dir, { recursive: true });
    const clone = (relative, origin) => {
        const directory = path.join(workspace, relative);
        fs.mkdirSync(directory, { recursive: true });
        git(directory, 'init', '-q', '-b', 'main');
        git(directory, 'remote', 'add', 'origin', origin);
        fs.writeFileSync(path.join(directory, 'stale'), 'interrupted clone');
        return directory;
    };
    const stale = {
        ploinky: clone('.runtime/ploinky', origins.ploinky ?? 'https://github.com/AssistOS-AI/ploinky.git'),
        ala: clone('AdvancedLanguageAgent', origins.ala ?? 'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git'),
    };
    fs.writeFileSync(path.join(backup, 'prior-containers.txt'), `podman|${PREDECESSOR}|${RESUME_BOX}\n`);
    fs.writeFileSync(path.join(backup, 'helpers', 'rollback-explorer-qa.mjs'), '// frozen rollback authority\n');
    const events = path.join(root, 'events');
    // The stand-in helper exports what the lock holder and the tail use. Acquiring records whether the stale clones still exist,
    // which proves that they are removed only after the workspace lock is held.
    fs.writeFileSync(path.join(retention, 'rollback-explorer-qa.mjs'), `
import fs from 'node:fs';
export const QA_SCOPE = { box: '${RESUME_BOX}' };
export const productionAdapters = () => ({
    assertHost() {},
    async acquireWorkspaceLock(runtimeRoot) {
        fs.appendFileSync('${events}', 'acquire ' + runtimeRoot + ' clones-present=' + (fs.existsSync('${stale.ploinky}') && fs.existsSync('${stale.ala}')) + '\\n');
        return { release() { fs.appendFileSync('${events}', 'release\\n'); } };
    },
});
`);
    return { root, home, backup, workspace, retention, stale, events };
}

function runResumeSetup(t, fixture, { repeat = 1, release = true } = {}) {
    const { home, backup, workspace, retention } = fixture;
    const setup = shellBlock('resume setup').replaceAll('/home/admin/explorerQaWorkspace', workspace);
    const once = `${setup}
assert_qa_workspace_lock_held
echo "stop-started=$QA_STOP_STARTED lock-pid-set=$([ -n "$QA_WORKSPACE_LOCK_PID" ] && echo yes || echo no)"
echo "tail-helper=$QA_TAIL_HELPER helper-dir=$QA_HELPER_DIR records=\${QA_CONTAINER_RECORDS[*]}"
${release ? `# The release request is written atomically here: the workflow's own writer creates the file before its content,
# so a holder poll in between can see it empty (reported separately as an adjacent finding).
printf 'release\\n' > "$QA_BACKUP_DIR-lock-release.tmp"
mv "$QA_BACKUP_DIR-lock-release.tmp" "$QA_BACKUP_DIR-lock-release"
wait "$QA_WORKSPACE_LOCK_PID"
QA_WORKSPACE_LOCK_PID=""` : ''}
`;
    const script = `set -euo pipefail
umask 077
${lockFunctions()}
assert_qa_install_admission() { echo admission-called; }
QA_OPERATION=resume
QA_RETENTION_DIR='${retention}'
QA_RESUME_BACKUP=${RESUME_BACKUP}
QA_RESUME_BACKUP_DIR='${backup}'
QA_RESUME_PREDECESSOR=${PREDECESSOR}
QA_RESUME_RECORD='podman|${PREDECESSOR}|${RESUME_BOX}'
BOX_INSTANCE=${RESUME_BOX}
WORK_DIR='${workspace}'
QA_WORKSPACE_LOCK_PID=""
QA_STOP_STARTED=0
declare -a QA_CONTAINER_RECORDS=()
${Array.from({ length: repeat }, (_, index) => `${index ? 'sleep 1.1\n' : ''}${once}`).join('\n')}
`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: home, ...gitEnv } });
}

const staleReceipts = backup => {
    const outer = { 'lock-ready.json': '{"held":true}', 'lock-released.json': '{"released":true}', 'lock-release': 'release\n', 'lock.log': 'old log\n', 'lock-source.txt': 'master|abc\n' };
    for (const [suffix, text] of Object.entries(outer)) fs.writeFileSync(`${backup}-${suffix}`, text, { mode: 0o600 });
    fs.writeFileSync(path.join(backup, 'lock-ready.json'), '{"held":true,"inner":true}', { mode: 0o600 });
    fs.writeFileSync(path.join(backup, 'lock-release'), 'release\n', { mode: 0o600 });
    return outer;
};

test('the resume setup archives the stale receipts, holds the lock through the predecessor runtime, then removes only the stale clones', t => {
    const f = resumeFixture(t);
    const outer = staleReceipts(f.backup);
    fs.writeFileSync(path.join(f.workspace, 'operator-data'), 'preserved');
    const result = runResumeSetup(t, f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Archived, with nothing lost: the outer and inner receipts sit in one interrupted-<UTC> directory.
    const archives = fs.readdirSync(path.join(f.backup, 'helpers')).filter(name => /^interrupted-\d{8}T\d{6}Z$/.test(name));
    assert.equal(archives.length, 1);
    const archived = path.join(f.backup, 'helpers', archives[0]);
    for (const [suffix, text] of Object.entries(outer)) assert.equal(fs.readFileSync(path.join(archived, `outer-${suffix}`), 'utf8'), text, suffix);
    assert.equal(fs.readFileSync(path.join(archived, 'inner-lock-ready.json'), 'utf8'), '{"held":true,"inner":true}');
    assert.equal(fs.statSync(archived).mode & 0o777, 0o700);
    // The holder started after the archive, took the lock through the predecessor's workspace, and kept it until released.
    const events = fs.readFileSync(f.events, 'utf8').trim().split('\n');
    assert.deepEqual(events, [`acquire ${path.join(f.backup, 'workspace')} clones-present=true`, 'release']);
    assert.match(result.stdout, /^admission-called$/m);
    assert.match(result.stdout, /^stop-started=1 lock-pid-set=yes$/m);
    assert.match(result.stdout, new RegExp(`^tail-helper=${f.retention}/rollback-explorer-qa\\.mjs helper-dir=${f.backup}/helpers records=podman\\|${PREDECESSOR}\\|${RESUME_BOX}$`, 'm'));
    assert.match(result.stdout, new RegExp(`Resuming the preserving redeploy from ${RESUME_BACKUP}; predecessor ${PREDECESSOR} stays retained stopped; no service is stopped and no workspace file is moved\\.`));
    // Only the two stale clones are gone; the operator data and the runtime directory stay.
    assert.equal(fs.existsSync(f.stale.ploinky), false);
    assert.equal(fs.existsSync(f.stale.ala), false);
    assert.equal(fs.readFileSync(path.join(f.workspace, 'operator-data'), 'utf8'), 'preserved');
    assert.equal(fs.statSync(path.join(f.workspace, '.runtime')).isDirectory(), true);
    assert.match(result.stdout, /Removed the stale \.runtime\/ploinky clone/);
    assert.match(result.stdout, /Removed the stale AdvancedLanguageAgent clone/);
    // The released receipts of this run are the only ones left beside the backup.
    assert.equal(fs.existsSync(`${f.backup}-lock-released.json`), true);
});

test('without the archive a stale release request ends the new lease at once (the base behavior this order prevents)', t => {
    const f = resumeFixture(t);
    staleReceipts(f.backup);
    fs.rmSync(`${f.backup}-lock-ready.json`);
    fs.rmSync(`${f.backup}-lock-released.json`);
    // Same holder, started with the failed run's release request still present and no archive step.
    const holder = [...workflow.matchAll(/cat > "\$QA_RETENTION_DIR\/hold-workspace-lock\.mjs" <<'NODE'\n([\s\S]*?)\n {10}NODE\n/g)][0][1].replace(/^ {10}/gm, '');
    fs.writeFileSync(path.join(f.retention, 'hold-workspace-lock.mjs'), holder);
    const script = `set -euo pipefail
${lockFunctions()}
BOX_INSTANCE=${RESUME_BOX}
QA_BACKUP_DIR='${f.backup}'
QA_WORKSPACE_LOCK_PID=""
node '${f.retention}/hold-workspace-lock.mjs' '${f.backup}/workspace' '${f.backup}' '${f.retention}/rollback-explorer-qa.mjs' "$$" > '${f.backup}-lock.log' 2>&1 &
QA_WORKSPACE_LOCK_PID=$!
for _ in $(seq 1 200); do if [ -f '${f.backup}-lock-ready.json' ]; then break; fi; sleep 0.1; done
sleep 1
assert_qa_workspace_lock_held
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: f.home } });
    assert.notEqual(result.status, 0, 'the lease was released by the stale request, so the held-lock assertion fails');
});

test('a second resume after a failed tail archives the new receipts beside the first archive and loses nothing', t => {
    const f = resumeFixture(t);
    const result = runResumeSetup(t, f, { repeat: 2 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const archives = fs.readdirSync(path.join(f.backup, 'helpers')).filter(name => /^interrupted-/.test(name)).sort();
    assert.equal(archives.length, 2);
    // The first run's receipts (ready, released, release request, log) are in the first archive; the second finds the second set.
    assert.deepEqual(fs.readdirSync(path.join(f.backup, 'helpers', archives[1])).filter(name => name.startsWith('outer-')).sort(),
        ['outer-lock-ready.json', 'outer-lock-release', 'outer-lock-released.json', 'outer-lock.log']);
    assert.equal(fs.readdirSync(path.join(f.backup, 'helpers', archives[0])).length, 0, 'the first archive was empty: nothing existed before the first run');
    assert.equal(fs.existsSync(f.stale.ploinky), false);
});

test('a stale clone with a foreign origin, a symlink or a wrong runtime entry stops the resume before the stop is declared and nothing else is removed', t => {
    for (const [name, prepare, options] of [
        ['a foreign origin of the ploinky clone', () => {}, { origins: { ploinky: 'https://example.test/evil/ploinky.git' } }],
        ['a foreign origin of the ALA clone', () => {}, { origins: { ala: 'https://github.com/AssistOS-AI/Other.git' } }],
        ['an extra entry in the runtime directory', f => fs.writeFileSync(path.join(f.workspace, '.runtime', 'unreviewed'), 'x'), {}],
        ['a symlinked ALA clone', f => { fs.rmSync(f.stale.ala, { recursive: true }); fs.symlinkSync(f.stale.ploinky, f.stale.ala); }, {}],
    ]) {
        const f = resumeFixture(t, options);
        prepare(f);
        fs.writeFileSync(path.join(f.workspace, 'operator-data'), 'preserved');
        const result = runResumeSetup(t, f);
        assert.notEqual(result.status, 0, name);
        assert.doesNotMatch(result.stdout, /Resuming the preserving redeploy|stop-started=1/, name);
        assert.equal(fs.readFileSync(path.join(f.workspace, 'operator-data'), 'utf8'), 'preserved', name);
        assert.equal(fs.lstatSync(f.stale.ploinky, { throwIfNoEntry: false }) !== undefined, true, `${name}: no clone is removed when any proof fails`);
        assert.equal(fs.lstatSync(f.stale.ala, { throwIfNoEntry: false }) !== undefined, true, name);
    }
});

test('the resume setup refuses a backup that is not the exact redeploy directory', t => {
    const f = resumeFixture(t);
    const result = runResumeSetup(t, f);
    assert.equal(result.status, 0, result.stderr);
    const bad = resumeFixture(t);
    const setup = shellBlock('resume setup');
    const script = `set -euo pipefail\numask 077\nQA_RETENTION_DIR='${bad.retention}'\nQA_RESUME_BACKUP=redeploy-AbCd1234\nQA_RESUME_BACKUP_DIR='${bad.home}/.qa-deployment-backups/redeploy-OTHER123'\n${setup}\n`;
    const refused = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: bad.home } });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /the resume backup is not a real redeploy backup directory/);
    assert.equal(fs.existsSync(bad.stale.ploinky), true);
});

// The summary shows the route and the deployed commit.
test('the summary renders the route and, for a resume, the deployed commit', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-summary-resume-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'explorer-qa-update-result.json'), `[deploy-qa] Interrupted preserving redeploy found.\n[deploy-qa] Deployment route: ${resumeAnswer()}\n`);
    fs.writeFileSync(path.join(dir, 'explorer-qa-reconcile.log'), `[deploy-qa] Selected AssistOSExplorer commit ${'9'.repeat(40)} (dispatch pin ${COMMIT}).\n[deploy-qa] Deployed AssistOSExplorer commit: ${'9'.repeat(40)}\n`);
    const summary = path.join(dir, 'summary.md');
    const result = spawnSync('bash', ['-c', stepScript('Create summary')], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, UPDATED_IN_PLACE: 'false', QA_OPERATION: 'resume',
            DISPATCH_REF: 'main', DISPATCH_SHA: '8'.repeat(40), EXPECTED_EXPLORER_COMMIT: COMMIT, SSH_USER: 'admin', SSH_HOST: 'h', WORKSPACE: 'w', ROUTER_PORT: '1',
            CLOUDFLARE_TUNNEL_NAME: 'n', CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: 'p', PUBLIC_URL: 'u' } });
    assert.equal(result.status, 0, result.stderr);
    const text = fs.readFileSync(summary, 'utf8');
    assert.match(text, new RegExp(`Deployment route: \`\\{"result":"routed","route":"resume","backup":"${RESUME_BACKUP}"`));
    assert.match(text, /Resumed preserving redeploy: the interrupted redeploy was finished from its retained backup; no service was stopped/);
    assert.match(text, new RegExp(`Deployed AssistOSExplorer commit: \`${'9'.repeat(40)}\``));
    assert.doesNotMatch(text, /Preserving redeploy: the prior workspace/);
});

test('the in-place step uploads, runs and cleans up the route helpers beside the updater', () => {
    const script = stepScript('Update the existing Explorer QA installation in place');
    assert.match(script, /for helper in update-explorer-qa\.mjs rollback-explorer-qa\.mjs qa-backups\.mjs qa-backups-privileged\.mjs; do/);
    assert.match(script, /rm -f '\$REMOTE_DIR\/update-explorer-qa\.mjs' '\$REMOTE_DIR\/rollback-explorer-qa\.mjs' '\$REMOTE_DIR\/qa-backups\.mjs' '\$REMOTE_DIR\/qa-backups-privileged\.mjs' '\$REMOTE_DIR\/update\.json'/);
    assert.match(script, /elif \[ "\$status" -eq 44 \]; then\n\s+echo 'updated=false' >> "\$GITHUB_OUTPUT"\n\s+echo 'operation=resume' >> "\$GITHUB_OUTPUT"/);
});
