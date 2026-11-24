import fs from 'node:fs/promises';
import path from 'node:path';

// One-time removal of the nested Podman image store, tool cache and npm cache RoboTeam kept in its own
// data directory before RoboWork took over robot execution. All three are re-pullable or regenerable.
// A marker in the data directory keeps this from running twice and is written only after every
// path is handled, so a failed removal is retried at the next start. Version 2 added the npm cache,
// so a data directory cleaned by version 1 is cleaned once more.
export const LEGACY_RUNTIME_MARKER = 'roboteam-runtime-v2.cleaned';
export const LEGACY_RUNTIME_PATHS = ['podman', 'tool-cache', '.npm'];

async function removeDirectory(directory) {
    let stat;
    try { stat = await fs.lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    // Never follow a link out of the folder being cleaned.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
}

export async function removeLegacyRuntimeData({ dataDir, log = () => {} }) {
    const marker = path.join(dataDir, LEGACY_RUNTIME_MARKER);
    try { await fs.access(marker); return []; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const removed = [];
    for (const name of LEGACY_RUNTIME_PATHS) {
        const directory = path.join(dataDir, name);
        if (await removeDirectory(directory)) {
            removed.push(directory);
            log(`[roboTeamAgent] removed legacy runtime data ${directory}`);
        }
    }
    if (!removed.length) log('[roboTeamAgent] legacy runtime cleanup: nothing to remove');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return removed;
}
