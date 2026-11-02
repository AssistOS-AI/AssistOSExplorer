import fs from 'node:fs/promises';
import path from 'node:path';

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
        if (resolved === await fs.realpath(this.workspaceRoot).catch(() => this.workspaceRoot)) throw fail(code, 'The workspace root is not available to a robot');
        for (const requestedRoot of [this.dataDir, '/data', this.privateRoot]) {
            const protectedRoot = await fs.realpath(requestedRoot).catch(() => requestedRoot);
            if (within(protectedRoot, resolved) || within(resolved, protectedRoot)) throw fail(code, 'Directory contains protected storage');
        }
        if (kind === 'cwd') {
            for (const requestedRoot of [path.join(this.workspaceRoot, '.data'), path.join(this.workspaceRoot, '.ploinky')]) {
                const root = await fs.realpath(requestedRoot).catch(() => requestedRoot);
                if (within(root, resolved)) throw fail(code, 'Working directory is protected');
            }
        }
        if (kind !== 'cwd') {
            // Registered repository sources live below .ploinky/repos/<name>; nothing else in .ploinky is for a robot.
            const root = await fs.realpath(path.join(this.workspaceRoot, '.ploinky')).catch(() => path.join(this.workspaceRoot, '.ploinky'));
            const parts = path.relative(root, resolved).split(path.sep);
            if (within(root, resolved) && !(parts[0] === 'repos' && parts.length > 2)) throw fail(code, 'Directory is protected workspace state');
        }
        return resolved;
    }
}
