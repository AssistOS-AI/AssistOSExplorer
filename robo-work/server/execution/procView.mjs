// The supervisor's own view of the container (R1.1, R1.7): the
// production /proc reader behind the recovery walk's view interface (recoveryWalk.mjs), plus what the Node sandbox supervisor (bwrap) needs
// to verify a sandbox claim before anything is committed. Nothing here believes a sandbox: every answer is read from
// /proc or the file system, and anything that cannot be read is answered "present" or throws.
//
//   listProcesses() -> [{ pid, ppid, startTime, cmdline, pidNs, netNs, mntNs, fdNs }]   start times and inodes are
//                      canonical decimal strings, pids integers (the types toLedgerIdentity commits)
//   listMounts()    -> [{ mountId, mountpoint, mntNs, fstype, nsInode, majorMinor }]
//   exists(kind, locator), kill({ pid, startTime }), remove(kind, locator), unmount() (always false)
//   processIdentity(pid) -> { pid, startTime, pidNamespaceInode } | null   (pid, start time and pid namespace inode)
//   heldNamespaces(pid)  -> { pidNs, netNs, mntNs, fdNs } | null
//   process(pid), fdDevices(pid), pathIdentity(path), selfNamespaces(), containerDevptsDev(), registerSandboxChild()
//
// Read errors: a per-pid ENOENT or ESRCH means the process vanished and it is skipped; an ENOENT on one fd/N means that
// descriptor closed and only it is skipped. Any other errno makes listProcesses or listMounts throw `proc_unreadable`,
// which rejects the walk: fail closed, never a release.
//
// Safety (R1.7): a procRoot other than /proc needs an explicit `signal`, so a test over a fake /proc can never signal a
// real pid taken from a fake entry. The sandbox supervisor itself is a direct child of the supervisor and is killed only through its
// ChildProcess (registerSandboxChild); anything else gets `signal` after its start time has been re-read (open risk K-3:
// Node has no pidfd, so a reuse window remains between that check and kill(2)).

import fs from 'node:fs';
import path from 'node:path';
import { virtualPathProblem } from './providerSchema.mjs';

const PID_ENTRY = /^[1-9][0-9]{0,9}$/u;
const DIGITS = /^[0-9]{1,20}$/u;
const NS_LINK = /^([a-z_]+):\[([0-9]{1,20})\]$/u;
const NAMESPACE_TYPES = new Set(['net', 'mnt', 'pid', 'uts', 'ipc', 'user', 'cgroup', 'time', 'pid_for_children', 'time_for_children']);
const LOCATOR_ID = '[0-9a-f]{32}';
const VANISHED = new Set(['ENOENT', 'ESRCH']);

export class ProcUnreadable extends Error {
    constructor(where, cause) { super(`proc_unreadable: ${where}`); this.name = 'ProcUnreadable'; this.code = 'proc_unreadable'; this.errno = cause?.code ?? null; }
}

class Vanished extends Error {}

// One /proc/<pid>/stat line. comm is attacker-controlled and may contain ') ' and spaces, so the fields are taken after
// the LAST ')'. Returns { pid, ppid, startTime } or null for a malformed line.
export function parseStatLine(line) {
    if (typeof line !== 'string') return null;
    const text = line.endsWith('\n') ? line.slice(0, -1) : line;
    const open = text.indexOf(' (');
    const close = text.lastIndexOf(')');
    if (open < 1 || close < open) return null;
    const pidText = text.slice(0, open);
    if (!PID_ENTRY.test(pidText)) return null;
    const fields = text.slice(close + 2).split(' ');
    // fields[0] is field 3 (state); ppid is field 4, starttime field 22.
    if (text[close + 1] !== ' ' || fields.length < 20) return null;
    const ppid = fields[1];
    const startTime = fields[19];
    if (!/^[0-9]{1,10}$/u.test(ppid) || !DIGITS.test(startTime)) return null;
    return { pid: Number(pidText), ppid: Number(ppid), startTime: String(BigInt(startTime)) };
}

// The Linux dev_t encoding (new_encode_dev / MKDEV in userspace): the `major:minor` of a mountinfo line for a device.
export function devMajorMinor(dev) {
    const value = BigInt(dev);
    const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn);
    const minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
    return `${major}:${minor}`;
}

const unescapeMount = (text) => text.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

