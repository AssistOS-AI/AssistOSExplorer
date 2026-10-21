import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';

// The Reconcile script of the deploy workflow in its rebuild and fresh-installation form: the route re-proof, the
// helpers staged once, the preflight, the teardown plan, the capacity admission, the install marker, the teardown, the
// restore of the access policy from its stash and the completion. The blocks are sliced out of the workflow and run
// against stub helpers and engines; the helpers themselves are tested in their own files.

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const retired = (...parts) => parts.join('');

function block(name) {
    const match = workflow.match(new RegExp(`// BEGIN QA ${name}\\n([\\s\\S]*?)// END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

function shellBlock(name) {
    const match = workflow.match(new RegExp(`# BEGIN QA ${name}\\n([\\s\\S]*?)# END QA ${name}`));
    assert.ok(match, `Missing ${name} implementation`);
    return match[1].replace(/^ {10}/gm, '');
}

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

const at = marker => { const index = workflow.indexOf(marker); assert.ok(index > 0, marker); return index; };
const COMMIT = 'a'.repeat(40);
const EXACT_ID = 'c'.repeat(64);
const BOX = 'ploinky-box-explorerqaworkspace-7a31ab7775eb';

// A block's own imports sit above its marker, so the check prepends the ones it uses.
function assertParses(t, name, source) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rebuild-block-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'block.mjs');
    fs.writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
}

const IMPORTS = `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
`;

// ---------------------------------------------------------------------------------------------
// The Resolve step and the pinned commit.
// ---------------------------------------------------------------------------------------------

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

// The Resolve step fails before any SSH and never pins an uncertain commit.
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
    assert.ok(early < at('# BEGIN QA preflight quiesce check'), 'the early check precedes the first stop');
    assert.ok(early > at('# END QA explorer fast-forward proof'));
    assert.ok(early > at('// END QA preservation admission'), 'the early check follows the read-only admissions');
    assert.match(workflow.slice(early, early + 400), /QA_RESOLVED_EXPLORER_COMMIT="\$QA_EXPLORER_HEAD"/);
    const lateCall = 'prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "${EXPECTED_COMMITS[AchillesIDE]}" late || exit 1';
    const lateStart = workflow.indexOf(lateCall);
    assert.ok(lateStart > workflow.indexOf('EXPLORER_BRANCH="${EXPECTED_BRANCHES[AchillesIDE]}"') && lateStart < workflow.indexOf("PLOINKY_URL='"));
    assert.equal(workflow.slice(workflow.lastIndexOf('\n', lateStart) + 1, workflow.indexOf('\n', lateStart)).includes('QA_OPERATION'), false, 'the late check is not gated on the mode');
    // No exact comparison with the pin remains in Reconcile.
    assert.doesNotMatch(workflow, /"\$\{EXPECTED_COMMITS\[AchillesIDE\]\}" != "\$EXPECTED_EXPLORER_COMMIT"|"\$QA_EXPLORER_HEAD" != "\$EXPECTED_EXPLORER_COMMIT"/);
});

// ---------------------------------------------------------------------------------------------
// Helpers: transferred once through the env file, checked, staged once, checked again.
// ---------------------------------------------------------------------------------------------

const SOURCES = ['QUIESCE', 'ROLLBACK', 'TEARDOWN', 'TEARDOWN_PRIVILEGED'];

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

test('the env file carries the four helper sources with their SHAs, read from the reviewed checkout, and nothing retired', () => {
    const script = stepScript('Reconcile and start Explorer QA Box');
    for (const [name, file] of [['QUIESCE', 'quiesce-explorer-qa.mjs'], ['ROLLBACK', 'rollback-explorer-qa.mjs'], ['TEARDOWN', 'qa-teardown.mjs'],
        ['TEARDOWN_PRIVILEGED', 'qa-teardown-privileged.mjs']]) {
        assert.ok(script.includes(`QA_${name}_SOURCE="$(cat "$GITHUB_WORKSPACE/.github/scripts/${file}")"`), `${name} source`);
        assert.ok(script.includes(`QA_${name}_SHA="$(printf '%s' "$QA_${name}_SOURCE" | sha256sum | awk '{print $1}')"`), `${name} sha`);
        assert.ok(script.includes(`write_shell_var QA_${name}_SOURCE\n`), `${name} source is written`);
        assert.ok(script.includes(`write_shell_var QA_${name}_SHA\n`), `${name} sha is written`);
    }
    assert.ok(script.includes('write_shell_var QA_DISPATCH\n'));
    assert.doesNotMatch(script, new RegExp(`QA_(?:${retired('BACKUPS')}|UPDATE)_`), 'the retention and updater helpers are not part of the Reconcile transfer');
    assert.match(step('Reconcile and start Explorer QA Box'), /DISPATCH_REF: \$\{\{ github\.ref_name \}\}\n\s+DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
});

// AC35: a helper changed in transfer stops the run before the QA Node, the staging and the route.
test('a helper changed in transfer stops the run before the route runs', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-integrity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    installSha256sum(bin);
    const routeCalls = path.join(dir, 'route-calls');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >> '${routeCalls}'\nexit 0\n`, { mode: 0o755 });
    const script = `set -euo pipefail\n${shellBlock('transferred helper integrity')}\necho integrity-passed\nnode qa-teardown.mjs route --lock-held\n`;
    const run = tamper => spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH}`, ...sourceEnv(tamper) } });
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /integrity-passed/);
    assert.match(fs.readFileSync(routeCalls, 'utf8'), /route --lock-held/);
    fs.rmSync(routeCalls);
    for (const name of SOURCES) {
        const tampered = run(name);
        assert.equal(tampered.status, 1, name);
        assert.match(tampered.stdout, /changed in transfer\./, name);
        assert.doesNotMatch(tampered.stdout, /integrity-passed/, name);
        assert.equal(fs.existsSync(routeCalls), false, `${name}: the route never ran`);
    }
    assert.ok(at('# END QA transferred helper integrity') < at('# BEGIN QA isolated Node runtime'));
    assert.ok(at('# END QA transferred helper integrity') < at('# BEGIN QA helper staging'));
});

function runStaging(t, { tamper = '', env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-staging-'));
    const bin = path.join(dir, 'bin');
    installSha256sum(bin);
    const script = `set -euo pipefail\nQA_HELPERS_DIR=""\n${shellBlock('helper staging')}\necho "dir=$QA_HELPERS_DIR tail=$QA_TAIL_HELPER"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH}`, ...sourceEnv(), ...(tamper ? { [`QA_${tamper}_SHA`]: '0'.repeat(64) } : {}), ...env } });
    const created = result.stdout.match(/^dir=(\S*)/m)?.[1];
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (/^\/tmp\/explorer_qa_helpers\.[A-Za-z0-9]{6}$/.test(created || '')) fs.rmSync(created, { recursive: true, force: true });
    });
    return { result, created };
}

test('the helpers are staged once in a private directory, each checked against its SHA, and the tail helper is the staged recovery helper', t => {
    const { result, created } = runStaging(t);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(created, /^\/tmp\/explorer_qa_helpers\.[A-Za-z0-9]{6}$/);
    assert.equal(fs.statSync(created).mode & 0o777, 0o700);
    const files = { 'qa-teardown.mjs': 'TEARDOWN', 'qa-teardown-privileged.mjs': 'TEARDOWN_PRIVILEGED', 'rollback-explorer-qa.mjs': 'ROLLBACK', 'quiesce-explorer-qa.mjs': 'QUIESCE' };
    assert.deepEqual(fs.readdirSync(created).sort(), Object.keys(files).sort());
    for (const [file, name] of Object.entries(files)) {
        assert.equal(fs.readFileSync(path.join(created, file), 'utf8'), sourceEnv()[`QA_${name}_SOURCE`], file);
        assert.equal(fs.statSync(path.join(created, file)).mode & 0o777, 0o600, file);
    }
    assert.match(result.stdout, new RegExp(`tail=${created}/rollback-explorer-qa\\.mjs`));
});

test('a staged helper that does not match its SHA stops the run', t => {
    for (const name of SOURCES) {
        const { result } = runStaging(t, { tamper: name });
        assert.notEqual(result.status, 0, name);
        assert.doesNotMatch(result.stdout, /^dir=/m, name);
    }
});

test('the helpers are staged exactly once, before the route re-proof, and the staged tail helper serves the tail', () => {
    assert.equal(workflow.match(/mktemp -d \/tmp\/explorer_qa_helpers/g).length, 1);
    assert.ok(at('mktemp -d /tmp/explorer_qa_helpers') < at('# BEGIN QA route re-proof'));
    assert.equal(workflow.match(/^ {10}QA_TAIL_HELPER=/gm).length, 1, 'one definition');
    assert.match(workflow, /QA_TAIL_HELPER="\$QA_HELPERS_DIR\/rollback-explorer-qa\.mjs"/);
    const tail = workflow.slice(workflow.indexOf('\n          mkdir -p "$WORK_DIR"\n'));
    assert.equal(tail.match(/"\$QA_TAIL_HELPER"/g).length, 2, 'the fresh graph readiness and the AgentLib verification');
    assert.doesNotMatch(tail, /"\$QA_HELPERS_DIR\/rollback-explorer-qa\.mjs"/);
});

