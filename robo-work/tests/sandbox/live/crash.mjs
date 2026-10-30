// AC12 (r10 P-CRASH): supervisor crash teardown, then recovery after restart. Run as container root in the nested-podman profile
// (or in the Box worker as an extra process). It needs no arguments:
//
//   parent  creates a real S1 store, an admitted running attempt, and starts a CHILD process (this file with --child);
//   child   builds a whole execution through the real ledger and supervisor (anchor, runtime dir, network, endpoint, orchestration,
//           a long workload) and SIGKILLs ITSELF;
//   parent  1. within 1 s no sandbox process of the child is left (parent-death teardown, before any recovery);
//           2. notes what the dead supervisor left behind by name (netns file, veth, nft table, runtime directory);
//           3. "restarts": reopens the store and runs production generation recovery (runtime/recovery.mjs, the walker over the
//              recovery view) and requires that it completes with every blocker released or quarantined, nothing unsettled;
//           4. requires the leftovers by name to be gone.
// Prints one JSON document; exit 0 only when every requirement held.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createProcView } from '../../../server/execution/procView.mjs';
import { createExecutionLedger } from '../../../server/execution/resourceLedger.mjs';
import { createWalker } from '../../../server/execution/recoveryWalk.mjs';
import { namesFor } from '../../../server/sandbox/executionNetwork.mjs';
import { createExecutionSupervisor, createRecoveryView, sandboxRecordFor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';
import { recoverWorkerGeneration } from '../../../server/runtime/recovery.mjs';
import { admitRequest, openStore, readyRobot, syntheticContext } from '../../helpers/synthetic.mjs';

const CODE = path.resolve(new URL('../../..', import.meta.url).pathname);
const clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

function assemble(dir) {
    const runtimeRoot = path.join(dir, 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const view = createProcView({ runtimeRoot });
    return { runtimeRoot, view, recovery: createRecoveryView(view) };
}

// ---- the child: a supervisor that dies -------------------------------------------------------------------------------------------
if (process.argv[2] === '--child') {
    const { dir, robotId, executionId, attemptId } = JSON.parse(process.argv[3]);
    const { runtimeRoot, view } = assemble(dir);
    const store = openStore(dir, { create: false });
    const project = path.join(dir, 'project');
    fs.mkdirSync(project, { recursive: true });
    const fdOf = (target) => fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const image = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: CODE, dest: '/opt/robo-work' }], symlinks: [
        { target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }] };
    const idle = ['/usr/local/bin/node', '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'setInterval(() => {}, 1e6)'];
    const supervisor = createExecutionSupervisor({
        launcher: createSandboxLauncher({ view, procMasks: readProcMasks() }), view, admission: { inventory: [{ name: 'sleep' }], streamDirectory: '/stream' },
        roles: { orchestration: { ...image, argv: idle }, endpoint: { ...image, argv: idle }, workload: { ...image } },
        home: { path: project, fd: fdOf(project) }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, access: 'write', fd: fdOf(project) }]
    });
    const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };
    const walker = createWalker({ view, clock, releaseDeadlineMs: 1000, pollMs: 100, sandboxRecord: () => null });
    const ledger = createExecutionLedger({ state: store, context: syntheticContext(), robotId, executionId, attemptId, referenceId: null, layout, sandbox: supervisor, walker, clock });
    await ledger.startKeeper();
    await ledger.publish({ kind: 'runtime-dir' });
    await ledger.publish({ kind: 'netns' });
    await ledger.publish({ kind: 'endpoint', spec: { config: {} } });
    await ledger.publish({ kind: 'process-tree', spec: { role: 'orchestration' } });
    const request = { processClass: 'run', executable: '/usr/bin/sleep', args: ['1000'], env: {}, home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], exclusions: [], network: 'none', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };
    await supervisor.providerSandbox(ledger).start({ process: 1, request, streams: {} });
    await new Promise((resolve) => setTimeout(resolve, 800));
    process.stdout.write(`CRASHING ${JSON.stringify({ netns: supervisor.network.name, runtimeDir: supervisor.runtimeDir })}\n`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
}

