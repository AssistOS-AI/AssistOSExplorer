// Live smoke for the Node sandbox (plan Revision 10). Run as container root inside the nested-podman profile, with this
// robo-work tree mounted read-only at /opt/robo-work:
//
//   podman run --rm --user 0 --cap-add SYS_ADMIN --cap-add NET_ADMIN --device /dev/fuse --device /dev/net/tun \
//     --security-opt label=disable \
//     --security-opt seccomp=<ploinky>/ploinky-box/seccomp/podman-nested-pid-fallback.json \
//     -v <robo-work>:/opt/robo-work:ro --entrypoint node <image> /opt/robo-work/tests/sandbox/live/smoke.mjs
//
// It builds an execution the way the ledger would (anchor, runtime dir, network, endpoint, orchestration, one workload)
// with the real launcher, supervisor, network and procView, runs a probe program inside each role, ends the execution in
// ledger order, and prints ONE JSON document of evidence on stdout (progress goes to stderr). Exit code 0 when no step
// recorded an error. The probe prints facts only; it never prints file content.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { createProcView } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionSupervisor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

// The robo-work tree on this machine (bound read-only at /opt/robo-work inside the sandboxes).
const SOURCE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const CODE = '/opt/robo-work';
const evidence = { steps: {}, errors: [], roles: {} };
const log = (text) => process.stderr.write(`[smoke] ${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function step(name, fn) {
    log(name);
    try { evidence.steps[name] = (await fn()) ?? 'ok'; } catch (error) {
        evidence.errors.push({ step: name, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) });
        evidence.steps[name] = 'FAILED';
    }
}
const tool = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8' }); return (r.stdout || r.stderr || '').trim().split('\n')[0]; };

// ---- the probe that runs inside every role (node -e) -------------------------------------------------------------------
const PROBE = String.raw`(() => {
const fs = require('fs'); const cp = require('child_process'); const net = require('net');
const out = { role: process.env.PROBE_ROLE || 'orchestration' };
const status = fs.readFileSync('/proc/self/status', 'utf8');
for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp', 'Uid']) out[key] = (status.match(new RegExp('^' + key + ':\\s*(.*)$', 'm')) || [])[1];
out.fds = fs.readdirSync('/proc/self/fd').map((n) => { try { return n + '->' + fs.readlinkSync('/proc/self/fd/' + n); } catch { return n + '->?'; } });
out.pids = fs.readdirSync('/proc').filter((n) => /^[0-9]+$/.test(n));
out.hostname = require('os').hostname();
const un = cp.spawnSync('/usr/bin/unshare', ['-U', 'true'], { encoding: 'utf8' });
out.unshareUserns = { status: un.status, stderr: (un.stderr || '').trim().slice(0, 80) };
const links = cp.spawnSync('/usr/bin/ip', ['-o', 'link'], { encoding: 'utf8' });
out.links = (links.stdout || links.stderr || '').trim().split('\n').map((l) => l.replace(/\s+/g, ' ').slice(0, 60));
const sizeOrCode = (f) => { try { return fs.readFileSync(f).length; } catch (e) { return e.code; } };
out.proc = { keys: sizeOrCode('/proc/keys'), kcore: sizeOrCode('/proc/kcore'), sysrq: (() => { try { fs.writeFileSync('/proc/sysrq-trigger', 'h'); return 'WROTE'; } catch (e) { return e.code; } })(),
    interrupts: sizeOrCode('/proc/interrupts'), timer_list: sizeOrCode('/proc/timer_list'), fsDir: (() => { try { return fs.readdirSync('/proc/fs').length; } catch (e) { return e.code; } })(),
    asound: (() => { try { return fs.readdirSync('/proc/asound').length; } catch (e) { return e.code; } })() };
try { fs.writeFileSync('/proc/sys/kernel/hostname', 'x'); out.procSysWrite = 'WROTE'; } catch (e) { out.procSysWrite = e.code; }
out.procMounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map((l) => l.split(' ')).filter((p) => (p[4] || '').startsWith('/proc/')).map((p) => p[4]);
out.keyctl = (() => { const r = cp.spawnSync('python3', ['-c', 'import ctypes;print(ctypes.CDLL(None,use_errno=True).syscall(250,0,0,0,0,0), ctypes.get_errno())'], { encoding: 'utf8', env: { PATH: '/usr/bin' } }); return r.error ? 'no-python3' : (r.stdout || '').trim(); })();
const finish = () => process.stdout.write('PROBE ' + JSON.stringify(out) + '\n');
if (out.role === 'endpoint') { fs.writeFileSync('/stream/probe.json', JSON.stringify(out)); setInterval(() => {}, 1000000); return; }
if (out.role !== 'workload') { finish(); return; }
const root = '/projects/p'; out.protected = {};
for (const rel of ['.env', '.data', 'x.secrets', 'sub/.env', 'sub/.data', '.roboteam', 'private-notes.txt', 'docs/hidden', 'README.md']) {
    const file = root + '/' + rel; const r = {};
    try { const s = fs.lstatSync(file); r.dir = s.isDirectory(); r.size = s.size; } catch (e) { r.stat = e.code; out.protected[rel] = r; continue; }
    if (r.dir) { try { r.entries = fs.readdirSync(file).length; } catch (e) { r.list = e.code; } try { fs.writeFileSync(file + '/new', 'x'); r.write = 'WROTE'; } catch (e) { r.write = e.code; } try { fs.rmdirSync(file); r.rmdir = 'REMOVED'; } catch (e) { r.rmdir = e.code; } }
    else { try { r.read = fs.readFileSync(file).length; } catch (e) { r.read = e.code; } if (rel === 'README.md') { out.protected[rel] = r; continue; } try { fs.appendFileSync(file, 'x'); r.write = 'WROTE'; } catch (e) { r.write = e.code; } try { fs.unlinkSync(file); r.unlink = 'REMOVED'; } catch (e) { r.unlink = e.code; } }
    try { fs.renameSync(file, file + '.moved'); r.rename = 'MOVED'; } catch (e) { r.rename = e.code; }
    out.protected[rel] = r;
}
try { fs.writeFileSync(root + '/created-by-workload.txt', 'ok'); out.projectWrite = 'ok'; } catch (e) { out.projectWrite = e.code; }
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
out.lateEnv = sizeOrCode(root + '/late/.env');
out.tmpShared = (() => { try { return fs.readdirSync('/tmp').length; } catch (e) { return e.code; } })();
const targets = JSON.parse(process.env.PROBE_TARGETS || '[]'); out.net = {}; let pending = targets.length;
const done = () => { pending -= 1; if (pending <= 0) finish(); };
if (pending === 0) finish();
for (const [name, host, port] of targets) {
    const socket = net.connect({ host, port, timeout: 2500 });
    socket.on('connect', () => { out.net[name] = 'connected'; socket.destroy(); done(); });
    socket.on('timeout', () => { out.net[name] = 'timeout'; socket.destroy(); done(); });
    socket.on('error', (e) => { out.net[name] = e.code; done(); });
}
})();
`;

// ---- setup -------------------------------------------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-smoke-'));
const project = path.join(root, 'project');
const home = path.join(root, 'home');
const runtimeRoot = path.join(root, 'runtime');
for (const dir of [project, home, runtimeRoot, path.join(project, 'sub', '.data'), path.join(project, '.data'), path.join(project, '.roboteam'), path.join(project, 'late')]) fs.mkdirSync(dir, { recursive: true });
for (const [file, text] of [['.env', 'SECRET=1'], ['x.secrets', 's'], ['sub/.env', 'SECRET=2'], ['README.md', 'hello'], ['.data/k', 'k'], ['sub/.data/k', 'k'], ['private-notes.txt', 'private'], ['docs/hidden/a.txt', 'h']]) { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), text); }

let supervisor;
let view;
const masksBefore = [];
let procMasks = [];
await step('preflight', async () => {
    evidence.versions = { node: process.version, bwrap: tool('bwrap', ['--version']), uid: process.getuid(), arch: process.arch, util: tool('unshare', ['--version']) };
    procMasks = readProcMasks();
    masksBefore.push(...procMasks.map((mask) => mask.path));
    evidence.workerProcMasks = { before: masksBefore };
    return { masks: masksBefore.length };
});

const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };
const resource = {};
let ledgerSeq = 0;
async function publish(kind, spec = null) {
    const locator = { ...deriveLocator(kind, newLocatorId(), layout), ...(kind === 'keeper' ? {} : { keeper: resource.keeper }) };
    const resourceId = crypto.randomBytes(16).toString('base64url');
    ledgerSeq += 1;
    const created = await supervisor.create({ kind, resourceId, marker: resourceId, locator, spec });
    if (kind === 'keeper') resource.keeper = resourceId;
    resource[kind] = { resourceId, locator, identity: created.identity };
    if (created.identity?.init) {
        // Evidence for the publication barrier: before the gate byte, bwrap's monitor carries the marker on its real argv and
        // the sandbox holds nothing but its init (no workload process exists yet).
        const id = created.identity;
        evidence.gateBeforeCommit ??= {};
        evidence.gateBeforeCommit[`${kind}:${spec?.role ?? ''}`] = {
            monitorCarriesMarker: view.process(id.pid)?.cmdline.includes(resourceId) === true,
            monitorCmdlineHead: view.process(id.pid)?.cmdline.slice(0, 6),
            sandboxMembers: view.listProcesses().filter((entry) => entry.pidNs === id.pidNs).map((entry) => entry.cmdline[0]),
            identity: { pidNsDiffersFromWorker: id.pidNs !== view.selfNamespaces().pidNs, stageMntNsDiffers: id.stageMntNs !== view.selfNamespaces().mntNs }
        };
    }
    if (created.gate && (await created.gate.commit()) !== true) throw new Error(`gate release failed for ${kind}`);
    return created;
}

const projectFd = fs.openSync(project, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const homeFd = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
view = createProcView({ runtimeRoot });
const launcher = createSandboxLauncher({
    view, procMasks,
    // diagnostics only: whatever the chain writes to stderr (bwrap errors) is shown
    spawnImpl: (file, args, options) => { const child = spawn(file, args, options); child.stdio[2]?.on?.('data', (chunk) => process.stderr.write(`[chain stderr] ${chunk}`)); return child; }
});
const image = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: SOURCE, dest: '/opt/robo-work' }], symlinks: [
    { target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }, { target: 'usr/sbin', dest: '/sbin' }] };
const nodeArgv = (role) => ['/usr/local/bin/node', '--import', `${CODE}/server/sandbox/fdTrim.mjs`, '-e', PROBE, role];
supervisor = createExecutionSupervisor({
    launcher, view, admission: { inventory: [{ name: 'sh' }], streamDirectory: '/stream' },
    roles: {
        orchestration: { ...image, env: { PROBE_ROLE: 'orchestration' }, argv: nodeArgv('role-orchestration') },
        endpoint: { ...image, env: { PROBE_ROLE: 'endpoint' }, argv: nodeArgv('role-endpoint') },
        workload: { ...image }
    },
    home: { path: home, fd: homeFd }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, access: 'write', fd: projectFd }],
    onInfrastructureLoss: (reason) => evidence.errors.push({ step: 'infrastructure', message: reason }), limits: { stopGraceMs: 1500 }
});

const probeOutput = (sandbox, key) => new Promise((resolve) => {
    let text = '';
    sandbox.stdio[1]?.on?.('data', (chunk) => { text += chunk; });
    sandbox.wait().then(() => setTimeout(() => {
        const line = text.split('\n').find((candidate) => candidate.startsWith('PROBE '));
        evidence.roles[key] = line ? JSON.parse(line.slice(6)) : { noProbeOutput: text.slice(0, 400) };
        resolve();
    }, 100));
});

await step('anchor', async () => { await publish('keeper'); });
await step('runtime-dir', async () => { await publish('runtime-dir'); });
await step('netns', async () => { const created = await publish('netns'); evidence.network = { ...created.identity }; });

const orchestrationDone = { promise: null };
await step('endpoint (probe)', async () => {
    const created = await publish('endpoint', { config: {} });
    evidence.endpointMonitor = created.identity;
});
await step('orchestration (probe)', async () => {
    const created = await publish('process-tree', { role: 'orchestration' });
    evidence.orchestrationMonitor = created.identity;
    orchestrationDone.promise = probeOutput(created.handle, 'orchestration');
    await orchestrationDone.promise;
});

// the endpoint's namespace facts from /proc while it lives
await step('endpoint facts', async () => {
    const ident = resource.endpoint.identity;
    const init = view.process(ident.init.pid);
    const self = view.selfNamespaces();
    evidence.roles.endpointNamespaces = init ? { pidNs: init.pidNs !== self.pidNs, mntNs: init.mntNs !== self.mntNs, netNs: init.netNs === resource.netns.identity.netNs, fdNs: init.fdNs.length } : 'gone';
    const status = init ? fs.readFileSync(`/proc/${ident.init.pid}/status`, 'utf8') : '';
    evidence.roles.endpointStatus = Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs', 'Seccomp'].map((key) => [key, (status.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [])[1]]));
    const probeFile = `${resource['runtime-dir'].locator.path}/stream/probe.json`;
    for (let attempt = 0; attempt < 40 && !fs.existsSync(probeFile); attempt += 1) await sleep(100);
    evidence.roles.endpoint = fs.existsSync(probeFile) ? JSON.parse(fs.readFileSync(probeFile, 'utf8')) : { noProbeFile: true };
    evidence.roles.endpointFds = init ? fs.readdirSync(`/proc/${ident.init.pid}/fd`).map((n) => { try { return `${n}->${fs.readlinkSync(`/proc/${ident.init.pid}/fd/${n}`)}`; } catch { return `${n}->?`; } }) : [];
});

// a TCP service in the worker, for the egress probe
const service = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => service.listen(0, '0.0.0.0', resolve));
const servicePort = service.address().port;
await step('workload (probe)', async () => {
    const streamDir = `${resource['runtime-dir'].locator.path}/stream`;
    const outputs = [];
    evidence.workloadOutputs = outputs;
    const servers = [];
    for (const name of ['stdoutaaaa', 'stderrbbbb']) {
        const server = net.createServer((socket) => { socket.on('data', (chunk) => outputs.push([name, String(chunk)])); });
        await new Promise((resolve) => server.listen(`${streamDir}/${name}`, resolve));
        servers.push(server);
    }
    const request = {
        processClass: 'run', executable: '/usr/local/bin/node', args: ['-e', PROBE, 'role-workload'],
        env: { PROBE_ROLE: 'workload', PROBE_TARGETS: JSON.stringify([['workerLoopbackViaGateway', supervisor.network.hostAddress, servicePort], ['publicDns', '1.1.1.1', 443]]) },
        home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], network: 'robot-egress',
        // M-17: provider exclusions are masked like protected names; one that does not exist is skipped and must not be created
        exclusions: ['/projects/p/private-notes.txt', '/projects/p/docs/hidden', '/projects/p/missing/ghost'],
        requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' }
    };
    let created;
    try {
        created = await publish('process-tree', { role: 'workload', process: 1, request, streams: { stdout: '/stream/stdoutaaaa', stderr: '/stream/stderrbbbb' } });
    } catch (error) {
        await sleep(300);
        throw error;
    }
    evidence.workloadMonitor = created.identity;
    // names that appear only after the start
    fs.mkdirSync(path.join(project, 'late'), { recursive: true });
    fs.writeFileSync(path.join(project, 'late', '.env'), 'LATE=1');
    const exit = await created.handle.wait();
    await sleep(200);
    const text = outputs.filter(([name]) => name === 'stdoutaaaa').map(([, chunk]) => chunk).join('');
    const line = text.split('\n').find((candidate) => candidate.startsWith('PROBE '));
    evidence.roles.workload = line ? JSON.parse(line.slice(6)) : { noProbeOutput: text.slice(0, 300), stderr: outputs.filter(([name]) => name === 'stderrbbbb').map(([, c]) => c).join('').slice(0, 600) };
    evidence.roles.workloadExit = exit;
    evidence.hostAfter = { env: fs.readFileSync(path.join(project, '.env'), 'utf8').length, readme: fs.readFileSync(path.join(project, 'README.md'), 'utf8'), hasCreated: fs.existsSync(path.join(project, 'created-by-workload.txt')), ghostCreated: fs.existsSync(path.join(project, 'missing')), privateNotes: fs.readFileSync(path.join(project, 'private-notes.txt'), 'utf8').length, hiddenFile: fs.existsSync(path.join(project, 'docs', 'hidden', 'a.txt')) };
    for (const server of servers) server.close();
});
service.close();

// ---- end in ledger order -----------------------------------------------------------------------------------------------
const endEvidence = {};
async function end(name, fn) { try { await fn(); endEvidence[name] = 'ok'; } catch (error) { endEvidence[name] = `FAILED ${error?.code ?? ''} ${error?.message ?? error} errno=${error?.errno ?? ''}`.slice(0, 200); evidence.errors.push({ step: `end ${name}`, message: endEvidence[name] }); } }
const diagnose = (error) => {
    const pid = /(\d+)\/fd/.exec(String(error?.message ?? ''))?.[1];
    if (!pid) return;
    const read = (file) => { try { return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8').replace(/\0/g, ' ').slice(0, 300); } catch (e) { return e.code; } };
    let owner = null; try { const st = fs.statSync(`/proc/${pid}`); owner = `${st.uid}:${st.gid}`; } catch (e) { owner = e.code; }
    evidence.unreadable = { pid, owner, cmdline: read('cmdline'), status: read('status').split('\n').filter((l) => /^(Name|State|PPid|Uid|NSpid|CapEff|Seccomp|NoNewPrivs)/.test(l)) };
};
await end('endProcessTrees', async () => { try { await supervisor.endProcessTrees(); } catch (error) { diagnose(error); throw error; } });
await end('endEndpoint', () => supervisor.endEndpoint());
await end('releaseEgress', () => supervisor.releaseEgress());
await end('releaseViews', () => supervisor.releaseViews());
const runtimePath = resource['runtime-dir']?.locator.path;
await end('removeRuntime', async () => supervisor.removeRuntime());
await end('exit', () => supervisor.exit());
evidence.end = endEvidence;
await step('verify cleanup', async () => {
    const ids = [resource.endpoint?.identity, resource['process-tree']?.identity].filter(Boolean);
    const processes = view.listProcesses();
    const names = resource.netns ? resource.netns.identity : null;
    evidence.cleanup = {
        runtimeDirGone: runtimePath ? !fs.existsSync(runtimePath) : null,
        projectStillThere: fs.existsSync(path.join(project, 'README.md')) && fs.existsSync(path.join(project, '.env')),
        processesWithSandboxNs: processes.filter((p) => ids.some((id) => p.pidNs === id.pidNs || p.mntNs === id.mntNs)).length,
        markerProcesses: processes.filter((p) => Object.values(resource).some((r) => r?.resourceId && p.cmdline.includes(r.resourceId))).length,
        netnsFile: names ? fs.existsSync(`/run/netns/${names.name}`) : null,
        links: names ? spawnSync('ip', ['-o', 'link', 'show'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(names.host)).length : null,
        nft: names ? spawnSync('nft', ['list', 'tables'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(names.table)).length : null
    };
    evidence.workerProcMasks.after = readProcMasks().map((mask) => mask.path);
    evidence.workerProcMasks.unchanged = JSON.stringify(masksBefore) === JSON.stringify(evidence.workerProcMasks.after);
});
fs.closeSync(projectFd);
fs.closeSync(homeFd);
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exit(evidence.errors.length === 0 ? 0 : 1);
