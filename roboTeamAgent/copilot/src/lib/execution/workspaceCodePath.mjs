import fs from 'node:fs/promises';
import path from 'node:path';

// RoboTeam's own code (the bundled skills) is mounted at /code in its container, while the worker sees the same files as
// the managed repository `<workspace>/.ploinky/repos/<repo>/<agent>`. A skill folder can only be granted to the worker by that
// workspace path. The projection is accepted only when both spellings are the same file (device and inode of the folder),
// as for the /data projection in workspace-paths.mjs; otherwise there is no workspace path and the caller reports it.
export async function workspaceCodePath(source, { workspaceRoot, env = process.env, codeRoot = '/code', stat = fs.stat } = {}) {
    const root = await fs.realpath(workspaceRoot);
    const real = await fs.realpath(source);
    if (real.startsWith(`${root}${path.sep}`)) return real;
    if (real !== codeRoot && !real.startsWith(`${codeRoot}${path.sep}`)) return null;
    const identity = /^agent:([^/]+)\/([^/]+)$/u.exec(String(env.PLOINKY_AGENT_ID || ''));
    if (!identity) return null;
    const projected = path.join(root, '.ploinky', 'repos', identity[1], identity[2], path.relative(codeRoot, real));
    try {
        const [actual, visible] = await Promise.all([stat(real), stat(projected)]);
        if (!visible.isDirectory() || actual.dev !== visible.dev || actual.ino !== visible.ino) return null;
        return await fs.realpath(projected);
    } catch {
        return null;
    }
}
