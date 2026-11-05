import fs from 'node:fs/promises';
import path from 'node:path';

// Entries of the workspace root that hold service or deployment state. A robot sees each as an empty read-only entry.
export const HIDDEN_WORKSPACE_ENTRIES = Object.freeze(['.data', '.ploinky', '.ploinky-box', '.env']);
// Ploinky quarantines former Box host state beside the root as `.ploinky-box.<suffix>`; it is hidden like `.ploinky-box`.
export const HIDDEN_WORKSPACE_PREFIX = '.ploinky-box.';
export const isHiddenWorkspaceEntry = name => HIDDEN_WORKSPACE_ENTRIES.includes(name) || name.startsWith(HIDDEN_WORKSPACE_PREFIX);

const MOUNTINFO = '/proc/self/mountinfo';
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function unavailable(message) {
    return Object.assign(new Error(message), { code: 'WORKSPACE_UNAVAILABLE', statusCode: 409 });
}

function within(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

const overlaps = (a, b) => within(a, b) || within(b, a);

// The kernel escapes a space, tab, newline, backslash and some other bytes in a mount point as \NNN octal.
function decodeMountPoint(value) {
    const bytes = Buffer.from(value, 'utf8').toString('latin1')
        .replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8) & 0xff));
    return Buffer.from(bytes, 'latin1').toString('utf8');
}

// One entry per line: `id parent major:minor root mountpoint options [optional...] - fstype source superoptions`.
// A malformed line is an error, because the list decides what stays writable.
export function parseMountinfo(content) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    const entries = [];
    for (const line of text.split('\n')) {
        if (line === '') continue;
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        if (separator < 6 || fields.length < separator + 3 || !/^\d+$/u.test(fields[0]) || !fields[4].startsWith('/')) {
            throw unavailable('The mount table is malformed');
        }
        entries.push({ mountPoint: decodeMountPoint(fields[4]), options: fields[5].split(',') });
    }
    return entries;
}

// The writable mounts below the root and outside the masks. Several mounts at one mount point leave only the last visible.
export function writableSubmounts(entries, root, masks) {
    const last = new Map();
    for (const entry of entries) {
        last.delete(entry.mountPoint);
        last.set(entry.mountPoint, entry.options);
    }
    return [...last].filter(([mountPoint, options]) => mountPoint !== root && within(root, mountPoint) && options.includes('rw')
        && !masks.some(mask => within(mask.path, mountPoint))).map(([mountPoint]) => mountPoint);
}

async function mask(root, entry) {
    let found = await fs.lstat(entry).catch(error => { if (MISSING.has(error.code)) return null; throw unavailable('A workspace entry cannot be inspected'); });
    // An absent entry has nothing to hide, and a robot cannot create one in a read-only root.
    if (!found) return null;
    let target = entry;
    if (found.isSymbolicLink()) {
        const resolved = await fs.realpath(entry).catch(error => { if (MISSING.has(error.code)) return null; throw unavailable('A workspace entry cannot be inspected'); });
        // A link that leads nowhere, or out of the root, shows nothing in the view.
        if (!resolved) return null;
        if (within(resolved, root)) throw unavailable('A hidden workspace entry leads to the workspace root or above');
        if (!within(root, resolved)) return null;
        target = resolved;
        found = await fs.stat(target).catch(() => { throw unavailable('A workspace entry cannot be inspected'); });
    }
    if (found.isDirectory()) return { path: target, directory: true };
    if (found.isFile()) return { path: target, directory: false };
    throw unavailable('A hidden workspace entry is neither a file nor a directory');
}

// Where a root can be shown. ALA refuses a destination at /workspace, where the Soul alias would also land inside the
// read-only root, and it refuses a root that overlaps the robot's own home.
export function assertShowableRoot(root, robotId) {
    if (root === '/workspace' || root === path.parse(root).root) throw unavailable('The workspace root cannot be shown at this path');
    if (overlaps(root, `/home/${robotId}`)) throw unavailable('The workspace root overlaps the robot home');
}

