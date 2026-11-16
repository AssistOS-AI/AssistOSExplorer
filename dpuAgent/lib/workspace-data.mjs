import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { requireAuthenticatedActor } from './dpu-store-internal/identity-acl.mjs';
import { loadPermissionsManifest } from './dpu-store-internal/storage.mjs';
import { appendToolAudit, assertInvocationScopeFor } from './dpu-store.mjs';

export const DATA_TOOLS = ['dpu_data_list', 'dpu_data_stat', 'dpu_data_read', 'dpu_data_download'];
const MAX_CHUNK = 1024 * 1024;
const PRIVATE_PATH = 'agents/explorer';

function relativePath(value = '') {
    if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) throw new Error('Invalid data path.');
    if (value && value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid data path.');
    return value;
}

function allowed(relative, admin) {
    if (relative === 'dpu-data/master-key' || relative.startsWith('dpu-data/master-key/') || relative.startsWith('dpu-data/master-key.')) return false;
    return admin || ['', 'agents', PRIVATE_PATH].includes(relative) || relative.startsWith(`${PRIVATE_PATH}/`);
}

// Open each directory through its descriptor. An agent can rename its own
// files concurrently; path checks followed by an ordinary open are insufficient.
async function openEntry(root, relative, handles) {
    const directoryFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
    let handle = await fs.open(root, directoryFlags);
    handles.push(handle);
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
        handle = await fs.open(`/proc/self/fd/${handle.fd}/${parts[i]}`,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            | (i < parts.length - 1 ? constants.O_DIRECTORY : 0));
        handles.push(handle);
    }
    const stat = await handle.stat();
    if (!(stat.isDirectory() || stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Unsupported data entry.');
    return { handle, stat };
}

function describe(relative, stat) {
    return { name: relative.split('/').pop() || '.data', path: relative,
        type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime.toISOString() };
}

export async function executeWorkspaceDataTool(tool, authInfo, args = {}) {
    if (!DATA_TOOLS.includes(tool)) throw new Error('Unknown data operation.');
    const handles = [];
    let relative = '';
    try {
        assertInvocationScopeFor(tool, authInfo);
        const actor = requireAuthenticatedActor(authInfo, await loadPermissionsManifest());
        if (actor.agentPrincipalId || actor.roles.includes('guest')) throw new Error('A user session is required.');
        const admin = actor.roles.map(role => String(role).toLowerCase()).includes('admin')
            || actor.id === 'local:admin' || actor.username === 'admin';
        relative = relativePath(args.path);
        if (!allowed(relative, admin)) throw new Error('Access denied.');
        const root = process.env.DPU_WORKSPACE_DATA_ROOT;
        if (!root || !path.isAbsolute(root)) throw new Error('Workspace data root is unavailable.');
        const { handle, stat } = await openEntry(root, relative, handles);
        let result;
        if (tool === 'dpu_data_list') {
            if (!stat.isDirectory()) throw new Error('Not a directory.');
            const directory = await fs.opendir(`/proc/self/fd/${handle.fd}`);
            const items = [];
            let visited = 0;
            for await (const entry of directory) {
                if (++visited > 10000) throw new Error('Directory is too large to list.');
                const child = relative ? `${relative}/${entry.name}` : entry.name;
                if (!allowed(child, admin)) continue;
                const childStat = await fs.lstat(`/proc/self/fd/${handle.fd}/${entry.name}`).catch(() => null);
                if (!childStat || childStat.isSymbolicLink() || (!childStat.isDirectory() && (!childStat.isFile() || childStat.nlink !== 1))) continue;
                items.push(describe(child, childStat));
            }
            result = { items: items.sort((a, b) => a.name.localeCompare(b.name)) };
        } else if (tool === 'dpu_data_stat') result = { item: describe(relative, stat) };
        else {
            if (!stat.isFile() || (!admin && !relative.startsWith(`${PRIVATE_PATH}/`))) throw new Error('Not a readable file.');
            const offset = args.offset ?? 0;
            const length = args.length ?? MAX_CHUNK;
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK) throw new Error('Invalid read range.');
            const bytes = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
            result = { item: describe(relative, stat), encoding: 'base64', content: bytes.subarray(0, bytesRead).toString('base64'), offset, nextOffset: offset + bytesRead, eof: offset + bytesRead >= stat.size };
        }
        await appendToolAudit(authInfo, tool, { id: relative });
        return { ok: true, ...result };
    } catch {
        await appendToolAudit(authInfo, tool, { id: relative }, 'error', 'Data access refused.');
        return { ok: false, error: 'Workspace data access refused or unavailable.' };
    } finally {
        for (const handle of handles.reverse()) await handle.close();
    }
}
