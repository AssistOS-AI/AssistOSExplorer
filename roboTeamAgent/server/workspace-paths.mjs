import { requireWorkspaceRoot } from './workspace-root.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

// /root is a RoboTeam container alias. Robot sandboxes use the workspace spelling.
export async function workspaceDataPath(source, workspaceRoot = requireWorkspaceRoot()) {
    const root = await fs.realpath(workspaceRoot);
    const resolved = await fs.realpath(source);
    if (resolved.startsWith(`${root}${path.sep}`)) return resolved;
    if (resolved !== '/root' && !resolved.startsWith('/root/')) throw new Error('Robot data is outside the Ploinky workspace');
    const projected = path.join(root, '.data/agents/roboTeamAgent', path.relative('/root', resolved));
    const [actual, visible] = await Promise.all([fs.stat(resolved), fs.stat(projected)]);
    if (actual.dev !== visible.dev || actual.ino !== visible.ino) throw new Error('Robot data workspace projection does not match');
    return fs.realpath(projected);
}
