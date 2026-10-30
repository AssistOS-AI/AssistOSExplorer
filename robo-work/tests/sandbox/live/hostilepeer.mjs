// M-36 live probe: one robot (execution A) leaves a long-lived zombie group leader with a live thread on purpose; another execution (B)
// must still stop and release promptly, and A must release too. The trick (python3):
//   threading.Thread(target=lambda: time.sleep(40)).start(); ctypes.CDLL(None).pthread_exit(None)
// leaves the leader State Z / Threads 2: its descriptors and mnt/net links are unreadable from outside, but its live thread's are readable.
// Needs python3 in the workload image (perl has no `threads` here, and node cannot exit one thread). Without it the probe reports that it
// cannot produce the state and exits 3. Run as container root in the nested-podman profile. Prints one JSON document.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProcView } from '../../../server/execution/procView.mjs';
import { createWalker } from '../../../server/execution/recoveryWalk.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionSupervisor, createRecoveryView } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

const CODE = path.resolve(new URL('../../..', import.meta.url).pathname);
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'].find((candidate) => fs.existsSync(candidate));
const evidence = { python: PYTHON ?? null, errors: [] };
if (!PYTHON) {
    evidence.cannotProduce = 'no python3 in the image; perl lacks the threads module and node cannot end a single thread: the zombie-leader-with-a-live-thread state cannot be made with stock tools here';
    process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
    process.exit(3);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-hostile-'));
const runtimeRoot = path.join(root, 'runtime');
fs.mkdirSync(runtimeRoot);
const fdOf = (dir) => fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const view = createProcView({ runtimeRoot });
const recovery = createRecoveryView(view);
const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });
const image = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: CODE, dest: '/opt/robo-work' }], symlinks: [
    { target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }, { target: 'usr/sbin', dest: '/sbin' }] };
const idle = ['/usr/local/bin/node', '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'setInterval(() => {}, 1e6)'];
const walker = createWalker({ view: recovery, clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, releaseDeadlineMs: 6000, pollMs: 100, sandboxRecord: () => null });
const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };

async function startExecution(name, program) {
    const project = path.join(root, `project-${name}`);
    fs.mkdirSync(project);
    const supervisor = createExecutionSupervisor({
        launcher, view, admission: { inventory: [{ name: 'x' }], streamDirectory: '/stream' },
        roles: { orchestration: { ...image, argv: idle }, endpoint: { ...image, argv: idle }, workload: { ...image } },
        home: { path: project, fd: fdOf(project) }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, access: 'write', fd: fdOf(project) }], limits: { stopGraceMs: 500 }
    });
    const blockers = [];
    const publish = async (kind, spec = null) => {
        const locator = deriveLocator(kind, newLocatorId(), layout);
        const id = crypto.randomBytes(16).toString('base64url');
        const created = await supervisor.create({ kind, resourceId: id, marker: id, locator, spec });
        await created.gate?.commit();
        blockers.push({ kind, identity: created.identity, locator: { ...locator, marker: id } });
        return created;
    };
    await publish('keeper'); await publish('runtime-dir'); await publish('netns'); await publish('endpoint', { config: {} });
    await publish('process-tree', { role: 'orchestration' });
    const request = { processClass: 'service', executable: program.executable, args: program.args, env: {}, home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], exclusions: [], network: 'robot-egress', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };
    const workload = await publish('process-tree', { role: 'workload', process: 1, request, streams: {} });
    return { name, supervisor, blockers, workload };
}

async function endExecution(execution) {
    const started = Date.now();
    const errors = [];
    const step = async (label, fn) => { try { await fn(); } catch (error) { errors.push(`${label}: ${error?.code ?? ''} ${error?.message ?? error}`); } };
    await step('endProcessTrees', () => execution.supervisor.endProcessTrees());
    await step('endEndpoint', () => execution.supervisor.endEndpoint());
    await step('releaseEgress', () => execution.supervisor.releaseEgress());
    await step('releaseViews', () => execution.supervisor.releaseViews());
    await step('removeRuntime', () => execution.supervisor.removeRuntime());
    const outcomes = [];
    for (const blocker of execution.blockers) outcomes.push([blocker.kind, await walker.walk(blocker)]);
    return { name: execution.name, ms: Date.now() - started, errors, outcomes, quarantined: outcomes.filter(([, outcome]) => outcome !== 'released').length };
}

const hostile = { executable: PYTHON, args: ['-c', 'import threading, time, ctypes\nthreading.Thread(target=lambda: time.sleep(40)).start()\ntime.sleep(0.5)\nctypes.CDLL(None).pthread_exit(None)'] };
const calm = { executable: '/usr/bin/sleep', args: ['300'] };
let a;
let b;
try {
    a = await startExecution('A', hostile);
    b = await startExecution('B', calm);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // the state really exists: a Z leader with Threads > 1 in A's pid namespace, unreadable from outside except through its thread
    const inA = view.listProcesses().filter((entry) => entry.pidNs === a.workload.identity.pidNs || (entry.threadNs?.pidNs ?? []).includes(a.workload.identity.pidNs));
    const stateOf = (entry) => { try { return /State:\s*(\S)/.exec(fs.readFileSync(`/proc/${entry.pid}/status`, 'utf8'))?.[1]; } catch { return 'gone'; } };
    const leader = inA.find((entry) => stateOf(entry) === 'Z');
    evidence.candidatesInA = inA.map((entry) => ({ pid: entry.pid, state: stateOf(entry), cmd: entry.cmdline[0]?.slice(-30) }));
    const raw = leader ? fs.readFileSync(`/proc/${leader.pid}/status`, 'utf8') : '';
    evidence.hostile = leader ? {
        pid: leader.pid, state: /State:\s*(\S)/.exec(raw)?.[1], threads: /Threads:\s*(\d+)/.exec(raw)?.[1], leaderFd: (() => { try { fs.readdirSync(`/proc/${leader.pid}/fd`); return 'readable'; } catch (e) { return e.code; } })(),
        leaderNsNet: (() => { try { fs.readlinkSync(`/proc/${leader.pid}/ns/net`); return 'readable'; } catch (e) { return e.code; } })(),
        listedAs: { opaque: leader.opaque === true, netNs: leader.netNs, viaThreads: leader.threadNs !== undefined }
    } : 'not found';
    evidence.hostileObserved = leader !== undefined && evidence.hostile.state === 'Z' && Number(evidence.hostile.threads) > 1;
    evidence.netnsOfB = b.blockers.find((blocker) => blocker.kind === 'netns').identity.netNs;
    // stop B while A's zombie leader is still running: B must release promptly, not quarantine
    evidence.stopB = await endExecution(b);
    evidence.hostileStillThereAfterB = view.listProcesses().some((entry) => entry.pid === leader?.pid);
    evidence.stopA = await endExecution(a);
    const left = view.listProcesses().filter((entry) => [a, b].some((execution) => execution.workload.identity.pidNs === entry.pidNs));
    evidence.processesLeft = left.length;
} catch (error) {
    evidence.errors.push(`${error?.code ?? ''} ${error?.message ?? error}`);
}
evidence.pass = evidence.errors.length === 0 && evidence.hostileObserved === true && evidence.stopB?.quarantined === 0 && evidence.stopB?.errors.length === 0
    && evidence.stopB.ms < 8000 && evidence.stopA?.quarantined === 0 && evidence.processesLeft === 0;
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
process.exit(evidence.pass ? 0 : 1);