test('the protected snapshot goes through the teardown helper, before the route and again after the tail', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-snapshot-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    installSha256sum(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >> '${calls}'\nprintf '%s\\n' '[{"kind":"container","id":"x"}]'\n`, { mode: 0o755 });
    const script = `set -euo pipefail\nQA_HELPERS_DIR=${dir}\n${shellBlock('protected resource snapshot')}\ncat "$PROTECTED_BEFORE_FILE"\nrm -f "$PROTECTED_BEFORE_FILE" "$PROTECTED_AFTER_FILE"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8').trim(), `${dir}/qa-teardown.mjs protected-snapshot`);
    assert.match(result.stdout, /Protected host resource identity sha256=[a-f0-9]{64}/);
    assert.match(result.stdout, /\[\{"kind":"container","id":"x"\}\]/);
    assert.ok(at('# BEGIN QA protected resource snapshot') < at('# BEGIN QA route re-proof'));
    assert.ok(at('# BEGIN QA protected resource snapshot') > at('# BEGIN QA helper staging'));
    assert.ok(at('protected-snapshot > "$PROTECTED_AFTER_FILE"') > at('// END QA fresh graph readiness'));
    assert.doesNotMatch(workflow, /snapshot_protected_resources/, 'the inline snapshot program is gone');
});

// ---------------------------------------------------------------------------------------------
// The retained blocks: the operator .env, the preservation admission and the tunnel lookup.
// ---------------------------------------------------------------------------------------------

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admission-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    const write = (relative, value = relative) => {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, value);
    };
    const read = relative => fs.readFileSync(path.join(target, relative), 'utf8');
    const execute = name => {
        const source = block(name).replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(target));
        new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
            assert, fs, path, execFileSync, { argv: ['node', '-', target], getuid: () => 0 }, { log() {} },
        );
    };
    return { root, target, write, read, execute };
}

test('QA bootstrap preserves operator env formatting and extra settings exactly', t => {
    const f = fixture(t);
    const value = '# Operator configuration\r\nCUSTOM_SETTING=retained\r\nPLOINKY_MASTER_KEY=prior-bootstrap-value\r\n';
    f.write('.env', value);
    const execute = () => new Function('fs', 'process', block('bootstrap environment'))(fs, {
        argv: ['node', '-', path.join(f.target, '.env')],
        env: { PLOINKY_MASTER_KEY: 'a'.repeat(64) }, getuid: () => fs.statSync(f.target).uid,
    });
    execute();
    assert.equal(f.read('.env'), value);
    fs.unlinkSync(path.join(f.target, '.env'));
    execute();
    assert.equal(f.read('.env'), `PLOINKY_MASTER_KEY=${'a'.repeat(64)}\n`);
});

test('QA admission rejects unsafe env and modified managed sources before any retirement', t => {
    const f = fixture(t);
    f.write('.env', '# retained operator config');
    f.execute('preservation admission');
    fs.unlinkSync(path.join(f.target, '.env'));
    fs.symlinkSync('missing', path.join(f.target, '.env'));
    assert.throws(() => f.execute('preservation admission'), /Unsafe operator/);
    fs.unlinkSync(path.join(f.target, '.env'));
    const runtime = path.join(f.target, '.runtime/ploinky');
    fs.mkdirSync(runtime, { recursive: true });
    execFileSync('git', ['init', '-q', runtime]);
    execFileSync('git', ['-C', runtime, 'remote', 'add', 'origin', 'https://github.com/AssistOS-AI/ploinky.git']);
    f.execute('preservation admission');
    f.write('.runtime/ploinky/local-skill.mjs', 'authored source');
    assert.throws(() => f.execute('preservation admission'), /Local managed source edits/);
    assert.equal(f.read('.runtime/ploinky/local-skill.mjs'), 'authored source');
    assert.ok(at('// END QA preservation admission') < at('# BEGIN QA install marker'), 'the admission precedes the first mutation');
});

const NEW_IDENTITY = ['.ploinky/data/master-key', '.ploinky/data/.secrets', '.ploinky/data/ploinky_subject_identity_ed25519_v1.enc'];
const LEGACY_IDENTITY = ['.ploinky/master-key', '.ploinky/.secrets', '.ploinky/passwords.enc', '.ploinky/ploinky_subject_identity_ed25519_v1.enc'];

test('QA admission accepts the Ploinky 7d8c04d0 identity layout under .ploinky/data and refuses the legacy layout', t => {
    const modern = fixture(t);
    modern.write('.data/dpu-data/blobs/one', 'ciphertext');
    for (const name of NEW_IDENTITY) modern.write(name, `new:${name}`);
    modern.write('.env', 'PLOINKY_MASTER_KEY=' + 'a'.repeat(64) + '\n');
    modern.execute('preservation admission');
    const legacy = fixture(t);
    legacy.write('.data/dpu-data/blobs/one', 'ciphertext');
    for (const name of LEGACY_IDENTITY) legacy.write(name, `legacy:${name}`);
    assert.throws(() => legacy.execute('preservation admission'), /Retired QA controller secrets/);
});

test('QA admission refuses durable data without a master key in either location', t => {
    const f = fixture(t);
    f.write('.data/dpu-data/blobs/one', 'ciphertext');
    f.write('.ploinky/data/.secrets', 'encrypted store without its key');
    f.write('.ploinky/passwords.enc', 'accounts without a key');
    assert.throws(() => f.execute('preservation admission'), /requires its original master key/);
    f.write('.ploinky/data/master-key', 'seed');
    f.execute('preservation admission');
});

test('QA admission refuses an unsafe master key or identity file in either location', t => {
    for (const layout of ['.ploinky/data', '.ploinky']) {
        const symlink = fixture(t);
        symlink.write('.data/dpu-data/blobs/one', 'ciphertext');
        symlink.write('outside-key', 'seed');
        symlink.write(`${layout === '.ploinky' ? '.ploinky/data' : '.ploinky'}/master-key`, 'seed');
        fs.mkdirSync(path.join(symlink.target, layout), { recursive: true });
        fs.symlinkSync(path.join(symlink.target, 'outside-key'), path.join(symlink.target, layout, 'master-key'));
        assert.throws(() => symlink.execute('preservation admission'), /Unsafe QA encryption identity/, `symlinked key in ${layout}`);

        const hardlink = fixture(t);
        hardlink.write('.data/dpu-data/blobs/one', 'ciphertext');
        hardlink.write(`${layout}/master-key`, 'seed');
        fs.linkSync(path.join(hardlink.target, layout, 'master-key'), path.join(hardlink.target, 'key-alias'));
        assert.throws(() => hardlink.execute('preservation admission'), /Unsafe QA encryption identity/, `hardlinked key in ${layout}`);

        const store = fixture(t);
        store.write(`${layout}/master-key`, 'seed');
        store.write('outside-store', 'ciphertext');
        fs.symlinkSync(path.join(store.target, 'outside-store'), path.join(store.target, layout, '.secrets'));
        assert.throws(() => store.execute('preservation admission'), /Unsafe QA encryption identity/, `symlinked store in ${layout}`);
    }
    const aliased = fixture(t);
    aliased.write('.data/dpu-data/blobs/one', 'ciphertext');
    aliased.write('elsewhere/master-key', 'seed');
    fs.mkdirSync(path.join(aliased.target, '.ploinky'));
    fs.symlinkSync(path.join(aliased.target, 'elsewhere'), path.join(aliased.target, '.ploinky/data'));
    assert.throws(() => aliased.execute('preservation admission'), /must not escape the QA workspace/);
});

test('QA admission refuses a master key owned by another user', t => {
    const f = fixture(t);
    f.write('.data/dpu-data/blobs/one', 'ciphertext');
    f.write('.ploinky/data/master-key', 'seed');
    const real = fs.lstatSync;
    const foreign = { ...fs, lstatSync: (file, ...rest) => {
        const stat = real(file, ...rest);
        return String(file).endsWith('.ploinky/data/master-key')
            ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 }) : stat;
    } };
    const source = block('preservation admission').replace("'/home/admin/explorerQaWorkspace'", JSON.stringify(f.target));
    assert.throws(() => new Function('assert', 'fs', 'path', 'execFileSync', 'process', 'console', source)(
        assert, foreign, path, execFileSync, { argv: ['node', '-', f.target] }, { log() {} }), /master key owner/);
});

test('QA admission refuses every retired .ploinky controller secret, alone or beside the new layout', t => {
    for (const name of ['master-key', '.secrets', 'ploinky_subject_identity_ed25519_v1.enc']) {
        for (const withNew of [false, true]) {
            const f = fixture(t);
            f.write('.data/dpu-data/blobs/one', 'ciphertext');
            f.write('.ploinky/data/master-key', 'seed-one');
            f.write(`.ploinky/${name}`, 'retired');
            if (!withNew) fs.rmSync(path.join(f.target, '.ploinky/data/master-key'));
            if (!withNew && name !== 'master-key') f.write('.ploinky/master-key', 'seed-one');
            assert.throws(() => f.execute('preservation admission'), /Retired QA controller secrets at .*\.ploinky\/.*migrate each into \.ploinky\/data first/, `${name} ${withNew}`);
            assert.equal(f.read(`.ploinky/${name}`), 'retired');
        }
    }
    const kept = fixture(t);
    kept.write('.data/dpu-data/blobs/one', 'ciphertext');
    kept.write('.ploinky/data/master-key', 'seed-one');
    kept.write('.ploinky/passwords.enc', 'accounts');
    kept.execute('preservation admission');
});

// The admission runs only when the workspace exists and no earlier run began the installation.
function runAdmissionCall(t, { workspace, marker }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admission-call-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    if (workspace === 'symlink') fs.symlinkSync(path.join(root, 'missing'), target);
    const script = `set -euo pipefail\nWORK_DIR='${target}'\nQA_MARKER_AT_ROUTE='${marker}'\nassert_qa_preservation_admission() { echo ADMISSION_CALLED; }\n${workflow.match(/(# The admission reads the durable state[\s\S]*?\n {10}fi\n)/)[1].replace(/^ {10}/gm, '')}\n`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
}

