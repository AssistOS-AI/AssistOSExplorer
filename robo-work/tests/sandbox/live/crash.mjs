// Live crash probe (plan Revision 10, AC12): builds an execution (anchor, runtime dir, network, endpoint, orchestration, a long
// workload), then SIGKILLs ITS OWN process. Run it under a shell that lists what survives (see crash.sh in the evidence):
//   podman run ... --entrypoint sh <image> -c 'node /opt/robo-work/tests/sandbox/live/crash.mjs; sleep 1; <list processes>'
// It prints "CRASHING" and the monitor pids on stdout just before the kill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createProcView } from '../../../server/execution/procView.mjs';
import { deriveLocator, newLocatorId } from '../../../server/execution/resourceLocators.mjs';
import { createExecutionSupervisor } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

// The robo-work tree on this machine (bound read-only at /opt/robo-work inside the sandboxes).
const SOURCE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-crash-'));
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, '.env'), 'x');
const runtimeRoot = path.join(root, 'runtime');
fs.mkdirSync(runtimeRoot);
const fdOf = (dir) => fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const view = createProcView({ runtimeRoot });
const image = { roBinds: [{ source: '/usr', dest: '/usr' }, { source: SOURCE, dest: '/opt/robo-work' }], symlinks: [
    { target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }] };
const idle = ['/usr/local/bin/node', '--import', '/opt/robo-work/server/sandbox/fdTrim.mjs', '-e', 'setInterval(() => {}, 1e6)'];
const supervisor = createExecutionSupervisor({
    launcher: createSandboxLauncher({ view, procMasks: readProcMasks() }), view, admission: { inventory: [{ name: 'sleep' }], streamDirectory: '/stream' },
    roles: { orchestration: { ...image, argv: idle }, endpoint: { ...image, argv: idle }, workload: { ...image } },
    home: { path: project, fd: fdOf(project) }, grants: [{ name: 'p', path: '/projects/p', hostPath: project, access: 'write', fd: fdOf(project) }]
});
const layout = { runtimeDir: runtimeRoot, cgroupSubtree: null };
const marks = {};
async function publish(kind, spec = null) {
    const locator = deriveLocator(kind, newLocatorId(), layout);
    const id = crypto.randomBytes(16).toString('base64url');
    const created = await supervisor.create({ kind, resourceId: id, marker: id, locator, spec });
    await created.gate?.commit();
    marks[kind + (spec?.role ? `:${spec.role}` : '')] = created.identity.pid ?? created.identity.name ?? null;
    if (kind === 'netns') marks.netnsLocatorId = locator.netns;
    return created;
}
await publish('keeper');
await publish('runtime-dir');
await publish('netns');
await publish('endpoint', { config: {} });
await publish('process-tree', { role: 'orchestration' });
const request = { processClass: 'run', executable: '/usr/bin/sleep', args: ['1000'], env: {}, home: '/home/robot', cwd: '/projects/p', folders: [{ path: '/projects/p', access: 'write' }], exclusions: [], network: 'none', requirements: { privateProc: true }, communication: { kind: 'stdio', stdin: 'ignore' } };
await publish('process-tree', { role: 'workload', process: 1, request, streams: {} });
await new Promise((resolve) => setTimeout(resolve, 800));
process.stdout.write(`CRASHING ${JSON.stringify(marks)} netns=${supervisor.network.name}\n`);
process.kill(process.pid, 'SIGKILL');