// ---- the parent -------------------------------------------------------------------------------------------------------------------
const evidence = { errors: [] };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-crash-'));
const check = (name, ok, extra = {}) => { evidence[name] = { ok, ...extra }; if (!ok) evidence.errors.push(name); };
const tool = (command, args) => spawnSync(command, args, { encoding: 'utf8' }).stdout ?? '';
try {
    const context = syntheticContext();
    let store = openStore(dir);
    const robotId = readyRobot(store, context);
    const admitted = store.admit(context, admitRequest(robotId, {}, context));
    store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    store.close();

    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--child', JSON.stringify({ dir, robotId, executionId: admitted.executionId, attemptId: admitted.attemptId })], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const crashing = /CRASHING (\{.*\})/u.exec(text);
    check('the child built an execution and killed itself', exit.signal === 'SIGKILL' && crashing !== null, { exit });
    const info = JSON.parse(crashing?.[1] ?? '{}');
    const killedAt = Date.now();

    // 1. before any recovery: parent-death teardown
    store = openStore(dir, { create: false });
    const { view, recovery } = assemble(dir);
    const blockers = store.listUnsettledResources();
    const markers = blockers.map((blocker) => blocker.locator.marker).filter(Boolean);
    const sandboxProcesses = () => view.listProcesses().filter((entry) => entry.cmdline.some((arg) => markers.includes(arg) || arg === '/usr/bin/sleep' && entry.cmdline.includes('1000')));
    let left = sandboxProcesses();
    while (left.length > 0 && Date.now() - killedAt < 1000) { await clock.sleep(25); left = sandboxProcesses(); }
    check('no sandbox process of the dead supervisor within 1 s', left.length === 0, { afterMs: Date.now() - killedAt, left: left.map((entry) => entry.cmdline[0]) });
    evidence.blockersBeforeRecovery = blockers.map((blocker) => [blocker.kind, blocker.release_state ?? blocker.state ?? 'committed']);

    // 2. what it left behind by name
    const names = namesFor(blockers.find((blocker) => blocker.kind === 'netns').locator.netns);
    const present = () => ({
        netnsFile: fs.existsSync(`/run/netns/${names.netns}`), link: tool('ip', ['-o', 'link', 'show']).includes(names.host), table: tool('nft', ['list', 'tables']).includes(names.table),
        runtimeDir: info.runtimeDir ? fs.existsSync(info.runtimeDir) : null
    });
    evidence.leftoverBeforeRecovery = present();
    check('the dead supervisor did leave its network behind (what recovery must remove)', evidence.leftoverBeforeRecovery.netnsFile && evidence.leftoverBeforeRecovery.link && evidence.leftoverBeforeRecovery.table);

    // 3. restart: production generation recovery
    const walker = createWalker({ view: recovery, clock, releaseDeadlineMs: 8000, pollMs: 100, sandboxRecord: sandboxRecordFor(() => store) });
    const recovered = await recoverWorkerGeneration({ state: store, walker });
    evidence.recovery = { outcomes: recovered.outcomes.map((entry) => [entry.kind, entry.outcome]), completed: recovered.completed };
    check('recovery completed (completeGenerationRecovery)', recovered.completed?.recovered === true || recovered.completed !== undefined);
    check('every blocker released or quarantined', recovered.outcomes.length >= 5 && recovered.outcomes.every((entry) => entry.outcome === 'released' || entry.outcome === 'quarantined'));
    check('nothing left unsettled', store.listUnsettledResources().length === 0);
    check('every blocker was released (nothing needed quarantine)', recovered.outcomes.every((entry) => entry.outcome === 'released'));

    // 4. the leftovers by name are gone
    evidence.leftoverAfterRecovery = present();
    check('netns, veth, nft table and runtime directory are gone after recovery', !evidence.leftoverAfterRecovery.netnsFile && !evidence.leftoverAfterRecovery.link && !evidence.leftoverAfterRecovery.table && evidence.leftoverAfterRecovery.runtimeDir === false);
    store.close();
} catch (error) {
    evidence.errors.push(`${error?.code ?? ''} ${error?.message ?? error}`);
}
evidence.pass = evidence.errors.length === 0;
fs.rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
process.exit(evidence.pass ? 0 : 1);
