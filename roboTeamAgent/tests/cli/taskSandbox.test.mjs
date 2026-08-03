import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    BWRAP_CAPABILITY_ERROR_CODE,
    __testables as openCodeSandboxTestables,
    buildTaskSandboxLaunch as buildOpenCodeSandbox,
    prepareTaskSandbox as prepareOpenCodeSandbox,
    probeNestedBubblewrap as probeOpenCodeBubblewrap,
    resolveSandboxProject as resolveOpenCodeProject,
} from '../opencodeAgent/scripts/task-sandbox.mjs';
import {
    __testables as piSandboxTestables,
    buildTaskSandboxLaunch as buildPiSandbox,
    prepareTaskSandbox as preparePiSandbox,
    probeNestedBubblewrap as probePiBubblewrap,
    resolveSandboxProject as resolvePiProject,
} from '../piAgent/scripts/task-sandbox.mjs';

const fakeBwrapPath = new URL('./helpers/fake-bwrap.sh', import.meta.url).pathname;
const openCodeInstaller = new URL('../opencodeAgent/scripts/ensure-bubblewrap.sh', import.meta.url).pathname;
const piInstaller = new URL('../piAgent/scripts/ensure-bubblewrap.sh', import.meta.url).pathname;
const credentialNames = Object.freeze([
    'PLOINKY_AGENT_API_KEY',
    'PLOINKY_AGENT_PRIVATE_SECRET',
    'PLOINKY_AGENT_CLIENT_SECRET',
    'PLOINKY_AGENT_SECRET',
    'PLOINKY_MASTER_KEY',
    'PLOINKY_INVOCATION_CREDENTIAL',
    'PLOINKY_ROUTER_CREDENTIAL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
]);

function procIdentity(overrides = {}) {
    return {
        ok: true,
        processPid: process.pid,
        procSelfPid: process.pid,
        pidNamespaceVisible: true,
        namespaceDevice: 'test-device',
        namespaceInode: 'test-inode',
        error: null,
        ...overrides,
    };
}

function testDependencies(overrides = {}) {
    return {
        bwrapPath: fakeBwrapPath,
        procInspector: () => procIdentity(),
        ...overrides,
    };
}

function bindPairs(args, option) {
    const pairs = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === option) pairs.push([args[index + 1], args[index + 2]]);
    }
    return pairs;
}

function selectedProcMode(args) {
    return args.some((value, index) => value === '--proc' && args[index + 1] === '/proc')
        ? 'private'
        : 'empty';
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

test('missing production Bubblewrap fails with the stable capability code without a skip', () => {
    openCodeSandboxTestables.clearProbeCache();
    assert.throws(
        () => probeOpenCodeBubblewrap({
            dependencies: testDependencies({ bwrapPath: '/definitely/missing/bwrap' }),
        }),
        (error) => error?.code === BWRAP_CAPABILITY_ERROR_CODE
            && /does not exist/.test(error.message),
    );
});

test('agent installers share the same install-if-missing Bubblewrap policy', async (t) => {
    assert.equal(await fs.readFile(openCodeInstaller, 'utf8'), await fs.readFile(piInstaller, 'utf8'));
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bwrap-install-test-'));
    t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
    const binDirectory = path.join(temporaryDirectory, 'bin');
    await fs.mkdir(binDirectory);
    await fs.writeFile(path.join(binDirectory, 'id'), '#!/bin/sh\nprintf "0\\n"\n', { mode: 0o755 });
    await fs.writeFile(path.join(binDirectory, 'apt-get'), `#!/bin/sh
if [ "$1" = "install" ]; then
    printf '%s\\n' '#!/bin/sh' 'exit 0' > "$FAKE_BIN_DIR/bwrap"
    /bin/chmod 755 "$FAKE_BIN_DIR/bwrap"
fi
exit 0
`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', [openCodeInstaller], {
        encoding: 'utf8',
        env: { PATH: binDirectory, FAKE_BIN_DIR: binDirectory },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await fs.stat(path.join(binDirectory, 'bwrap'))).mode & 0o111, 0o111);
});

