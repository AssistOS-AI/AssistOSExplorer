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
out.keyctl = (() => { const nr = process.arch === 'arm64' ? 219 : 250; const r = cp.spawnSync('perl', ['-e', 'my $r = syscall(' + nr + ', 0, 0, 0, 0, 0); print "$r ", $!+0'], { encoding: 'utf8', env: { PATH: '/usr/bin:/usr/sbin' } }); return r.error ? 'no-perl' : (r.stdout || '').trim(); })(); // keyctl(2): expect "-1 1" (EPERM)
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
const view = '/run/robo-work/skills';
out.skills = { names: (() => { try { return fs.readdirSync(view).sort(); } catch (e) { return e.code; } })(),
    writeRoot: (() => { try { fs.writeFileSync(view + '/x', 'x'); return 'WROTE'; } catch (e) { return e.code; } })(),
    mkdirRoot: (() => { try { fs.mkdirSync(view + '/y'); return 'MADE'; } catch (e) { return e.code; } })(),
    writeInside: (() => { try { fs.writeFileSync(view + '/alpha/x', 'x'); return 'WROTE'; } catch (e) { return e.code; } })(),
    unlinkInside: (() => { try { fs.unlinkSync(view + '/alpha/SKILL.md'); return 'REMOVED'; } catch (e) { return e.code; } })(),
    skillMd: sizeOrCode(view + '/alpha/SKILL.md'), plantedEnv: sizeOrCode(view + '/alpha/.env'), ignored: sizeOrCode(view + '/alpha/ignored.txt'), unselected: sizeOrCode(view + '/unselected/SKILL.md') };
