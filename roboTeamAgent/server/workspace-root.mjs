import fs from 'node:fs';
import path from 'node:path';

// The workspace root is the one resolved anchor (decision M-60): the operator configures PLOINKY_WORKSPACE_ROOT, a workload cannot
// write it, and every other path that can reach a worker admission field is validated below it without following links.
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
