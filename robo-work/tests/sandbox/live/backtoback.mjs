// Live probe for B1 (namespace inode reuse) and B2 (a marker that begins with a dash). Run as container root in the nested-podman
// profile, like smoke.mjs. It starts sandboxes back to back and shows that ending one never touches another:
//   1. while the first is alive and pinned, the second has different pid and mount namespace inodes;
//   2. after the first is stopped and released (unpinned), a second one may be given the SAME inode numbers by the kernel
//      (reported as `inodeReused`), and a recovery walk of the FIRST sandbox's recorded blocker neither kills nor counts it;
//   3. the markers used all begin with '-'.
// Prints one JSON document; exit 0 when every check holds.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProcView } from '../../../server/execution/procView.mjs';
import { createWalker } from '../../../server/execution/recoveryWalk.mjs';
import { createRecoveryView } from '../../../server/sandbox/executionSupervisor.mjs';
import { createSandboxLauncher } from '../../../server/sandbox/sandboxLauncher.mjs';
import { readProcMasks } from '../../../server/sandbox/procMasks.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-b2b-'));
const runtimeDir = path.join(root, 'rt');
for (const dir of ['channels', 'ctl', 'stage', 'tmp']) fs.mkdirSync(path.join(runtimeDir, dir), { recursive: true });
const home = path.join(root, 'home');
fs.mkdirSync(home);
const homeFd = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
const view = createProcView({ runtimeRoot: path.join(root, 'runtime') });
const launcher = createSandboxLauncher({ view, procMasks: readProcMasks() });
const walker = createWalker({ view: createRecoveryView(view), clock: { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, releaseDeadlineMs: 4000, pollMs: 100, sandboxRecord: () => null });
const evidence = { checks: {}, cycles: [], errors: [] };
const check = (name, ok, extra = {}) => { evidence.checks[name] = { ok, ...extra }; if (!ok) evidence.errors.push(name); };

const marker = () => `-${crypto.randomBytes(15).toString('base64url')}`;
const launch = (label) => launcher.launch({
    role: 'workload', marker: marker(), runtimeDir, netMode: 'none', cwd: '/', argv: ['/usr/bin/sleep', '1000'], env: { PATH: '/usr/bin:/bin' },
    roBinds: [{ source: '/usr', dest: '/usr' }, { source: '/opt/robo-work', dest: '/opt/robo-work' }],
    symlinks: [{ target: 'usr/bin', dest: '/bin' }, { target: 'usr/lib', dest: '/lib' }, { target: 'usr/lib64', dest: '/lib64' }],
    home: { path: home, fd: homeFd }, grants: [], channelsDir: path.join(runtimeDir, 'channels'), stdio: ['ignore', 'ignore', 'ignore'],
    onIdentity: async () => {}, label
});
const blockerOf = (sandbox) => ({ kind: 'process-tree', identity: sandbox.identity, locator: { marker: sandbox.marker } });
const alive = (sandbox) => view.process(sandbox.identity.init.pid)?.startTime === sandbox.identity.init.startTime;

try {
    // 1. two live sandboxes: distinct inodes, both pinned
    const a = await launch('A');
    const b = await launch('B');
    check('markers begin with a dash', a.marker.startsWith('-') && b.marker.startsWith('-'), { a: a.marker, b: b.marker });
    check('live sandboxes have distinct pid and mount namespaces', a.identity.pidNs !== b.identity.pidNs && a.identity.mntNs !== b.identity.mntNs && a.identity.stageMntNs !== b.identity.stageMntNs,
        { a: a.identity.pidNs, b: b.identity.pidNs });
    check('both are pinned', view.isPinned('pid', a.identity.pidNs) && view.isPinned('pid', b.identity.pidNs));
    // stop A through the walker's own blocker (as recovery would) while B runs
    const verdictA = await a.stop({ graceMs: 200 });
    check('A is gone and B untouched after A stops', verdictA.absent === true && alive(b));
    check('walking A\'s blocker releases it and leaves B alone', (await walker.walk(blockerOf(a))) === 'released' && alive(b));
    check('A releases cleanly', (await a.release()).absent === true);

    // 2. back to back: stop one, start the next at once, then walk the stopped one's recorded blocker
    let reused = 0;
    for (let cycle = 0; cycle < 8; cycle += 1) {
        const x = await launch(`X${cycle}`);
        const recorded = { identity: structuredClone(x.identity), marker: x.marker };
        await x.stop({ graceMs: 100 });
        await x.release();
        const y = await launch(`Y${cycle}`);
        const sameInode = y.identity.pidNs === recorded.identity.pidNs;
        if (sameInode) reused += 1;
        const outcome = await walker.walk({ kind: 'process-tree', identity: recorded.identity, locator: { marker: recorded.marker } });
        const untouched = alive(y) && alive(b) && !y.exited;
        evidence.cycles.push({ cycle, inodeReused: sameInode, mountInodeReused: y.identity.stageMntNs === recorded.identity.stageMntNs, outcome, untouched });
        if (!untouched || outcome !== 'released') check(`cycle ${cycle}`, false, { sameInode, outcome });
        await y.stop({ graceMs: 100 });
        await y.release();
    }
    evidence.inodeReusedCycles = reused;
    check('every walk of a stopped sandbox left the next one alone', evidence.cycles.every((c) => c.untouched && c.outcome === 'released'));
    await b.stop({ graceMs: 200 });
    check('B ends cleanly', (await b.release()).absent === true);
    check('no sandbox process remains', view.listProcesses().every((p) => !p.cmdline.some((arg) => arg.startsWith('-') && arg.length === 21 && /^-[A-Za-z0-9_-]{20}$/.test(arg))));
} catch (error) {
    evidence.errors.push(`${error?.code ?? ''} ${error?.message ?? error}`);
}
fs.closeSync(homeFd);
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exit(evidence.errors.length === 0 ? 0 : 1);
