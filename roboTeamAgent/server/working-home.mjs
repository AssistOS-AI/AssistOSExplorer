import { requireWorkspaceRoot } from './workspace-root.mjs';
import { workspaceDataPath } from './workspace-paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function linkGatewaySocket(home, original, workspaceRoot) {
    const relative = '.config/opencode/soul-gateway.sock';
    const source = path.join(original, relative);
    const socket = await fs.lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!socket?.isSocket()) return;
    const destination = path.join(home, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (!(await fs.realpath(path.dirname(destination))).startsWith(`${home}${path.sep}`)) throw new Error('Unsafe gateway socket parent');
    const visible = workspaceRoot ? await workspaceDataPath(source, workspaceRoot) : source;
    try { await fs.symlink(visible, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// Native accounts/caches stay writable only inside the selected working directory.
// Preserve the original home as migration evidence; never move or overwrite it.
export async function prepareWorkingHome(cwd, original, { workspaceRoot = requireWorkspaceRoot() } = {}) {
    cwd = await fs.realpath(cwd);
    original = await fs.realpath(original);
    if (original.startsWith(`${cwd}${path.sep}`)) return original;
    const identity = crypto.createHash('sha256').update(original).digest('hex').slice(0, 20);
    const parent = path.join(cwd, '.roboteam-homes');
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(parent)).isDirectory() || await fs.realpath(parent) !== parent) throw new Error('Unsafe native home parent');
    const home = path.join(parent, identity);
    try {
        if (!(await fs.lstat(home)).isDirectory() || await fs.realpath(home) !== home) throw new Error('Unsafe native home');
        await linkGatewaySocket(home, original, workspaceRoot);
        return home;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stage = await fs.mkdtemp(path.join(parent, '.prepare-'));
    try {
        await fs.cp(original, stage, { recursive: true, dereference: false, verbatimSymlinks: true,
            filter: async source => { const info = await fs.lstat(source); return info.isFile() || info.isDirectory() || info.isSymbolicLink(); } });
        try { await fs.rename(stage, home); }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    await linkGatewaySocket(home, original, workspaceRoot);
    return home;
}
