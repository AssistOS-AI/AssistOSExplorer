// A fake /proc tree for the procView tests. Never G1 evidence: nothing here creates a namespace, a pty or a mount.
// It is a directory tree with the files procView reads: <pid>/stat, cmdline, ns/{pid,net,mnt} links, fd/<n> links
// (namespace links as dangling `net:[N]` text; everything else /dev/null), <pid>/mountinfo, and self/.
// Fake pids start at 200000 and the view is built with a recording `signal`, so no real process is ever signalled.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SELF_PID_NS = '4026531836';
export const SELF_NET_NS = '4026531840';
export const SELF_MNT_NS = '4026531841';
const SELF_MOUNTINFO = '22 1 0:21 / / rw,relatime - apfs /dev/root rw\n';

let worldCounter = 0;

export function createFakeWorld(t) {
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwk-'));
    // after hooks run in registration order, so the steps that must precede removal (ending fake sandbox processes) are queued
    // here and run first.
    const beforeRemove = [];
    t.after(async () => {
        for (const step of beforeRemove.splice(0)) { try { await step(); } catch { /* best effort */ } }
        if (path.basename(base).startsWith('rwk-') && path.dirname(base) === fs.realpathSync(os.tmpdir())) fs.rmSync(base, { recursive: true, force: true });
    });
    worldCounter += 1;
    const world = {
        base,
        beforeRemove,
        procRoot: path.join(base, 'proc'),
        runtimeRoot: path.join(base, 'rt'),
        cgroupSubtree: path.join(base, 'cg'),
        devpts: path.join(base, 'pts'),
        grants: path.join(base, 'g'),
        signals: [],
        // pids that ignore SIGKILL and stay in /proc (a stuck task), and pids kept when their sandbox exits
        stubborn: new Set(),
        keepOnSandboxExit: new Set(),
        nextPid: 200000 + worldCounter * 1000,
        nextInode: 4026600000 + worldCounter * 10000,
        nextStart: 900000 + worldCounter * 1000
    };
    for (const dir of [world.procRoot, world.runtimeRoot, world.cgroupSubtree, world.devpts, world.grants, path.join(world.runtimeRoot, 'x')]) fs.mkdirSync(dir, { recursive: true });
    world.statfs = (target) => ({ type: target === world.cgroupSubtree ? 0x63677270 : 0 });
    world.newPid = () => world.nextPid++;
    world.newInode = () => String(world.nextInode++);
    world.newStartTime = () => String(world.nextStart++);

    // self: the supervisor as the view sees it.
    const selfDir = path.join(world.procRoot, 'self');
    fs.mkdirSync(path.join(selfDir, 'ns'), { recursive: true });
    fs.symlinkSync(`pid:[${SELF_PID_NS}]`, path.join(selfDir, 'ns', 'pid'));
    fs.symlinkSync(`net:[${SELF_NET_NS}]`, path.join(selfDir, 'ns', 'net'));
    fs.symlinkSync(`mnt:[${SELF_MNT_NS}]`, path.join(selfDir, 'ns', 'mnt'));
    fs.writeFileSync(path.join(selfDir, 'mountinfo'), SELF_MOUNTINFO);

    const procDir = (pid) => path.join(world.procRoot, String(pid));
    world.exists = (pid) => fs.existsSync(procDir(pid));
    world.writeProcess = ({ pid, ppid, startTime, cmdline, pidNs = SELF_PID_NS, netNs = SELF_NET_NS, mntNs = SELF_MNT_NS, comm = 'fake', mountinfo = null }) => {
        const dir = procDir(pid);
        fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
        const fields = ['S', ppid, pid, pid, 0, -1, 4194304, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, startTime, 0, 0];
        fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`);
        fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.length === 0 ? '' : `${cmdline.join('\0')}\0`);
        for (const [type, inode] of [['pid', pidNs], ['net', netNs], ['mnt', mntNs]]) {
            const link = path.join(dir, 'ns', type);
            fs.rmSync(link, { force: true });
            fs.symlinkSync(`${type}:[${inode}]`, link);
        }
        for (const fd of [0, 1, 2]) world.addFd(pid, fd, '/dev/null');
        if (mountinfo !== null) fs.writeFileSync(path.join(dir, 'mountinfo'), mountinfo);
        return { pid, ppid, startTime, pidNs, netNs, mntNs };
    };
    world.removeProcess = (pid) => fs.rmSync(procDir(pid), { recursive: true, force: true });
    world.addFd = (pid, fd, target) => {
        const link = path.join(procDir(pid), 'fd', String(fd));
        fs.rmSync(link, { force: true });
        fs.symlinkSync(target, link);
        return fd;
    };
    world.nextFd = (pid) => {
        const used = new Set(fs.readdirSync(path.join(procDir(pid), 'fd')).map(Number));
        let fd = 10;
        while (used.has(fd)) fd += 1;
        return fd;
    };
    world.removeFd = (pid, fd) => fs.rmSync(path.join(procDir(pid), 'fd', String(fd)), { force: true });
    world.readStat = (pid) => fs.readFileSync(path.join(procDir(pid), 'stat'), 'utf8');
    world.ppidOf = (pid) => Number(world.readStat(pid).split(') ')[1].split(' ')[1]);
    world.pids = () => fs.readdirSync(world.procRoot).filter((name) => /^[0-9]+$/u.test(name)).map(Number);
    world.descendants = (pid) => {
        const out = new Set();
        for (let grew = true; grew;) {
            grew = false;
            for (const candidate of world.pids()) {
                if (out.has(candidate) || candidate === pid) continue;
                let ppid;
                try { ppid = world.ppidOf(candidate); } catch { continue; }
                if (ppid === pid || out.has(ppid)) { out.add(candidate); grew = true; }
            }
        }
        return [...out];
    };
    world.appendSelfMount = (line) => fs.appendFileSync(path.join(selfDir, 'mountinfo'), line);
    world.writeSelfMountinfo = (text) => fs.writeFileSync(path.join(selfDir, 'mountinfo'), text);
    // The recording signal of the view: a SIGKILL makes a fake process (and its descendants) go, unless it is stubborn.
    world.signal = (pid, name) => {
        world.signals.push({ pid, name });
        if (pid < 200000) throw new Error(`refusing to model a signal to non-fake pid ${pid}`);
        if (world.stubborn.has(pid)) return;
        for (const descendant of world.descendants(pid)) if (!world.stubborn.has(descendant)) world.removeProcess(descendant);
        world.removeProcess(pid);
    };
    // A real file whose device stands for a devpts instance.
    world.newPtyFile = (index) => {
        const file = path.join(world.devpts, `ptmx-${index}`);
        fs.writeFileSync(file, '');
        return { file, dev: String(fs.statSync(file, { bigint: true }).dev) };
    };
    // A directory opened for a grant root or HOME slot.
    world.openDir = (t2, name) => {
        const dir = path.join(world.grants, name);
        fs.mkdirSync(dir, { recursive: true });
        const fd = fs.openSync(dir, 'r');
        t2.after(() => { try { fs.closeSync(fd); } catch { /* closed */ } });
        const stat = fs.fstatSync(fd, { bigint: true });
        return { fd, identity: { dev: String(stat.dev), ino: String(stat.ino) }, dir };
    };
    return world;
}
