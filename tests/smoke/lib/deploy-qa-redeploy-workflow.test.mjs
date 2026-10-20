import assert from 'node:assert/strict';
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

function runStep(t, name, env, { remoteHead = 'f'.repeat(40) } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-redeploy-step-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho "git $*" >> '${calls}'\nprintf '%s\\trefs/heads/main\\n' '${remoteHead}'\n`, { mode: 0o755 });
    const result = spawnSync('bash', ['-c', stepScript(name)], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...env } });
    return { result, git: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

const COMMIT = 'a'.repeat(40);
const CONFIRM = 'redeploy explorerQaWorkspace';

test('the deploy job is selected for every operation except the rollbacks and has the raised timeout', () => {
    const deploy = workflow.match(/\n  deploy:\n([\s\S]*?)\n    steps:/)[1];
    assert.match(deploy, /if: \$\{\{ !startsWith\(inputs\.operation, 'rollback-'\) \}\}/);
    assert.match(deploy, /timeout-minutes: 90\n/);
    const rollback = workflow.match(/\n  rollback:\n([\s\S]*?)\n    steps:/)[1];
    assert.match(rollback, /if: \$\{\{ startsWith\(inputs\.operation, 'rollback-'\) \}\}/);
    assert.match(rollback, /timeout-minutes: 120\n/);
    assert.equal(workflow.match(/<<'ROLLBACK'/g)?.length, 1);
    assert.equal(workflow.match(/^          ROLLBACK$/gm)?.length, 1);
    const scripts = [...workflow.matchAll(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/gm)];
    assert(scripts.length >= 8);
    for (const [, script] of scripts) assert.doesNotMatch(script, /\$\{\{ *inputs\./, 'inputs reach a shell script only through env');
});

test('the operation validator accepts update with no inputs and pins redeploys to the remote main commit', t => {
    const update = runStep(t, 'Validate the requested operation', { OPERATION: 'update' });
    assert.equal(update.result.status, 0, update.result.stderr);
    assert.equal(update.git, '', 'update needs no remote lookup');
    assert.equal(runStep(t, 'Validate the requested operation', {}).result.status, 0, 'a missing operation means update');

    const rehearsal = runStep(t, 'Validate the requested operation', { OPERATION: 'redeploy-rehearsal', EXPECTED_EXPLORER_COMMIT: COMMIT },
        { remoteHead: COMMIT });
    assert.equal(rehearsal.result.status, 0, rehearsal.result.stderr);
    assert.match(rehearsal.git, /ls-remote --exit-code --heads https:\/\/github\.com\/AssistOS-AI\/AssistOSExplorer\.git refs\/heads\/main/);

    const redeploy = runStep(t, 'Validate the requested operation', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT, CONFIRM },
        { remoteHead: COMMIT });
    assert.equal(redeploy.result.status, 0, redeploy.result.stderr);
    assert.match(redeploy.result.stdout, new RegExp(`pinned to AssistOSExplorer main at ${COMMIT}`));
});

for (const [name, env, remoteHead] of [
    ['a commit of 39 hexadecimal characters', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT.slice(1), CONFIRM }],
    ['an uppercase commit', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: 'A'.repeat(40), CONFIRM }],
    ['a missing commit', { OPERATION: 'redeploy-rehearsal' }],
    ['a redeploy without its confirmation', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT }],
    ['a redeploy with a near-miss confirmation', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT, CONFIRM: 'redeploy' }],
    ['a rehearsal that carries a confirmation', { OPERATION: 'redeploy-rehearsal', EXPECTED_EXPLORER_COMMIT: COMMIT, CONFIRM }],
    ['an update that carries a commit', { OPERATION: 'update', EXPECTED_EXPLORER_COMMIT: COMMIT }],
    ['an update that carries a confirmation', { OPERATION: 'update', CONFIRM }],
    ['a deploy job given rollback inputs', { OPERATION: 'update', ROLLBACK_BACKUP: 'redeploy-AbCd1234' }],
    ['a deploy job given a rollback Box ID', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT, CONFIRM, ROLLBACK_CURRENT_ID: 'absent' }],
    ['a rollback operation', { OPERATION: 'rollback-plan' }],
    ['an unknown operation', { OPERATION: 'destroy' }],
    ['a main commit that moved', { OPERATION: 'redeploy', EXPECTED_EXPLORER_COMMIT: COMMIT, CONFIRM }, 'b'.repeat(40)],
]) {
    test(`the operation validator rejects ${name} before any SSH`, t => {
        const { result, git } = runStep(t, 'Validate the requested operation', env, { remoteHead });
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /::error::/);
        if (!remoteHead) assert.equal(git, '', 'rejected without contacting the remote');
    });
}

test('rollback requests are validated on the runner and cannot reach SSH with a malformed name or Box ID', t => {
    const validate = env => {
        const result = spawnSync('bash', ['-c', stepScript('Validate the rollback request')], { encoding: 'utf8', timeout: 5000,
            env: { PATH: process.env.PATH, ...env } });
        return result;
    };
    const plan = { OPERATION: 'rollback-plan', ROLLBACK_BACKUP: 'redeploy-AbCd1234', ROLLBACK_CURRENT_ID: 'absent' };
    assert.equal(validate(plan).status, 0);
    assert.equal(validate({ ...plan, ROLLBACK_CURRENT_ID: 'c'.repeat(64) }).status, 0);
    assert.equal(validate({ ...plan, OPERATION: 'rollback-execute', CONFIRM: 'redeploy-AbCd1234' }).status, 0);
    for (const [name, env] of [
        ['a seven character backup id', { ...plan, ROLLBACK_BACKUP: 'redeploy-1234567' }],
        ['a path traversal backup', { ...plan, ROLLBACK_BACKUP: '../x' }],
        ['a nine character backup id', { ...plan, ROLLBACK_BACKUP: 'redeploy-AbCd12345' }],
        ['a backup with a quote', { ...plan, ROLLBACK_BACKUP: "redeploy-AbCd12'3" }],
        ['an empty backup', { ...plan, ROLLBACK_BACKUP: '' }],
        ['a short Box id', { ...plan, ROLLBACK_CURRENT_ID: 'c'.repeat(63) }],
        ['an uppercase Box id', { ...plan, ROLLBACK_CURRENT_ID: 'C'.repeat(64) }],
        ['an empty Box id', { ...plan, ROLLBACK_CURRENT_ID: '' }],
        ['a plan with a confirmation', { ...plan, CONFIRM: 'redeploy-AbCd1234' }],
        ['an execute without a confirmation', { ...plan, OPERATION: 'rollback-execute' }],
        ['an execute with a mismatched confirmation', { ...plan, OPERATION: 'rollback-execute', CONFIRM: 'redeploy-ZyXw9876' }],
        ['an execute confirmed with the redeploy phrase', { ...plan, OPERATION: 'rollback-execute', CONFIRM }],
        ['a commit', { ...plan, EXPECTED_EXPLORER_COMMIT: COMMIT }],
        ['an update operation', { ...plan, OPERATION: 'update' }],
    ]) {
        const result = validate(env);
        assert.notEqual(result.status, 0, name);
        assert.match(result.stdout, /::error::/, name);
    }
});

test('the rollback job runs the backup\'s own helper, pins the host key and holds the host lock for both modes', () => {
    const run = stepScript('Run the recovery from the backup\'s own reviewed helper');
    assert.match(run, /"\$BACKUP\/helpers\/rollback-explorer-qa\.mjs"/);
    assert.match(run, /BACKUP\/helpers\/node-runtime-path/);
    assert.match(run, /\^\/home\/admin\/\\\.qa-deployment-tools\/node-v24\\\.19\\\.0-linux-\(x64\|arm64\)\$/);
    const arm = name => run.match(new RegExp(`${name}\\)\\n([\\s\\S]*?);;`))[1];
    for (const name of ['rollback-plan', 'rollback-execute']) {
        assert.match(arm(name), /LOCK_PREFIX='flock -n -E 75 --close \/home\/admin\/\.qa-deployment-operation\.lock '/, name);
    }
    assert.match(run, /--current-id "\$current_id" --lock-held\n/, 'both modes skip the helper\'s capped re-exec');
    assert.match(workflow, /rollback:\n[\s\S]*?timeout-minutes: 120/);
    assert.match(run, /--current-id "\$current_id"/);
    assert.match(step('Pin the Explorer QA SSH identity'), /= "\$SSH_ED25519_FINGERPRINT"/);
    assert.match(step('Pin the Explorer QA SSH identity'), /-o BatchMode|ssh-keyscan -T 10 -t ed25519 "\$SSH_HOST"/);
    assert.doesNotMatch(run, /scp |rollback-explorer-qa\.mjs"? *<|node "\$GITHUB_WORKSPACE/, 'no helper is copied to the host from the runner');
});

test('capacity stops a rehearsal only by report, while redeploy, update and an unnamed mode stay fatal', t => {
    const gib = 1024n ** 3n;
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-capacity-'));
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));
    const run = (mode, { free, workspace = 30n * gib, duFails = false }) => {
        const logs = [];
        const source = block('capacity admission').replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(target));
        new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
            assert, { ...fs, statfsSync: () => ({ bavail: free, bsize: 1n }) }, path,
            (_command, args) => {
                if (duFails && args.at(-1) === target) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
                return `${args.at(-1) === target ? workspace : 0n}\tx\n`;
            },
            { argv: ['node', '-', target, ...(mode ? [mode] : [])] }, { log: (...parts) => logs.push(parts.join(' ')) });
        return logs;
    };
    const required = 30n * gib + 4n * gib;
    for (const mode of ['redeploy', 'update', undefined, 'rollback-plan']) {
        assert.throws(() => run(mode, { free: 15n * gib }), /Insufficient QA capacity/, String(mode));
        assert.throws(() => run(mode, { free: 40n * gib, duFails: true }), /Unable to measure QA workspace allocation/, String(mode));
        assert.match(run(mode, { free: 40n * gib }).at(-1), /Capacity admission passed before stopping the previous runtime\./);
    }
    const short = run('redeploy-rehearsal', { free: 15n * gib });
    assert.equal(short.at(-1), `[deploy-qa] Capacity verdict: admitted=false required=${required} available=${15n * gib}`);
    assert.match(short[0], /Capacity diagnostics: /, 'the diagnostics line is part of the rehearsal log');
    assert.doesNotMatch(short.join('\n'), /Capacity admission passed/);
    assert.equal(run('redeploy-rehearsal', { free: 40n * gib }).at(-1),
        `[deploy-qa] Capacity verdict: admitted=true required=${required} available=${40n * gib}`);
    const unmeasured = run('redeploy-rehearsal', { free: 40n * gib, duFails: true });
    assert.match(unmeasured.at(-1), /admitted=false required=\d+ available=\d+$/, 'a du timeout is a failed verdict, not a throw');
});

test('the rehearsal reports every gate after capacity and exits before the backup directory exists', () => {
    const capacity = workflow.indexOf('// END QA capacity admission');
    const rehearsal = workflow.indexOf('# BEGIN QA redeploy rehearsal');
    const rehearsalExit = workflow.indexOf("exit 0\n            # END QA redeploy rehearsal");
    const backups = workflow.indexOf('mkdir -p "$HOME/.qa-deployment-backups"');
    assert.ok(capacity > 0 && capacity < rehearsal && rehearsal < rehearsalExit && rehearsalExit < backups);
    assert.ok(workflow.indexOf('Verified QA-scoped Node v24.19.0') < rehearsal);
    const text = workflow.slice(rehearsal, rehearsalExit);
    assert.match(text, /Rehearsal: capacity \$QA_CAPACITY_VERDICT/);
    assert.match(text, /\[deploy-qa\] Redeploy rehearsal passed; no service was stopped and no workspace file was moved\./);
    assert.match(text, /QA_REHEARSAL_FAILED=1/);
    // The one container exec is the quiesce helper in its preflight-only mode.
    const withoutPreflight = text.replace(/# BEGIN QA rehearsal quiesce preflight[\s\S]*?# END QA rehearsal quiesce preflight/, '');
    assert.doesNotMatch(withoutPreflight, /container (?:stop|rename|exec)|renameSync|cp -a|rm -rf|--lock-held|capture "/);
    const preflight = text.match(/# BEGIN QA rehearsal quiesce preflight[\s\S]*?# END QA rehearsal quiesce preflight/)?.[0];
    assert.ok(preflight, 'the rehearsal runs the quiesce preflight');
    assert.equal((preflight.match(/container exec/g) || []).length, 1);
    assert.match(preflight, /--env QA_QUIESCE_PREFLIGHT_ONLY=1/);
    assert.doesNotMatch(preflight, /container (?:stop|rename|kill)|signal|--lock-held/);
    // Nothing that stops or moves anything may precede the rehearsal exit.
    const before = workflow.slice(0, rehearsalExit);
    for (const mutation of ['container stop', 'container rename', 'fs.renameSync(target, source)']) {
        assert.equal(before.includes(mutation), false, mutation);
    }
    assert.match(workflow, /Rehearsal: prior account runtime reviewed=\$\{reviewed\}/);
    assert.ok(workflow.indexOf('// BEGIN QA rehearsal capture preview') > rehearsal);
});

test('the rehearsal runs the quiesce preflight in the running Box and fails on any receipt but a pass', t => {
    const handler = shellBlock('rehearsal quiesce preflight');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-preflight-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'engine.log');
    fs.writeFileSync(path.join(bin, 'podman'), [
        '#!/bin/bash',
        'echo "$*" >> "$QA_MOCK_LOG"',
        'if [ "$2" = inspect ]; then echo "$QA_MOCK_RUNNING"; exit 0; fi',
        'if [ "$2" = exec ]; then cat > "$QA_MOCK_LOG.stdin"; printf "%s\\n" "$QA_MOCK_RECEIPT"; exit "$QA_MOCK_STATUS"; fi',
        'exit 99',
    ].join('\n'), { mode: 0o755 });
    const passed = '{"version":1,"kind":"qa-quiesce","result":"preflight-passed","phase":"preflight","stopped":[]}';
    const refused = '{"version":1,"kind":"qa-quiesce","result":"failed","phase":"preflight","stopped":[],"code":"QA_UNREGISTERED_WRITABLE_MOUNT"}';
    const run = ({ records = 'declare -a QA_CONTAINER_RECORDS=("podman|' + 'a'.repeat(64) + '|box")', running = 'true', receipt = passed, status = 0 }) => {
        const script = `set -uo pipefail\nWORK_DIR=/home/admin/explorerQaWorkspace\nQA_QUIESCE_SOURCE='export const x = 1;'\nQA_REHEARSAL_FAILED=0\n${records}\n${handler}\necho "failed=$QA_REHEARSAL_FAILED"\n`;
        fs.rmSync(log, { force: true });
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
            QA_MOCK_LOG: log, QA_MOCK_RUNNING: running, QA_MOCK_RECEIPT: receipt, QA_MOCK_STATUS: String(status) } });
        return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    };
    const ok = run({});
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /failed=0/);
    assert.match(ok.calls, /container exec -i --user podman --workdir \/home\/admin\/explorerQaWorkspace --env PLOINKY_WORKSPACE_ROOT=\/home\/admin\/explorerQaWorkspace .* --env QA_QUIESCE_PREFLIGHT_ONLY=1 a{64} node --input-type=module -/);
    assert.equal(fs.readFileSync(`${log}.stdin`, 'utf8'), 'export const x = 1;\n', 'the helper source is streamed on stdin');
    assert.doesNotMatch(ok.calls, /container (?:stop|kill|rename)/);
    const refusal = run({ receipt: refused, status: 1 });
    assert.match(refusal.stdout, /quiesce preflight receipt: .*QA_UNREGISTERED_WRITABLE_MOUNT/);
    assert.match(refusal.stdout, /failed=1/);
    assert.match(run({ receipt: '' , status: 1 }).stdout, /receipt: none[\s\S]*failed=1/, 'an empty receipt fails');
    assert.match(run({ receipt: '{"result":"passed"}' }).stdout, /failed=1/, 'only a preflight pass counts');
    const stopped = run({ running: 'false' });
    assert.match(stopped.stdout, /skipped; the QA Box is not running[\s\S]*failed=0/);
    assert.doesNotMatch(stopped.calls, /container exec/);
    const cold = run({ records: 'declare -a QA_CONTAINER_RECORDS=()' });
    assert.match(cold.stdout, /skipped; there is no QA Box[\s\S]*failed=0/);
    assert.equal(cold.calls, '');
});

test('the rehearsal preview fails when an account runtime is unreviewed or the capture proofs fail, and predicts the dispositions', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rehearsal-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const real = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    const run = ({ reviewed, error }) => {
        fs.writeFileSync(path.join(dir, 'helper.mjs'), `
