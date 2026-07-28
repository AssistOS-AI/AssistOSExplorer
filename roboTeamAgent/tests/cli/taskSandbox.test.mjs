import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    __testables as openCodeSandboxTestables,
    buildTaskSandboxLaunch as buildOpenCodeSandbox,
    resolveSandboxProject as resolveOpenCodeProject,
} from '../opencodeAgent/scripts/task-sandbox.mjs';
import {
    buildTaskSandboxLaunch as buildPiSandbox,
    resolveSandboxProject as resolvePiProject,
} from '../piAgent/scripts/task-sandbox.mjs';

const fakeBwrapPath = new URL('./helpers/fake-bwrap.sh', import.meta.url).pathname;
const openCodeInstaller = new URL(
    '../opencodeAgent/scripts/ensure-bubblewrap.sh',
    import.meta.url,
).pathname;
const piInstaller = new URL(
    '../piAgent/scripts/ensure-bubblewrap.sh',
    import.meta.url,
).pathname;

function bindPairs(args, option) {
    const pairs = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === option) {
            pairs.push([args[index + 1], args[index + 2]]);
        }
    }
    return pairs;
}

test('nested Bubblewrap probe mounts the dynamic loader paths', () => {
    const args = openCodeSandboxTestables.minimalProbeArgs('private');
    for (const candidate of ['/lib', '/lib64']) {
        if (!fsSync.existsSync(candidate)) continue;
        const stat = fsSync.lstatSync(candidate);
        const expected = stat.isSymbolicLink()
            ? ['--symlink', fsSync.readlinkSync(candidate), candidate]
            : ['--ro-bind', candidate, candidate];
        assert.ok(args.some((value, index) => (
            value === expected[0]
            && args[index + 1] === expected[1]
            && args[index + 2] === expected[2]
        )));
    }
});

test('real Bubblewrap denies parent writes', async (t) => {
    if (!fsSync.existsSync('/usr/bin/bwrap')) {
        t.skip('bubblewrap is not installed in this test environment');
        return;
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'real-bwrap-test-'));
    t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
    const workspaceRoot = path.join(temporaryDirectory, 'workspace');
    const projectDir = path.join(workspaceRoot, 'project');
    await fs.mkdir(projectDir, { recursive: true });
    let launch;
    try {
        launch = buildOpenCodeSandbox({
            projectDir,
            command: '/usr/bin/sh',
            args: [
                '-c',
                'touch inside.txt && ! touch ../outside.txt 2>/dev/null',
            ],
            env: {
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            },
        });
    } catch (error) {
        t.skip(`nested bubblewrap is unavailable here: ${error?.message || error}`);
        return;
    }
    const result = spawnSync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: {
            PATH: '/usr/bin:/bin',
        },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    await fs.access(path.join(projectDir, 'inside.txt'));
    await assert.rejects(fs.access(path.join(workspaceRoot, 'outside.txt')));
});

test('agent installers share the same install-if-missing Bubblewrap policy', async (t) => {
    assert.equal(
        await fs.readFile(openCodeInstaller, 'utf8'),
        await fs.readFile(piInstaller, 'utf8'),
    );
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bwrap-install-test-'));
    t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
    const binDirectory = path.join(temporaryDirectory, 'bin');
    await fs.mkdir(binDirectory);
    await fs.writeFile(
        path.join(binDirectory, 'id'),
        '#!/bin/sh\nprintf "0\\n"\n',
        { mode: 0o755 },
    );
    await fs.writeFile(
        path.join(binDirectory, 'apt-get'),
        `#!/bin/sh
if [ "$1" = "install" ]; then
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$FAKE_BIN_DIR/bwrap"
    /bin/chmod 755 "$FAKE_BIN_DIR/bwrap"
fi
exit 0
`,
        { mode: 0o755 },
    );
    const result = spawnSync('/bin/sh', [openCodeInstaller], {
        encoding: 'utf8',
        env: {
            PATH: binDirectory,
            FAKE_BIN_DIR: binDirectory,
        },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await fs.stat(path.join(binDirectory, 'bwrap'))).mode & 0o111, 0o111);
});

