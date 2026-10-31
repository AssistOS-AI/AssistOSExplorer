// Child process of prepFdLeak.test.mjs (M-65). It is started with a PTY master at a descriptor WITHOUT close-on-exec (as
// node-pty leaves one in the worker) and runs the REAL sandbox launcher with the real child_process.spawn. Only the tools
// are shims (setpriv, nsenter and unshare exec the rest of their command line; setpriv also lists its own descriptors), and
// the stage script is a copy whose bwrap and node prep are stubs. Prints one JSON line: the precondition and the outcome.
//
//   node fdLeakDriver.mjs '<json { role, dir, stage, shims, leakFd, variant }>'
import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';
import { createFakeView } from './fakes.mjs';

const { role, dir, stage, shims, leakFd, variant = null } = JSON.parse(process.argv[2]);

// Precondition: the leaked descriptor is a PTY master and is NOT close-on-exec in this process.
const leakTarget = (() => { try { return fs.readlinkSync(`/proc/self/fd/${leakFd}`); } catch { return null; } })();
const leakFlags = (() => { try { return /^flags:\s*([0-7]+)/mu.exec(fs.readFileSync(`/proc/self/fdinfo/${leakFd}`, 'utf8'))?.[1] ?? null; } catch { return null; } })();
const leakCloexec = leakFlags === null ? null : (parseInt(leakFlags, 8) & 0o2000000) !== 0;

const MASKS = readProcMasks({ readFile: () => fs.readFileSync(new URL('../fixtures/podman-nested-mountinfo.txt', import.meta.url), 'utf8') });
const toolPath = `${shims}:/usr/local/bin:/usr/bin:/bin`;
const tool = (name) => `${shims}/${name}`;
const launcher = createSandboxLauncher({
    view: createFakeView(), spawnImpl: spawn, procMasks: MASKS, stageScript: stage, toolPath,
    tools: { setpriv: tool('setpriv'), unshare: tool('unshare'), nsenter: tool('nsenter'), mount: '/bin/true', umount: '/bin/true', node: process.execPath },
    fsImpl: { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) }
});

const runtimeDir = fs.mkdtempSync(`${dir}/rt-`);
const dirFd = fs.openSync(runtimeDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const common = { marker: 'rw-FdLeakMarker0123456789', runtimeDir, roBinds: [{ source: '/usr', dest: '/usr' }], cwd: '/', prepTimeoutMs: 20000 };
const specs = {
    workload: { ...common, role: 'workload', netMode: 'none', env: { HOME: '/home/robot' }, argv: ['/usr/bin/true'], home: { path: runtimeDir, fd: dirFd },
        grants: [{ name: 'a', path: runtimeDir, fd: dirFd, mode: 'rw' }], channelsDir: `${runtimeDir}/channels`, tmpDir: `${runtimeDir}/tmp`, stdio: ['ignore', 'pipe', 'pipe'] },
    terminal: { ...common, role: 'terminal', netMode: 'none', env: { HOME: '/home/robot' }, argv: ['/bin/sh'], home: { path: runtimeDir, fd: dirFd },
        grants: [], channelsDir: `${runtimeDir}/channels`, tmpDir: `${runtimeDir}/tmp`, stdio: ['pipe', 'pipe', 'pipe'] },
    orchestration: { ...common, role: 'orchestration', env: {}, argv: [process.execPath, '--import', '/opt/fdTrim.mjs', '/opt/ala.mjs'],
        anchored: [{ name: 'session', path: runtimeDir, fd: dirFd, dest: '/session', mode: 'rw' }], stdio: ['pipe', 'pipe', 'pipe'], roleFds: variant === 'noRoleFd' ? {} : { 3: 'pipe' } },
    endpoint: { ...common, role: 'endpoint', netns: '/run/netns/rw0123456789abcdef', env: {}, argv: [process.execPath, '--import', '/opt/fdTrim.mjs', '/opt/main.mjs'],
        stdio: ['ignore', 'ignore', 'ignore'], roleFds: { 3: 'pipe', 4: 'pipe' } }
};

let outcome;
try {
    const sandbox = await launcher.launch(specs[role]);
    outcome = { launched: true };
    try { await sandbox.stop({ graceMs: 10 }); } catch { /* stub chain */ }
} catch (error) {
    outcome = { launched: false, code: error?.code ?? null };
}
fs.closeSync(dirFd);
process.stdout.write(`${JSON.stringify({ leakTarget, leakCloexec, outcome })}\n`);
process.exit(0);
