// Prep stage of a sandbox start (plan Revision 10, section D steps 2 to 6, and decision M-4 for /proc).
//
// Run by `stage.sh prep` as a foreground child, as container root, inside the PRIVATE mount namespace that `unshare
// --mount --propagation private` created for this start:
//
//   node sandboxPrep.mjs <marker> <spec-json>
//   spec  { supervisorMntNs: "<inode>", stageDir, maskDir, maskFile, masksFile? (= <stageDir>/masks.json: evidence of what was masked), limits?,
//           grants: [{ name, path, dev, ino, exclusions? }],  bound at <stageDir>/projects/<name>, scanned and masked;
//                   exclusions are grant-relative paths masked like protected names (exclusions.mjs)
//           binds:  [{ name, path, dev, ino }] }  bound at <stageDir>/binds/<name> (HOME, session storage, config)
//
//   1. refuse unless /proc/self/ns/mnt differs from the supervisor's mount namespace (nothing below may touch the
//      worker's own mounts);
//   2. lazily unmount the worker container's /proc masks (procMasks.mjs classification of THIS namespace's mountinfo;
//      an unclassified submount, or any submount left afterwards, is setup_failed), because bwrap cannot mount a new
//      procfs over a /proc that has submounts;
//   3. each directory is opened HERE, after the namespace exists, by an anchored walk from / (O_NOFOLLOW at every
//      component) and must carry the device and inode that the supervisor recorded from its own descriptor. A
//      descriptor inherited from the supervisor cannot be bound: the kernel refuses to bind a mount of another mount
//      namespace (EINVAL, observed), so identity is re-proven instead of inherited. The directory is bound from
//      /proc/<pid>/fd/<n> (mount(8) is a child of this process), so a swap after the identity check changes nothing.
//   4. for each grant: scan it, bind the empty read-only mask directory or file over each protected entry, and
//      verify the masks through a fresh descriptor of the staging bind (an anchored rescan: every protected entry must
//      carry the mask's device and inode). A grant under a reserved skill stage name (bwrapArgs.mjs SKILL_STAGE_NAME; the
//      M-22 skills view, T2) must then also hold a regular file SKILL.md at its root, read through that fresh descriptor
//      without following a link (a SKILL.md swapped for a link or anything else since admission is mask_unverified).
//
// Exit 0 only after every mask is verified. Never execs. On failure it prints one JSON line to stderr
// ({"error":code,"detail":...}, no file names) and exits with PREP_EXIT[code].

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { isValidComponentName } from '../views/protectedNames.mjs';
import { isMarker } from './marker.mjs';
import { SKILL_STAGE_NAME } from './bwrapArgs.mjs';
import { checkRelativeExclusion, dropCovered, resolveExclusions, verifyExclusionMasks } from './exclusions.mjs';
import { classifyProcMasks } from './procMasks.mjs';
import { DEFAULT_SCAN_LIMITS, scanProtected, verifyMasks } from './protectedScan.mjs';
import { PREP_EXIT, sandboxError } from './sandboxErrors.mjs';

