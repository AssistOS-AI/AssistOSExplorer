import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymlinks } from '../../../../server/no-follow-path.mjs';

// RoboTeam's own code (the bundled skills) is mounted at /code in its container, while the worker sees the same files as
// the managed repository `<workspace>/.ploinky/repos/<repo>/<agent>`. A skill folder can only be granted to the worker by that
// workspace path. The projection is accepted only when both spellings are the same file (device and inode of the folder),
// as for the /data projection in workspace-paths.mjs; otherwise there is no workspace path and the caller reports it.
//
// Decision M-60 (no symlink resolution in a path that reaches a folder grant):
//  - A source already in the workspace is workload-writable ground. It is checked below the workspace root component by component
//    (a link yields null: no grant path) and returned as the lexical path, never as a resolution of it.
//  - The workspace root's realpath is the anchor (`requireWorkspaceRoot` resolves it once, as the operator configures it).
//  - The `/code` projection is RoboTeam-owned (its bundle is mounted read-only into the container) and is accepted only when the
//    device and inode of both spellings are the same folder. Its resolved projected path is trusted for that reason.
export async function workspaceCodePath(source, { workspaceRoot, env = process.env, codeRoot = '/code', stat = fs.stat } = {}) {
    const root = await fs.realpath(workspaceRoot);
    const lexical = path.resolve(source);
    if (lexical.startsWith(`${root}${path.sep}`)) {
        try { return await assertNoSymlinks(root, lexical, { label: 'skill folder', code: 'skill_path_symlinked' }); } catch { return null; }
    }
    const real = await fs.realpath(source);
    if (real.startsWith(`${root}${path.sep}`)) return null;
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