// The read-only view of the workspace that every robot execution path shows next to its writable working folder. The root
// stays at its canonical path; the masks and the writable submounts are computed for this start and nothing is written.
export async function workspaceView(workspaceRoot, { robotId, readFile = fs.readFile, platform = process.platform } = {}) {
    if (typeof robotId !== 'string' || !robotId) throw unavailable('A robot is required for the workspace view');
    const root = await fs.realpath(workspaceRoot).catch(() => { throw unavailable('The workspace root is unavailable'); });
    if (!(await fs.stat(root).catch(() => null))?.isDirectory()) throw unavailable('The workspace root is not a directory');
    assertShowableRoot(root, robotId);
    let names;
    try { names = await fs.readdir(root); } catch { throw unavailable('The workspace root cannot be listed'); }
    const hidden = [...HIDDEN_WORKSPACE_ENTRIES, ...names.filter(name => name.startsWith(HIDDEN_WORKSPACE_PREFIX)).sort()];
    const found = [];
    for (const name of hidden) {
        const entry = await mask(root, path.join(root, name));
        if (entry) found.push(entry);
    }
    // A mask inside another mask is already covered, and a second mount could not be placed under a read-only tmpfs.
    const distinct = [...new Map(found.map(entry => [entry.path, entry])).values()];
    const masks = distinct.filter(entry => !distinct.some(other => other !== entry && other.directory && within(other.path, entry.path)))
        .sort((a, b) => a.path.localeCompare(b.path));
    let submounts = [];
    if (platform === 'linux') {
        let content;
        try { content = await readFile(MOUNTINFO); } catch { throw unavailable('The mount table cannot be read'); }
        submounts = writableSubmounts(parseMountinfo(content), root, masks);
    }
    return { root, masks, writableSubmounts: submounts };
}

function assertView(view) {
    if (!view || typeof view.root !== 'string' || !path.isAbsolute(view.root) || !Array.isArray(view.masks)
        || !Array.isArray(view.writableSubmounts) || view.masks.some(entry => typeof entry?.path !== 'string' || !path.isAbsolute(entry.path))
        || view.writableSubmounts.some(entry => typeof entry !== 'string' || !path.isAbsolute(entry))) {
        throw unavailable('A workspace view is required');
    }
}

// A mask that holds the working folder, or lies inside it, would hide it or be covered by it.
function assertClear(view, cwd) {
    if (cwd && view.masks.some(entry => overlaps(entry.path, cwd))) throw unavailable('A workspace mask overlaps the working folder');
}

// Arguments for ALA, native or inside an Environment. A native run masks through ALA. An Environment container already
// carries its masks from Podman, where a character device cannot be named again as an ignored path.
export function alaWorkspaceOptions(view, { cwd, home, environment = false } = {}) {
    assertView(view); assertClear(view, cwd);
    // The folder's private project data holds records RoboTeam reads back; it comes first, as it always has. The robot home
    // has none to mask.
    const ignoredPaths = cwd && cwd !== home ? [path.join(cwd, '.roboteam')] : [];
    if (!environment) ignoredPaths.push(...view.masks.map(entry => entry.path));
    return { folders: [{ source: view.root }], ignoredPaths };
}

// Podman arguments for a container that holds the view. `ro` covers only the top mount there, so every writable submount of
// the root is mounted read-only again; the masks are empty read-only mounts, and the working folder is mounted after them.
export function podmanWorkspaceArguments(view, { cwd, volumeFlag = '--volume' } = {}) {
    assertView(view); assertClear(view, cwd);
    const named = value => {
        if (/[:,\n\r\0]/u.test(value)) throw unavailable('A workspace path cannot be passed to a container');
        return value;
    };
    const { root } = view;
    const args = [volumeFlag, `${named(root)}:${root}:ro,rbind`];
    for (const submount of view.writableSubmounts) {
        if (cwd && within(cwd, submount)) continue;
        args.push(volumeFlag, `${named(submount)}:${submount}:ro`);
    }
    for (const entry of view.masks) {
        named(entry.path);
        if (entry.directory) args.push('--tmpfs', `${entry.path}:ro,size=64k,mode=0555,nosuid,nodev,noexec,notmpcopyup`);
        else args.push(volumeFlag, `/dev/null:${entry.path}:ro`);
    }
    return args;
}