for (const [agent, testables, buildSandbox, prepareSandbox, probeBubblewrap, resolveProject] of [
    [
        'OpenCode',
        openCodeSandboxTestables,
        buildOpenCodeSandbox,
        prepareOpenCodeSandbox,
        probeOpenCodeBubblewrap,
        resolveOpenCodeProject,
    ],
    ['PI', piSandboxTestables, buildPiSandbox, preparePiSandbox, probePiBubblewrap, resolvePiProject],
]) {
    test(`${agent} validates outer proc before probe or project mutation`, async (t) => {
        testables.clearProbeCache();
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'outer-proc-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const projectDir = path.join(workspaceRoot, 'missing-project');
        await fs.mkdir(workspaceRoot);
        let spawnCount = 0;
        for (const inspection of [
            procIdentity({ ok: false, error: 'missing outer proc' }),
            procIdentity({ procSelfPid: process.pid + 1 }),
            procIdentity({ pidNamespaceVisible: false }),
        ]) {
            assert.throws(
                () => prepareSandbox({
                    projectDir,
                    env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
                    createProjectDir: true,
                    dependencies: testDependencies({
                        procInspector: () => inspection,
                        spawnSyncImpl: () => { spawnCount += 1; return { status: 0 }; },
                    }),
                }),
                (error) => error?.code === BWRAP_CAPABILITY_ERROR_CODE,
            );
        }
        assert.equal(spawnCount, 0);
        await assert.rejects(fs.access(projectDir));
    });

    test(`${agent} private and empty proc modes both launch the exact executable`, async (t) => {
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-mode-task-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const projectDir = path.join(workspaceRoot, 'project');
        const command = path.join(temporaryDirectory, 'agent-executable.sh');
        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(command, '#!/bin/sh\nprintf "%s" "$1" > exact-command.txt\n', { mode: 0o755 });

        for (const expectedMode of ['private', 'empty']) {
            testables.clearProbeCache();
            const dependencies = expectedMode === 'private'
                ? testDependencies()
                : testDependencies({
                    spawnSyncImpl(binary, args, options) {
                        if (selectedProcMode(args) === 'private') {
                            return { status: 1, stderr: 'private unavailable' };
                        }
                        return spawnSync(binary, args, options);
                    },
                });
            const capability = probeBubblewrap({ dependencies });
            assert.equal(capability.procMode, expectedMode);
            assert.ok(Object.isFrozen(capability));
            assert.ok(Object.isFrozen(capability.binaryIdentity));
            const launch = buildSandbox({
                projectDir,
                command,
                args: [expectedMode],
                env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
                dependencies,
            });
            assert.equal(selectedProcMode(launch.args), expectedMode);
            const result = spawnSync(launch.command, launch.args, {
                cwd: launch.cwd,
                encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(await fs.readFile(path.join(projectDir, 'exact-command.txt'), 'utf8'), expectedMode);
        }
    });

    test(`${agent} total capability failure creates no project or task state`, async (t) => {
        testables.clearProbeCache();
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-fail-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const projectDir = path.join(workspaceRoot, 'missing-project');
        await fs.mkdir(workspaceRoot);
        let attempts = 0;
        assert.throws(
            () => prepareSandbox({
                projectDir,
                env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
                createProjectDir: true,
                dependencies: testDependencies({
                    spawnSyncImpl: () => {
                        attempts += 1;
                        return { status: 1, stderr: 'denied' };
                    },
                }),
            }),
            (error) => error?.code === BWRAP_CAPABILITY_ERROR_CODE
                && /private: denied; empty: denied/.test(error.message),
        );
        assert.equal(attempts, 2);
        await assert.rejects(fs.access(projectDir));
    });

    test(`${agent} binary replacement at the same path invalidates the cached capability`, async (t) => {
        testables.clearProbeCache();
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bwrap-identity-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const binary = path.join(temporaryDirectory, 'bwrap');
        await fs.writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        let attempts = 0;
        const dependencies = testDependencies({
            bwrapPath: binary,
            spawnSyncImpl: () => { attempts += 1; return { status: 0 }; },
        });
        const first = probeBubblewrap({ dependencies });
        assert.equal(probeBubblewrap({ dependencies }), first);
        assert.equal(attempts, 1);
        const replacement = path.join(temporaryDirectory, 'replacement');
        await fs.writeFile(replacement, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await fs.rename(replacement, binary);
        const second = probeBubblewrap({ dependencies });
        assert.notEqual(second, first);
        assert.equal(attempts, 2);
    });

    test(`${agent} launch exposes only projectDir as workspace-writable and filters credentials`, async (t) => {
        testables.clearProbeCache();
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
        await fs.writeFile(command, '#!/bin/sh\nenv\n', { mode: 0o755 });
        const sentinels = Object.fromEntries(credentialNames.map((name) => [name, `sentinel-${name}`]));
        const launch = buildSandbox({
            projectDir,
            command,
            args: ['task'],
            env: {
                PLOINKY_WORKSPACE_ROOT: workspaceRoot,
                PLOINKY_TASK_BWRAP_BIN: '/operator-controlled/path',
                LD_PRELOAD: '/tmp/hostile.so',
                NODE_OPTIONS: '--require=/tmp/hostile.cjs',
                SAFE_TEST_VALUE: 'kept',
                PLOINKY_TASK_BROKER_URL: 'http://127.0.0.1:1234/v1',
                PLOINKY_TASK_BROKER_KEY: 'scoped-broker-token',
                ...sentinels,
            },
            writablePaths: [stateDir],
            dependencies: testDependencies({ taskEnvironmentNames: ['SAFE_TEST_VALUE'] }),
        });
        const writableBinds = bindPairs(launch.args, '--bind');
        assert.deepEqual(writableBinds, [
            [await fs.realpath(stateDir), await fs.realpath(stateDir)],
            [await fs.realpath(projectDir), await fs.realpath(projectDir)],
        ]);
        assert.equal(writableBinds.some(([source]) => source === workspaceRoot), false);
        assert.equal(writableBinds.some(([source]) => source === siblingDir), false);
        assert.ok(launch.args.includes('--clearenv'));
        assert.ok(launch.args.includes('SAFE_TEST_VALUE'));
        for (const [name, sentinel] of Object.entries(sentinels)) {
            assert.equal(launch.args.includes(name), false, name);
            assert.equal(launch.args.includes(sentinel), false, sentinel);
        }
        for (const forbidden of ['LD_PRELOAD', 'NODE_OPTIONS', 'PLOINKY_TASK_BWRAP_BIN']) {
            assert.equal(launch.args.includes(forbidden), false, forbidden);
        }
        const executed = spawnSync(launch.command, launch.args, {
            cwd: launch.cwd,
            encoding: 'utf8',
        });
        assert.equal(executed.status, 0, executed.stderr);
        assert.match(executed.stdout, /^SAFE_TEST_VALUE=kept$/m);
        assert.match(
            executed.stdout,
            /^PLOINKY_TASK_BROKER_URL=http:\/\/127\.0\.0\.1:1234\/v1$/m
        );
        assert.match(executed.stdout, /^PLOINKY_TASK_BROKER_KEY=scoped-broker-token$/m);
        for (const sentinel of Object.values(sentinels)) {
            assert.doesNotMatch(executed.stdout, new RegExp(sentinel));
            assert.doesNotMatch(executed.stderr, new RegExp(sentinel));
        }
        assert.equal(launch.cwd, await fs.realpath(projectDir));
        assert.throws(
            () => buildSandbox({
                projectDir,
                command: siblingCommand,
                env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
                dependencies: testDependencies(),
            }),
            /must not expose another workspace path/,
        );
    });

    test(`${agent} path authorization rejects outside, traversal, and symlink paths without mutation`, async (t) => {
        testables.clearProbeCache();
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-path-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const outside = path.join(temporaryDirectory, 'outside');
        const outsideMissing = path.join(temporaryDirectory, 'outside-missing');
        const link = path.join(workspaceRoot, 'linked-project');
        await fs.mkdir(workspaceRoot);
        await fs.mkdir(outside);
        await fs.symlink(outside, link);
        for (const [candidate, pattern] of [
            [outsideMissing, /must stay inside/],
            [`${workspaceRoot}${path.sep}..${path.sep}traversal-target`, /traversal segments/],
            [link, /must not contain symlinks/],
        ]) {
            assert.throws(
                () => prepareSandbox({
                    projectDir: candidate,
                    env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
                    createProjectDir: true,
                    dependencies: testDependencies(),
                }),
                pattern,
            );
        }
        await assert.rejects(fs.access(outsideMissing));
        await assert.rejects(fs.access(path.join(temporaryDirectory, 'traversal-target')));
        assert.equal(await fs.realpath(link), await fs.realpath(outside));
    });

    test(`${agent} creates authorized missing path components and revalidates the final real path`, async (t) => {
        testables.clearProbeCache();
        const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-create-test-'));
        t.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
        const workspaceRoot = path.join(temporaryDirectory, 'workspace');
        const projectDir = path.join(workspaceRoot, 'one', 'two');
        await fs.mkdir(workspaceRoot);
        const prepared = prepareSandbox({
            projectDir,
            env: { PLOINKY_WORKSPACE_ROOT: workspaceRoot },
            createProjectDir: true,
            dependencies: testDependencies(),
        });
        assert.equal(prepared.projectDir, await fs.realpath(projectDir));
        assert.equal(
            resolveProject(projectDir, { PLOINKY_WORKSPACE_ROOT: workspaceRoot }),
            await fs.realpath(projectDir),
        );
        assert.equal((await fs.stat(path.join(workspaceRoot, 'one'))).isDirectory(), true);
    });
}
