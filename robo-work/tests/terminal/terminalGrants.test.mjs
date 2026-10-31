import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TERMINAL_ARGV, TERMINAL_ENV, createExecutionFactory } from '../../server/runtime/executionFactory.mjs';
import { createRuntimeSourceProvider } from '../../server/runtime/executionGrants.mjs';
import { createTerminalExecutions } from '../../server/terminal/terminalExecutions.mjs';
import { ProtocolError, launchFields } from '../../server/terminal/terminalProtocol.mjs';
import { count } from '../helpers/synthetic.mjs';
import { PATH, fakePtyHost, launchEvidence, terminalRig } from './helpers/terminalRig.mjs';

// M-8 U1 grant probes: the REAL factory.openTerminal and the REAL resolveExecutionGrants / anchored resolver over a real temporary
// workspace; the supervisor and ledger are counting fakes, so "zero spawns" means no supervisor was even built.

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-terminal-ws-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-terminal-out-')));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
    for (const directory of ['proj/sub', '.ploinky/repos/x/y/z', 'a/b', 'home/robot-home']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'link-outside'));
    return { root, outside };
}

function factoryFor(store, root, { sources = [], fetchFails = false } = {}) {
    const counter = { supervisors: 0, publishes: [], supervisorOptions: null, registered: 0 };
    const fetch = async () => {
        if (fetchFails) throw new Error('down');
        return { schemaVersion: 1, authorizationGeneration: `sha256:${'a'.repeat(64)}`, activationId: crypto.randomUUID(), sources, outsideWorkspace: 0 };
    };
    let nextFd = 700;
    const factory = createExecutionFactory({
        store, robots: { root: path.join(root, 'home'), paths: () => ({ home: path.join(root, 'home/robot-home') }) },
        launcher: {}, view: {}, walker: {}, clock: {}, workspaceRoot: root, runtimeDir: path.join(root, 'home/runtime'), serverDir: '/code/server', alaRoot: '/ala',
        nodePath: '/usr/local/bin/node', runtimeSources: createRuntimeSourceProvider({ workspaceRoot: root, fetch }),
        deps: {
            openDirectory: () => nextFd++, closeFd: () => {},
            timers: { setInterval: () => { counter.registered += 1; return { unref() {} }; }, clearInterval: () => {} },
            createExecutionSupervisor: (options) => { counter.supervisors += 1; counter.supervisorOptions = options; return { exit: async () => {} }; },
            createExecutionLedger: ({ context, executionId, attemptId }) => ({
                startKeeper: async () => { counter.publishes.push('keeper'); },
                publish: async ({ kind, spec }) => { counter.publishes.push(spec ? `${kind}:${spec.role}:${spec.cwd}` : kind); return { handle: kind === 'process-tree' ? { wait: () => new Promise(() => {}) } : null }; },
                endExecution: async (outcome) => {
                    store.beginAttemptEnd(context, { executionId, attemptId, expectedState: outcome.expectedState, outcome: { classification: outcome.classification, outputText: outcome.outputText, data: outcome.data } });
                    return { releaseLog: [] };
                }
            }),
            imageBinds: () => ({ roBinds: [{ source: '/usr', dest: '/usr' }], symlinks: [], toolBinds: [{ source: '/opt/robo-work-tools', dest: '/opt/robo-work-tools' }] })
        }
    });
    return { factory, counter };
}

async function launcherFor(t, options) {
    const rig = await terminalRig(t);
    const { root } = workspace(t);
    const { factory, counter } = factoryFor(rig.store, root, options);
    const logs = [];
    const executions = createTerminalExecutions({ store: rig.store, verifier: rig.verifier, workspaceId: 'ws-synthetic', path: PATH, factory, ptyHost: fakePtyHost(), log: (event, fields) => logs.push({ event, ...fields }) });
    const launch = (project) => {
        const fields = { operationId: crypto.randomUUID(), targetId: rig.robotId, project, cols: 80, rows: 24 };
        return executions.launch({ fields, evidence: launchEvidence(rig.secret, fields) });
    };
    return { rig, root, counter, launch, logs };
}

