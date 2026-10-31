import fs from 'node:fs';
import path from 'node:path';

// Decision M-60: RoboTeam never resolves symlinks in a path that can reach a worker admission field (a working folder, a
// folder grant, a skill source, a registered project, a schedule folder). Such a path is either validated here, component by
// component without following links, and used as written, or it is sent unresolved. The worker's anchored O_NOFOLLOW
// resolver is the only resolver. The anchor is a trusted directory (the workspace root, which the operator configures and
// which is resolved once by `requireWorkspaceRoot`); components above it are not inspected, components below it must not be
// links.
const CODE = 'cwd_symlinked';

export function symlinkedPath(label = 'working folder', code = CODE) {
    return Object.assign(new Error(`${code}: a folder in the ${label} path is a link. Pick the ${label} again.`), { code, statusCode: 400 });
}

// The part of `candidate` below `root`, as segments; null when the candidate is not the root or inside it (lexically).
export function segmentsBelow(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (relative === '') return [];
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return relative.split(path.sep);
}

// Rebases a path spelled with one of `aliases` (a configured but unresolved spelling of the root, or the host's spelling of it)
// onto `root`; a path already below `root` is returned as it is. Purely lexical. Null when the path is in none of them.
export function rebaseOnRoot(root, candidate, aliases = []) {
    const full = path.resolve(candidate);
    for (const spelling of [root, ...aliases.filter(Boolean)]) {
        const below = segmentsBelow(spelling, full);
        if (below) return path.join(path.resolve(root), ...below);
    }
    return null;
}

function check(stat, current, { label, code, intermediate, type }) {
    if (stat.isSymbolicLink()) throw symlinkedPath(label, code);
    if (intermediate && !stat.isDirectory()) throw Object.assign(new Error(`${label} path component is not a directory: ${path.basename(current)}`), { code: 'ENOTDIR', statusCode: 400 });
    if (!intermediate && type === 'directory' && !stat.isDirectory()) throw Object.assign(new Error(`${label} must reference a directory`), { code: 'ENOTDIR', statusCode: 400 });
}

// Walks `target` below `root` with lstat and refuses any component that is a link. Returns the lexical path. The tail may be
// missing only with `allowMissing` (a folder the caller creates); any other error, a missing folder included, is thrown.
export async function assertNoSymlinks(root, target, { label = 'working folder', code = CODE, type = 'directory', allowMissing = false } = {}) {
    const below = segmentsBelow(root, target);
    if (!below) throw Object.assign(new Error(`${label} must stay inside the workspace`), { code: 'ENOTWORKSPACE', statusCode: 400 });
    let current = path.resolve(root);
    for (let index = 0; index < below.length; index += 1) {
        current = path.join(current, below[index]);
        let stat;
        try { stat = await fs.promises.lstat(current); }
        catch (error) { if (allowMissing && error.code === 'ENOENT') break; throw error; }
        check(stat, current, { label, code, intermediate: index < below.length - 1, type });
    }
    return path.join(path.resolve(root), ...below);
}

export function assertNoSymlinksSync(root, target, { label = 'working folder', code = CODE, type = 'directory', allowMissing = false } = {}) {
    const below = segmentsBelow(root, target);
    if (!below) throw Object.assign(new Error(`${label} must stay inside the workspace`), { code: 'ENOTWORKSPACE', statusCode: 400 });
    let current = path.resolve(root);
    for (let index = 0; index < below.length; index += 1) {
        current = path.join(current, below[index]);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) { if (allowMissing && error.code === 'ENOENT') break; throw error; }
        check(stat, current, { label, code, intermediate: index < below.length - 1, type });
    }
    return path.join(path.resolve(root), ...below);
}
