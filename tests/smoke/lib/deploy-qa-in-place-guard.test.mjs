import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../../.github/workflows/deploy-explorer-qa.yml', import.meta.url), 'utf8');
const guardPath = new URL('../../../.github/scripts/qa-in-place-guard.sh', import.meta.url).pathname;
const locked = workflow.match(/<<'UPDATE' \|\| status=\$\?\n([\s\S]*?)\n {10}UPDATE\n/)[1].replace(/^ {10}/gm, '');

function fixture(t, { workspace }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-in-place-guard-'));
    const suffix = crypto.randomBytes(6).toString('hex').slice(0, 8);
    const updateDir = `/tmp/explorer-qa-update.${suffix}`;
    fs.mkdirSync(updateDir, { mode: 0o700 });
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(updateDir, { recursive: true, force: true });
    });
    fs.copyFileSync(guardPath, path.join(updateDir, 'qa-in-place-guard.sh'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(root, 'markers');
    fs.mkdirSync(marker);
    for (const name of ['ploinky', 'podman', 'docker', 'node', 'curl', 'ssh', 'scp', 'git']) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$0 $*" >> "${marker}/${name}"\n[ "$1 $2" = 'container inspect' ] && exit 1\nexit 0\n`, { mode: 0o755 });
    }
    const target = path.join(root, 'workspace');
    if (workspace === 'directory') fs.mkdirSync(target);
    return { root, bin, marker, target, updateDir };
}

function runLocked(f, inPlaceOnly) {
    const script = `id() { echo admin; }\n${locked.replaceAll('/home/admin/explorerQaWorkspace', f.target)}`;
    return spawnSync('bash', ['-s', '--', f.updateDir, ...(inPlaceOnly === undefined ? [] : [inPlaceOnly])], {
        input: script, encoding: 'utf8', timeout: 10000,
        env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: '/home/admin' },
    });
}

const markers = (f) => fs.readdirSync(f.marker);

test('the workflow declares a boolean in_place_only input defaulting to false and passes it through env', () => {
    assert.match(workflow, /in_place_only:\n\s+description: .*\n\s+type: boolean\n\s+default: false/);
    assert.match(workflow, /env:\n\s+IN_PLACE_ONLY: \$\{\{ inputs\.in_place_only \}\}\n\s+run: \|/);
    assert.doesNotMatch(workflow.replace(/IN_PLACE_ONLY: \$\{\{ inputs\.in_place_only \}\}/, ''), /inputs\.in_place_only/);
});

test('the guard runs under the lock before any probe, 42 exit or provisioning command', () => {
    const lockLine = workflow.indexOf('flock -n -E 75 --close /home/admin/.qa-deployment-operation.lock bash -s -- \'$REMOTE_DIR\'');
    const guard = workflow.indexOf('bash "$update_dir/qa-in-place-guard.sh"');
    const probe = workflow.indexOf('command -v "$engine"');
    const exit42 = workflow.indexOf('exit 42');
    const fresh = workflow.indexOf('name: Reconcile and start Explorer QA Box');
    assert(lockLine > 0 && lockLine < guard && guard < probe && probe < exit42 && exit42 < fresh);
    assert.match(workflow, /elif \[ "\$status" -eq 43 \]; then[\s\S]*?exit 43/);
});

test('in_place_only=true with an absent workspace fails before any command runs', t => {
    const f = fixture(t, { workspace: 'absent' });
    const checked = runLocked(f, 'true');
    assert.equal(checked.status, 43, checked.stderr);
    assert.match(checked.stderr, /in_place_only is true and the QA workspace is absent/);
    assert.deepEqual(markers(f), []);
});

test('in_place_only=true with a present workspace passes the guard', t => {
    const f = fixture(t, { workspace: 'directory' });
    const checked = runLocked(f, 'true');
    assert.notEqual(checked.status, 43);
    assert.doesNotMatch(checked.stderr, /in_place_only is true/);
    assert.deepEqual(markers(f).filter((name) => name !== 'node'), []);
});

test('in_place_only=false with an absent workspace keeps the exit-42 path after probing engines', t => {
    const f = fixture(t, { workspace: 'absent' });
    const checked = runLocked(f, 'false');
    assert.equal(checked.status, 42, checked.stderr);
    assert(markers(f).includes('podman'));
    assert.deepEqual(markers(f).filter((name) => !['podman', 'docker'].includes(name)), []);
});

test('an empty flag inside the lock fails closed instead of being treated as false', t => {
    const f = fixture(t, { workspace: 'absent' });
    assert.equal(runLocked(f, '').status, 1);
    assert.deepEqual(markers(f), []);
});

test('the guard rejects malformed values and a missing argument', t => {
    const f = fixture(t, { workspace: 'absent' });
    for (const args of [[f.target, 'TRUE'], [f.target, '1'], [f.target], []]) {
        const checked = spawnSync('bash', [guardPath, ...args], { encoding: 'utf8', timeout: 5000 });
        assert.equal(checked.status, 1, JSON.stringify(args));
    }
});

test('the guard treats a dangling symlink as present', t => {
    const f = fixture(t, { workspace: 'absent' });
    fs.symlinkSync(path.join(f.root, 'missing'), f.target);
    assert.equal(spawnSync('bash', [guardPath, f.target, 'true'], { encoding: 'utf8' }).status, 0);
});