// M-69 Q2: nothing can be created or renamed outside the binds (the root and /run/robo-work are read-only); the binds still work.
const attempt = (fn) => { try { fn(); return 'DONE'; } catch (e) { return e.code; } };
out.readOnlyRoot = { touchRunRoboWork: attempt(() => fs.writeFileSync('/run/robo-work/x', 'x')), mvRunRoboWork: attempt(() => fs.renameSync('/run/robo-work', '/run/moved')),
    touchRun: attempt(() => fs.writeFileSync('/run/x', 'x')), touchRoot: attempt(() => fs.writeFileSync('/x', 'x')), mkdirRoot: attempt(() => fs.mkdirSync('/newdir')),
    tmp: attempt(() => fs.writeFileSync('/tmp/rw-probe', 'x')), home: attempt(() => fs.writeFileSync('/home/robot/rw-probe', 'x')),
    channels: (() => { try { return fs.readdirSync('/run/robo-work/channels').length >= 0 ? 'DONE' : 'x'; } catch (e) { return e.code; } })() };
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
out.lateEnv = sizeOrCode(root + '/late/.env');
out.tmpShared = (() => { try { return fs.readdirSync('/tmp').length; } catch (e) { return e.code; } })();
const targets = JSON.parse(process.env.PROBE_TARGETS || '[]'); out.net = {};
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return e.code; } };
out.etc = { resolv: readText('/etc/resolv.conf'), hosts: readText('/etc/hosts') };
const dnsHost = process.env.PROBE_DNS_HOST || 'opencode.ai';
const gt = cp.spawnSync('/usr/bin/getent', ['ahostsv4', dnsHost], { encoding: 'utf8' });
out.getent = gt.error ? 'no-getent' : ((gt.stdout || gt.stderr || '').trim().split('\n')[0] || 'empty').slice(0, 80);
const runTargets = () => {
    let pending = targets.length;
    const done = () => { pending -= 1; if (pending <= 0) finish(); };
    if (pending === 0) finish();
    for (const [name, host, port] of targets) {
        const socket = net.connect({ host: host === '$DNS' ? dnsHost : host, port, timeout: 2500 });
        socket.on('connect', () => { out.net[name] = 'connected'; socket.destroy(); done(); });
        socket.on('timeout', () => { out.net[name] = 'timeout'; socket.destroy(); done(); });
        socket.on('error', (e) => { out.net[name] = e.code; done(); });
    }
};
require('dns').lookup(dnsHost, { all: true }, (error, addresses) => {
    out.dns = error ? { host: dnsHost, error: error.code } : { host: dnsHost, addresses: addresses.map((a) => a.address + '/v' + a.family) };
    runTargets();
});
})();
`;

// ---- setup -------------------------------------------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-smoke-'));
const project = path.join(root, 'project');
const home = path.join(root, 'home');
const runtimeRoot = path.join(root, 'runtime');
for (const dir of [project, home, runtimeRoot, path.join(project, 'sub', '.data'), path.join(project, '.data'), path.join(project, '.roboteam'), path.join(project, 'late')]) fs.mkdirSync(dir, { recursive: true });
for (const [file, text] of [['.env', 'SECRET=1'], ['x.secrets', 's'], ['sub/.env', 'SECRET=2'], ['README.md', 'hello'], ['.data/k', 'k'], ['sub/.data/k', 'k'], ['private-notes.txt', 'private'], ['docs/hidden/a.txt', 'h']]) { fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true }); fs.writeFileSync(path.join(project, file), text); }
// S2 (T2 skills view): two admitted skills (one with a planted .env) and an unselected sibling that must not appear in the view.
const skillsRoot = path.join(root, 'skills');
for (const [name, files] of [['alpha', { 'SKILL.md': '---\nname: alpha\n---\nmarker-alpha', '.env': 'SKILL_SECRET=1', 'ignored.txt': 'IGNORED' }], ['beta', { 'SKILL.md': '---\nname: beta\n---\n' }], ['unselected', { 'SKILL.md': 'no' }]]) {
    fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(skillsRoot, name, file), text);
}

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
const skillFds = Object.fromEntries(['alpha', 'beta'].map((name) => [name, fs.openSync(path.join(skillsRoot, name), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)]));
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
    // `exclusions`: a specification ignore path inside the skill folder (M-22 / M-70), masked in the view like a grant exclusion.
    skills: [{ name: 'alpha', stageName: 's0', path: path.join(skillsRoot, 'alpha'), fd: skillFds.alpha, exclusions: ['ignored.txt'] }, { name: 'beta', stageName: 's1', path: path.join(skillsRoot, 'beta'), fd: skillFds.beta }],
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

// AC13 / M-13 negatives need things to fail to reach: the worker's own address, the Router, and a service of ANOTHER execution.
const tcp = (host, port, timeoutMs = 2000) => new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('timeout', () => { socket.destroy(); resolve('timeout'); });
    socket.on('error', (error) => resolve(error.code));
});
const workerAddress = Object.entries(os.networkInterfaces()).filter(([name]) => !/^(lo|rw)/.test(name)).flatMap(([, list]) => list).find((entry) => entry.family === 'IPv4' && !entry.internal)?.address ?? null;
const defaultGateway = /default via (\S+)/.exec(spawnSync('ip', ['-4', 'route', 'show', 'default'], { encoding: 'utf8' }).stdout)?.[1] ?? null;
const routerHost = process.env.PLOINKY_ROUTER_HOST || 'host.containers.internal';
const routerAddress = await new Promise((resolve) => import('node:dns').then((dns) => dns.lookup(routerHost, { family: 4 }, (error, address) => resolve(error ? null : address))));
const otherExecution = { port: 41000 + Math.floor(Math.random() * 2000), network: null, listener: null, peer: null };
await step('other execution (listener)', async () => {
    const { createExecutionNetwork } = await import('../../../server/sandbox/executionNetwork.mjs');
    otherExecution.network = createExecutionNetwork({ reservationId: crypto.randomBytes(16).toString('hex') });
    await otherExecution.network.setup();
    otherExecution.peer = otherExecution.network.peerAddress;
    // a service on all addresses of the OTHER execution's namespace (reachable by address if the firewall let it through)
    otherExecution.listener = spawn('nsenter', [`--net=${otherExecution.network.nsPath}`, '--', process.execPath, '-e',
        "require('net').createServer((s) => s.destroy()).listen(Number(process.argv[1]), '0.0.0.0')", String(otherExecution.port)], { stdio: 'ignore' });
    await sleep(700);
});
const controls = {
    ownListenerViaWorkerAddress: workerAddress ? await tcp(workerAddress, servicePort) : 'no-address',
    // from inside the other execution's own namespace (the worker itself cannot connect to an execution: the input chain drops the replies)
    otherExecutionServiceInsideItsNamespace: otherExecution.network ? spawnSync('nsenter', [`--net=${otherExecution.network.nsPath}`, '--', process.execPath, '-e',
        "const s = require('net').connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 1500 }); s.on('connect', () => { console.log('connected'); process.exit(0); }); s.on('error', (e) => { console.log(e.code); process.exit(0); }); s.on('timeout', () => { console.log('timeout'); process.exit(0); });",
        otherExecution.peer, String(otherExecution.port)], { encoding: 'utf8' }).stdout.trim() : 'no-listener',
    coordinator7000FromWorker: workerAddress ? await tcp(workerAddress, 7000) : 'no-address',
    provider7300FromWorkerLoopback: await tcp('127.0.0.1', 7300),
    routerFromWorker8080: routerAddress ? await tcp(routerAddress, 8080) : 'unresolved',
    routerFromWorker8081: routerAddress ? await tcp(routerAddress, 8081) : 'unresolved'
};
evidence.ac13 = { workerAddress, defaultGateway, routerAddress, otherExecution: { port: otherExecution.port, peer: otherExecution.peer }, controls };
const probeTargets = [
    ['publicHttps', '$DNS', 443], ['publicIp', '1.1.1.1', 443],
    ['workerOwnListenerViaGateway', supervisor.network.hostAddress, servicePort], ['workerOwnListenerViaWorkerAddress', workerAddress, servicePort],
    ['coordinator7000ViaWorkerAddress', workerAddress, 7000], ['provider7300ViaWorkerAddress', workerAddress, 7300],
    ['coordinator7000ViaGateway', supervisor.network.hostAddress, 7000], ['provider7300ViaGateway', supervisor.network.hostAddress, 7300],
    ['router8080', routerAddress, 8080], ['router8081', routerAddress, 8081], ['defaultGateway8081', defaultGateway, 8081],
    ['otherExecutionLoopback', '127.0.0.1', otherExecution.port], ['otherExecutionPeer', otherExecution.peer, otherExecution.port]
].filter(([, host]) => host !== null && host !== undefined);
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
        env: { PROBE_ROLE: 'workload', PROBE_TARGETS: JSON.stringify(probeTargets) },
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
await step('skills view verdict (S2)', async () => {
    const k = evidence.roles.workload?.skills ?? {};
    const problems = [];
    if (JSON.stringify(k.names) !== JSON.stringify(['alpha', 'beta'])) problems.push(`names ${JSON.stringify(k.names)}`);
    for (const key of ['writeRoot', 'mkdirRoot', 'writeInside', 'unlinkInside']) if (k[key] !== 'EROFS') problems.push(`${key}=${k[key]}`);
    if (!(k.skillMd > 0)) problems.push(`SKILL.md=${k.skillMd}`);
    if (k.plantedEnv !== 0) problems.push(`.env=${k.plantedEnv}`);
    if (k.ignored !== 0) problems.push(`ignored exclusion=${k.ignored}`);
    const r = evidence.roles.workload?.readOnlyRoot ?? {};
    for (const key of ['touchRunRoboWork', 'touchRun', 'touchRoot', 'mkdirRoot']) if (r[key] !== 'EROFS') problems.push(`${key}=${r[key]}`);
    if (!['EROFS', 'EBUSY'].includes(r.mvRunRoboWork)) problems.push(`mvRunRoboWork=${r.mvRunRoboWork}`);
    for (const key of ['tmp', 'home', 'channels']) if (r[key] !== 'DONE') problems.push(`${key}=${r[key]}`);
    if (k.unselected !== 'ENOENT') problems.push(`unselected=${k.unselected}`);
    if (fs.readFileSync(path.join(skillsRoot, 'alpha', '.env'), 'utf8') !== 'SKILL_SECRET=1') problems.push('the host .env changed');
    if (problems.length > 0) throw new Error(`skills view: ${problems.join(', ')}`);
    return k;
});
await step('ac13 verdict', async () => {
    const w = evidence.roles.workload ?? {};
    const reached = w.net ?? {};
    const negatives = ['workerOwnListenerViaGateway', 'workerOwnListenerViaWorkerAddress', 'coordinator7000ViaWorkerAddress', 'provider7300ViaWorkerAddress', 'coordinator7000ViaGateway',
        'provider7300ViaGateway', 'router8080', 'router8081', 'defaultGateway8081', 'otherExecutionLoopback', 'otherExecutionPeer'];
    const violated = negatives.filter((name) => reached[name] === 'connected');
    // a negative proves nothing when the same target was not reachable from the worker itself: say which controls held
    const meaningful = { otherExecutionPeer: controls.otherExecutionServiceInsideItsNamespace === 'connected', otherExecutionLoopback: controls.otherExecutionServiceInsideItsNamespace === 'connected', workerOwnListenerViaWorkerAddress: controls.ownListenerViaWorkerAddress === 'connected',
        coordinator7000ViaWorkerAddress: controls.coordinator7000FromWorker === 'connected', provider7300ViaWorkerAddress: controls.provider7300FromWorkerLoopback === 'connected',
        router8080: controls.routerFromWorker8080 === 'connected', router8081: controls.routerFromWorker8081 === 'connected' };
    const offline = process.env.SMOKE_OFFLINE === '1';
    const dnsOk = Array.isArray(w.dns?.addresses) && w.dns.addresses.length > 0;
    const httpsOk = reached.publicHttps === 'connected';
    evidence.ac13.result = { negativesReached: violated, negativesMeaningful: meaningful, dns: w.dns ?? null, getent: w.getent ?? null, publicHttps: reached.publicHttps ?? null, publicIp: reached.publicIp ?? null, etc: w.etc ?? null, all: reached };
    if (violated.length > 0) throw new Error(`reachable from the workload: ${violated.join(', ')}`);
    if (!offline && (!dnsOk || !httpsOk)) throw new Error(`no DNS or public HTTPS from the workload: dns=${JSON.stringify(w.dns)} https=${reached.publicHttps}`);
    // keyctl(2) must be EPERM in every role
    evidence.keyctl = { orchestration: evidence.roles.orchestration?.keyctl, endpoint: evidence.roles.endpoint?.keyctl, workload: w.keyctl };
    const bad = Object.entries(evidence.keyctl).filter(([, value]) => value !== '-1 1' && value !== 'no-perl');
    if (bad.length > 0) throw new Error(`keyctl not EPERM: ${JSON.stringify(bad)}`);
});
otherExecution.listener?.kill('SIGKILL');
await step('other execution (release)', async () => {
    if (!otherExecution.network) return;
    await otherExecution.network.release();
    const verdict = await otherExecution.network.verifyAbsent();
    if (!verdict.absent) throw new Error(`other execution network remains: ${verdict.problems.join(',')}`);
});

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
