import fs from 'node:fs/promises';
import path from 'node:path';

import { projectDirectories } from './project-storage.mjs';

// One-time removal of storage replaced by .roboteam and ALA transcripts:
// each registered project's .achilles-cli and .ala-pi-sessions directories,
// and the native session records ALA kept in every robot home. Nothing is
// migrated. A marker in the data directory keeps this from running twice.
export const LEGACY_STORAGE_MARKER = 'roboteam-storage-v2.cleaned';

async function removeDirectory(directory) {
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // Never follow a link out of the folder being cleaned.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
}

export async function removeLegacyStorage({ dataDir, workspaceRoot, log = () => {} }) {
    const marker = path.join(dataDir, LEGACY_STORAGE_MARKER);
    try { await fs.access(marker); return []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const candidates = [];
    for (const cwd of projectDirectories({ dataDir, workspaceRoot })) {
        candidates.push(path.join(cwd, '.achilles-cli'), path.join(cwd, '.ala-pi-sessions'));
    }
    const robots = await fs.readdir(path.join(dataDir, 'robots'), { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    for (const robot of robots) if (robot.isDirectory()) candidates.push(path.join(dataDir, 'robots', robot.name, 'home', '.ala', 'sessions'));
    const removed = [];
    for (const directory of candidates) if (await removeDirectory(directory)) removed.push(directory);
    for (const directory of removed) log(`Removed legacy conversation storage ${directory}`);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return removed;
}