const codeOf = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('dir refusal probes: .., a/../b, /etc, .ploinky/repos/x, a symlink to outside and the workspace root are grant_refused with zero spawns', async (t) => {
    const { rig, counter, launch } = await launcherFor(t);
    // The workspace root: '' never reaches the terminal path (the frame schema refuses it and closes the connection; an empty browser
    // `dir` is `project: null`, i.e. HOME), and its spellings '.' and './' are refused here.
    assert.throws(() => launchFields({ operationId: crypto.randomUUID(), targetId: rig.robotId, project: { selection: '', relativePath: '' }, cols: 80, rows: 24 }), ProtocolError);
    const probes = ['..', 'a/../b', '/etc', '.ploinky/repos/x/y/z', 'link-outside', '.', './', 'a//b', 'missing/dir', 'proj\\sub'];
    for (const selection of probes) {
        assert.equal(await codeOf(launch({ selection, relativePath: '' })), 'grant_refused', selection);
    }
    assert.equal(counter.supervisors, 0, 'no supervisor was built');
    assert.deepEqual(counter.publishes, [], 'nothing was published');
    // Syntax refusals never admit; resolver refusals admitted and ended the admission at once (nothing open, nothing running).
    assert.equal(rig.store.countOpenTerminals(), 0);
    assert.ok(count(rig.dir, 'admission') <= 4);
});

test('HOME terminal: terminal-mode supervisor with no grant, the fixed shell, cwd /home/robot; publication keeper, runtime dir, netns, terminal tree', async (t) => {
    const { counter, launch } = await launcherFor(t);
    const terminal = await launch(null);
    assert.ok(terminal.executionId);
    const options = counter.supervisorOptions;
    assert.equal(options.mode, 'terminal');
    assert.deepEqual(options.grants, []);
    assert.deepEqual(options.roles.terminal.argv, [...TERMINAL_ARGV]);
    assert.deepEqual(options.roles.terminal.env, { ...TERMINAL_ENV });
    assert.ok(options.roles.terminal.roBinds.some((bind) => bind.dest === '/opt/robo-work-tools'), 'the coding agents are reachable');
    assert.deepEqual(counter.publishes, ['keeper', 'runtime-dir', 'netns', 'process-tree:terminal:/home/robot']);
    assert.equal(counter.registered, 0, 'a HOME terminal registers no writable grant with the source watch');
});

test('project terminal: the folder is resolved writable through resolveExecutionGrants and watched; cwd is its /projects root', async (t) => {
    const { counter, launch } = await launcherFor(t);
    await launch({ selection: 'proj/sub', relativePath: '' });
    const options = counter.supervisorOptions;
    assert.equal(options.grants.length, 1);
    assert.deepEqual({ name: options.grants[0].name, path: options.grants[0].path, access: options.grants[0].access }, { name: 'sub', path: '/projects/sub', access: 'write' });
    assert.ok(options.grants[0].hostPath.endsWith('/proj/sub'));
    assert.equal(counter.publishes.at(-1), 'process-tree:terminal:/projects/sub');
    assert.equal(counter.registered, 1, 'the writable grant is registered with the source watch');
});

test('M-63: a project folder inside an active runtime source, or no source list, is grant_refused with zero spawns', async (t) => {
    const inside = await launcherFor(t, { sources: [{ kind: 'agent-repository', relativePath: 'proj' }] });
    assert.equal(await codeOf(inside.launch({ selection: 'proj/sub', relativePath: '' })), 'grant_refused');
    assert.equal(inside.counter.supervisors, 0);
    assert.ok(inside.logs.some((entry) => entry.reason === 'grant_inside_active_source'));
    const down = await launcherFor(t, { fetchFails: true });
    assert.equal(await codeOf(down.launch({ selection: 'proj/sub', relativePath: '' })), 'grant_refused');
    assert.equal(down.counter.supervisors, 0);
    // A HOME terminal needs no source list.
    assert.equal(await codeOf(down.launch(null)), 'ok');
});
