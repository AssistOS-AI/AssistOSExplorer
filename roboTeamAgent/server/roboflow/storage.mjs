import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const locks = new Map();

export async function ensureDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('roboflow storage path must be a real directory');
}

// Single-process serialization. RoboFlow runs inside one RoboTeam service, so a
// keyed promise chain plus atomic rename is sufficient for consistency.
export function withLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    return current.finally(() => {
        if (locks.get(key) === current) locks.delete(key);
    });
}

export async function writeJsonAtomic(file, value) {
    await ensureDirectory(path.dirname(file));
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${process.pid}-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
}

export async function readJson(file) {
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
    if (!handle) return null;
    try {
        if (!(await handle.stat()).isFile()) throw new Error('roboflow record is not a regular file');
        return JSON.parse(await handle.readFile('utf8'));
    } finally {
        await handle.close();
    }
}

export async function listDirectories(directory) {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
}

export async function appendFileBounded(file, text, limit) {
    await ensureDirectory(path.dirname(file));
    let existing = '';
    try {
        existing = await fs.readFile(file, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const combined = existing + String(text ?? '');
    const bounded = combined.length > limit ? combined.slice(combined.length - limit) : combined;
    await fs.writeFile(file, bounded, { mode: 0o600 });
    return bounded.length;
}

export async function readFileBounded(file, limit) {
    try {
        const value = await fs.readFile(file, 'utf8');
        return value.length > limit ? value.slice(0, limit) : value;
    } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
    }
}

export async function removePath(target) {
    await fs.rm(target, { recursive: true, force: true });
}

export async function listFiles(directory, suffix = '') {
    let entries;
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    return entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix)).map((entry) => entry.name);
}

export const storageInternals = { ensureDirectory };