export { classifyPriorSelections, describeSelectionDispositions, EXPECTED_DEFAULT_GRAPH, QA_SCOPE } from '${real}';
export const accountCapability = () => ${reviewed};
export const productionAdapters = () => ({});
export const createRollbackService = () => ({ previewCapture() {
    ${error ? `throw Object.assign(new Error('x'), { code: '${error}' });` : ''}
    const agent = (repo, name) => ({ name: repo + name, repo, agent: name, alias: '', profile: 'default', auth: 'sso', runMode: 'global' });
    return { sources: [{}, {}], agents: [agent('AchillesIDE', 'explorer'), agent('AchillesIDE', 'soplangAgent'),
        agent('AchillesIDE', 'multimedia'), agent('AchillesCLI', 'promotionScout')] };
} });
`);
        fs.writeFileSync(path.join(dir, 'block.mjs'), block('rehearsal capture preview')
            .replace('const [helper] = process.argv.slice(2);', `const helper = ${JSON.stringify(path.join(dir, 'helper.mjs'))};`));
        return spawnSync(process.execPath, [path.join(dir, 'block.mjs')], { encoding: 'utf8', timeout: 10000 });
    };
    const passed = run({ reviewed: true });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /Rehearsal: prior account runtime reviewed=true/);
    assert.match(passed.stdout, /Rehearsal: prior selection retained: AchillesIDE\/explorer/);
    assert.match(passed.stdout, /Rehearsal: prior selection not replayed: AchillesIDE\/soplangAgent \(not in the fresh default graph;/);
    assert.match(passed.stdout, /Rehearsal: prior selection not replayed: AchillesCLI\/promotionScout \(not in the fresh default graph;/);
    assert.match(passed.stdout, /Rehearsal: prior selections: 4 total, 1 retained, 0 superseded, 3 not replayed, 0 enabled\./);
    const unreviewed = run({ reviewed: false });
    assert.equal(unreviewed.status, 1);
    assert.match(unreviewed.stdout, /reviewed=false/);
    assert.match(unreviewed.stdout, /capture preview passed/, 'every gate still reports');
    const refused = run({ reviewed: true, error: 'QA_UNSELECTED_ACTIVE_BOX' });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /Rehearsal: capture preview failed: QA_UNSELECTED_ACTIVE_BOX/);
    assert.equal(run({ reviewed: true, error: 'EACCES' }).stdout.includes('QA_PREVIEW_FAILED'), true, 'raw errors are not disclosed');
});

test('a redeploy pins the AssistOSExplorer commit before and after source resolution, and never creates a tunnel', () => {
    const early = workflow.indexOf('Redeploy pinned to AchillesIDE/');
    assert.ok(early > 0 && early < workflow.indexOf('# BEGIN QA redeploy rehearsal'));
    assert.ok(early < workflow.indexOf('mkdir -p "$HOME/.qa-deployment-backups"'));
    assert.match(workflow, /if \[ "\$QA_EXPLORER_HEAD" != "\$EXPECTED_EXPLORER_COMMIT" \]/);
    const late = workflow.indexOf('if [ "$QA_OPERATION" = redeploy ] && [ "${EXPECTED_COMMITS[AchillesIDE]}" != "$EXPECTED_EXPLORER_COMMIT" ]');
    assert.ok(late > workflow.indexOf('EXPLORER_BRANCH="${EXPECTED_BRANCHES[AchillesIDE]}"') - 1 && late < workflow.indexOf('PLOINKY_URL='));
    const refusal = workflow.indexOf('never creates one');
    assert.ok(refusal > 0 && refusal < workflow.indexOf('-X POST'));
    assert.match(workflow.slice(refusal - 200, refusal), /if \[ -n "\$\{OPERATION:-\}" \]/);
    assert.match(step('Reconcile and start Explorer QA Box'), /OPERATION: \$\{\{ steps\.inplace\.outputs\.operation \}\}/);
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

test('the rehearsal skips the public and topology checks and the summary names the operation', () => {
    assert.match(step('Verify public URL'), /^ {8}if: steps\.inplace\.outputs\.operation != 'redeploy-rehearsal'$/m);
    assert.match(step('Verify dedicated connector and protected Cloudflare topology'),
        /^ {8}if: always\(\) && steps\.inplace\.outputs\.operation != 'redeploy-rehearsal'$/m);
    const summary = step('Create summary');
    assert.match(summary, /Redeploy rehearsal only/);
    assert.match(summary, /Preserving redeploy: the prior workspace and Box are retained for rollback/);
});

test('the retained Boxes and regenerated repository maps are named in the preservation step', () => {
    const preservation = block('durable workspace preservation');
    for (const name of ['enabled_repos.json', 'repo_sources.json', 'unregistered_agent_repos.json']) {
        assert.match(preservation, new RegExp(`'${name}'`));
    }
});

test('the remote deployment, update and rollback scripts parse as shell, including their nested heredocs', () => {
    for (const [name, terminator] of [['REMOTE', 'REMOTE'], ['UPDATE', 'UPDATE'], ['ROLLBACK', 'ROLLBACK']]) {
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
    assert.match(script, /rm -f "\$QA_REHEARSAL_DIR\/rollback-explorer-qa\.mjs"\n\s+rmdir "\$QA_REHEARSAL_DIR" 2>\/dev\/null \|\| true/);
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
