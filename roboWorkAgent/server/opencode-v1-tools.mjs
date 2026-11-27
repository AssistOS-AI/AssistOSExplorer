import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The OpenCode 1 executable generation is the rollback target of the V1-to-V2 migration. Tool-cache garbage collection
// keeps only what a descriptor or a view names, so before it runs the one V1 generation is moved into the migration
// backup. Nothing under the backup's `v1-tool-cache` is ever removed here: that is an operator step after verification.

const GENERATION = /^[0-9a-f]{64}$/u;
const MAJOR = version => (typeof version === 'string' ? Number(version.split('.')[0]) : Number.NaN);

async function readJson(file) {
    try {
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (error) {
        if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}

const entryOrNull = file => fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });

// A stamp that names this OpenCode generation and an OpenCode below 2; null for anything else.
async function v1Stamp(generationsDirectory, generation, cacheSchema) {
    const stat = await entryOrNull(path.join(generationsDirectory, generation));
    if (!stat || !stat.isDirectory()) return null;
    const stamp = await readJson(path.join(generationsDirectory, generation, 'stamp.json'));
    if (stamp?.schema !== cacheSchema || stamp.name !== 'opencode' || stamp.generation !== generation) return null;
    return MAJOR(stamp.versions?.opencode) < 2 ? stamp : null;
}

// The V1 generation current.json names, or the newest prepared one when current.json already names OpenCode 2.
async function selectV1Generation(cacheRoot, cacheSchema) {
    const generationsDirectory = path.join(cacheRoot, 'opencode', 'generations');
    let entries;
    try { entries = await fs.readdir(generationsDirectory); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const found = new Map();
    for (const name of entries.filter(entry => GENERATION.test(entry)).sort()) {
        const stamp = await v1Stamp(generationsDirectory, name, cacheSchema);
        if (stamp) found.set(name, stamp);
    }
    if (!found.size) return null;
    const current = await readJson(path.join(cacheRoot, 'opencode', 'current.json'));
    const named = current?.schema === cacheSchema && current.name === 'opencode' ? current.generation : null;
    let generation = found.has(named) ? named : null;
    if (!generation) {
        const time = name => Date.parse(found.get(name).preparedAt) || 0;
        generation = [...found.keys()].sort((a, b) => time(b) - time(a) || (a < b ? 1 : -1))[0];
    }
    return { generation, stamp: found.get(generation), directory: path.join(generationsDirectory, generation) };
}

async function writeCurrent(directory, descriptor) {
    const file = path.join(directory, 'current.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
}

// An earlier interrupted copy, or anything that is not this exact V1 generation, is set aside inside the backup, never deleted.
async function setAside(backup, target, label) {
    if (!await entryOrNull(target)) return false;
    await fs.mkdir(path.join(backup, 'partial'), { recursive: true, mode: 0o700 });
    await fs.rename(target, path.join(backup, 'partial', `${label}-${randomUUID()}`));
    return true;
}

async function noteFailure(root, error) {
    const file = path.join(root, 'v1-retention-failures.json');
    let count = 1;
    try {
        count = (Number((await readJson(file))?.count) || 0) + 1;
        await fs.writeFile(file, `${JSON.stringify({ count, lastError: error?.code || error?.message || 'FAILED', at: new Date().toISOString() })}\n`, { mode: 0o600 });
    } catch { /* The count is only a report; the failure itself is what matters. */ }
    return count;
}

// Called once at startup, before tool-cache collection. Returns `{ generation, action }` with action 'moved', 'copied',
// 'present' or 'none' (`rename` exists for tests). A failure throws an error carrying `consecutiveFailures`; the caller must then keep every OpenCode
// generation (`keepBundles`), because collection could otherwise delete the only copy.
export async function retainV1OpenCode({ cacheRoot, root, cacheSchema, rename = fs.rename }) {
    try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const marker = path.join(root, 'tools-saved');
        if (await entryOrNull(marker)) return { generation: null, action: 'present' };
        const source = await selectV1Generation(cacheRoot, cacheSchema);
        if (!source) return { generation: null, action: 'none' };
        const backup = path.join(root, 'v1-tool-cache');
        const generations = path.join(backup, 'generations');
        await fs.mkdir(generations, { recursive: true, mode: 0o700 });
        const destination = path.join(generations, source.generation);
        let action;
        if (await v1Stamp(generations, source.generation, cacheSchema)) {
            // A complete copy from an earlier attempt; the live generation, if any, is left for collection.
            action = 'present';
        } else {
            await setAside(backup, destination, source.generation);
            try {
                await rename(source.directory, destination);
                action = 'moved';
            } catch (error) {
                if (error.code !== 'EXDEV') throw error;
                // Another filesystem: copy beside the destination first, so a killed copy is never mistaken for a backup.
                const staging = path.join(generations, `.copying-${source.generation}`);
                await setAside(backup, staging, `copying-${source.generation}`);
                await fs.cp(source.directory, staging, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
                await fs.rename(staging, destination);
                action = 'copied';
            }
        }
        await writeCurrent(backup, { schema: cacheSchema, name: 'opencode', generation: source.generation, versions: source.stamp.versions });
        await fs.writeFile(marker, '1\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await fs.rm(path.join(root, 'v1-retention-failures.json'), { force: true });
        return { generation: source.generation, action };
    } catch (error) {
        error.consecutiveFailures = await noteFailure(root, error);
        throw error;
    }
}
