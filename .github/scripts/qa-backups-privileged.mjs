// Root-side QA backup retention. It runs as
// `sudo -n /usr/bin/node --input-type=module - prune --root R --workspace W --owner U`
// with this source on stdin, so it imports only Node built-ins, stays
// compatible with Node 20 and never depends on its own file location.
// One process reads the root-owned receipts, classifies every backup and
// deletes only the prunable ones. Nothing here runs a shell or `rm`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QA_PRIVILEGED_SCOPE = Object.freeze({
    backups: '/home/admin/.qa-deployment-backups',
    workspace: '/home/admin/explorerQaWorkspace',
});
// Keep these lists literal; the admin module defines its own copy and a test compares them.
export const BACKUP_INNER_ENTRIES = Object.freeze({
    completion: Object.freeze(['helpers', 'prior-containers.txt', 'rollback-authority.json', 'preservation.json',
        'workspace', 'quiesce.log', 'quiesce-source.mjs', 'lock-ready.json', 'lock-released.json', 'lock-release',
        'lock.log', 'lock-source.txt', 'policy-restoration.json', 'restored-selections.json']),
    rollbackMarkers: Object.freeze(['rollback-result.json', /^rollback-result\.json\.[a-f0-9]{16}$/, 'failed-workspace']),
});
export const BACKUP_SIBLING_SUFFIXES = Object.freeze(['helpers', 'lock-ready.json', 'lock-released.json', 'lock-release',
    'lock.log', 'lock-source.txt', 'quiesce.log']);
export const RETAINED_CLASSES = Object.freeze(['rollback-attempted', 'unrecognized-entry', 'stop-attempted-unpreserved',
    'incomplete-redeploy']);
export const PRUNABLE_CLASSES = Object.freeze(['complete-redeploy', 'no-workspace']);

