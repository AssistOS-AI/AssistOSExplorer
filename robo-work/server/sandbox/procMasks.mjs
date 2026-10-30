// Classifier for the masks that the worker container's runtime places under /proc (plan Revision 10, decision M-4).
//
// Why: a new procfs mount (bwrap `--proc /proc`) is refused by the kernel while the mount namespace's existing /proc
// has submounts that hide part of it ("Can't mount proc on /proc"). The prep stage therefore lazily unmounts those
// submounts inside its PRIVATE mount namespace, and bwrap re-applies the same protection inside the sandbox. Both sides
// use this one classification of the worker container's own /proc/self/mountinfo, read once at supervisor start.
//
//   parseProcSubmounts(text)  -> [{ mountId, mountpoint, root, fstype }]     every mount strictly below /proc/
//   classifyProcMasks(text)   -> { masks: [{ path, kind, bwrap }], unclassified: [{ path, fstype, root }] }
//        kind  'null-file'  a devtmpfs file bind (the runtime's /dev/null mask)  bwrap: `--ro-bind /dev/null <path>`
//              'empty-dir'  a tmpfs directory mask                               bwrap: `--perms 0555 --tmpfs <path> --remount-ro <path>`
//              'proc-ro'    a read-only bind of a procfs subtree (sys, sysrq-trigger, irq, bus, fs, asound)
//                                                                                bwrap: see PROC_RO_BWRAP below (ro-bind-self, ro-bind-null or empty-dir)
//        masks are ordered deepest first (the order to unmount in).
//   readProcMasks({ readFile })  -> masks; throws sandbox_unavailable when mountinfo is unreadable or any submount
//        cannot be classified (an unclassified submount would be refused at every start, so it fails closed here).
//
// The classification is by filesystem type and root, never by a name list alone: a procfs bind is accepted only at the
// matching /proc/<name>, a devtmpfs bind or a tmpfs mount only as the runtime's mask shapes.

import fs from 'node:fs';

import { sandboxError } from './sandboxErrors.mjs';

// How bwrap re-applies a procfs-subtree mask. Observed with bwrap 0.12.0 in the nested container: `--remount-ro` on
// /proc/sys, /proc/fs, ... fails ("Unable to find ... in mount table") because they are not mountpoints in bwrap's fresh
// procfs. sys is therefore a read-only bind of itself; sysrq-trigger is covered by /dev/null; irq, bus, fs and asound are
// replaced by empty read-only directories (asound otherwise lists the host's sound cards).
const PROC_RO_BWRAP = new Map([
    ['sys', 'ro-bind-self'], ['sysrq-trigger', 'ro-bind-null'], ['irq', 'empty-dir'], ['bus', 'empty-dir'],
    ['fs', 'empty-dir'], ['asound', 'empty-dir']
]);
const unescapeMount = (text) => text.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function parseProcSubmounts(text) {
    const out = [];
    for (const line of String(text).split('\n')) {
        if (line === '') continue;
        const parts = line.split(' ');
        const separator = parts.indexOf('-', 6);
        if (parts.length < 10 || separator < 0 || separator + 1 >= parts.length) throw sandboxError('sandbox_unavailable', 'malformed mountinfo line');
        const mountpoint = unescapeMount(parts[4]);
        if (!mountpoint.startsWith('/proc/')) continue;
        out.push({ mountId: Number(parts[0]), mountpoint, root: unescapeMount(parts[3]), fstype: parts[separator + 1] });
    }
    return out;
}

const depthOf = (path) => path.split('/').length;

export function classifyProcMasks(text) {
    const masks = [];
    const unclassified = [];
    for (const mount of parseProcSubmounts(text)) {
        const { mountpoint: path, fstype, root } = mount;
        if (fstype === 'devtmpfs' && root.startsWith('/') && !root.includes('/', 1)) {
            masks.push({ path, kind: 'null-file', bwrap: 'ro-bind-null' });
        } else if (fstype === 'tmpfs' && (root === '/' || /^\/[^\0]*\/crun\/\.empty-directory$/u.test(root))) {
            // A tmpfs of its own (podman/runc), or crun's shared read-only empty directory (crun in a nested Box binds
            // <run>/crun/.empty-directory over masked directories).
            masks.push({ path, kind: 'empty-dir', bwrap: 'empty-dir' });
        } else if (fstype === 'proc' && path === `/proc${root}` && root.indexOf('/', 1) === -1) {
            const name = root.slice(1);
            if (PROC_RO_BWRAP.has(name)) masks.push({ path, kind: 'proc-ro', bwrap: PROC_RO_BWRAP.get(name) });
            else unclassified.push({ path, fstype, root });
        } else {
            unclassified.push({ path, fstype, root });
        }
    }
    masks.sort((a, b) => depthOf(b.path) - depthOf(a.path) || (a.path < b.path ? -1 : 1));
    return { masks, unclassified };
}

export function readProcMasks({ readFile = (file) => fs.readFileSync(file, 'utf8'), file = '/proc/self/mountinfo' } = {}) {
    let text;
    try {
        text = readFile(file);
    } catch (error) {
        throw sandboxError('sandbox_unavailable', `mountinfo unreadable: ${error?.code ?? 'error'}`);
    }
    const { masks, unclassified } = classifyProcMasks(text);
    if (unclassified.length > 0) throw sandboxError('sandbox_unavailable', `unclassified /proc submount: ${unclassified[0].path}`);
    return masks;
}

// The bwrap arguments that re-apply the masks after `--proc /proc`. `exists(path)` skips a path the fresh procfs lacks.
export function procMaskArgs(masks, exists = () => true) {
    const args = [];
    for (const mask of masks) {
        if (!exists(mask.path)) continue;
        if (mask.bwrap === 'ro-bind-null') args.push('--ro-bind', '/dev/null', mask.path);
        else if (mask.bwrap === 'empty-dir') args.push('--perms', '0555', '--tmpfs', mask.path, '--remount-ro', mask.path);
        else if (mask.bwrap === 'ro-bind-self') args.push('--ro-bind', mask.path, mask.path);
        else throw sandboxError('invalid_request', `unknown mask strategy ${mask.bwrap}`);
    }
    return args;
}