for (const [agent, buildSandbox, resolveProject] of [
    ['OpenCode', buildOpenCodeSandbox, resolveOpenCodeProject],
    ['PI', buildPiSandbox, resolvePiProject],
]) {
    test(`${agent} task sandbox exposes only projectDir as workspace-writable`, async (t) => {
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-sandbox-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const projectDir = path.join(workspaceRoot, 'project');
        const siblingDir = path.join(workspaceRoot, 'sibling');
        const siblingCommand = path.join(siblingDir, 'agent-bin');
        const stateDir = path.join(temporaryDirectory, 'state');
        const command = path.join(temporaryDirectory, 'agent-bin');
        await fs.mkdir(projectDir, { recursive: true });
        await fs.mkdir(siblingDir);
        await fs.writeFile(siblingCommand, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await fs.mkdir(stateDir);
        await fs.writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const launch = buildSandbox({
            projectDir,
            command,
            args: ['task'],
            env: {
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                PLOINKY_TASK_BWRAP_BIN: fakeBwrapPath,
                LD_PRELOAD: '/tmp/hostile.so',
                NODE_OPTIONS: '--require=/tmp/hostile.cjs',
                PLOINKY_AGENT_SECRET: 'must-not-enter-task',
                PLOINKY_MASTER_KEY: 'must-not-enter-task',
                SAFE_VALUE: 'kept',
            },
            writablePaths: [stateDir],
        });

        const writableBinds = bindPairs(launch.args, '--bind');
        assert.deepEqual(writableBinds, [
            [await fs.realpath(stateDir), await fs.realpath(stateDir)],
            [await fs.realpath(projectDir), await fs.realpath(projectDir)],
        ]);
        assert.equal(writableBinds.some(([source]) => source === workspaceRoot), false);
        assert.equal(writableBinds.some(([source]) => source === siblingDir), false);
        assert.ok(launch.args.includes('--unshare-user'));
        assert.ok(launch.args.includes('--unshare-pid'));
        assert.ok(launch.args.includes('--share-net'));
        const rootReadOnlyIndex = launch.args.findIndex((value, index) => (
            value === '--remount-ro' && launch.args[index + 1] === '/'
        ));
        const projectBindIndex = launch.args.findIndex((value, index) => (
            value === '--bind' && launch.args[index + 1] === projectDir
        ));
        assert.ok(rootReadOnlyIndex > projectBindIndex);
        assert.equal(launch.args.includes('LD_PRELOAD'), false);
        assert.equal(launch.args.includes('NODE_OPTIONS'), false);
        assert.equal(launch.args.includes('PLOINKY_AGENT_SECRET'), false);
        assert.equal(launch.args.includes('PLOINKY_MASTER_KEY'), false);
        assert.ok(launch.args.includes('SAFE_VALUE'));
        assert.equal(launch.cwd, projectDir);

        assert.throws(
            () => resolveProject(siblingDir, {
                PLOINKY_WORKSPACE_ROOT: projectDir,
            }),
            /must stay inside PLOINKY_WORKSPACE_ROOT/,
        );
        assert.throws(
            () => buildSandbox({
                projectDir,
                command,
                env: {
                    PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                    PLOINKY_TASK_BWRAP_BIN: path.join(temporaryDirectory, 'missing-bwrap'),
                },
            }),
            /bubblewrap does not exist/,
        );
        assert.throws(
            () => buildSandbox({
                projectDir,
                command: siblingCommand,
                env: {
                    PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                    PLOINKY_TASK_BWRAP_BIN: fakeBwrapPath,
                },
            }),
            /must not expose another workspace path/,
        );
    });

    test(`${agent} task sandbox rejects a project symlink escaping the workspace`, async (t) => {
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-sandbox-link-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const outsideDir = path.join(temporaryDirectory, 'outside');
        const linkedProject = path.join(workspaceRoot, 'linked-project');
        await fs.mkdir(workspaceRoot);
        await fs.mkdir(outsideDir);
        await fs.symlink(outsideDir, linkedProject);

        assert.throws(
            () => resolveProject(linkedProject, {
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            }),
            /must stay inside PLOINKY_WORKSPACE_ROOT/,
        );
    });
}
