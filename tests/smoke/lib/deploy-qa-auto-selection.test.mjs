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

function runLocked(t, { workspace = 'absent', labelled = false, named = false, engineFailure = false, updateFailure = false } = {}) {
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
    const result = spawnSync('bash', ['-s', '--', updateDir], {
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