const BACKUP = /^redeploy-[A-Za-z0-9]{8}$/;
const TOMBSTONE = /^\.pruning-(redeploy-[A-Za-z0-9]{8})$/;
const SIBLING = /^(redeploy-[A-Za-z0-9]{8})-(helpers|lock-ready\.json|lock-released\.json|lock-release|lock\.log|lock-source\.txt|quiesce\.log)$/;
const PRIOR_RECORD = /^(?:podman|docker)\|[a-f0-9]{64}\|[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
const DIRECTORY_ENTRIES = new Set(['helpers', 'workspace']);
const RECEIPT_LIMIT = 1024 * 1024;

function requireProof(condition, code) {
    if (!condition) throw Object.assign(new Error(code), { code });
}

/** Mount points of `/proc/self/mountinfo` (field 5, with its octal escapes decoded). */
export function parseMountPoints(text) {
    return text.split('\n').filter(Boolean).map(line => String(line.split(' ')[4] || '')
        .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
}

function readMountPoints() {
    // QA runs on Linux; other platforms have no mount table here and run only the tests.
    if (process.platform !== 'linux') return [];
    let text = '';
    try { text = fs.readFileSync('/proc/self/mountinfo', 'utf8'); } catch {}
    const points = parseMountPoints(text);
    requireProof(points.length > 0 && points.every(point => path.isAbsolute(point)), 'QA_PRIVILEGED_MOUNTS_UNREADABLE');
    return points;
}

function isRollbackMarker(name) {
    return BACKUP_INNER_ENTRIES.rollbackMarkers.some(marker => typeof marker === 'string' ? marker === name : marker.test(name));
}

/**
 * Classifies and prunes the backups under `root`. `hooks` exist for in-process
 * tests only: `lstat(file, stat)` may substitute device or inode identities,
 * `beforeRead(file)` runs before a receipt is read, `afterRename(name)`
 * runs after a backup became a tombstone, and `mountPoints()` replaces the
 * mount table.
 */
export function prunePrivileged(options) {
    const removedNames = [];
    try { return pruneAll(options, removedNames); }
    catch (error) { throw Object.assign(error, { removedBeforeFailure: [...removedNames] }); }
}

function pruneAll({ root, workspace, owner, hooks = {} }, removedNames) {
    requireProof(path.isAbsolute(root || '') && path.isAbsolute(workspace || '') && path.normalize(root) === root
        && path.normalize(workspace) === workspace && root !== workspace && !root.startsWith(workspace + path.sep)
        && !workspace.startsWith(root + path.sep) && Number.isSafeInteger(owner) && owner > 0, 'QA_PRIVILEGED_USAGE_INVALID');
    const uid = BigInt(owner);
    const lstat = file => {
        const stat = fs.lstatSync(file, { bigint: true });
        return hooks.lstat ? hooks.lstat(file, stat) : stat;
    };
    const present = file => {
        try { return lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const result = { result: 'pruned', removed: [], retained: [], unrecognized: [], replayedTombstones: [] };
    const rootStat = present(root);
    if (!rootStat) return result;
    requireProof(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === uid
        && fs.realpathSync(root) === root, 'QA_PRIVILEGED_ROOT_INVALID');
    const workspaceStat = present(workspace);
    requireProof(workspaceStat?.isDirectory() && !workspaceStat.isSymbolicLink(), 'QA_PRIVILEGED_WORKSPACE_INVALID');
    const rootDev = rootStat.dev;
    // A bind mount from the backups filesystem keeps its device, so the walk
    // cannot see it and rmSync would descend into it. Refuse any mount below
    // the backups root before anything is removed, and again before each removal.
    const mountPoints = () => hooks.mountPoints ? hooks.mountPoints() : readMountPoints();
    const assertNoMount = (top, allowTop) => requireProof(!mountPoints().some(point =>
        (!allowTop && point === top) || point.startsWith(top + path.sep)), 'QA_PRIVILEGED_MOUNT_INSIDE');
    assertNoMount(root, true);

    // Identity of one removable top-level entry: never a link, owned by the admin,
    // on the backups filesystem and never the live workspace itself.
    const entryIdentity = (file, directory) => {
        const stat = present(file);
        if (!stat || stat.isSymbolicLink() || stat.uid !== uid || stat.dev !== rootDev
            || (stat.dev === workspaceStat.dev && stat.ino === workspaceStat.ino)) return null;
        if (directory ? !stat.isDirectory() || fs.realpathSync(file) !== file : !stat.isFile()) return null;
        return stat;
    };
    // Every entry below `top` is examined with lstat only; links are never
    // followed and any other device aborts before anything is removed.
    const walk = top => {
        const stack = [top];
        while (stack.length) {
            const directory = stack.pop();
            for (const name of fs.readdirSync(directory)) {
                const stat = lstat(path.join(directory, name));
                requireProof(stat.dev === rootDev, 'QA_PRIVILEGED_OTHER_FILESYSTEM');
                if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(path.join(directory, name));
            }
        }
    };
    const readReceipt = file => {
        if (hooks.beforeRead) hooks.beforeRead(file);
        const stat = lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(RECEIPT_LIMIT)) return null;
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };

    const names = fs.readdirSync(root).sort();
    const backups = [], tombstones = [], siblings = new Map(), unrecognized = [];
    for (const name of names) {
        const file = path.join(root, name);
        if (BACKUP.test(name)) {
            const stat = present(file);
            if (stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o077n) === 0n
                && fs.realpathSync(file) === file && stat.dev === rootDev
                && !(stat.dev === workspaceStat.dev && stat.ino === workspaceStat.ino)) backups.push({ name, file, stat });
            else unrecognized.push(name);
        } else if (TOMBSTONE.test(name)) {
            // A leftover tombstone that is not exactly ours fails the run before any removal.
            const stat = entryIdentity(file, true);
            requireProof(stat, 'QA_PRIVILEGED_TOMBSTONE_INVALID');
            tombstones.push({ name, backup: TOMBSTONE.exec(name)[1], file, stat });
        } else if (SIBLING.test(name)) {
            const [, base, suffix] = SIBLING.exec(name);
            if (!siblings.has(base)) siblings.set(base, []);
            siblings.get(base).push({ name, suffix, file });
        } else unrecognized.push(name);
    }
    const backupNames = new Set(backups.map(item => item.name));
    // Siblings of a removable item must be exactly ours as well; otherwise they stay.
    const removableSiblings = base => (siblings.get(base) || []).map(item => ({ ...item,
        stat: entryIdentity(item.file, item.suffix === 'helpers') }));

    const classify = backup => {
        const entries = fs.readdirSync(backup.file);
        if (entries.some(isRollbackMarker)) return 'rollback-attempted';
        for (const entry of entries) {
            if (!BACKUP_INNER_ENTRIES.completion.includes(entry)) return 'unrecognized-entry';
            const stat = lstat(path.join(backup.file, entry));
            const valid = DIRECTORY_ENTRIES.has(entry) ? stat.isDirectory() && !stat.isSymbolicLink()
                : stat.isFile() && !stat.isSymbolicLink();
            if (!valid) return 'unrecognized-entry';
        }
        const own = removableSiblings(backup.name);
        if (own.some(item => !item.stat)) return 'unrecognized-entry';
        const has = entry => entries.includes(entry);
        const quiesced = has('quiesce.log') || own.some(item => item.suffix === 'quiesce.log');
        if (!has('workspace')) {
            if (quiesced) return 'stop-attempted-unpreserved';
            // A preservation receipt that names a workspace which is gone is not a clean abort.
            if (has('preservation.json')) {
                const preservation = readReceipt(path.join(backup.file, 'preservation.json'));
                if (!preservation || preservation.source !== null) return 'incomplete-redeploy';
            }
            return 'no-workspace';
        }
        const preservation = has('preservation.json') ? readReceipt(path.join(backup.file, 'preservation.json')) : null;
        const policy = has('policy-restoration.json') ? readReceipt(path.join(backup.file, 'policy-restoration.json')) : null;
        const selections = has('restored-selections.json') ? readReceipt(path.join(backup.file, 'restored-selections.json')) : null;
        const complete = preservation?.exactCopiesVerified === true
            && preservation.source === path.join(backup.file, 'workspace') && preservation.target === workspace
            && policy?.exactCopiesVerified === true
            && selections !== null && typeof selections === 'object' && FULL_ID.test(String(selections.boxId || ''));
        return complete ? 'complete-redeploy' : 'incomplete-redeploy';
    };
    const priorRecord = backup => {
        const file = path.join(backup.file, 'prior-containers.txt');
        const stat = present(file);
        if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 4096n) return null;
        const text = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
        return PRIOR_RECORD.test(text) ? text : null;
    };

    // Phase 1: classify and prove every identity, including the full walks,
    // before the first rename or removal.
    const prunable = [];
    for (const backup of backups) {
        const backupClass = classify(backup);
        if (!PRUNABLE_CLASSES.includes(backupClass)) { result.retained.push({ name: backup.name, class: backupClass }); continue; }
        prunable.push({ ...backup, priorRecord: priorRecord(backup), siblings: removableSiblings(backup.name) });
    }
    const replay = tombstones.map(item => ({ ...item,
        siblings: backupNames.has(item.backup) ? [] : removableSiblings(item.backup).filter(sibling => sibling.stat) }));
    for (const item of [...replay, ...prunable]) {
        walk(item.file);
        for (const sibling of item.siblings) if (sibling.stat.isDirectory()) walk(sibling.file);
    }
    const kept = new Set([...replay, ...prunable].flatMap(item => item.siblings.map(sibling => sibling.name)));
    for (const [base, items] of siblings) {
        if (backupNames.has(base) && !prunable.some(item => item.name === base)) continue;
        for (const item of items) if (!kept.has(item.name)) unrecognized.push(item.name);
    }
    result.unrecognized = [...new Set(unrecognized)].sort();

    const removeSiblings = item => {
        for (const sibling of item.siblings) {
            const stat = lstat(sibling.file);
            requireProof(!stat.isSymbolicLink() && stat.uid === uid && stat.dev === rootDev && stat.ino === sibling.stat.ino,
                'QA_PRIVILEGED_SIBLING_CHANGED');
            if (stat.isDirectory()) {
                walk(sibling.file);
                assertNoMount(sibling.file, false);
            }
            fs.rmSync(sibling.file, { recursive: stat.isDirectory() });
        }
    };
    const removeTombstone = (file, expected) => {
        const stat = lstat(file);
        requireProof(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && stat.dev === rootDev
            && stat.ino === expected.ino && stat.dev === expected.dev
            && !(stat.dev === workspaceStat.dev && stat.ino === workspaceStat.ino), 'QA_PRIVILEGED_TOMBSTONE_CHANGED');
        walk(file);
        assertNoMount(file, false);
        fs.rmSync(file, { recursive: true });
    };

    // Phase 2: leftover tombstones first, then each prunable backup. Siblings go
    // before the tombstone, so an interruption always leaves a tombstone to replay.
    for (const item of replay) {
        removeSiblings(item);
        removeTombstone(item.file, item.stat);
        result.replayedTombstones.push(item.name);
    }
    for (const item of prunable) {
        const tombstone = path.join(root, `.pruning-${item.name}`);
        requireProof(present(tombstone) === null, 'QA_PRIVILEGED_TOMBSTONE_EXISTS');
        const before = lstat(item.file);
        requireProof(before.ino === item.stat.ino && before.dev === item.stat.dev && !before.isSymbolicLink(),
            'QA_PRIVILEGED_BACKUP_CHANGED');
        fs.renameSync(item.file, tombstone);
        if (hooks.afterRename) hooks.afterRename(item.name, tombstone);
        removeSiblings(item);
        removeTombstone(tombstone, item.stat);
        removedNames.push(item.name);
        result.removed.push({ name: item.name, priorRecord: item.priorRecord });
    }
    return result;
}

const safeCode = (error, fallback) => /^QA_[A-Z_]+$/.test(error?.code || '') ? error.code : fallback;

/** CLI form; exactly one JSON line on stdout. */
export function runPrivilegedCli(argv) {
    try {
        requireProof(argv.length === 7 && argv[0] === 'prune' && argv[1] === '--root' && argv[3] === '--workspace'
            && argv[5] === '--owner' && /^[1-9][0-9]{0,9}$/.test(argv[6]), 'QA_PRIVILEGED_USAGE_INVALID');
        requireProof(argv[2] === QA_PRIVILEGED_SCOPE.backups && argv[4] === QA_PRIVILEGED_SCOPE.workspace,
            'QA_PRIVILEGED_USAGE_INVALID');
        requireProof(typeof process.getuid === 'function' && process.getuid() === 0, 'QA_PRIVILEGED_ROOT_REQUIRED');
        const result = prunePrivileged({ root: argv[2], workspace: argv[4], owner: Number(argv[6]) });
        process.stdout.write(JSON.stringify(result) + '\n');
        return 0;
    } catch (error) {
        process.stdout.write(JSON.stringify({ result: 'failed', code: safeCode(error, 'QA_PRIVILEGED_FAILED'),
            removedBeforeFailure: Array.isArray(error?.removedBeforeFailure) ? error.removedBeforeFailure : [] }) + '\n');
        return 1;
    }
}

// Loaded from stdin, argv[1] is '-' and this module has no file of its own.
const fromStdin = process.argv[1] === '-' && !import.meta.url.endsWith('/qa-backups-privileged.mjs');
const asFile = !fromStdin && Boolean(process.argv[1]) && import.meta.url.startsWith('file:')
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (fromStdin || asFile) process.exitCode = runPrivilegedCli(process.argv.slice(2));
