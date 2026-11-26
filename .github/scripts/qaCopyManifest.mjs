#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function validPath(value) {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
        && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Accept only the complete, version-independent record shapes emitted here.
export function validateManifest(value) {
    if (!Array.isArray(value)) throw new Error('Invalid manifest');
    const records = value.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || !validPath(record.path) || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
            throw new Error('Invalid manifest record');
        }
        const keys = Object.keys(record).sort().join(',');
        if (record.type === 'file' && keys === 'executable,path,sha256,type'
            && typeof record.executable === 'boolean') {
            return { path: record.path, type: 'file', sha256: record.sha256, executable: record.executable };
        }
        if (record.type === 'symlink' && keys === 'path,sha256,type') {
            return { path: record.path, type: 'symlink', sha256: record.sha256 };
        }
        throw new Error('Invalid manifest record');
    }).sort((a, b) => compare(a.path, b.path));
    const seen = new Set();
    for (const record of records) {
        if (seen.has(record.path)) throw new Error('Duplicate manifest path');
        const components = record.path.split('/');
        components.pop();
        while (components.length) {
            if (seen.has(components.join('/'))) throw new Error('Conflicting manifest paths');
            components.pop();
        }
        seen.add(record.path);
    }
    return records;
}

export function sourceManifest(root) {
    const base = path.resolve(root);
    if (!fs.lstatSync(base).isDirectory()) throw new Error('Source must be a directory');
    const records = [];
    let count = 0;
    let bytes = 0;
    const maxEntries = 100000;
    const maxBytes = 2 * 1024 * 1024 * 1024;
    const stable = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
        && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    function visit(directory, prefix) {
        const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
            const before = fs.fstatSync(fd);
            // Linux procfs paths anchor each lookup to the open parent, even if
            // a directory name is concurrently replaced. Other hosts use the
            // original path and fail if their observed directory changes.
            const anchored = process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory;
            for (const rawName of fs.readdirSync(anchored, { encoding: 'buffer' })) {
                if (++count > maxEntries) throw new Error('Source entry limit exceeded');
                const name = rawName.toString('utf8');
                if (!Buffer.from(name).equals(rawName)) throw new Error('Unsupported filename encoding');
                const relative = prefix ? `${prefix}/${name}` : name;
                if (!validPath(relative)) throw new Error('Invalid source path');
                const entry = path.join(anchored, name);
                const info = fs.lstatSync(entry);
                if (info.isSymbolicLink()) {
                    const target = fs.readlinkSync(entry, { encoding: 'buffer' });
                    if (!stable(info, fs.lstatSync(entry))) throw new Error('Source changed');
                    records.push({ path: relative, type: 'symlink', sha256: digest(target) });
                } else if (info.isDirectory()) {
                    visit(entry, relative);
                } else if (info.isFile()) {
                    const file = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
                    try {
                        const opened = fs.fstatSync(file);
                        if (!opened.isFile() || !stable(opened, info)) throw new Error('Source changed');
                        if (opened.size > maxBytes - bytes) throw new Error('Source byte limit exceeded');
                        const hash = createHash('sha256');
                        const buffer = Buffer.allocUnsafe(128 * 1024);
                        let length;
                        while ((length = fs.readSync(file, buffer, 0, buffer.length, null)) > 0) {
                            bytes += length;
                            if (bytes > maxBytes) throw new Error('Source byte limit exceeded');
                            hash.update(buffer.subarray(0, length));
                        }
                        if (!stable(opened, fs.fstatSync(file))) throw new Error('Source changed');
                        records.push({ path: relative, type: 'file', sha256: hash.digest('hex'), executable: Boolean(opened.mode & 0o111) });
                    } finally {
                        fs.closeSync(file);
                    }
                } else {
                    throw new Error('Unsupported source entry');
                }
            }
            if (!stable(before, fs.fstatSync(fd))) throw new Error('Source changed');
        } finally {
            fs.closeSync(fd);
        }
    }
    visit(base, '');
    return validateManifest(records);
}

export function diffManifests(baseline, live) {
    const before = new Map(validateManifest(baseline).map(record => [record.path, record]));
    const after = new Map(validateManifest(live).map(record => [record.path, record]));
    return [...new Set([...before.keys(), ...after.keys()])].sort(compare).flatMap(name => {
        if (!before.has(name)) return [{ status: 'A', path: name }];
        if (!after.has(name)) return [{ status: 'D', path: name }];
        if (JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))) return [{ status: 'M', path: name }];
        return [];
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.length !== 3) throw new Error('Usage: node qaCopyManifest.mjs <source-directory>');
        process.stdout.write(`${JSON.stringify(sourceManifest(process.argv[2]))}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
