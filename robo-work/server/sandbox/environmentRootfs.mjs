import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_RESERVED_NAMES = Object.freeze(['home', 'projects', 'run', 'tmp', 'proc', 'dev', 'sys', 'rw-stage', 'rw-opt', 'session', 'config', 'stream']);
const RESERVED = new Set(IMAGE_RESERVED_NAMES);
const NAME = /^rw-env-[a-f0-9]{32}$/u;
const LABEL = /^robo-work\.reservation=[a-f0-9]{32}$/u;
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
export const environmentError = (reason) => Object.assign(new Error('The selected environment is not available.'), { code: 'environment_unavailable', reason });

export function validRootfsLocator(locator) {
    return NAME.test(locator?.name) && LABEL.test(locator?.label) && locator.label.endsWith(locator.name.slice(7));
}

// All image-controlled links are resolved as container paths, including absolute links. A held root descriptor and
// no-follow opens prevent the host filesystem from becoming part of the image walk. No image process runs during preparation.
export function openImageRoot(root, { fdPath = (fd) => `/proc/self/fd/${fd}` } = {}) {
    const rootFd = fs.openSync(root, DIR_FLAGS);
    function resolve(virtual) {
        let pending = virtual.split('/').filter(Boolean);
        const parts = [];
        let links = 0;
        while (pending.length) {
            const name = pending.shift();
            if (name === '.') continue;
            if (name === '..') { if (!parts.length) throw environmentError('image_reserved_path'); parts.pop(); continue; }
            if (/[\0\n\r]/u.test(name)) throw environmentError('image_reserved_path');
            let parent = fs.openSync(`${fdPath(rootFd)}/.`, DIR_FLAGS);
            try {
                for (const part of parts) {
                    const next = fs.openSync(`${fdPath(parent)}/${part}`, DIR_FLAGS);
                    fs.closeSync(parent); parent = next;
                }
                const target = `${fdPath(parent)}/${name}`;
                const st = fs.lstatSync(target);
                if (st.isSymbolicLink()) {
                    if (++links > 40) throw environmentError('image_reserved_path');
                    const link = fs.readlinkSync(target);
                    if (link.startsWith('/')) parts.length = 0;
                    pending = [...link.split('/').filter(Boolean), ...pending];
                } else {
                    if (pending.length && !st.isDirectory()) throw environmentError('image_reserved_path');
                    parts.push(name);
                }
            } finally { fs.closeSync(parent); }
        }
        return parts;
    }
    function withPath(virtual, action) {
        const parts = resolve(virtual);
        let parent = fs.openSync(`${fdPath(rootFd)}/.`, DIR_FLAGS);
        try {
            for (const part of parts.slice(0, -1)) {
                const next = fs.openSync(`${fdPath(parent)}/${part}`, DIR_FLAGS);
                fs.closeSync(parent); parent = next;
            }
            return action(`${fdPath(parent)}/${parts.at(-1) ?? '.'}`);
        } finally { fs.closeSync(parent); }
    }
    return {
        rootFd, at: (name) => `${fdPath(rootFd)}/${name}`, resolve,
        stat: (virtual) => withPath(virtual, (target) => fs.lstatSync(target)),
        list: (virtual) => withPath(virtual, (target) => fs.readdirSync(target)),
        read(virtual, maxBytes = 64 * 1024 * 1024) {
            return withPath(virtual, (target) => {
                const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
                try {
                    const st = fs.fstatSync(fd);
                    if (!st.isFile() || st.size > maxBytes) throw environmentError('image_reserved_path');
                    return fs.readFileSync(fd);
                } finally { fs.closeSync(fd); }
            });
        },
        close: () => fs.closeSync(rootFd),
    };
}