test('the preservation admission runs for an existing workspace without a marker and for nothing else', t => {
    assert.match(runAdmissionCall(t, { workspace: 'directory', marker: '' }).stdout, /ADMISSION_CALLED/);
    assert.match(runAdmissionCall(t, { workspace: 'symlink', marker: '' }).stdout, /ADMISSION_CALLED/, 'a symlinked workspace reaches the admission, which refuses it');
    assert.doesNotMatch(runAdmissionCall(t, { workspace: 'absent', marker: '' }).stdout, /ADMISSION_CALLED/);
    for (const marker of ['update', 'rebuild', 'destroy-keep']) {
        assert.doesNotMatch(runAdmissionCall(t, { workspace: 'directory', marker }).stdout, /ADMISSION_CALLED/, marker);
    }
    assert.equal(workflow.match(/^ {12}assert_qa_preservation_admission$/gm).length, 1, 'one call, inside the guard');
});

test('QA tunnel lookup reuses one exact tunnel, leaves an absent one to creation, and rejects ambiguity', t => {
    const marker = workflow.indexOf("const tunnels = payload?.success === true ? payload.result : null;");
    const start = workflow.lastIndexOf("<<'NODE'\n", marker) + "<<'NODE'\n".length;
    const end = workflow.indexOf('\n          NODE', marker);
    const script = workflow.slice(start, end).replace(/^ {10}/gm, '');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-selected-tunnel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const inventory = path.join(root, 'inventory.json');
    const id = '89dd05b5-05a7-4bd4-9626-ec4343b07c67';
    const run = result => {
        fs.writeFileSync(inventory, JSON.stringify({ success: true, result }));
        return spawnSync(process.execPath, ['--input-type=module', '-', inventory], {
            input: script, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_TUNNEL_NAME: 'explorer-qa' },
        });
    };
    assert.equal(run([{ id, name: 'explorer-qa' }]).stdout, id);
    const absent = run([]);
    assert.equal(absent.status, 0);
    assert.equal(absent.stdout, '', 'an absent tunnel yields no id so the workflow creates one');
    for (const [result, message] of [
        [[{ id, name: 'other' }], /identity changed/],
        [[{ id, name: 'explorer-qa', deleted_at: 'yesterday' }], /identity changed/],
        [[{ id }, { id }], /ambiguous/],
    ]) {
        const observed = run(result);
        assert.notEqual(observed.status, 0);
        assert.match(observed.stderr, message);
    }
});

test('a rebuild never creates a tunnel, and a fresh installation may', () => {
    const refusal = workflow.indexOf('A rebuild reuses the existing dedicated Explorer QA tunnel and never creates one');
    assert.ok(refusal > 0 && refusal < workflow.indexOf('-X POST'));
    assert.match(workflow.slice(refusal - 200, refusal), /if \[ -n "\$\{OPERATION:-\}" \]/);
    assert.match(step('Reconcile and start Explorer QA Box'), /OPERATION: \$\{\{ steps\.inplace\.outputs\.operation \}\}/);
});

// ---------------------------------------------------------------------------------------------
// The preflight, the plan, the capacity, the marker and the teardown.
// ---------------------------------------------------------------------------------------------

// The preflight, run as the shell sees it, against a stub engine. QA_CONTAINER_RECORDS is declared empty only so that
// the same slice also runs against the workflow this one replaced, whose preflight read that array.
function runPreflight(t, { operation = 'rebuild', running = 'true', marker = '', receipt, status = 0, engine = 'podman', id = EXACT_ID, source = shellBlock('preflight quiesce check') } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-preflight-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'engine.log');
    fs.writeFileSync(path.join(bin, engine), [
        '#!/bin/bash',
        'echo "$*" >> "$QA_MOCK_LOG"',
        'if [ "$2" = inspect ]; then echo "$QA_MOCK_RUNNING"; exit 0; fi',
        'if [ "$2" = exec ]; then cat > "$QA_MOCK_LOG.stdin"; printf "%s\\n" "$QA_MOCK_RECEIPT"; exit "$QA_MOCK_STATUS"; fi',
        'exit 99',
    ].join('\n'), { mode: 0o755 });
    const passed = '{"version":1,"kind":"qa-quiesce","result":"preflight-passed","phase":"preflight","stopped":[]}';
    const script = `set -euo pipefail
WORK_DIR=/home/admin/explorerQaWorkspace
QA_OPERATION=${operation}
QA_MARKER_AT_ROUTE='${marker}'
QA_EXACT_ENGINE=${engine}
QA_EXACT_ID=${id}
QA_EXACT_RUNNING=${running}
QA_QUIESCE_SOURCE='export const x = 1;'
declare -a QA_CONTAINER_RECORDS=()
${source}
echo NEXT_STAGE_REACHED
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir,
        QA_MOCK_LOG: log, QA_MOCK_RUNNING: running, QA_MOCK_RECEIPT: receipt ?? passed, QA_MOCK_STATUS: String(status) } });
    return { ...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', stdin: fs.existsSync(`${log}.stdin`) ? fs.readFileSync(`${log}.stdin`, 'utf8') : null };
}

// The exact arguments of the preflight exec: the same environment the quiesce itself runs with, with no wildcard between the pairs.
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PREFLIGHT_ENVIRONMENT = '--env PLOINKY_ROUTER_HOST_PORT=8097 --env PLOINKY_MEDIA_HOST_PORT=7882';
const preflightCall = () => new RegExp(escapeRegExp(`container exec -i --user podman --workdir /home/admin/explorerQaWorkspace --env PLOINKY_WORKSPACE_ROOT=/home/admin/explorerQaWorkspace ${PREFLIGHT_ENVIRONMENT} --env QA_QUIESCE_PREFLIGHT_ONLY=1 ${EXACT_ID} node --input-type=module -`));

// AC28: the preflight runs from the route output, in the exact running Box, before the marker.
test('the preflight runs the quiesce proof in the exact Box named by the route and is fatal before the next stage', t => {
    const refused = '{"version":1,"kind":"qa-quiesce","result":"failed","phase":"preflight","stopped":[],"code":"QA_UNREGISTERED_WRITABLE_MOUNT"}';
    const ok = runPreflight(t);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /quiesce preflight passed; no service was stopped and no workspace file was removed\./);
    assert.match(ok.stdout, /NEXT_STAGE_REACHED/);
    assert.match(ok.calls, preflightCall());
    assert.equal(ok.stdin, 'export const x = 1;\n', 'the helper source is streamed on stdin');
    assert.doesNotMatch(ok.calls, /container (?:stop|kill|rm)/);

    for (const [name, options, message] of [
        ['a refused quiesce preflight', { receipt: refused, status: 1 }, /quiesce preflight receipt: .*QA_UNREGISTERED_WRITABLE_MOUNT/],
        ['an empty receipt', { receipt: '', status: 1 }, /receipt: none/],
        ['a receipt that is not a preflight pass', { receipt: '{"result":"passed"}' }, /receipt: \{"result":"passed"\}/],
    ]) {
        const failed = runPreflight(t, options);
        assert.equal(failed.status, 1, name);
        assert.match(failed.stdout, message, name);
        assert.match(failed.stdout, /ERROR: the quiesce preflight failed; no service was stopped and no workspace file was removed\./, name);
        assert.doesNotMatch(failed.stdout, /NEXT_STAGE_REACHED|preflight passed/, `${name}: the run never reaches the plan, the capacity or the marker`);
        assert.match(failed.calls, new RegExp(EXACT_ID), `${name}: the exec addressed the route's exact id`);
    }
});

test('dropping either port variable from the workflow preflight fails the exact argument check', t => {
    const source = shellBlock('preflight quiesce check');
    assert.match(runPreflight(t, { source }).calls, preflightCall(), 'the workflow preflight passes its own check');
    for (const variable of ['--env PLOINKY_ROUTER_HOST_PORT=8097', '--env PLOINKY_MEDIA_HOST_PORT=7882']) {
        const mutated = source.replace(new RegExp(`\\s*${escapeRegExp(variable)}\\s*\\\\?\\n?`), ' ');
        assert.notEqual(mutated, source, `${variable} is present in the workflow preflight`);
        const run = runPreflight(t, { source: mutated });
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.doesNotMatch(run.calls, preflightCall(), `${variable} removed`);
    }
    // A changed value fails it too.
    const wrong = runPreflight(t, { source: source.replace('PLOINKY_MEDIA_HOST_PORT=7882', 'PLOINKY_MEDIA_HOST_PORT=7883') });
    assert.doesNotMatch(wrong.calls, preflightCall());
});

test('the preflight is skipped, and no engine is called, unless a rebuild finds a running Box that no earlier run began to quiesce', t => {
    for (const options of [
        { running: 'false' },
        { marker: 'rebuild' },
        { marker: 'destroy-keep' },
        { operation: 'update', running: '', id: '' },
    ]) {
        const skipped = runPreflight(t, options);
        assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
        assert.match(skipped.stdout, /quiesce preflight skipped/);
        assert.match(skipped.stdout, /NEXT_STAGE_REACHED/);
        assert.equal(skipped.calls, '', JSON.stringify(options));
    }
});

test('the preflight is a fatal gate with one container exec, no mutation, no lock and no early exit', () => {
    const preflight = shellBlock('preflight quiesce check');
    assert.equal((preflight.match(/container exec/g) || []).length, 1);
    assert.match(preflight, /--env QA_QUIESCE_PREFLIGHT_ONLY=1/);
    assert.doesNotMatch(preflight, /\bexit 0\b/);
    assert.doesNotMatch(preflight, /container (?:stop|rm|rename|kill)|renameSync|cp -a|rm -rf|--lock-held|mkdir/);
    assert.match(preflight, /\[ "\$QA_OPERATION" = rebuild \] && \[ "\$QA_EXACT_RUNNING" = true \] && \[ -z "\$QA_MARKER_AT_ROUTE" \]/);
    assert.equal(workflow.includes(retired('QA_CONTAINER', '_RECORDS')), false, 'the container record array no longer exists');
});

