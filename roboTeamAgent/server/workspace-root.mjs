import fs from 'node:fs';
import path from 'node:path';

export function requireWorkspaceRoot(env = process.env) {
    const value = env?.PLOINKY_WORKSPACE_ROOT;
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('PLOINKY_WORKSPACE_ROOT is required; RoboTeam must run with a configured Ploinky workspace.');
    }
    if (!path.isAbsolute(value)) throw new Error('PLOINKY_WORKSPACE_ROOT must be an absolute directory.');
    try {
        const root = fs.realpathSync(value);
        if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
        return root;
    } catch (cause) {
        throw new Error('PLOINKY_WORKSPACE_ROOT must reference an accessible existing directory.', { cause });
    }
}
