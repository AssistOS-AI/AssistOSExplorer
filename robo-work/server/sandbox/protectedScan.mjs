// Bounded, anchored scan for protected names (plan Revision 10, section D steps 3 and 5).
//
//   scanProtected(dirFd, limits?)             -> { entries: [{ rel, kind: 'dir' | 'file' }], scanned }
//   verifyMasks(dirFd, entries, maskIds, limits?)   -> { ok: true, checked } or throws code 'mask_unverified'
//        maskIds = { dir: { dev, ino }, file: { dev, ino } }
//
// The walk starts at an open directory descriptor. Each component is opened as `/proc/self/fd/<dirfd>/<name>` with
// O_NOFOLLOW | O_DIRECTORY (the grantResolver.mjs Linux strategy), so no symlink is followed. A protected symlink is
// neither masked nor returned (its target is governed by its own name). A protected directory is returned and not
// descended into, since it is masked whole. kind is 'dir' for a directory and 'file' for every other non-link entry.
// Every descriptor opened here is closed before return. Errors carry `code`: 'mask_scan_limit', 'scan_unreadable',
// 'mask_unverified'. The caller's dirFd is never closed.

import fs from 'node:fs';

import { classifyGrantName } from '../views/protectedNames.mjs';

export const DEFAULT_SCAN_LIMITS = Object.freeze({ maxEntries: 200000, maxMasks: 4096, maxDepth: 64 });
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

function coded(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function resolveLimits(limits) {
    const merged = { ...DEFAULT_SCAN_LIMITS, ...(limits || {}) };
    for (const key of Object.keys(DEFAULT_SCAN_LIMITS)) {
        if (!Number.isSafeInteger(merged[key]) || merged[key] < 0) throw coded('invalid_request', `Invalid scan limit ${key}`);
    }
    return merged;
}

// Walk and collect protected entries with their lstat identity.
function walk(rootFd, limitsInput) {
    const limits = resolveLimits(limitsInput);
    const entries = [];
    let scanned = 0;

    const visit = (fd, prefix, depth) => {
        let dirents;
        try {
            dirents = fs.readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true });
        } catch (error) {
            throw coded('scan_unreadable', `Cannot read ${prefix || '.'}: ${error.code || error.message}`);
        }
        for (const dirent of dirents) {
            scanned += 1;
            if (scanned > limits.maxEntries) throw coded('mask_scan_limit', 'Too many entries');
            const name = dirent.name;
            const rel = prefix ? `${prefix}/${name}` : name;
            const edge = `/proc/self/fd/${fd}/${name}`;
            const protectedName = classifyGrantName(name) !== null;
            let stat;
            try {
                stat = fs.lstatSync(edge, { bigint: true });
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw coded('scan_unreadable', `Cannot stat ${rel}: ${error.code || error.message}`);
            }
            if (stat.isSymbolicLink()) continue;
            if (protectedName) {
                if (entries.length >= limits.maxMasks) throw coded('mask_scan_limit', 'Too many protected entries');
                entries.push({ rel, kind: stat.isDirectory() ? 'dir' : 'file', dev: stat.dev, ino: stat.ino });
                continue;
            }
            if (!stat.isDirectory()) continue;
            if (depth + 1 > limits.maxDepth) throw coded('mask_scan_limit', 'Tree too deep');
            let child;
            try {
                child = fs.openSync(edge, DIRECTORY_FLAGS);
            } catch (error) {
                // A race replaced the directory with a link or removed it; neither is descended.
                if (error.code === 'ELOOP' || error.code === 'ENOTDIR' || error.code === 'ENOENT') continue;
                throw coded('scan_unreadable', `Cannot open ${rel}: ${error.code || error.message}`);
            }
            try {
                visit(child, rel, depth + 1);
            } finally {
                fs.closeSync(child);
            }
        }
    };

    visit(rootFd, '', 0);
    return { entries, scanned };
}

export function scanProtected(dirFd, limits) {
    const { entries, scanned } = walk(dirFd, limits);
    return { entries: entries.map(({ rel, kind }) => ({ rel, kind })), scanned };
}

export function verifyMasks(dirFd, entries, maskIds, limits) {
    const unverified = (message) => coded('mask_unverified', message);
    if (!maskIds || !maskIds.dir || !maskIds.file) throw unverified('Missing mask identities');
    let rescan;
    try {
        rescan = walk(dirFd, limits);
    } catch (error) {
        throw unverified(`Rescan failed: ${error.code || error.message}`);
    }
    const expected = new Map(entries.map((entry) => [entry.rel, entry.kind]));
    if (rescan.entries.length !== expected.size) throw unverified('The protected entries changed since the scan');
    for (const found of rescan.entries) {
        const kind = expected.get(found.rel);
        if (kind === undefined || kind !== found.kind) throw unverified(`Unexpected protected entry ${found.rel}`);
        const id = maskIds[kind];
        if (String(found.dev) !== String(id.dev) || String(found.ino) !== String(id.ino)) {
            throw unverified(`Entry ${found.rel} is not masked`);
        }
    }
    return { ok: true, checked: rescan.entries.length };
}
