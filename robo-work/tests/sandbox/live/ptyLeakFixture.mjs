// M-65 fd-only fixture: real launchers, held role programs, explicit start/finish, then independently checked cleanup.
// Unlike smoke.mjs, role programs run no child commands and do not deliberately exit during measurement.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { createProcView } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionSupervisor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';
import { heldRoleArgv } from './ptyLeakMeasurement.mjs';

const source = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const send = (message) => fs.writeFileSync(1, `${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const input = readline.createInterface({ input: process.stdin });
const commands = new Set();
let aborted = false;
input.on('line', (line) => {
    if (line === 'start' || line === 'finish') commands.add(line);
    else aborted = true;
});
input.on('close', () => { aborted = true; });
async function waitFor(label, predicate, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
        if (aborted) throw new Error(`controller disconnected or aborted during ${label}`);
        if (Date.now() >= until) throw new Error(`${label} deadline`);
        await sleep(5);
    }
}

const evidence = { type: 'result', errors: [], cleanup: {} };
let root;
let supervisor;
let view;
let homeFd;
const resources = [];
const servers = [];
const sockets = new Set();
const snapshots = {};
let readinessState = () => ({});
try {
    await waitFor('start', () => commands.has('start'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-pty-fd-'));
    const runtimeRoot = path.join(root, 'runtime');
    const home = path.join(root, 'home');
    fs.mkdirSync(runtimeRoot); fs.mkdirSync(home);
    homeFd = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    view = createProcView({ runtimeRoot });
    const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });
    const image = {
        roBinds: [{ source: '/usr', dest: '/usr' }, { source, dest: '/opt/robo-work' }],
        symlinks: ['bin', 'lib', 'lib64', 'sbin'].map((name) => ({ target: `usr/${name}`, dest: `/${name}` })),
    };
    const argv = heldRoleArgv;
    supervisor = createExecutionSupervisor({
        launcher, view, admission: { inventory: [{ name: 'sh' }], streamDirectory: '/stream' },
        roles: { orchestration: { ...image, argv: argv('orchestration') }, endpoint: { ...image, argv: argv('endpoint') }, workload: image },
        home: { path: home, fd: homeFd }, grants: [], limits: { stopGraceMs: 1500 },
        onInfrastructureLoss: (reason) => evidence.errors.push(`infrastructure: ${reason}`),
    });
    const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };
    let keeper;
    async function publish(kind, spec) {
        if (aborted) throw new Error('controller aborted');
        const locator = { ...deriveLocator(kind, newLocatorId(), layout), ...(kind === 'keeper' ? {} : { keeper }) };
        const marker = crypto.randomBytes(16).toString('base64url');
        const created = await supervisor.create({ kind, resourceId: marker, marker, locator, spec });
        if (kind === 'keeper') keeper = marker;
        resources.push({ kind, marker, locator, identity: created.identity });
        if (created.gate && await created.gate.commit() !== true) throw new Error(`gate commit failed: ${kind}`);
        return created;
    }
    await publish('keeper');
    const runtime = await publish('runtime-dir');
    await publish('netns');
    const endpoint = await publish('endpoint', { config: {} });
    const orchestration = await publish('process-tree', { role: 'orchestration' });
    let orchestrationText = '';
    orchestration.handle.stdio[1].on('data', (chunk) => { orchestrationText += chunk; });
    // Buffered pipe output remains readable even when the held program wrote before this listener was attached.
    const outputs = [];
    const errors = [];
    for (const name of ['stdoutaaaa', 'stderrbbbb']) {
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('data', (chunk) => { (name === 'stdoutaaaa' ? outputs : errors).push(String(chunk)); });
        });
        await new Promise((resolve) => server.listen(path.join(runtime.identity.path, 'stream', name), resolve));
        servers.push(server);
    }
    const workload = await publish('process-tree', { role: 'workload', process: 1,
        request: { processClass: 'run', executable: argv('workload')[0], args: argv('workload').slice(1), env: {},
            home: '/home/robot', cwd: '/home/robot', folders: [], network: 'robot-egress',
            requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } },
        streams: { stdout: '/stream/stdoutaaaa', stderr: '/stream/stderrbbbb' },
    });
    const endpointFile = path.join(runtime.identity.path, 'stream', 'fd-ready.json');
    readinessState = () => ({ endpointSnapshot: fs.existsSync(endpointFile), orchestrationBytes: orchestrationText.length,
        workloadBytes: outputs.join('').length, workloadStderr: errors.join('').slice(-1000),
        exited: { endpoint: endpoint.handle.exited, orchestration: orchestration.handle.exited, workload: workload.handle.exited } });
    await waitFor('all role snapshots', () => {
        if ([endpoint, orchestration, workload].some(({ handle }) => handle.exited)) throw new Error('held role exited before its snapshot');
        return fs.existsSync(endpointFile) && orchestrationText.includes('\n') && outputs.join('').includes('\n');
    });
    snapshots.endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
    snapshots.orchestration = JSON.parse(orchestrationText.split('\n')[0]);
    snapshots.workload = JSON.parse(outputs.join('').split('\n')[0]);
    const held = [];
    const processes = view.listProcesses();
    for (const [role, created] of Object.entries({ endpoint, orchestration, workload })) {
        const members = processes.filter((entry) => entry.pidNs === created.identity.pidNs);
        if (!members.some((entry) => entry.cmdline.includes(`role-${role}`))) throw new Error(`missing held ${role}`);
        for (const member of members) held.push({ role, pid: member.pid, startTime: member.startTime });
        held.push({ role: 'bwrap', pid: created.identity.pid, startTime: created.identity.startTime });
    }
    send({ type: 'ready', held, snapshots, markers: resources.map((entry) => entry.marker) });
    await waitFor('finish acknowledgment', () => commands.has('finish'));
    evidence.measurementAcknowledged = true;
} catch (error) {
    evidence.errors.push(String(error.message).slice(0, 500));
    evidence.readiness = readinessState();
} finally {
    // This point is reached after a controller finish/abort/disconnect or a failed/deadlined setup, never after ready alone.
    if (supervisor) {
        for (const name of ['endProcessTrees', 'endEndpoint', 'releaseEgress', 'releaseViews', 'removeRuntime', 'exit']) {
            try { await supervisor[name](); evidence.cleanup[name] = true; }
            catch (error) { evidence.cleanup[name] = false; evidence.errors.push(`cleanup ${name}: ${error.code ?? error.message}`); }
        }
        try {
            const processes = view.listProcesses();
            evidence.cleanup.markersAbsent = !processes.some((entry) => resources.some(({ marker }) => entry.cmdline.includes(marker)));
            evidence.cleanup.namespacesAbsent = !processes.some((entry) => resources.some(({ identity }) => identity?.pidNs && entry.pidNs === identity.pidNs));
            const runtime = resources.find(({ kind }) => kind === 'runtime-dir');
            evidence.cleanup.runtimeAbsent = !runtime || !fs.existsSync(runtime.identity.path);
        } catch (error) { evidence.errors.push(`cleanup verify: ${error.code ?? error.message}`); }
    }
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    if (homeFd !== undefined) fs.closeSync(homeFd);
    if (root && Object.values(evidence.cleanup).every((ok) => ok === true) && evidence.errors.length === 0) fs.rmSync(root, { recursive: true, force: true });
    else if (root) evidence.retainedFixture = root;
    globalThis.__ptyleakA?.kill();
    input.close();
}
evidence.ok = evidence.measurementAcknowledged === true && evidence.errors.length === 0 && Object.values(evidence.cleanup).every((ok) => ok === true);
send(evidence);
process.exitCode = evidence.ok ? 0 : 1;
