// Live E9 check of the QA source sandbox against real rootless Podman. Opt in
// with QA_SOURCE_SANDBOX_LIVE_IMAGE set to the full ID of a local Box image
// (for example `podman image inspect --format '{{.Id}}' <image>`); nothing is
// pulled. Without it the test is skipped, and a skip is not a pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { productionAdapters } from '../../../.github/scripts/rollback-explorer-qa.mjs';
import { updateProductionAdapters } from '../../../.github/scripts/update-explorer-qa.mjs';

const image = String(process.env.QA_SOURCE_SANDBOX_LIVE_IMAGE || '').replace(/^sha256:/, '');

test('E9 live: a Box-written core.fsmonitor runs only inside the sandbox and never reaches the host', { skip: image ? false
    : 'set QA_SOURCE_SANDBOX_LIVE_IMAGE to a local Box image ID to run against real Podman' }, t => {
    assert.match(image, /^[a-f0-9]{64}$/);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-source-sandbox-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = { workspace: path.join(root, 'workspace'), box: 'ploinky-box-qa-7a31ab7775eb', hash: '7a31ab7775eb' };
    const repo = path.join(scope.workspace, '.ploinky/repos/AchillesIDE');
    const marker = path.join(root, 'fsmonitor-ran-on-host');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
    const git = args => {
        const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
                GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(['init', '--initial-branch=main']); git(['remote', 'add', 'origin', 'https://github.com/AssistOS-AI/AssistOSExplorer.git']);
    git(['add', '.']); git(['commit', '-m', 'Fixture source']);
    const head = git(['rev-parse', 'HEAD']);
    const hook = path.join(repo, '.git/fsmonitor-hook');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    fs.appendFileSync(path.join(repo, '.git/config'), `[core]\n\tfsmonitor = ${hook}\n`);

    // Control: the status check as the former host-side code ran it runs the hook.
    const direct = spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, 'status', '--porcelain=v1', '--untracked-files=all',
        '--ignore-submodules=none'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(fs.existsSync(marker), true, 'the fixture triggers on the host');
    fs.rmSync(marker);

    const pin = productionAdapters(scope).sourcePin(repo, { engine: 'podman', image });
    assert.deepEqual(pin, { commit: head, branch: 'main', origin: 'https://github.com/AssistOS-AI/AssistOSExplorer.git' });
    assert.equal(fs.existsSync(marker), false, 'the hook never ran on the host');
});

test('E9 live (merge): a Box-written filter driver runs only inside the sandboxed fast-forward and never reaches the host', { skip: image ? false
    : 'set QA_SOURCE_SANDBOX_LIVE_IMAGE to a local Box image ID to run against real Podman' }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-merge-sandbox-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = name => {
        const repo = path.join(root, name), marker = path.join(root, `${name}-filter-ran-on-host`);
        const git = args => {
            const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
                GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
                GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
            assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
        };
        fs.mkdirSync(repo, { recursive: true });
        git(['init', '--initial-branch=main']);
        fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
        git(['add', '.']); git(['commit', '-m', 'base']);
        const base = git(['rev-parse', 'HEAD']);
        fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=x\n');
        fs.writeFileSync(path.join(repo, 'notes.txt'), 'smudged on checkout\n');
        git(['add', '.']); git(['commit', '-m', 'next']);
        const next = git(['rev-parse', 'HEAD']);
        git(['reset', '--hard', base]);
        fs.appendFileSync(path.join(repo, '.git/config'), `[filter "x"]\n\tsmudge = "sh -c 'echo ran >> ${marker}; cat'"\n\tclean = cat\n`);
        return { repo, marker, next, git };
    };
    // Control: the same fast-forward in the host process runs the driver.
    const control = fixture('control');
    control.git(['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '--no-edit', control.next]);
    assert.equal(fs.existsSync(control.marker), true, 'the fixture triggers on the host');
    const sandboxed = fixture('sandboxed');
    updateProductionAdapters({ workspace: '/w', box: 'fixture-qa-box' }).fastForward(sandboxed.repo, sandboxed.next, { engine: 'podman', image });
    assert.equal(sandboxed.git(['rev-parse', 'HEAD']), sandboxed.next, 'the sandboxed fast-forward completed');
    assert.equal(fs.readFileSync(path.join(sandboxed.repo, 'notes.txt'), 'utf8'), 'smudged on checkout\n');
    assert.equal(fs.existsSync(sandboxed.marker), false, 'the filter driver never ran on the host');
});
