import fs from 'node:fs/promises';
import path from 'node:path';

// Resolve registered remote or managed sources to the workspace checkout without mutating either.
export async function workspaceSkillSource(source, workspaceRoot) {
    let name;
    if (source.startsWith('https://')) {
        const url = new URL(source);
        if (url.username || url.password || url.search || url.hash) return source;
        name = path.posix.basename(url.pathname).replace(/\.git$/, '');
    } else if (path.isAbsolute(source) && path.dirname(path.resolve(source)) === path.join(path.resolve(workspaceRoot), '.ploinky', 'repos')) {
        name = path.basename(source);
    } else return source;
    if (!name || name === '.' || name === '..') return source;
    try {
        const workspace = await fs.realpath(workspaceRoot);
        const candidate = path.join(workspace, name);
        const root = await fs.realpath(candidate);
        if (root !== candidate) return source;
        const git = await fs.stat(path.join(root, '.git'));
        if (!git.isFile() && !git.isDirectory()) return source;
        if (!(await fs.lstat(path.join(root, 'skills'))).isDirectory()) return source;
        return root;
    } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return source;
        throw error;
    }
}
