import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

// O_PATH needs only search permission on each directory. It has this value on the Linux architectures RoboWork runs on.
const O_PATH = process.platform === 'linux' ? 0o10000000 : 0;
const WALK_FLAGS = O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export function fail(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

export function robotId(value) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(value)) throw fail('INVALID_INPUT', 'Invalid robotId');
    return value;
}

export function runId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(value)) throw fail('INVALID_INPUT', 'Invalid runId');
    return value;
}

export function within(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Walks a canonical path one component at a time and never through a link, so the directory reached is the path that was
// checked even when a robot swaps a component meanwhile. On Linux each step opens relative to the directory just reached.
async function openDirectory(directory) {
    let current = path.parse(directory).root;
    let handle = await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        for (const name of directory.split(path.sep).filter(Boolean)) {
            current = path.join(current, name);
            const next = await fs.open(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}/${name}` : current, WALK_FLAGS);
            await handle.close();
            handle = next;
        }
        return handle;
    } catch (error) { await handle.close(); throw error; }
}

const identityOf = async handle => { const stat = await handle.stat({ bigint: true }); return `${stat.dev}:${stat.ino}`; };

export async function directoryIdentity(directory) {
    const handle = await openDirectory(directory);
    try { return await identityOf(handle); } finally { await handle.close(); }
}

// Opens a granted directory and names it for nested Podman through this process's descriptor, so no later swap of its
// path can change what is mounted. The descriptor must stay open until the container has started.
export async function pinDirectory(directory, identity, code = 'FOLDER_REFUSED') {
    const handle = await openDirectory(directory).catch(() => null);
    if (handle && await identityOf(handle) === identity) return { source: `/proc/${process.pid}/fd/${handle.fd}`, close: () => handle.close() };
    await handle?.close();
    throw fail(code, 'A granted folder changed before it was mounted');
}

// ALA keeps transcripts and a session keeps its mask in a folder's private data, where a robot may have planted something else.
export async function assertPrivateDirectory(cwd, code) {
    const entry = await fs.lstat(path.join(cwd, '.roboteam')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (entry && !entry.isDirectory()) throw fail(code, "The working folder's .roboteam is not a real directory");
}

export function homeTarget(id) { return `/home/${robotId(id)}`; }

export class RobotPaths {
    constructor({ dataDir = '/data', workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT } = {}) {
        this.dataDir = path.resolve(dataDir);
        if (!workspaceRoot) throw fail('WORKSPACE_UNAVAILABLE', 'Workspace root is required');
        this.workspaceRoot = path.resolve(workspaceRoot);
        this.privateRoot = path.join(this.workspaceRoot, '.data', '.private');
    }

    robot(id) { return path.join(this.dataDir, 'robots', robotId(id)); }
    home(id) { return path.join(this.robot(id), 'home'); }
    soul(id) { return path.join(this.robot(id), 'run', 'soul'); }
    run(id) { return path.join(this.dataDir, 'runs', runId(id)); }

    async grant(value, kind = 'folder') {
        const code = kind === 'cwd' ? 'CWD_REFUSED' : 'FOLDER_REFUSED';
        if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail(code, 'An absolute directory is required');
        let resolved;
        try { resolved = await fs.realpath(value); }
        catch { throw fail(code, 'Directory is unavailable'); }
        if (!(await fs.stat(resolved)).isDirectory()) throw fail(code, 'A directory is required');
        // The root holds every project; a robot receives a folder below it.
        const root = await fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot);
        if (resolved === root) throw fail(code, 'The workspace root is not available to a robot');
        if (kind === 'cwd' && !within(root, resolved)) throw fail(code, 'Directory is outside the workspace');
        for (const requestedRoot of [this.dataDir, '/data', this.privateRoot]) {
            const protectedRoot = await fs.realpath(requestedRoot).catch(() => requestedRoot);
            if (within(protectedRoot, resolved) || within(resolved, protectedRoot)) throw fail(code, 'Directory contains protected storage');
        }
        if (kind === 'cwd') {
            for (const requestedRoot of [path.join(this.workspaceRoot, '.data'), path.join(this.workspaceRoot, '.ploinky')]) {
                const protectedRoot = await fs.realpath(requestedRoot).catch(() => requestedRoot);
                if (within(protectedRoot, resolved)) throw fail(code, 'Working directory is protected');
            }
            if (path.relative(root, resolved).split(path.sep).includes('.roboteam')) throw fail(code, 'Directory is private project data');
        }
        if (kind !== 'cwd') {
            // Registered repository sources live below .ploinky/repos/<name>; nothing else in .ploinky is for a robot.
            const ploinky = await fs.realpath(path.join(this.workspaceRoot, '.ploinky')).catch(() => path.join(this.workspaceRoot, '.ploinky'));
            const parts = path.relative(ploinky, resolved).split(path.sep);
            if (within(ploinky, resolved) && !(parts[0] === 'repos' && parts.length >= 2)) throw fail(code, 'Directory is protected workspace state');
        }
        // RoboTeam sends canonical paths, so a difference here is a path swapped since it resolved it.
        if (resolved !== value) throw fail(code, 'A canonical directory path is required');
        return resolved;
    }

    async identity(resolved, kind = 'folder') {
        try { return await directoryIdentity(resolved); }
        catch { throw fail(kind === 'cwd' ? 'CWD_REFUSED' : 'FOLDER_REFUSED', 'Directory changed while it was being granted'); }
    }
}