// One mountinfo line: "36 35 98:0 /root /mountpoint opts [optional...] - fstype source superopts".
export function parseMountinfoLine(line, mntNs) {
    const parts = line.split(' ');
    const separator = parts.indexOf('-', 6);
    if (parts.length < 10 || separator < 0 || separator + 1 >= parts.length) return null;
    const mountId = Number(parts[0]);
    if (!Number.isSafeInteger(mountId) || mountId < 0 || !/^[0-9]+:[0-9]+$/u.test(parts[2])) return null;
    const root = unescapeMount(parts[3]);
    const fstype = parts[separator + 1];
    const link = NS_LINK.exec(root);
    return {
        mountId, mountpoint: unescapeMount(parts[4]), mntNs, fstype, majorMinor: parts[2],
        nsInode: fstype === 'nsfs' && link ? link[2] : null
    };
}

export function createProcView({
    procRoot = '/proc', signal, runtimeRoot = null, cgroupSubtree = null, identityForLocator = null, sandboxRecord = null,
    containerDevpts = '/dev/pts', statfs
} = {}) {
    if (procRoot !== '/proc' && typeof signal !== 'function') throw new TypeError('procView over a procRoot other than /proc needs an explicit signal');
    if (statfs !== undefined && (procRoot === '/proc' || typeof statfs !== 'function')) throw new TypeError('statfs injection requires a fake procRoot');
    if (cgroupSubtree !== null && (cgroupSubtree === '/' || virtualPathProblem(cgroupSubtree, 989) !== null)) throw new TypeError('Invalid cgroup subtree');
    const readStatfs = statfs ?? fs.statfsSync;
    const send = typeof signal === 'function' ? signal : (pid, name) => process.kill(pid, name);
    const sandboxChildren = new Map();
    const at = (...parts) => path.join(procRoot, ...parts.map(String));

    // A read that distinguishes "vanished" (ENOENT/ESRCH) from "unreadable" (anything else).
    function guarded(where, read) {
        try { return read(); } catch (error) {
            if (VANISHED.has(error?.code)) throw new Vanished(where);
            throw new ProcUnreadable(where, error);
        }
    }
    const nsLink = (pid, type) => {
        const target = guarded(`${pid}/ns/${type}`, () => fs.readlinkSync(at(pid, 'ns', type)));
        const match = NS_LINK.exec(target);
        if (!match || match[1] !== type) throw new ProcUnreadable(`${pid}/ns/${type}`);
        return match[2];
    };

    // The namespace inodes a process holds through descriptors, and the devices of its path descriptors.
    function readFds(pid, { devices = false } = {}) {
        const names = guarded(`${pid}/fd`, () => fs.readdirSync(at(pid, 'fd')));
        const fdNs = [];
        const devs = [];
        for (const name of names) {
            let target;
            try { target = fs.readlinkSync(at(pid, 'fd', name)); } catch (error) {
                if (VANISHED.has(error?.code)) continue; // this descriptor closed
                throw new ProcUnreadable(`${pid}/fd/${name}`, error);
            }
            const link = NS_LINK.exec(target);
            if (link) {
                if (NAMESPACE_TYPES.has(link[1])) fdNs.push(link[2]);
                continue; // socket:[N], pipe:[N] and namespace links are never a devpts file
            }
            if (!devices || !target.startsWith('/')) continue;
            try { devs.push(String(fs.statSync(at(pid, 'fd', name), { bigint: true }).dev)); } catch (error) {
                if (VANISHED.has(error?.code)) continue;
                throw new ProcUnreadable(`${pid}/fd/${name}`, error);
            }
        }
        return devices ? { fdNs, devs } : { fdNs };
    }

    // State Z with a single thread (read from status; both fields are world-readable).
    function isDeadZombie(pid) {
        try {
            const text = fs.readFileSync(at(pid, 'status'), 'utf8');
            return /^State:\s*Z\b/mu.test(text) && /^Threads:\s*1\s*$/mu.test(text);
        } catch { return false; }
    }

    function readProcess(pid) {
        const stat = parseStatLine(guarded(`${pid}/stat`, () => fs.readFileSync(at(pid, 'stat'), 'utf8')));
        if (!stat || stat.pid !== pid) throw new ProcUnreadable(`${pid}/stat`);
        const raw = guarded(`${pid}/cmdline`, () => fs.readFileSync(at(pid, 'cmdline')));
        const cmdline = raw.length === 0 ? [] : raw.toString('utf8').replace(/\0$/u, '').split('\0');
        let fdNs;
        try {
            ({ fdNs } = readFds(pid));
        } catch (error) {
            // A zombie's descriptors are unreadable (EACCES on Linux). A zombie group leader with no other thread holds nothing and
            // runs nothing, and a container whose pid 1 does not reap leaves such zombies behind: it counts as gone. A
            // leader with live threads still runs, so its unreadable state stays an error.
            if (error instanceof ProcUnreadable && isDeadZombie(pid)) throw new Vanished(`${pid}/fd`);
            throw error;
        }
        return { pid, ppid: stat.ppid, startTime: stat.startTime, cmdline, pidNs: nsLink(pid, 'pid'), netNs: nsLink(pid, 'net'), mntNs: nsLink(pid, 'mnt'), fdNs };
    }

    function pids() {
        const names = guarded('.', () => fs.readdirSync(procRoot));
        return names.filter((name) => PID_ENTRY.test(name)).map(Number).sort((a, b) => a - b);
    }

    function listProcesses() {
        const out = [];
        for (const pid of pids()) {
            try { out.push(readProcess(pid)); } catch (error) {
                if (error instanceof Vanished) continue;
                throw error;
            }
        }
        return out;
    }

    function processOrNull(pid) {
        if (!Number.isSafeInteger(pid) || pid < 1) return null;
        try { return readProcess(pid); } catch (error) {
            if (error instanceof Vanished) return null;
            throw error;
        }
    }

    function readMountinfo(where, file, mntNs) {
        const text = guarded(where, () => fs.readFileSync(file, 'utf8'));
        const out = [];
        for (const line of text.split('\n')) {
            if (line === '') continue;
            const mount = parseMountinfoLine(line, mntNs);
            if (!mount) throw new ProcUnreadable(`${where}: malformed line`);
            out.push(mount);
        }
        return out;
    }

    // The supervisor's own mount table plus one representative member of every other mount namespace.
    function listMounts() {
        const selfMnt = nsLink('self', 'mnt');
        const mounts = readMountinfo('self/mountinfo', at('self', 'mountinfo'), selfMnt);
        const seen = new Set([selfMnt]);
        for (const entry of listProcesses()) {
            if (seen.has(entry.mntNs)) continue;
            try {
                mounts.push(...readMountinfo(`${entry.pid}/mountinfo`, at(entry.pid, 'mountinfo'), entry.mntNs));
                seen.add(entry.mntNs);
            } catch (error) {
                if (error instanceof Vanished) continue; // another member may represent it
                throw error;
            }
        }
        return mounts;
    }

    const selfNamespaces = () => ({ pidNs: nsLink('self', 'pid'), netNs: nsLink('self', 'net'), mntNs: nsLink('self', 'mnt') });

    function pathIdentity(target) {
        let stat;
        try { stat = fs.lstatSync(target, { bigint: true }); } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw new ProcUnreadable(`lstat ${target}`, error);
        }
        const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'other';
        return { type, mode: Number(stat.mode & 0o7777n), dev: String(stat.dev), ino: String(stat.ino) };
    }

    function containerDevptsDev() {
        try { return String(fs.statSync(containerDevpts, { bigint: true }).dev); } catch { return null; }
    }

    // Exactly <root>/<infix><32 hex>, the parent a real directory, and the object itself gone (ENOENT). Anything else,
    // a link or another errno included, is present.
    function locatorPathAbsent(root, infix, locatorPath) {
        if (typeof root !== 'string' || typeof locatorPath !== 'string') return false;
        const pattern = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/${infix}${LOCATOR_ID}$`, 'u');
        if (!pattern.test(locatorPath)) return false;
        const parent = infix === 'x/' ? path.join(root, 'x') : root;
        try {
            const parentStat = fs.lstatSync(parent);
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
            fs.lstatSync(locatorPath);
            return false;
        } catch (error) {
            return error?.code === 'ENOENT' && fs.existsSync(parent);
        }
    }

    function cgroupSubtreeIdentity() {
        if (cgroupSubtree === null) return null;
        try {
            const found = fs.lstatSync(cgroupSubtree, { bigint: true });
            if (!found.isDirectory() || found.isSymbolicLink() || fs.realpathSync(cgroupSubtree) !== cgroupSubtree
                || BigInt(readStatfs(cgroupSubtree).type) !== 0x63677270n) return null;
            return { path: cgroupSubtree, dev: String(found.dev), ino: String(found.ino) };
        } catch { return null; }
    }

    // Whether the sandbox supervisor named by the locator is present, from its own S1 record: committed { pid, startTime }, or its
    // marker if it never committed. An unreadable record is present.
    function sandboxPresent(locator) {
        if (typeof sandboxRecord !== 'function') return true;
        let record;
        try { record = sandboxRecord({ locator }); } catch { return true; }
        if (!record || typeof record !== 'object' || !record.locator) return true;
        const processes = listProcesses();
        if (record.identity === null) return processes.some((entry) => entry.cmdline.includes(record.locator.marker));
        return processes.some((entry) => entry.pid === record.identity.pid && entry.startTime === record.identity.startTime);
    }

    function ptyPresent(locator) {
        let identity;
        try { identity = identityForLocator('pty', locator); } catch { return true; }
        if (identity === null || identity === undefined || typeof identity.devptsDev !== 'string' || !DIGITS.test(identity.devptsDev)) {
            // Uncommitted (or no usable identity): only the sandbox supervisor can hold it. Absent only when the sandbox supervisor is.
            return sandboxPresent(locator);
        }
        const device = identity.devptsDev;
        for (const pid of pids()) {
            let devs;
            try { ({ devs } = readFds(pid, { devices: true })); } catch (error) {
                if (error instanceof Vanished) continue;
                throw error;
            }
            if (devs.includes(device)) return true;
        }
        const majorMinor = devMajorMinor(device);
        return listMounts().some((mount) => mount.majorMinor === majorMinor);
    }

    function exists(kind, locator) {
        switch (kind) {
            case 'runtime-dir': return !locatorPathAbsent(runtimeRoot, 'x/', locator?.path);
            case 'cgroup': return cgroupSubtreeIdentity() === null || !locatorPathAbsent(cgroupSubtree, 'x-', locator?.path);
            case 'pty': return ptyPresent(locator);
            default: return true; // veth, nft-table, GUI kinds and anything unknown: never proven absent here
        }
    }

    // Kills only a process whose start time still matches. The sandbox supervisor goes through its ChildProcess.
    function kill({ pid, startTime }) {
        const entry = processOrNull(pid);
        if (!entry || entry.startTime !== startTime) return false;
        const child = sandboxChildren.get(pid);
        if (child && child.startTime === startTime) {
            try { child.kill(); } catch { return false; }
            return true;
        }
        try { send(pid, 'SIGKILL'); } catch { return false; }
        return true;
    }

    function hasMountBeneath(target) {
        const prefix = `${target}/`;
        return readMountinfo('self/mountinfo', at('self', 'mountinfo'), null).some((mount) => mount.mountpoint === target || mount.mountpoint.startsWith(prefix));
    }

    function remove(kind, locator) {
        if (kind === 'cgroup' && cgroupSubtreeIdentity() === null) return false;
        if (kind === 'runtime-dir' || kind === 'cgroup') {
            const root = kind === 'runtime-dir' ? runtimeRoot : cgroupSubtree;
            const infix = kind === 'runtime-dir' ? 'x/' : 'x-';
            const target = locator?.path;
            if (typeof root !== 'string' || typeof target !== 'string'
                || !new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/${infix}${LOCATOR_ID}$`, 'u').test(target)) return false;
            const found = pathIdentity(target);
            if (found === null || found.type !== 'dir' || hasMountBeneath(target)) return false;
            try {
                // rmSync unlinks links and does not follow them. A cgroup directory is removed with rmdir only.
                if (kind === 'cgroup') fs.rmdirSync(target); else fs.rmSync(target, { recursive: true, force: false });
            } catch { return false; }
            return true;
        }
        return false; // a pty goes with its holders; egress and GUI kinds are not created in v1
    }

    return {
        cgroupSubtree,
        cgroupSubtreeIdentity,
        listProcesses,
        listMounts,
        exists,
        kill,
        remove,
        // Node cannot umount2 or setns. A view dies with its mount-namespace holders, which the walk proves.
        unmount: () => false,
        process: processOrNull,
        processIdentity(pid) {
            const entry = processOrNull(pid);
            return entry ? { pid: entry.pid, startTime: entry.startTime, pidNamespaceInode: entry.pidNs } : null;
        },
        heldNamespaces(pid) {
            const entry = processOrNull(pid);
            return entry ? { pidNs: entry.pidNs, netNs: entry.netNs, mntNs: entry.mntNs, fdNs: [...entry.fdNs] } : null;
        },
        fdDevices(pid) {
            try { return readFds(pid, { devices: true }).devs; } catch (error) {
                if (error instanceof Vanished) return [];
                throw error;
            }
        },
        pathIdentity,
        selfNamespaces,
        containerDevptsDev,
        // The sandbox supervisor registers its live bwrap child, so that a kill of that pid and start time goes to
        // ChildProcess.kill('SIGKILL') and never to kill(2). Returns an unregister function.
        registerSandboxChild({ pid, startTime, kill: killChild }) {
            const entry = { startTime, kill: killChild };
            sandboxChildren.set(pid, entry);
            return () => { if (sandboxChildren.get(pid) === entry) sandboxChildren.delete(pid); };
        }
    };
}