export function prepareImageRoot(root, options = {}) {
    const reader = openImageRoot(root, options);
    try {
        for (const name of ['etc', 'opt']) {
            let st;
            try { st = fs.lstatSync(reader.at(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!st?.isDirectory() || st.isSymbolicLink()) throw environmentError('image_reserved_path');
        }
        const etc = fs.openSync(reader.at('etc'), DIR_FLAGS);
        try {
            const base = (options.fdPath ?? ((fd) => `/proc/self/fd/${fd}`))(etc);
            for (const name of ['resolv.conf', 'hosts']) {
                const file = `${base}/${name}`;
                let st;
                try { st = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (st && !st.isSymbolicLink() && !st.isFile()) throw environmentError('image_reserved_path');
                if (st?.isSymbolicLink()) fs.unlinkSync(file);
                const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
                fs.closeSync(fd);
            }
        } finally { fs.closeSync(etc); }
        const entries = [];
        let skipped = 0;
        const names = fs.readdirSync(reader.at('.'));
        if (names.length > 256) throw environmentError('image_reserved_path');
        for (const name of names.sort()) {
            if (RESERVED.has(name)) continue;
            if (!name || name === '.' || name === '..' || /[\/\0\n\r]/u.test(name)) throw environmentError('image_reserved_path');
            const st = fs.lstatSync(reader.at(name));
            if (st.isSymbolicLink()) {
                const target = fs.readlinkSync(reader.at(name));
                const destination = path.posix.resolve('/', target);
                if (RESERVED.has(destination.split('/')[1]) || /[\0\n\r]/u.test(target)) throw environmentError('image_reserved_path');
                entries.push({ name, kind: 'symlink', target });
            } else if (st.isDirectory() || st.isFile()) entries.push({ name, kind: st.isDirectory() ? 'directory' : 'file' });
            else {
                skipped += 1;
                const kind = st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : st.isBlockDevice() || st.isCharacterDevice() ? 'device' : 'other';
                const escaped = JSON.stringify(name).slice(1, -1).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
                    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).slice(0, 128);
                try { options.log?.('environment_image_entry_skipped', { name: escaped, kind, count: skipped }); }
                catch { /* advisory logging cannot turn a skipped entry into a bind */ }
            }
        }
        return entries;
    } finally { reader.close(); }
}

function mountPresent(mergedPath, readMounts) {
    if (!mergedPath) return true;
    const encoded = mergedPath.replace(/\\/gu, '\\134').replace(/ /gu, '\\040').replace(/\t/gu, '\\011').replace(/\n/gu, '\\012');
    return readMounts().split('\n').some((line) => line.split(' ')[4] === encoded);
}

export function createRootfsRecovery({ podman, readMounts = () => fs.readFileSync('/proc/self/mountinfo', 'utf8') } = {}) {
    const mergedPaths = new Map();
    function exists(locator) {
        if (!validRootfsLocator(locator)) return true;
        const result = podman.runSync(['container', 'exists', locator.name]);
        if (result.status === 0) {
            const inspect = podman.runSync(['inspect', '--type', 'container', locator.name]);
            try {
                const [info] = JSON.parse(inspect.stdout);
                const merged = info.GraphDriver?.Data?.MergedDir;
                if (inspect.status === 0 && typeof merged === 'string' && merged.startsWith('/')) mergedPaths.set(locator.name, merged);
            } catch { /* presence is already proven */ }
            return true;
        }
        if (result.status !== 1) return true;
        // The committed identity persists the merged path; it is also passed to this view by the walker.
        const merged = locator.mergedPath ?? mergedPaths.get(locator.name);
        if (!merged) {
            // An uncommitted, already-absent container has no mount whose path is known. Inspect the store's exact container
            // mount listing rather than assuming command failure means absence.
            const mounts = podman.runSync(['mount', '--format', 'json']);
            if (mounts.status !== 0) return true;
            try {
                const entries = JSON.parse(mounts.stdout);
                if (!Array.isArray(entries)) return true;
                return entries.some((entry) => {
                    const names = typeof entry.Name === 'string' ? [entry.Name] : Array.isArray(entry.Names) ? entry.Names : null;
                    return names === null || names.some((name) => typeof name !== 'string') || names.includes(locator.name);
                });
            } catch { return true; }
        }
        try { return mountPresent(merged, readMounts); } catch { return true; }
    }
    function remove(locator) {
        if (!validRootfsLocator(locator)) return false;
        const result = podman.runSync(['inspect', '--type', 'container', locator.name]);
        if (result.status !== 0) return !exists(locator);
        let info;
        try { [info] = JSON.parse(result.stdout); } catch { return false; }
        const labels = info?.Config?.Labels;
        if (labels?.['robo-work.reservation'] !== locator.name.slice(7)) return false;
        const merged = info.GraphDriver?.Data?.MergedDir;
        if (typeof merged === 'string') mergedPaths.set(locator.name, merged);
        podman.runSync(['umount', locator.name]);
        podman.runSync(['rm', '--force', locator.name]);
        return !exists(locator);
    }
    return { exists, remove };
}

export async function createEnvironmentRootfs({ podman, imageId, locator, workspaceId, executionId, signal, inspectRoot = prepareImageRoot, log = () => {} } = {}) {
    if (!validRootfsLocator(locator) || !/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw environmentError('image_mismatch');
    const create = await podman.run(['create', '--pull=never', '--network', 'none', '--name', locator.name,
        '--label', locator.label, '--label', `robo-work.workspace=${workspaceId}`, '--label', `robo-work.execution=${executionId}`,
        imageId, '/nonexistent'], { signal });
    if (create.status !== 0 || !/^[a-f0-9]{64}$/u.test(create.stdout.trim())) throw environmentError('runtime_unavailable');
    const mounted = await podman.run(['mount', locator.name], { signal });
    const mergedPath = mounted.stdout.trim();
    if (mounted.status !== 0 || !mergedPath.startsWith('/') || /[\0\n\r]/u.test(mergedPath)) throw environmentError('runtime_unavailable');
    const identity = { name: locator.name, containerId: create.stdout.trim(), mergedPath, imageId };
    const recovery = createRootfsRecovery({ podman });
    const owned = { ...locator, mergedPath };
    return {
        identity, entries: inspectRoot(mergedPath, { log }),
        async release() { const removed = recovery.remove(owned); const absent = removed && !recovery.exists(owned); return { absent, problems: absent ? [] : ['env-rootfs'] }; },
        verifyAbsent() { const absent = !recovery.exists(owned); return { absent, problems: absent ? [] : ['env-rootfs'] }; },
    };
}
