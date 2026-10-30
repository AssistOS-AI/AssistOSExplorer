// F13 live probe: stop an IDLE multi-threaded workload (`opencode serve`, or a 12-thread node if opencode is absent) through the real
// end path while /proc is listed continuously, as RoboFlow's owner stop did. Builds an execution like crash.mjs, ends it in ledger
// order, then walks every recorded process blocker with the recovery walker, and prints one JSON document.
// Passes (exit 0) when nothing threw, every blocker was released, and no sandbox process remains. Run as container root.
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
const TOOLS = '/opt/robo-work-tools';
const OPENCODE = `${TOOLS}/node_modules/opencode-ai/bin/opencode.exe`;
const haveOpencode = fs.existsSync(OPENCODE);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-stopidle-'));
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });
const runtimeRoot = path.join(root, 'runtime');
fs.mkdirSync(runtimeRoot);
const fdOf = (dir) => fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const view = createProcView({ runtimeRoot });
const recovery = createRecoveryView(view);
const image = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: CODE, dest: '/opt/robo-work' }, ...(haveOpencode ? [{ source: TOOLS, dest: TOOLS }] : [])],
    symlinks: [{ target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }] };
const idle = ['/usr/local/bin/node', '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'setInterval(() => {}, 1e6)'];
const supervisor = createExecutionSupervisor({
    launcher: createSandboxLauncher({ view, procMasks: readProcMasks() }), view, admission: { inventory: [{ name: 'serve' }], streamDirectory: '/stream' },
    roles: { orchestration: { ...image, argv: idle }, endpoint: { ...image, argv: idle }, workload: { ...image } },
    home: { path: project, fd: fdOf(project) }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, access: 'write', fd: fdOf(project) }], limits: { stopGraceMs: 500 }
});
const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };
const blockers = [];
async function publish(kind, spec = null) {
    const locator = deriveLocator(kind, newLocatorId(), layout);
    const id = crypto.randomBytes(16).toString('base64url');
    const created = await supervisor.create({ kind, resourceId: id, marker: id, locator, spec });
    await created.gate?.commit();
    blockers.push({ kind, identity: created.identity, locator: { ...locator, marker: id } });
    return created;
}
const evidence = { opencode: haveOpencode, listings: 0, listThrows: {}, opaqueSeen: 0, outcomes: [], errors: [] };
await publish('keeper');
await publish('runtime-dir');
await publish('netns');
await publish('endpoint', { config: {} });
await publish('process-tree', { role: 'orchestration' });
const argv = haveOpencode ? ['serve', '--hostname', '127.0.0.1', '--port', '0'] : ['-e', 'const { Worker } = require("worker_threads"); for (let i = 0; i < 12; i += 1) new Worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600000)", { eval: true }); setInterval(() => {}, 1e6);'];
const request = { processClass: 'service', executable: haveOpencode ? OPENCODE : '/usr/local/bin/node', args: argv, env: {}, home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], exclusions: [], network: 'none', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };
const workload = await publish('process-tree', { role: 'workload', process: 1, request, streams: {} });
await new Promise((resolve) => setTimeout(resolve, 4000)); // let it start its threads and go idle
const members = view.listProcesses().filter((entry) => entry.pidNs === workload.identity.pidNs);
evidence.workloadMembers = members.map((entry) => ({ pid: entry.pid, comm: entry.cmdline[0]?.slice(-40) }));
evidence.workloadThreads = members.map((entry) => Number(/Threads:\s*(\d+)/.exec(fs.readFileSync(`/proc/${entry.pid}/status`, 'utf8'))?.[1] ?? 0));

// the stop, with /proc listed continuously (what recovery, the launcher's proof and a sibling's own stop do at the same time)
let spamming = true;
const spam = (async () => {
    while (spamming) {
        try { for (const entry of view.listProcesses()) if (entry.opaque) evidence.opaqueSeen += 1; evidence.listings += 1; } catch (error) { evidence.listThrows[error.code ?? error.name] = (evidence.listThrows[error.code ?? error.name] ?? 0) + 1; }
        await new Promise((resolve) => setImmediate(resolve));
    }
})();
const stepError = async (name, fn) => { try { await fn(); } catch (error) { evidence.errors.push(`${name}: ${error?.code ?? ''} ${error?.message ?? error}`); } };
await stepError('endProcessTrees', () => supervisor.endProcessTrees());
await stepError('endEndpoint', () => supervisor.endEndpoint());
await stepError('releaseEgress', () => supervisor.releaseEgress());
await stepError('releaseViews', () => supervisor.releaseViews());
await stepError('removeRuntime', () => supervisor.removeRuntime());
// every recorded blocker through the walker, as the ledger's end path and a restart's recovery do
const walker = createWalker({ view: recovery, clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, releaseDeadlineMs: 8000, pollMs: 100, sandboxRecord: () => null });
for (const blocker of blockers) {
    try { evidence.outcomes.push([blocker.kind, await walker.walk(blocker)]); } catch (error) { evidence.errors.push(`walk ${blocker.kind}: ${error?.code ?? ''} ${error?.message ?? error}`); }
}
spamming = false;
await spam;
const left = view.listProcesses().filter((entry) => blockers.some((blocker) => blocker.identity.pidNs && entry.pidNs === blocker.identity.pidNs));
evidence.sandboxProcessesLeft = left.length;
evidence.pass = evidence.errors.length === 0 && Object.keys(evidence.listThrows).length === 0 && evidence.outcomes.every(([, outcome]) => outcome === 'released') && left.length === 0;
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 1)}\n`);
process.exit(evidence.pass ? 0 : 1);