// AC29: the plan is read-only, and the capacity admission that follows it decides before the marker.
const GIB = 1024n ** 3n;
const DIGEST = `sha256:${'d'.repeat(64)}`;
const capacityOf = (extra = {}) => ({ freeBytes: Number(20n * GIB), reclaimableBytes: 0, pullBytes: 1414184938, minimumFreeBytes: Number(16n * GIB), ...extra });
const plan = (extra = {}, capacity = {}) => ({ output: JSON.stringify({ result: 'planned', scope: 'rebuild', mode: 'keep-data',
    containers: [{ engine: 'podman', id: EXACT_ID, name: BOX, running: true, image: '1'.repeat(64) }], volumes: [],
    images: { remove: [{ engine: 'podman', id: '1'.repeat(64), tags: [], size: 1414184938 }], retained: [] },
    workspace: { result: 'planned', delete: [{ relative: '.runtime', type: 'directory' }],
        keep: { count: 7, top: [SENTINEL_NAME, 'WebMeet', 'test1.backlog'], digest: `sha256:${'a'.repeat(64)}` },
        identity: [{ relative: '.env', sha256: SENTINEL_HASH }] }, marker: null, stash: false,
    capacity: { ...capacityOf(), requiredBytes: 0, sufficient: true, ...capacity }, digest: DIGEST, ...extra }), status: 0 });

// The plan block and the capacity admission that follows it, as one script, against a stub helper.
const planAndCapacity = () => {
    const start = at('# BEGIN QA read-only plan');
    const marker = at('// END QA capacity admission');
    return workflow.slice(workflow.lastIndexOf('\n', start) + 1, workflow.indexOf('\n          NODE\n', marker) + '\n          NODE\n'.length).replace(/^ {10}/gm, '');
};

function runPlan(t, { operation = 'rebuild', answer }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-plan-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    const answerFile = path.join(dir, 'answer');
    fs.writeFileSync(answerFile, answer.output);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-teardown.mjs*)
    echo "$*" >> '${calls}'
    case "$*" in *\\ plan\\ *) cat '${answerFile}'; exit ${answer.status} ;; esac
    exit 98 ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `set -euo pipefail
QA_OPERATION=${operation}
QA_HELPERS_DIR=/tmp/helpers
${shellBlock('safe receipts')}
${planAndCapacity()}
echo "scope=$QA_SCOPE digest=$QA_PLAN_DIGEST"
echo MARK_STAGE_REACHED
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('the plan names its scope and digest, and the capacity admission passes before the marker stage', t => {
    const { result, calls } = runPlan(t, { answer: plan() });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(calls, /\/tmp\/helpers\/qa-teardown\.mjs plan --scope rebuild --mode keep-data --lock-held/);
    assert.doesNotMatch(calls, /\b(?:mark|execute|complete)\b/);
    const line = JSON.parse(result.stdout.match(/^\[deploy-qa\] Teardown plan: (.*)$/m)[1]);
    assert.deepEqual({ scope: line.scope, mode: line.mode, digest: line.digest, containers: line.containers, imagesRemoved: line.imagesRemoved },
        { scope: 'rebuild', mode: 'keep-data', digest: DIGEST, containers: 1, imagesRemoved: 1 });
    assert.match(result.stdout, new RegExp(`scope=rebuild digest=${DIGEST}\\nMARK_STAGE_REACHED`));
    assert.match(result.stdout, /Capacity admission passed before stopping the previous runtime\./);
    const fresh = runPlan(t, { operation: 'update', answer: plan({ scope: 'fresh', containers: [] }) });
    assert.equal(fresh.result.status, 0, fresh.result.stdout + fresh.result.stderr);
    assert.match(fresh.calls, /plan --scope fresh --mode keep-data --lock-held/);
    assert.match(fresh.result.stdout, new RegExp(`scope=fresh digest=${DIGEST}`));
});

// AC29: a refused plan stops the run with nothing stopped, removed or marked.
test('a plan refusal or a malformed plan exits 1 before any mark', t => {
    for (const [name, answer] of [
        ['a retired identity refusal', { output: '{"result":"refused","code":"QA_TEARDOWN_RETIRED_IDENTITY"}', status: 1 }],
        ['a helper that exits 75', { output: '', status: 75 }],
        ['a plan without a digest', plan({ digest: undefined })],
        ['a short digest', plan({ digest: 'sha256:abc' })],
        ['a digest without its prefix', plan({ digest: 'd'.repeat(64) })],
        ['a plan for another scope', plan({ scope: 'destroy' })],
        ['a plan for another mode', plan({ mode: 'delete-data' })],
        ['a plan without capacity', plan({ capacity: undefined })],
        ['a capacity number that is not an integer', plan({}, { freeBytes: 'many' })],
        ['a negative capacity number', plan({}, { reclaimableBytes: -1 })],
        ['a fractional capacity number', plan({}, { pullBytes: 1.5 })],
        ['a plan that is not planned', plan({ result: 'refused' })],
        ['garbage', { output: 'not json', status: 0 }],
    ]) {
        const { result, calls } = runPlan(t, { answer });
        assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /ERROR: the teardown plan (?:was refused|is malformed); nothing was stopped or removed\./, name);
        assert.doesNotMatch(result.stdout, /MARK_STAGE_REACHED/, name);
        assert.doesNotMatch(calls, /qa-teardown\.mjs (?:mark|execute|complete)/, name);
    }
});

// AC21: free + reclaimable must cover 16 GiB + the pull, and a shortfall is fatal before the marker.
test('capacity admits when free space plus the reclaimable bytes cover 16 GiB plus the pull, and a shortfall stops the run before the marker stage', t => {
    // 16 GiB + 1 GiB of pull needs 17 GiB: 2 free + 15 reclaimable passes, one byte less does not.
    const exact = plan({}, { freeBytes: Number(2n * GIB), reclaimableBytes: Number(15n * GIB), pullBytes: Number(GIB) });
    const passed = runPlan(t, { answer: exact });
    assert.equal(passed.result.status, 0, passed.result.stdout + passed.result.stderr);
    const diagnostics = JSON.parse(passed.result.stdout.match(/Capacity diagnostics: (.*)$/m)[1]);
    assert.equal(diagnostics.requiredBytes, String(17n * GIB));
    assert.equal(diagnostics.shortfallBytes, '0');
    const short = runPlan(t, { answer: plan({}, { freeBytes: Number(2n * GIB), reclaimableBytes: Number(15n * GIB) - 1, pullBytes: Number(GIB) }) });
    assert.equal(short.result.status, 1);
    assert.match(short.result.stderr, /Insufficient QA capacity/);
    assert.equal(JSON.parse(short.result.stdout.match(/Capacity diagnostics: (.*)$/m)[1]).shortfallBytes, '1');
    assert.doesNotMatch(short.result.stdout, /Capacity admission passed|MARK_STAGE_REACHED/);
    assert.doesNotMatch(short.calls, /qa-teardown\.mjs (?:mark|execute|complete)/);
    // `sufficient: true` in the plan is not trusted: the workflow recomputes the requirement.
    const claimed = runPlan(t, { answer: plan({}, { freeBytes: 0, reclaimableBytes: 0, sufficient: true }) });
    assert.equal(claimed.result.status, 1);
    assert.doesNotMatch(claimed.result.stdout, /MARK_STAGE_REACHED/);
});

test('capacity keeps the 16 GiB floor even if a plan lowers it, and prints only numbers', t => {
    const lowered = runPlan(t, { answer: plan({}, { minimumFreeBytes: Number(GIB), freeBytes: Number(100n * GIB) }) });
    assert.equal(lowered.result.status, 1);
    assert.match(lowered.result.stderr, /lowered the 16 GiB floor/);
    assert.doesNotMatch(lowered.result.stdout, /MARK_STAGE_REACHED/);
    // Without anything to reclaim the floor alone is 16 GiB plus the pull of the current image.
    const floor = runPlan(t, { answer: plan({}, { freeBytes: Number(16n * GIB) + 1414184938 - 1 }) });
    assert.equal(floor.result.status, 1);
    assert.equal(runPlan(t, { answer: plan({}, { freeBytes: Number(16n * GIB) + 1414184938 }) }).result.status, 0);
    assert.ok(at('// END QA capacity admission') < at('# BEGIN QA install marker'), 'capacity is decided before the marker');
    assert.equal(workflow.match(/\/\/ BEGIN QA capacity admission/g).length, 1);
    assert.doesNotMatch(block('capacity admission'), /sudo|du |execFileSync|statfs/, 'the plan measured as root; the admission only compares numbers');
});

// The sentinels stand for what a real receipt carries and a public log must not: a user's file name and an identity hash.
const SENTINEL_NAME = 'Quarterly-Salary-Review-SENTINEL';
const SENTINEL_HASH = 'cafe'.repeat(16);
const BOX_REF = { engine: 'podman', id: EXACT_ID, name: BOX };
const TEARDOWN_RECEIPT = { result: 'torn-down', scope: 'rebuild', mode: 'keep-data', phase: 'done',
    removedContainers: [BOX_REF], removedImages: [{ engine: 'podman', id: '1'.repeat(64), tags: ['docker.io/assistos/ploinky-box:latest'] }],
    retainedImages: [{ engine: 'podman', id: '2'.repeat(64), tags: [`${SENTINEL_NAME}:tag`], reason: 'retained-in-use' }],
    removedVolumes: [], quiesce: { result: 'passed', phase: 'complete' }, stash: 'created', marker: { operation: 'rebuild' },
    workspace: { result: 'reduced', deleted: ['.runtime', '.ploinky/box', `.ploinky/code/${SENTINEL_NAME}`],
        keep: { count: 7, top: [SENTINEL_NAME, 'WebMeet', 'test1.backlog', '.env'], digest: `sha256:${'a'.repeat(64)}` },
        identity: [{ relative: '.env', sha256: SENTINEL_HASH, uid: 1000, gid: 1000, mode: 33152, nlink: 1 }], digest: `sha256:${'b'.repeat(64)}` },
    legacyBackups: null, retainedBackups: [], warnings: [] };

// The marker and the teardown run as the shell sees them, against a stub helper that records its arguments.
function runMarkAndTeardown(t, { operation = 'rebuild', marker = '', markStatus = 0, executeStatus = 0, scope = 'rebuild', receipt = TEARDOWN_RECEIPT } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-mark-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-teardown.mjs\\ mark*) echo "$*" >> '${calls}'; echo '{"result":"marked","existing":${marker ? 'true' : 'false'}}'; exit ${markStatus} ;;
  *qa-teardown.mjs\\ execute*) echo "$*" >> '${calls}'; printf '%s' '${JSON.stringify(receipt)}'; exit ${executeStatus} ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `set -uo pipefail
