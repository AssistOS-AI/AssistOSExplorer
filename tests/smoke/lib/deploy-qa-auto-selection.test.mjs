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

function runLocked(t, { workspace = 'absent', labelled = false, named = false, engineFailure = false, updateFailure = false, operation } = {}) {
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
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n[ "$1" = '--version' ] && { echo v24.19.0; exit 0; }\necho "update $*" >> '${marker}'\nexit ${updateFailure || ['symlink', 'file'].includes(workspace) ? 19 : 0}\n`, { mode: 0o755 });
    const script = `id() { echo admin; }\n${locked.replaceAll('/home/admin/explorerQaWorkspace', target).replace(/node_home="[^"]+"/, `node_home='${root}'`)}`;
    const result = spawnSync('bash', ['-s', '--', updateDir, ...(operation ? [operation] : [])], {
        input: script, encoding: 'utf8', timeout: 10000,
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/admin' },
    });
    return { result, calls: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '' };
}

test('locked deployment selects update with no operator input for an existing installation', t => {
    const { result, calls } = runLocked(t, { workspace: 'directory' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls, /update .*update-explorer-qa.mjs execute --receipt .* --lock-held/);
    assert.doesNotMatch(calls, /podman|docker/);
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
    'failed update': { workspace: 'directory', updateFailure: true },
    'failed engine probe': { engineFailure: true },
    'labelled orphan Box': { labelled: true },
    'named orphan Box': { named: true },
    'dangling workspace symlink': { workspace: 'symlink' },
    'ordinary workspace file': { workspace: 'file' },
})) {
    test(`locked deployment never selects first installation after ${name}`, t => {
        const { result, calls } = runLocked(t, options);
        assert.notEqual(result.status, 0);
        assert.notEqual(result.status, 42);
        if (options.workspace) assert.match(calls, /update .* --lock-held/);
        else assert.doesNotMatch(calls, /update/);
    });
}

for (const status of [0, 42, 19, 75]) {
    test(`workflow result handler maps status ${status} without failure fallthrough`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-result-dispatch-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const output = path.join(root, 'output');
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', `set -euo pipefail\nstatus=${status}\n${dispatch}`], {
            encoding: 'utf8', timeout: 5000, env: { ...process.env, GITHUB_OUTPUT: output },
        });
        assert.equal(result.status, [0, 42].includes(status) ? 0 : status, result.stderr);
        assert.equal(fs.readFileSync(output, 'utf8'), status === 0 ? 'updated=true\n' : status === 42 ? 'updated=false\n' : '');
        if ([19, 75].includes(status)) {
            assert.match(result.stdout, /will not recreate or destroy/);
            assert.doesNotMatch(result.stdout, /proceeding to first installation/);
        }
    });
}

for (const operation of [undefined, 'update']) {
    test(`locked deployment keeps the update mapping for operation ${operation ?? '(none)'}`, t => {
        const existing = runLocked(t, { workspace: 'directory', operation });
        assert.equal(existing.result.status, 0, existing.result.stderr);
        assert.match(existing.calls, /update .*update-explorer-qa.mjs execute/);
        const absent = runLocked(t, { operation });
        assert.equal(absent.result.status, 42, absent.result.stderr);
        assert.doesNotMatch(absent.calls, /update/);
        const failed = runLocked(t, { workspace: 'directory', updateFailure: true, operation });
        assert.equal(failed.result.status, 19);
    });
}

for (const operation of ['redeploy-rehearsal', 'redeploy']) {
    test(`locked ${operation} hands an existing workspace to Reconcile without running the updater`, t => {
        const { result, calls } = runLocked(t, { workspace: 'directory', operation });
        assert.equal(result.status, 43, result.stderr);
        assert.match(result.stdout, new RegExp(`Preserving redeploy selected \\(${operation}\\); the in-place updater was not run\\.`));
        assert.doesNotMatch(calls, /update|podman|docker/);
    });

    for (const workspace of ['absent', 'file', 'symlink']) {
        test(`locked ${operation} refuses a ${workspace} workspace and never selects first installation`, t => {
            const { result, calls } = runLocked(t, { workspace, operation });
            assert.equal(result.status, 1, result.stderr);
            assert.match(result.stderr, /redeploy requires an existing QA workspace directory/);
            assert.doesNotMatch(calls, /update|podman|docker/);
        });
    }
}

test('locked deployment refuses an unsupported operation before touching the host', t => {
    const { result, calls } = runLocked(t, { workspace: 'directory', operation: 'destroy' });
    assert.equal(result.status, 1);
    assert.equal(calls, '');
});

for (const [status, operation, output, failed] of [
    [43, 'redeploy', 'updated=false\noperation=redeploy\n', false],
    [43, 'redeploy-rehearsal', 'updated=false\noperation=redeploy-rehearsal\n', false],
    [43, 'update', '', true],
    [43, undefined, '', true],
    [19, 'redeploy', '', true],
    [75, 'redeploy-rehearsal', '', true],
    [42, 'redeploy', 'updated=false\n', false],
]) {
    test(`result handler maps status ${status} for operation ${operation ?? '(none)'} without a failure fallthrough`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-result-dispatch-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const outputFile = path.join(root, 'output');
        fs.writeFileSync(outputFile, '');
        const env = { ...process.env, GITHUB_OUTPUT: outputFile };
        delete env.OPERATION;
        if (operation) env.OPERATION = operation;
        const result = spawnSync('bash', ['-c', `set -euo pipefail\nstatus=${status}\n${dispatch}`],
            { encoding: 'utf8', timeout: 5000, env });
        assert.equal(result.status === 0, !failed, result.stderr);
        assert.equal(fs.readFileSync(outputFile, 'utf8'), output);
        if (failed) assert.doesNotMatch(result.stdout, /proceeding to/i);
    });
}
