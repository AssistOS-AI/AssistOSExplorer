// Provider-request exclusions as extra masks (monitor M-17). An exclusion names a path inside an admitted grant that the
// sandbox must not see through: it is mounted over like a protected name (an empty read-only file or directory), verified after
// mounting, and counted toward the mask limit.
//
//   checkRelativeExclusion(rel)                 throws invalid_request unless rel is a plain grant-relative path
//   mapVirtualExclusions(paths, grants)         -> Map<grantName, rel[]>   (supervisor: virtual /projects/<g>/... -> grant-relative)
//   resolveExclusions(grantFd, rels, io?)       -> [{ rel, kind: 'dir' | 'file' }]   (prep: anchored O_NOFOLLOW walk from the grant fd;
//                                                  a path that does not exist is skipped, never created; a symlink anywhere on the
//                                                  path, final component included, is refused with invalid_request)
//   verifyExclusionMasks(dirFd, entries, maskIds)   every entry must carry the mask's device and inode, else mask_unverified
//
// Nothing here follows a link or creates a file.

import fs from 'node:fs';

import { sandboxError } from './sandboxErrors.mjs';

export const MAX_EXCLUSION_BYTES = 1024;
const MAX_COMPONENT_BYTES = 255;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;

const invalid = (detail) => sandboxError('invalid_request', detail);

export function checkRelativeExclusion(rel) {
    if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || Buffer.byteLength(rel) > MAX_EXCLUSION_BYTES) throw invalid('exclusion is not a path');
    if (rel.startsWith('/')) throw invalid('exclusion must be relative to its grant');
    for (const part of rel.split('/')) {
        if (part === '' || part === '.' || part === '..') throw invalid('exclusion has an empty, . or .. component');
        if (Buffer.byteLength(part) > MAX_COMPONENT_BYTES) throw invalid('exclusion component too long');
    }
    return rel;
}

// grants: [{ name, path }] with the virtual path of each ADMITTED grant (not only the mounted ones).
export function mapVirtualExclusions(paths, grants) {
    const byGrant = new Map();
    for (const virtual of paths ?? []) {
        if (typeof virtual !== 'string' || !virtual.startsWith('/') || virtual.includes('\0')) throw invalid('exclusion is not an absolute virtual path');
        const grant = grants.find((candidate) => virtual.startsWith(`${candidate.path}/`));
        if (!grant) throw invalid('exclusion is outside every admitted grant');
        const rel = checkRelativeExclusion(virtual.slice(grant.path.length + 1));
        if (!byGrant.has(grant.name)) byGrant.set(grant.name, []);
        if (!byGrant.get(grant.name).includes(rel)) byGrant.get(grant.name).push(rel);
    }
    return byGrant;
}

const defaultIo = {
    open: (file) => fs.openSync(file, DIRECTORY_FLAGS), close: (fd) => fs.closeSync(fd), lstat: (file) => fs.lstatSync(file, { bigint: true })
};

export function resolveExclusions(grantFd, rels, io = defaultIo) {
    const { open, close, lstat } = { ...defaultIo, ...io };
    const found = [];
    for (const rel of rels) {
        checkRelativeExclusion(rel);
        const parts = rel.split('/');
        let dir = grantFd;
        let owned = false;
        let missing = false;
        try {
            for (let index = 0; index < parts.length - 1 && !missing; index += 1) {
                const edge = `/proc/self/fd/${dir}/${parts[index]}`;
                let stat;
                try { stat = lstat(edge); } catch (error) {
                    if (error?.code === 'ENOENT') { missing = true; break; }
                    throw sandboxError('scan_unreadable', `cannot stat an exclusion path: ${error?.code ?? 'error'}`);
                }
                if (stat.isSymbolicLink()) throw invalid('exclusion passes through a symlink');
                if (!stat.isDirectory()) { missing = true; break; } // a file in the way: the path cannot exist
                let next;
                try { next = open(edge); } catch (error) {
                    if (error?.code === 'ENOENT') { missing = true; break; }
                    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') throw invalid('exclusion passes through a symlink');
                    throw sandboxError('scan_unreadable', `cannot open an exclusion path: ${error?.code ?? 'error'}`);
                }
                if (owned) close(dir);
                dir = next;
                owned = true;
            }
            if (missing) continue;
            let stat;
            try { stat = lstat(`/proc/self/fd/${dir}/${parts.at(-1)}`); } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw sandboxError('scan_unreadable', `cannot stat an exclusion: ${error?.code ?? 'error'}`);
            }
            if (stat.isSymbolicLink()) throw invalid('exclusion is a symlink');
            found.push({ rel, kind: stat.isDirectory() ? 'dir' : 'file' });
        } finally {
            if (owned) { try { close(dir); } catch { /* closed */ } }
        }
    }
    return found;
}

// An exclusion at or below an entry that is already masked (a protected directory, or an earlier exclusion directory) is hidden
// already, and mounting below a masked directory is impossible: drop it.
export function dropCovered(extra, masked) {
    const kept = [];
    const covers = (outer, rel) => rel === outer.rel || (outer.kind === 'dir' && rel.startsWith(`${outer.rel}/`));
    for (const entry of [...extra].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || (a.rel < b.rel ? -1 : 1))) {
        if ([...masked, ...kept].some((outer) => covers(outer, entry.rel))) continue;
        kept.push(entry);
    }
    return kept;
}

export function verifyExclusionMasks(dirFd, entries, maskIds, lstat = defaultIo.lstat) {
    for (const entry of entries) {
        const id = maskIds[entry.kind];
        let stat;
        try { stat = lstat(`/proc/self/fd/${dirFd}/${entry.rel}`); } catch { throw sandboxError('mask_unverified', 'an exclusion cannot be read back'); }
        if (String(stat.dev) !== String(id.dev) || String(stat.ino) !== String(id.ino)) throw sandboxError('mask_unverified', 'an exclusion is not masked');
    }
    return { ok: true, checked: entries.length };
}