QA_OPERATION=${operation}
QA_SCOPE=${scope}
QA_HELPERS_DIR=/tmp/helpers
QA_DISPATCH=main@${'9'.repeat(40)}
QA_MARKER_AT_ROUTE='${marker}'
QA_PLAN_DIGEST='${DIGEST}'
QA_MARKED=0
trap 'echo "marked-at-exit=$QA_MARKED"' EXIT
set -e
${shellBlock('safe receipts')}
${shellBlock('install marker')}
echo "after-mark mode=$QA_QUIESCE_MODE marked=$QA_MARKED"
${shellBlock('teardown')}
echo "stash=$QA_TEARDOWN_STASH"
echo TAIL_REACHED
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('the marker is written first, the first quiesce is fatal and a later one is not, and the teardown reproduces the plan digest', t => {
    const first = runMarkAndTeardown(t);
    assert.equal(first.result.status, 0, first.result.stdout + first.result.stderr);
    assert.deepEqual(first.calls, [
        `/tmp/helpers/qa-teardown.mjs mark --operation rebuild --dispatch main@${'9'.repeat(40)} --lock-held`,
        `/tmp/helpers/qa-teardown.mjs execute --scope rebuild --mode keep-data --quiesce fatal --plan-digest ${DIGEST} --lock-held`,
    ]);
    assert.match(first.result.stdout, /after-mark mode=fatal marked=1/);
    assert.match(first.result.stdout, /Teardown receipt: \{"result":"torn-down"/);
    assert.match(first.result.stdout, /^stash=created$/m);
    for (const marker of ['update', 'rebuild', 'destroy-keep']) {
        const again = runMarkAndTeardown(t, { marker });
        assert.equal(again.result.status, 0, again.result.stdout + again.result.stderr);
        assert.match(again.calls[1], /--quiesce warn /, marker);
    }
    const fresh = runMarkAndTeardown(t, { operation: 'update', scope: 'fresh' });
    assert.match(fresh.calls[0], /mark --operation update /);
    assert.match(fresh.calls[1], /execute --scope fresh --mode keep-data /);
});

test('a marker that cannot be written stops the run before the teardown, and a failed teardown keeps the marker flagged', t => {
    const unmarked = runMarkAndTeardown(t, { markStatus: 1 });
    assert.equal(unmarked.result.status, 1);
    assert.match(unmarked.result.stdout, /ERROR: the install marker was not written; nothing was stopped or removed\./);
    assert.match(unmarked.result.stdout, /marked-at-exit=0/);
    assert.equal(unmarked.calls.length, 1, 'the teardown never ran');
    assert.doesNotMatch(unmarked.result.stdout, /TAIL_REACHED/);
    const failed = runMarkAndTeardown(t, { executeStatus: 1 });
    assert.equal(failed.result.status, 1);
    assert.match(failed.result.stdout, /ERROR: the teardown failed; the install marker is kept\./);
    assert.match(failed.result.stdout, /marked-at-exit=1/, 'the exit handler knows the marker was written');
    assert.doesNotMatch(failed.result.stdout, /TAIL_REACHED/);
});

// AC16 and AC29: the order of the whole Reconcile.
test('the Reconcile order: helpers and Node, snapshot, route, admission, early check, preflight, plan, capacity, marker, teardown, tail, completion', () => {
    const order = [
        '# BEGIN QA transferred helper integrity',
        '# BEGIN QA isolated Node runtime',
        '# BEGIN QA helper staging',
        '# BEGIN QA protected resource snapshot',
        '# BEGIN QA route re-proof',
        '// BEGIN QA preservation admission',
        '# BEGIN QA explorer fast-forward proof',
        'prove_explorer_fast_forward "$EXPECTED_EXPLORER_COMMIT" "$QA_EXPLORER_HEAD" early',
        '# BEGIN QA preflight quiesce check',
        '# BEGIN QA read-only plan',
        '// BEGIN QA capacity admission',
        '# BEGIN QA install marker',
        'qa-teardown.mjs" execute --scope',
        '# END QA teardown',
        '          mkdir -p "$WORK_DIR"\n',
        'prepareBoxForCommand',
        '# BEGIN QA policy restoration',
        '"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"',
        '// BEGIN QA fresh graph readiness',
        'Protected host resource identities remained unchanged',
        'qa-teardown.mjs" complete --lock-held',
        'Explorer QA Box is ready.',
    ].map(at);
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    // `mark` and `complete` occur once, and `execute` is the only caller of the teardown after the marker.
    assert.equal(workflow.match(/# BEGIN QA install marker/g).length, 1);
    assert.equal(workflow.match(/qa-teardown\.mjs" mark /g).length, 1);
    assert.equal(workflow.match(/complete --lock-held/g).length, 1);
    assert.equal(workflow.match(/qa-teardown\.mjs" execute --scope/g).length, 1);
    assert.equal(workflow.match(/qa-teardown\.mjs" plan /g).length, 1);
    // No file is deleted by shell around the teardown: it deletes, and only through the helper.
    const region = workflow.slice(at('# BEGIN QA install marker'), at('# END QA teardown'));
    assert.doesNotMatch(region, /rm\s+-rf|rm\s+-fr|mkdir -p "\$WORK_DIR"/);
    assert.equal(workflow.split('mkdir -p "$WORK_DIR"').length - 1, 1, 'the only workspace mkdir is the one after the teardown');
});

// ---------------------------------------------------------------------------------------------
// The access policy: one restore, slice A's tested stash-restore, called after the fresh edge sources exist.
// ---------------------------------------------------------------------------------------------

function runRestore(t, { answer, stash = 'created' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-restore-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    const answerFile = path.join(dir, 'answer');
    fs.writeFileSync(answerFile, answer.output);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-teardown.mjs*) echo "$*" >> '${calls}'; cat '${answerFile}'; exit ${answer.status} ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const script = `set -euo pipefail\nQA_HELPERS_DIR=/tmp/helpers\nQA_TEARDOWN_STASH=${stash}\n${shellBlock('safe receipts')}\n${shellBlock('policy restoration')}\necho START_STAGE_REACHED\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 15000, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

const restored = (extra = {}) => ({ output: JSON.stringify({ result: 'restored', copied: ['policy-state.json', 'sessions-revocations.json', 'policy-audit.log', 'policy-audit-archive'],
    discarded: [], stashRemoved: true, ...extra }), status: 0 });
const noStash = (extra = {}) => ({ output: JSON.stringify({ result: 'no-stash', copied: [], discarded: [], stashRemoved: false, ...extra }), status: 0 });

// AC17: with a stash the helper's receipt gives the restored line; without one the fresh policy stays.
test('a restored stash is logged with its entries and the Box start is reached only after the helper removed the stash', t => {
    for (const stash of ['created', 'kept']) {
        const ok = runRestore(t, { answer: restored(), stash });
        assert.equal(ok.result.status, 0, ok.result.stdout + ok.result.stderr);
        assert.deepEqual(ok.calls, ['/tmp/helpers/qa-teardown.mjs stash-restore --lock-held']);
        assert.match(ok.result.stdout, /^\[deploy-qa\] Durable access policy, revocations and audit history restored before graph activation \(policy-state\.json, sessions-revocations\.json, policy-audit\.log, policy-audit-archive\); the stash was removed\.\nSTART_STAGE_REACHED$/m);
    }
    const leftovers = runRestore(t, { answer: restored({ discarded: ['router-security.removing-77'] }) });
    assert.equal(leftovers.result.status, 0, 'discarded leftovers are reported by the helper and do not fail the run');
});

test('without a stash the fresh access policy stays and the run continues', t => {
    const none = runRestore(t, { answer: noStash({ discarded: ['router-security.removing-77'] }), stash: 'none' });
    assert.equal(none.result.status, 0, none.result.stdout + none.result.stderr);
    assert.match(none.result.stdout, /^\[deploy-qa\] fresh access policy: no stashed policy exists, so nothing is restored\.\nSTART_STAGE_REACHED$/m);
    assert.doesNotMatch(none.result.stdout, /restored before graph activation/);
});

// The teardown receipt and the restore receipt must agree about the stash.
test('a teardown that created or kept a stash is never answered by no-stash', t => {
    for (const stash of ['created', 'kept']) {
        const { result } = runRestore(t, { answer: noStash(), stash });
        assert.equal(result.status, 1, `${stash}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /ERROR: the access policy restore receipt is not a complete restore; the install marker and the stash remain for the next deploy\./, stash);
        assert.doesNotMatch(result.stdout, /START_STAGE_REACHED|fresh access policy/, stash);
    }
    assert.equal(runRestore(t, { answer: noStash(), stash: 'none' }).result.status, 0);
});

// AC12: only a complete restore passes; everything else stops before the Box starts and leaves the marker and the stash.
test('any other receipt, or a failure, stops the run before the start with the marker and the stash left for the next deploy', t => {
    for (const [name, answer] of [
        ['a restore that did not remove the stash', restored({ stashRemoved: false })],
        ['a restore that copied nothing', restored({ copied: [] })],
        ['a restore without a copied list', restored({ copied: undefined })],
        ['a restore naming a path', restored({ copied: ['../policy-state.json'] })],
        ['a restore naming a file that is not a policy file', restored({ copied: ['policy-state.json', SENTINEL_NAME] })],
        ['a no-stash answer that copied something', noStash({ copied: ['policy-state.json'] })],
        ['a no-stash answer that removed a stash', noStash({ stashRemoved: true })],
        ['an unknown result', { output: '{"result":"cleared","copied":[],"discarded":[],"stashRemoved":false}', status: 0 }],
        ['a refusal with a non-zero exit', { output: '{"result":"failed","code":"QA_TEARDOWN_POLICY_NOT_INITIALIZED"}', status: 1 }],
        ['a helper that exits 75', { output: '', status: 75 }],
        ['garbage', { output: 'not json', status: 0 }],
        ['empty output', { output: '', status: 0 }],
    ]) {
        const { result } = runRestore(t, { answer, stash: name.startsWith('a no-stash') ? 'none' : 'created' });
        assert.equal(result.status, 1, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /ERROR: the access policy (?:was not restored|restore receipt is not a complete restore); the install marker and the stash remain for the next deploy\./, name);
        assert.doesNotMatch(result.stdout, /START_STAGE_REACHED|restored before graph activation|fresh access policy/, name);
        assert.doesNotMatch(result.stdout, new RegExp(SENTINEL_NAME), `${name}: no name outside the policy files reaches the log`);
    }
});

test('the restore sits after the fresh edge sources and before ploinky start, calls the helper once and keeps no inline copy', () => {
    assert.ok(at('initializeFreshEdgeRoutingSources({') < at('# BEGIN QA policy restoration'));
    assert.ok(at('# END QA policy restoration') < at('"$PLOINKY" start explorer "${BRANCH_ARGS[@]}"'), 'the stash is removed before ploinky start');
    assert.equal(workflow.match(/qa-teardown\.mjs" stash-restore --lock-held/g).length, 1);
    assert.equal(workflow.match(/# BEGIN QA policy restoration/g).length, 1);
    const restoration = shellBlock('policy restoration');
    assert.doesNotMatch(restoration, /sudo|cp -a|diff -qr|renameSync|rmSync/, 'one restore: the helper copies, compares and removes');
    assert.doesNotMatch(workflow, /\/\/ BEGIN QA policy restoration|\.qa-deployment-state/, 'no inline restore program or state path remains in the workflow');
    assert.equal(spawnSync('bash', ['-n'], { input: restoration, encoding: 'utf8' }).status, 0);
    assert.ok(at('QA_TEARDOWN_STASH="$(') < at('# BEGIN QA policy restoration'), 'the teardown receipt states the stash before the restore reads it');
});

// The real admin CLI accepts the exact argv the workflow builds.
test('the admin CLI parses the stash-restore argv of the workflow', async () => {
    const { parseArguments } = await import('../../../.github/scripts/qa-teardown.mjs');
    assert.equal(parseArguments(['stash-restore', '--lock-held']).command, 'stash-restore');
    assert.equal(parseArguments(['stash-restore', '--lock-held']).lockHeld, true);
    assert.throws(() => parseArguments(['stash-restore']), error => error.code === 'QA_TEARDOWN_USAGE_INVALID');
});

// ---------------------------------------------------------------------------------------------
// The fresh graph readiness and the completion.
// ---------------------------------------------------------------------------------------------

function runReadiness(t, { ready = true, stopsLater = false, changesLater = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-readiness-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const helper = path.join(dir, 'helper.mjs');
    const record = path.join(dir, 'ready-argument');
    fs.writeFileSync(helper, `
import fs from 'node:fs';
let listed = 0;
export const currentQaBox = boxes => boxes.find(item => item.box.running);
export const productionAdapters = () => ({
    boxes: () => { listed += 1; return [{ engine: 'podman', box: { id: '${EXACT_ID}', contract: listed > 1 && ${changesLater} ? 'changed' : 'contract', running: !(listed > 1 && ${stopsLater}) } }]; },
    async ready(current, authority) { fs.writeFileSync('${record}', JSON.stringify({ id: current.box.id, authority })); return { ready: ${ready} }; },
});
`);
    const source = `import assert from 'node:assert/strict';\n${block('fresh graph readiness')}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-', helper], { encoding: 'utf8', input: source, timeout: 10000 });
    return { result, argument: fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null };
}

test('the fresh graph readiness asks the current Box for its own agents only, with no earlier selection', t => {
    const ok = runReadiness(t);
    assert.equal(ok.result.status, 0, ok.result.stderr);
    assert.equal(ok.result.stdout.trim(), '[deploy-qa] Fresh graph readiness confirmed.');
    assert.deepEqual(ok.argument, { id: EXACT_ID, authority: { agents: [] } });
    for (const options of [{ ready: false }, { stopsLater: true }, { changesLater: true }]) {
        const failed = runReadiness(t, options);
        assert.notEqual(failed.result.status, 0, JSON.stringify(options));
        assert.doesNotMatch(failed.result.stdout, /confirmed/);
    }
    assert.ok(at('// END QA fresh graph readiness') < at('Verified $repository_name/$expected_branch at'));
    assert.doesNotMatch(block('fresh graph readiness'), /backup|restorePriorSelections|enableArguments|classifyPriorSelections/);
});

function runCompletion(t, { before = 'same', completeStatus = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-completion-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    installSha256sum(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$*" in
  *qa-teardown.mjs\\ protected-snapshot*) echo snapshot >> '${calls}'; echo '${before === 'same' ? '[]' : '[{"changed":true}]'}'; exit 0 ;;
  *qa-teardown.mjs\\ complete*) echo "$*" >> '${calls}'; echo '{"result":"completed"}'; exit ${completeStatus} ;;
esac
exec '${process.execPath}' "$@"
`, { mode: 0o755 });
    const start = at('node "$QA_HELPERS_DIR/qa-teardown.mjs" protected-snapshot > "$PROTECTED_AFTER_FILE"');
    const end = workflow.indexOf('\n', at('Explorer QA Box is ready.')) + 1;
    const tailEnd = workflow.slice(start, end).replace(/^ {10}/gm, '');
    fs.writeFileSync(path.join(dir, 'before'), '[]\n');
    const script = `set -euo pipefail\nQA_HELPERS_DIR=${dir}\nQA_MARKED=1\nPROTECTED_BEFORE_FILE=${dir}/before\nPROTECTED_AFTER_FILE=${dir}/after\n${tailEnd}echo "marked=$QA_MARKED"\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:${process.env.PATH}` } });
    return { result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
}

test('the marker is completed only after the protected resources compared equal, and the Box is ready only after that', t => {
    const ok = runCompletion(t);
    assert.equal(ok.result.status, 0, ok.result.stdout + ok.result.stderr);
    assert.match(ok.calls, /snapshot\n.*qa-teardown\.mjs complete --lock-held\n/);
    assert.ok(ok.result.stdout.indexOf('Protected host resource identities remained unchanged') < ok.result.stdout.indexOf('Install marker cleared'));
    assert.ok(ok.result.stdout.indexOf('Install marker cleared') < ok.result.stdout.indexOf('Explorer QA Box is ready.'));
    assert.match(ok.result.stdout, /marked=0/);
    const changed = runCompletion(t, { before: 'changed' });
    assert.equal(changed.result.status, 1);
    assert.match(changed.result.stdout, /an unrelated host container or volume identity changed/);
    assert.doesNotMatch(changed.calls, /complete/, 'the marker stays when a protected resource changed');
    assert.doesNotMatch(changed.result.stdout, /Box is ready/);
    const failed = runCompletion(t, { completeStatus: 1 });
    assert.equal(failed.result.status, 1);
    assert.match(failed.result.stdout, /ERROR: the install marker was not cleared; it is kept\./);
    assert.doesNotMatch(failed.result.stdout, /Box is ready|marked=0/);
});

// The exit handler tells the operator that a failed run left its marker, and only then.
test('the exit handler reports a kept marker only for a failure after the marker, and removes the staged helpers', t => {
    const source = workflow.match(/\n {10}cleanup_remote_files\(\) \{\n([\s\S]*?)\n {10}\}\n/)[0].replace(/^ {10}/gm, '');
    const run = (marked, exitStatus) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cleanup-'));
        t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
        const helpers = path.join(dir, 'helpers');
        fs.mkdirSync(helpers);
        for (const name of ['qa-teardown.mjs', 'qa-teardown-privileged.mjs', 'rollback-explorer-qa.mjs', 'quiesce-explorer-qa.mjs']) fs.writeFileSync(path.join(helpers, name), 'x');
        const envFile = path.join(dir, 'env');
        fs.writeFileSync(envFile, 'x');
        const script = `set -uo pipefail
remove_qa_ancestry_dir() { echo ancestry-removed; }
REMOTE_ENV_FILE='${envFile}'
CLOUDFLARE_CREDENTIAL_FILE=""
PROTECTED_BEFORE_FILE=""
PROTECTED_AFTER_FILE=""
QA_HELPERS_DIR='${helpers}'
QA_MARKED=${marked}
${source}
trap cleanup_remote_files EXIT
exit ${exitStatus}
`;
        const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 });
        return { result, helpers, envFile };
    };
    const failedAfter = run(1, 7);
    assert.equal(failedAfter.result.status, 7, 'the status is preserved');
    assert.match(failedAfter.result.stdout, /Install marker kept; the next deploy finishes this installation from the preserved data\./);
    assert.equal(fs.existsSync(failedAfter.helpers), false);
    assert.equal(fs.existsSync(failedAfter.envFile), false);
    assert.match(failedAfter.result.stdout, /ancestry-removed/);
    assert.doesNotMatch(run(0, 7).result.stdout, /Install marker kept/, 'a failure before the marker keeps nothing');
    assert.doesNotMatch(run(1, 0).result.stdout, /Install marker kept/, 'a success keeps nothing');
});

// ---------------------------------------------------------------------------------------------
// Privacy: the repository, its logs and its step summaries are public.
// ---------------------------------------------------------------------------------------------

const LEAKS = [SENTINEL_NAME, SENTINEL_HASH, 'WebMeet', 'test1.backlog'];
const assertNoLeak = (text, label) => { for (const leak of LEAKS) assert.equal(String(text).includes(leak), false, `${label}: ${leak} reached the output`); };

function safeResult(t, value) {
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${shellBlock('safe receipts')}\nqa_safe_result <<< '${typeof value === 'string' ? value : JSON.stringify(value)}'\n`],
        { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

test('the safe projection keeps counts, digests, IDs, states and codes and drops names and hashes', t => {
    const safe = JSON.parse(safeResult(t, TEARDOWN_RECEIPT));
    assert.deepEqual(safe, {
        result: 'torn-down', scope: 'rebuild', mode: 'keep-data', phase: 'done',
        removedContainers: [`podman:${EXACT_ID}`], removedImages: [`podman:${'1'.repeat(64)}`],
        retainedImages: [{ image: `podman:${'2'.repeat(64)}`, reason: 'retained-in-use' }],
        removedVolumes: 0, warnings: 0, stash: 'created', marker: 'rebuild', quiesce: { result: 'passed', phase: 'complete' },
        workspace: { result: 'reduced', deleted: 3, keepCount: 7, keepDigest: `sha256:${'a'.repeat(64)}`, digest: `sha256:${'b'.repeat(64)}` },
        retainedBackups: [],
    });
    assertNoLeak(JSON.stringify(safe), 'projection');
    // A failure keeps only its code and phase; unknown and hostile values are dropped, not echoed.
    const failure = JSON.parse(safeResult(t, { result: 'failed', phase: 'workspace', code: 'QA_TEARDOWN_KEEP_CHANGED', detail: SENTINEL_NAME,
        privileged: { operation: 'reduce-workspace', code: 'QA_TEARDOWN_KEEP_CHANGED', deleted: [SENTINEL_NAME], removed: [SENTINEL_HASH] },
        removedContainers: [{ engine: 'lxc', id: SENTINEL_HASH }, { engine: 'podman', id: SENTINEL_NAME }], code2: SENTINEL_NAME }));
    assert.deepEqual(failure, { result: 'failed', phase: 'workspace', code: 'QA_TEARDOWN_KEEP_CHANGED',
        removedContainers: [], privileged: { operation: 'reduce-workspace', code: 'QA_TEARDOWN_KEEP_CHANGED' } });
    for (const hostile of [{ code: `QA_${SENTINEL_NAME}` }, { result: SENTINEL_NAME }, { phase: 'Done With Spaces' }, { stash: SENTINEL_NAME }, { marker: { operation: SENTINEL_NAME } }]) {
        assertNoLeak(safeResult(t, hostile), JSON.stringify(hostile));
    }
    assert.deepEqual(JSON.parse(safeResult(t, 'not json')), { unreadable: true });
    const backups = JSON.parse(safeResult(t, { result: 'torn-down', retainedBackups: [{ name: 'redeploy-AbCd1234', reason: 'rollback-attempted' },
        { name: SENTINEL_NAME, reason: 'unrecognized-entry' }, { name: 'redeploy-AbCd1234-helpers', reason: 'sibling-of-retained' }] }));
    assert.deepEqual(backups.retainedBackups.map(item => item.name), ['redeploy-AbCd1234', 'unrecognized', 'redeploy-AbCd1234-helpers']);
});

test('a teardown receipt with a user file name and an identity hash never reaches the log, on success or on failure', t => {
    const success = runMarkAndTeardown(t);
    assert.equal(success.result.status, 0, success.result.stdout + success.result.stderr);
    assertNoLeak(success.result.stdout + success.result.stderr, 'success');
    const receipt = JSON.parse(success.result.stdout.match(/Teardown receipt: (.*)$/m)[1]);
    assert.deepEqual([receipt.workspace.keepCount, receipt.workspace.deleted, receipt.stash, receipt.marker], [7, 3, 'created', 'rebuild']);
    const failed = runMarkAndTeardown(t, { executeStatus: 1, receipt: { ...TEARDOWN_RECEIPT, result: 'failed', phase: 'workspace', code: 'QA_TEARDOWN_KEEP_CHANGED',
        privileged: { operation: 'reduce-workspace', code: 'QA_TEARDOWN_KEEP_CHANGED', deleted: [SENTINEL_NAME], removed: [SENTINEL_HASH] } } });
    assert.equal(failed.result.status, 1);
    assertNoLeak(failed.result.stdout + failed.result.stderr, 'failure');
    assert.match(failed.result.stdout, /ERROR: the teardown failed; the install marker is kept\. Result: \{"result":"failed","scope":"rebuild"/);
    assert.match(failed.result.stdout, /"code":"QA_TEARDOWN_KEEP_CHANGED"/);
    // A receipt that does not state the stash is refused, and also without a leak.
    const unstated = runMarkAndTeardown(t, { receipt: { ...TEARDOWN_RECEIPT, stash: SENTINEL_NAME } });
    assert.equal(unstated.result.status, 1);
    assert.match(unstated.result.stdout, /does not state what happened to the access policy; the install marker is kept\./);
    assertNoLeak(unstated.result.stdout + unstated.result.stderr, 'unstated stash');
});

test('a plan with a user file name and an identity hash prints only counts and digests, on success and on every refusal', t => {
    const ok = runPlan(t, { answer: plan() });
    assert.equal(ok.result.status, 0, ok.result.stdout + ok.result.stderr);
    assertNoLeak(ok.result.stdout + ok.result.stderr, 'plan');
    const line = JSON.parse(ok.result.stdout.match(/Teardown plan: (.*)$/m)[1]);
    assert.deepEqual([line.keepCount, line.keepDigest, line.deleteTargets], [7, `sha256:${'a'.repeat(64)}`, 1]);
    for (const [name, answer] of [
        ['a refusal that carries a name', { output: JSON.stringify({ result: 'refused', code: 'QA_TEARDOWN_RETIRED_IDENTITY', detail: SENTINEL_NAME, identity: [SENTINEL_HASH] }), status: 1 }],
        ['a malformed plan that carries both', plan({ digest: 'short', workspace: { keep: { top: [SENTINEL_NAME] }, identity: [{ sha256: SENTINEL_HASH }] } })],
        ['a plan for another scope', plan({ scope: 'destroy' })],
    ]) {
        const refused = runPlan(t, { answer });
        assert.equal(refused.result.status, 1, name);
        assertNoLeak(refused.result.stdout + refused.result.stderr, name);
    }
});

test('a restore receipt that carries a user file name never reaches the log', t => {
    for (const answer of [restored({ copied: [SENTINEL_NAME], discarded: [SENTINEL_HASH] }), noStash({ discarded: [SENTINEL_NAME], identity: [{ sha256: SENTINEL_HASH }] }),
        { output: JSON.stringify({ result: 'failed', code: 'QA_TEARDOWN_STATE_INVALID', detail: SENTINEL_NAME }), status: 1 }]) {
        const run = runRestore(t, { answer, stash: 'created' });
        assert.equal(run.result.status, 1);
        assertNoLeak(run.result.stdout + run.result.stderr, 'restore');
    }
});

test('the step summary built from a run log carries no user file name and no identity hash', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-summary-privacy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stages = [runPlan(t, { answer: plan() }).result.stdout, runMarkAndTeardown(t).result.stdout,
        runMarkAndTeardown(t, { executeStatus: 1, receipt: { ...TEARDOWN_RECEIPT, result: 'failed' } }).result.stdout].join('\n');
    fs.writeFileSync(path.join(dir, 'explorer-qa-reconcile.log'), stages);
    fs.writeFileSync(path.join(dir, 'explorer-qa-update-result.json'), '[deploy-qa] Deployment route: {"result":"routed","route":"select"}\n');
    const summary = path.join(dir, 'summary.md');
    const result = spawnSync('bash', ['-c', stepScript('Create summary')], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, UPDATED_IN_PLACE: 'false', QA_OPERATION: 'rebuild',
            DISPATCH_REF: 'main', DISPATCH_SHA: '9'.repeat(40), EXPECTED_EXPLORER_COMMIT: COMMIT, SSH_USER: 'admin', SSH_HOST: 'h', WORKSPACE: 'w', ROUTER_PORT: '1',
            CLOUDFLARE_TUNNEL_NAME: 'n', CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: 'p', PUBLIC_URL: 'u' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(stages, /Teardown receipt: /, 'the run log did carry a receipt line');
    const text = fs.readFileSync(summary, 'utf8');
    assert.match(text, /Teardown receipt: `\{"result":"torn-down"/);
    assertNoLeak(text + result.stdout, 'summary');
});

test('no step prints the raw JSON of a plan, a teardown receipt or a restore receipt', () => {
    for (const variable of ['QA_PLAN', 'QA_TEARDOWN_RECEIPT', 'QA_RESTORE']) {
        const uses = workflow.split('\n').filter(line => new RegExp(`\\$\\{?${variable}(?![A-Z_])`).test(line));
        assert.ok(uses.length > 0, variable);
        for (const line of uses) {
            assert.match(line, new RegExp(`printf '%s' "\\$\\{?${variable}\\}?" \\|`), `${variable} only enters a pipe: ${line.trim()}`);
            assert.doesNotMatch(line, new RegExp(`(?:echo|printf)[^|]*\\$\\{?${variable}(?![A-Z_])[^|]*$`), `${variable} is not echoed raw: ${line.trim()}`);
        }
    }
    assert.equal(/keep\??\.top|workspace\??\.identity|workspace\.keep\.top/.test(workflow), false, 'no step reads the kept names or the identity list');
});

// ---------------------------------------------------------------------------------------------
// Static contracts that other tests and the acceptance criteria rely on.
// ---------------------------------------------------------------------------------------------

test('the deploy test step runs the privileged cases and the retired-source scan', () => {
    const script = stepScript('Test deployment admission and recovery');
    assert.match(script, /^QA_TEARDOWN_PRIVILEGED_TESTS=1 node --test tests\/smoke\/lib\/deploy-\*\.test\.mjs tests\/smoke\/lib\/qa-\*\.test\.mjs tests\/smoke\/lib\/retired-source-absence\.test\.mjs$/m);
    assert.ok(fs.existsSync(new URL('./retired-source-absence.test.mjs', import.meta.url)));
});

test('the deploy workflow keeps no backup, no rename, no lock holder and no resume', () => {
    for (const forbidden of [
        retired('container ', 'rename'), retired('.qa-deployment-', 'backups'), retired('redeploy-', 'XXXXXXXX'), retired('QA_BACK', 'UP_DIR'), retired('QA_RES', 'UME_'),
        retired('Rollback ', 'reference'), retired('hold-workspace', '-lock'), retired('operation=', 'resume'), retired('qa-', 'backups'), retired('verify-explorer-qa', '-runtime'),
        retired('QA_CONTAINER', '_RECORDS'), retired('QA_VOLUME', '_RECORDS'), retired('release_qa_', 'workspace_lock'), retired('QA_STOP', '_STARTED'),
        retired('assert_qa_install', '_admission'), retired('capture "$QA_', 'BACKUP_DIR"'),
    ]) {
        assert.equal(workflow.includes(forbidden), false, `no ${forbidden}`);
    }
    // Nothing deletes a workspace path from shell, and the only workspace mkdir follows the teardown.
    assert.doesNotMatch(workflow, /rm -rf "\$WORK_DIR|rm -rf \/home\/admin|rm -fr/);
});

test('every edited heredoc of the Reconcile script is valid module code and the shell parses', t => {
    assertParses(t, 'capacity admission', `import assert from 'node:assert/strict';\n${block('capacity admission')}`);
    assertParses(t, 'fresh graph readiness', `import assert from 'node:assert/strict';\n${block('fresh graph readiness')}`);
    const removal = workflow.match(/remove_qa_ancestry_dir\(\) \{\n[^\n]*\n[^\n]*<<'NODE' \|\| return 1\n([\s\S]*?)\n {10}NODE\n/)[1].replace(/^ {10}/gm, '');
    assertParses(t, 'ancestry directory removal', removal);
    for (const name of ['REMOTE', 'UPDATE']) {
        const match = workflow.match(new RegExp(`<<'${name}'[^\\n]*\\n([\\s\\S]*?)\\n {10}${name}\\n`));
        assert.ok(match, `Missing ${name} script`);
        const checked = spawnSync('bash', ['-n'], { input: match[1].replace(/^ {10}/gm, ''), encoding: 'utf8', timeout: 10000 });
        assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
    }
    for (const name of ['helper staging', 'safe receipts', 'protected resource snapshot', 'route re-proof', 'preflight quiesce check', 'read-only plan',
        'install marker', 'teardown', 'policy restoration', 'explorer fast-forward proof', 'ancestry directory removal', 'deployed source verification', 'transferred helper integrity']) {
        assert.equal(spawnSync('bash', ['-n'], { input: shellBlock(name), encoding: 'utf8' }).status, 0, name);
    }
});

// ---------------------------------------------------------------------------------------------
// The summary and the verification expectation.
// ---------------------------------------------------------------------------------------------

test('every step after the Reconcile runs after a rebuild, and the summary names the route, the selection, the pin and the teardown receipt', () => {
    assert.doesNotMatch(step('Verify public URL'), /^ {8}if:/m);
    assert.match(step('Verify dedicated connector and protected Cloudflare topology'), /^ {8}if: always\(\)$/m);
    const summary = step('Create summary');
    assert.match(summary, /DISPATCH_REF: \$\{\{ github\.ref_name \}\}/);
    assert.match(summary, /DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(summary, /Helpers and tests from .*DISPATCH_REF.*DISPATCH_SHA.*pinned at .*EXPECTED_EXPLORER_COMMIT/);
    assert.match(summary, /Deployment selection and reasons/);
    assert.match(summary, /Rebuild: the Box, its containers and image/);
    assert.match(summary, /Teardown receipt: /);
    assert.doesNotMatch(summary, /Retention|Resumed|retained for rollback/);
    assert.match(workflow, /<<'REMOTE' \| tee "\$RUNNER_TEMP\/explorer-qa-reconcile\.log"/);
    const cleanup = step('Cleanup');
    assert.match(cleanup, /explorer-qa-update-result\.json/);
    assert.match(cleanup, /explorer-qa-reconcile\.log/);
});

function runSummary(t, { operation, updated = 'false', update = '', reconcile = '' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-summary-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'explorer-qa-update-result.json'), update);
    fs.writeFileSync(path.join(dir, 'explorer-qa-reconcile.log'), reconcile);
    const summary = path.join(dir, 'summary.md');
    const result = spawnSync('bash', ['-c', stepScript('Create summary')], { encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, UPDATED_IN_PLACE: updated, QA_OPERATION: operation,
            DISPATCH_REF: 'main', DISPATCH_SHA: '9'.repeat(40), EXPECTED_EXPLORER_COMMIT: COMMIT, SSH_USER: 'admin', SSH_HOST: 'h', WORKSPACE: 'w', ROUTER_PORT: '1',
            CLOUDFLARE_TUNNEL_NAME: 'n', CLOUDFLARE_PROTECTED_SHARED_TUNNEL_ID: 'p', PUBLIC_URL: 'u' } });
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(summary, 'utf8');
}

test('the summary renders the route, the selection, the teardown receipt and the deployed commit of a rebuild', t => {
    const receipt = '{"result":"torn-down","removedContainers":["d4ada362"]}';
    const text = runSummary(t, { operation: 'rebuild',
        update: `[deploy-qa] Deployment route: {"result":"routed","route":"select"}\n[deploy-qa] Deployment selection: {"result":"selected","mode":"redeploy"}\n`,
        reconcile: `[deploy-qa] Teardown receipt: ${receipt}\n[deploy-qa] Deployed AssistOSExplorer commit: ${'9'.repeat(40)}\n` });
    assert.match(text, new RegExp(`pinned at \`${COMMIT}\``));
    assert.match(text, /Helpers and tests from `main@9{40}`/);
    assert.match(text, /Deployment route: `\{"result":"routed","route":"select"\}`/);
    assert.match(text, /Deployment selection and reasons: `\{"result":"selected","mode":"redeploy"\}`/);
    assert.match(text, /Rebuild: the Box, its containers and image/);
    assert.ok(text.includes(`Teardown receipt: \`${receipt}\``));
    assert.match(text, new RegExp(`Deployed AssistOSExplorer commit: \`${'9'.repeat(40)}\``));
    assert.doesNotMatch(text, /Retention|Resumed|rollback/i);
});

test('the summary renders a fresh installation and an in-place update without the rebuild lines', t => {
    const fresh = runSummary(t, { operation: '', update: `[deploy-qa] Deployment route: {"result":"routed","route":"fresh"}\n`,
        reconcile: `[deploy-qa] Teardown receipt: {"result":"torn-down"}\n` });
    assert.match(fresh, /Fresh installation: configured repository defaults/);
    assert.match(fresh, /Teardown receipt: `\{"result":"torn-down"\}`/);
    assert.doesNotMatch(fresh, /Rebuild:/);
    const inPlace = runSummary(t, { operation: '', updated: 'true' });
    assert.match(inPlace, /updated in place from its configured default branch/);
    assert.doesNotMatch(inPlace, /Rebuild:|Fresh installation/);
});

test('the verification expectation is one line carrying the Box, the image, the start time and every source', t => {
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
    assert.match(expected.boxId, /^[a-f0-9]{64}$/);
    assert.match(expected.imageId, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(expected.minimumRunStartedAtMs) && expected.minimumRunStartedAtMs > 0);
    assert.equal(Object.keys(expected.sources).length, 8);
    for (const source of Object.values(expected.sources)) assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(Object.keys(expected.sources).filter(name => name.startsWith('.ploinky/repos/')).map(name => name.slice('.ploinky/repos/'.length)).sort(),
        repositories.sort());
});

// ---------------------------------------------------------------------------------------------
// Fast-forward acceptance, the post-start rule.
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

function runProof(t, { origin, expected, resolved, phase = 'early', operation = 'rebuild', url, merge } = {}) {
    const tools = ancestryTools(origin.root);
    fs.rmSync(path.join(origin.root, 'git.log'), { force: true });
    const script = `set -uo pipefail
QA_ANCESTRY_DIR=""
QA_OPERATION=${operation}
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
    'early rebuild': { operation: 'rebuild', phase: 'early', text: /nothing was stopped or removed\.$/m },
    'early fresh install': { operation: 'update', phase: 'early', text: /nothing was stopped or removed\.$/m },
    'late rebuild': { operation: 'rebuild', phase: 'late', text: /the data stays in place and the install marker remains, so dispatching again finishes this installation\.$/m },
    'late fresh install': { operation: 'update', phase: 'late', text: /the data stays in place and the install marker remains, so dispatching again finishes this installation\.$/m },
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

// The post-start rule, run against a stub engine. `merge-base` answers with a forced status.
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
BOX_INSTANCE=${BOX}
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