const DIGITS = /^[0-9]{1,20}$/u;
const TOOL_ENV = Object.freeze({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' });
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

// Default command runner: mount(8) and umount(8) by spawnSync, no shell. A missing binary is sandbox_unavailable.
export function defaultRunTool(command, args) {
    const result = spawnSync(command, args, { env: TOOL_ENV, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 20000 });
    if (result.error?.code === 'ENOENT') throw sandboxError('sandbox_unavailable', `${command} is missing`);
    return { status: result.status ?? 128, stderr: result.stderr ?? '' };
}

// One short line of a tool's diagnostic, for the stderr JSON (the tools print paths, never file content).
const firstLine = (text) => String(text ?? '').split('\n')[0].replace(/[^ -~]/gu, '?').slice(0, 160);

const STAGE_BIND_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

function checkMounts(list, what, nameOk) {
    if (!Array.isArray(list)) throw sandboxError('setup_failed', `invalid ${what}`);
    const seen = new Set();
    for (const entry of list) {
        if (!entry || !nameOk(entry.name) || seen.has(entry.name) || typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path === '/'
            || entry.path.includes('\0') || entry.path.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')
            || !DIGITS.test(String(entry.dev)) || !DIGITS.test(String(entry.ino))) {
            throw sandboxError('setup_failed', `invalid ${what}`);
        }
        seen.add(entry.name);
        for (const rel of entry.exclusions ?? []) checkRelativeExclusion(rel);
    }
}

function checkSpec(marker, spec) {
    if (!isMarker(marker)) throw sandboxError('setup_failed', 'invalid marker');
    if (spec === null || typeof spec !== 'object' || !DIGITS.test(String(spec.supervisorMntNs ?? ''))) throw sandboxError('setup_failed', 'invalid spec');
    spec.binds ??= [];
    checkMounts(spec.grants, 'grants', isValidComponentName);
    checkMounts(spec.binds, 'binds', (name) => typeof name === 'string' && STAGE_BIND_NAME.test(name));
    // A role without mounts (orchestration without session storage) only needs the /proc step.
    for (const key of spec.grants.length + spec.binds.length === 0 ? [] : ['stageDir', 'maskDir', 'maskFile']) {
        if (typeof spec[key] !== 'string' || !spec[key].startsWith('/') || spec[key].includes('\0') || spec[key].split('/').includes('..')) throw sandboxError('setup_failed', `invalid ${key}`);
    }
    if (spec.masksFile !== undefined && spec.masksFile !== null && spec.masksFile !== `${spec.stageDir}/masks.json`) throw sandboxError('setup_failed', 'invalid masksFile');
}

// An anchored walk from / with O_NOFOLLOW at every component (the grantResolver.mjs Linux strategy). Returns an open descriptor.
export function openAnchored(target, { open = (file) => fs.openSync(file, DIRECTORY_FLAGS), close = (fd) => fs.closeSync(fd) } = {}) {
    let dir = open('/');
    try {
        for (const part of target.split('/').slice(1)) {
            const next = open(`/proc/self/fd/${dir}/${part}`);
            close(dir);
            dir = next;
        }
    } catch (error) {
        try { close(dir); } catch { /* closed */ }
        throw sandboxError('setup_failed', `cannot open a directory: ${error?.code ?? 'error'}`);
    }
    return dir;
}

export function runPrep(marker, spec, deps = {}) {
    const {
        runTool = defaultRunTool, readlink = (file) => fs.readlinkSync(file), readFile = (file) => fs.readFileSync(file, 'utf8'),
        pid = process.pid, scan = scanProtected, verify = verifyMasks, lstat = (file) => fs.lstatSync(file, { bigint: true }),
        openDir = (file) => fs.openSync(file, DIRECTORY_FLAGS), closeFd = (fd) => fs.closeSync(fd), openPath = openAnchored, verifyExclusions = verifyExclusionMasks, writeFile = (file, text) => fs.writeFileSync(file, text, { mode: 0o600 }),
        fstat = (fd) => fs.fstatSync(fd, { bigint: true })
    } = deps;
    checkSpec(marker, spec);

    // 1. Only in a private mount namespace.
    const ownNs = /^mnt:\[([0-9]+)\]$/u.exec(readlink('/proc/self/ns/mnt'))?.[1];
    if (ownNs === undefined) throw sandboxError('setup_failed', 'mount namespace unreadable');
    if (ownNs === String(spec.supervisorMntNs)) throw sandboxError('setup_failed', 'not in a private mount namespace');

    // 2. The /proc masks of the worker container.
    const mountinfo = () => readFile('/proc/self/mountinfo');
    const { masks, unclassified } = classifyProcMasks(mountinfo());
    if (unclassified.length > 0) throw sandboxError('setup_failed', 'unclassified /proc submount');
    for (const mask of masks) {
        const result = runTool('umount', ['-l', '--', mask.path]);
        if (result.status !== 0) throw sandboxError('setup_failed', `umount ${mask.path} failed: ${firstLine(result.stderr)}`);
    }
    if (classifyProcMasks(mountinfo()).masks.length > 0 || classifyProcMasks(mountinfo()).unclassified.length > 0) {
        throw sandboxError('setup_failed', 'a /proc submount remains');
    }

    // 3. Directories: open anchored, prove identity, bind.
    if (spec.grants.length + spec.binds.length === 0) return;
    const opened = [];
    const masked = {};
    try {
        const open = (entry, target) => {
            const fd = openPath(entry.path);
            opened.push(fd);
            const found = fstat(fd);
            if (String(found.dev) !== String(entry.dev) || String(found.ino) !== String(entry.ino)) throw sandboxError('setup_failed', 'a directory changed since admission');
            const bound = runTool('mount', ['--no-canonicalize', '--bind', `/proc/${pid}/fd/${fd}`, target]);
            if (bound.status !== 0) throw sandboxError('setup_failed', `bind failed: ${firstLine(bound.stderr)}`);
            return fd;
        };
        for (const bind of spec.binds) open(bind, `${spec.stageDir}/binds/${bind.name}`);

        // 4. Grants: scan, mask, verify.
        const maskDirId = lstat(spec.maskDir);
        const maskFileId = lstat(spec.maskFile);
        if (!maskDirId.isDirectory() || !maskFileId.isFile()) throw sandboxError('setup_failed', 'invalid mask sources');
        const maskIds = { dir: { dev: maskDirId.dev, ino: maskDirId.ino }, file: { dev: maskFileId.dev, ino: maskFileId.ino } };
        for (const grant of spec.grants) {
            const staged = `${spec.stageDir}/projects/${grant.name}`;
            const grantFd = open(grant, staged);
            const { entries } = scan(grantFd, spec.limits, { identity: true });
            // Exclusions: resolved from the same anchored descriptor, a missing one skipped, a link refused (invalid_request).
            const extra = dropCovered(resolveExclusions(grantFd, grant.exclusions ?? []), entries);
            const maxMasks = { ...DEFAULT_SCAN_LIMITS, ...(spec.limits ?? {}) }.maxMasks;
            if (entries.length + extra.length > maxMasks) throw sandboxError('mask_scan_limit', 'Too many protected entries and exclusions');
            for (const entry of [...entries, ...extra]) {
                const source = entry.kind === 'dir' ? spec.maskDir : spec.maskFile;
                const masked = runTool('mount', ['--no-canonicalize', '--bind', '-o', 'ro', source, `${staged}/${entry.rel}`]);
                if (masked.status !== 0) throw sandboxError('mask_unverified', `a mask mount failed: ${firstLine(masked.stderr)}`);
            }
            // A mask lands on whatever object holds the name when mount(2) runs. The scan above and the mounts are not atomic, so a writer
            // that renames a protected object away and another in (D <-> .data) between them would have the mask cover the wrong object. The
            // REAL tree (this descriptor does not see the masks) is scanned again: every protected name must still be the object that was
            // scanned, or the start is refused. This shrinks the window to a rename-and-back inside the mount calls; the verification below
            // proves the names are masked.
            const rescanned = scan(grantFd, spec.limits, { identity: true }).entries;
            const fingerprint = (list) => list.map((entry) => `${entry.rel}\0${entry.kind}\0${entry.dev}\0${entry.ino}`).sort().join('\n');
            if (fingerprint(rescanned) !== fingerprint(entries)) throw sandboxError('mask_unverified', 'the protected entries changed while they were masked');
            let fresh;
            try {
                fresh = openDir(staged);
            } catch {
                throw sandboxError('mask_unverified', 'staging view unreadable');
            }
            try {
                verify(fresh, entries, maskIds, spec.limits);
                verifyExclusions(fresh, extra, maskIds);
                if (SKILL_STAGE_NAME.test(grant.name)) {
                    let skillFile = null;
                    try { skillFile = lstat(`/proc/self/fd/${fresh}/SKILL.md`); } catch { skillFile = null; }
                    if (!skillFile || !skillFile.isFile()) throw sandboxError('mask_unverified', 'a skill has no regular SKILL.md');
                }
            } finally {
                closeFd(fresh);
            }
            masked[grant.name] = entries.map(({ rel, kind, dev, ino }) => ({ rel, kind, dev, ino }));
        }
        // Advisory evidence of what was masked, with the identity of each covered object (read back by the launcher on request).
        if (typeof spec.masksFile === 'string') {
            try { writeFile(spec.masksFile, JSON.stringify({ grants: masked })); } catch { /* evidence only: the masks themselves are verified */ }
        }
    } finally {
        for (const fd of opened) { try { closeFd(fd); } catch { /* closed */ } }
    }
}

export function exitCodeFor(error) {
    const code = error?.code;
    return Object.hasOwn(PREP_EXIT, code) && code !== 'ok' ? { code, status: PREP_EXIT[code] } : { code: 'setup_failed', status: PREP_EXIT.setup_failed };
}

export function main(argv, deps = {}, stderr = process.stderr) {
    try {
        if (argv.length !== 2) throw sandboxError('setup_failed', 'expected <marker> <spec>');
        let spec;
        try { spec = JSON.parse(argv[1]); } catch { throw sandboxError('setup_failed', 'spec is not JSON'); }
        runPrep(argv[0], spec, deps);
        return 0;
    } catch (error) {
        const { code, status } = exitCodeFor(error);
        const detail = code === error?.code ? (error.detail ?? null) : 'unexpected error';
        try { stderr.write(`${JSON.stringify({ error: code, detail })}\n`); } catch { /* nothing more to do */ }
        return status;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = main(process.argv.slice(2));
}
