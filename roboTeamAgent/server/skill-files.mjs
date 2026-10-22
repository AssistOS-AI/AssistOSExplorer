import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const skillError = (message) => Object.assign(new Error(message), { statusCode: 400 });
export const inside = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
export const hashValue = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Content, membership and executable modes participate in every capture. No timestamp cache.
export async function readSkillTree(root, { budget = { bytes: 0, files: 0 }, skipDependencies = false } = {}) {
    const records = [];
    const canonical = await fs.realpath(root);
    if (process.platform === 'linux' && path.resolve(root) !== canonical) throw skillError('skill root changed or contains a symbolic link');
    root = canonical;
    const changed = () => skillError('skill changed during capture');
    async function visit(file, relative, depth) {
        if (depth > 32) throw skillError('skill directory nesting exceeds 32');
        budget.entries = (budget.entries || 0) + 1;
        if (budget.entries > 10000) throw skillError('skill catalog exceeds 10000 file/directory entries');
        const before = await fs.lstat(file);
        if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
            throw skillError('skills cannot contain symbolic links or special files');
        }
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
            | (before.isDirectory() ? fs.constants.O_DIRECTORY : 0));
        try {
            const opened = await handle.stat();
            if (opened.ino !== before.ino || opened.dev !== before.dev || opened.mode !== before.mode) throw changed();
            // Linux captures traverse held directory descriptors. Renaming a parent cannot redirect a child read.
            const anchored = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : file;
            const expected = path.join(root, relative);
            if (await fs.realpath(anchored) !== expected) throw changed();
            if (opened.isDirectory()) {
                records.push({ path: relative, type: 'dir', mode: opened.mode & 0o111 });
                const names = (await fs.readdir(anchored)).sort();
                for (const name of names) {
                    if (skipDependencies && ['.git', 'node_modules'].includes(name)) continue;
                    await visit(path.join(anchored, name), relative ? `${relative}/${name}` : name, depth + 1);
                }
                if (JSON.stringify(names) !== JSON.stringify((await fs.readdir(anchored)).sort())) throw changed();
            } else if (opened.isFile()) {
                budget.bytes += opened.size;
                if (++budget.files > 5000 || budget.bytes > 64 * 1024 * 1024) throw skillError('skill catalog exceeds 64 MiB or 5000 files');
                const data = await handle.readFile();
                const after = await handle.stat();
                if (after.size !== data.length || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
                    || opened.ctimeMs !== after.ctimeMs || opened.mode !== after.mode) throw changed();
                records.push({ path: relative, type: 'file', mode: opened.mode & 0o111, data });
            } else throw skillError('skills cannot contain special files');
            const after = await fs.lstat(file);
            if (before.ino !== after.ino || before.dev !== after.dev || before.mode !== after.mode
                || await fs.realpath(anchored) !== expected) throw changed();
        } finally { await handle.close(); }
    }
    await visit(root, '', 0);
    return records;
}

export function treeFingerprint(records) {
    const hash = crypto.createHash('sha256');
    for (const entry of records) {
        hash.update(JSON.stringify([entry.path, entry.type, entry.mode, entry.data?.length || 0]));
        if (entry.data) hash.update(entry.data);
    }
    return hash.digest('hex');
}

export async function writeSkillTree(records, target) {
    for (const entry of records) {
        const file = path.join(target, entry.path);
        if (entry.type === 'dir') await fs.mkdir(file, { mode: 0o700 });
        else {
            await fs.writeFile(file, entry.data, { flag: 'wx', mode: 0o400 | entry.mode });
            await fs.chmod(file, 0o400 | entry.mode);
        }
    }
    // Directory traversal bits are relevant too; retain them for digest validation.
    for (const entry of [...records].reverse()) {
        if (entry.type === 'dir') await fs.chmod(path.join(target, entry.path), 0o600 | entry.mode);
    }
}

export async function catalogDigest(root) {
    return treeFingerprint(await readSkillTree(root));
}

export async function atomicJson(file, value) {
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
}
