import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, robotId } from './robot-paths.mjs';

export const TERMINAL_PROFILE_ADMIN_REQUIRED = 'administrator access by a signed-in user is required';
export function terminalProfileAccess(access) {
    return access?.ok === true && access.internal === false && access.canAdmin === true
        && typeof access.principal === 'string' && /^user:.+/u.test(access.principal)
        ? { ok: true } : { ok: false, status: 403, error: TERMINAL_PROFILE_ADMIN_REQUIRED };
}

export function parseTerminalProfile(value) {
    if (typeof value !== 'string' || value.length > 128) throw fail('INVALID_INPUT', 'Invalid terminal profile');
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,96}$/u.test(parts[1])) throw fail('INVALID_INPUT', 'Invalid terminal profile');
    return { id: robotId(parts[0]), key: parts[1] };
}

// These directories are service-owned. No robot-controlled home is traversed here.
export async function terminalDirectory(directory, { create = false, empty = false } = {}) {
    if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory
        || typeof process.getuid === 'function' && stat.uid !== process.getuid()
        || empty && (await fs.readdir(directory)).length) throw fail('UNSAFE_STORAGE', 'Terminal storage is unavailable', 409);
    return stat;
}

export async function ensureTerminalStub(paths, id) {
    robotId(id);
    let directory = path.join(paths.workspaceRoot, '.data');
    await terminalDirectory(directory);
    for (const segment of ['roboWorkAgent', 'terminal', id]) {
        directory = path.join(directory, segment);
        await terminalDirectory(directory, { create: true, empty: segment === id });
    }
    return directory;
}

export function createTerminalProfiles({ paths, robots, toolCache, homeOperation, environment, runtimeBundle }) {
    const stubRoot = path.join(paths.workspaceRoot, '.data', 'roboWorkAgent', 'terminal');
    const stateRoot = path.join(paths.dataDir, 'server-state', 'terminal');
    const stub = id => path.join(stubRoot, id);
    const recordPath = profile => path.join(stateRoot, profile + '.json');
    const prepareOperations = new Map();

    async function selection(profile) {
        const { id, key } = parseTerminalProfile(profile);
        const robot = await robots.require(id);
        const selected = key === 'default' ? null : (await environment.list()).find(entry => entry.key === key);
        if (key !== 'default' && !selected) throw fail('ENVIRONMENT_UNAVAILABLE', 'Terminal environment is unavailable', 409);
        if (selected) await environment.require(selected.ref, { retry: true });
        return { id, key, robot, environment: selected?.ref || null };
    }

    async function catalog() {
        const profiles = [];
        for (const id of await fs.readdir(path.join(paths.dataDir, 'robots'))) {
            const record = await robots.require(id);
            profiles.push({ id: record.id, label: record.name });
        }
        profiles.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
        const environments = [{ key: 'default', label: 'RoboWork (default)', available: true, reason: '' },
            ...(await environment.list()).map(({ key, name, available, reason }) => ({ key, label: name, available, reason }))];
        return { ok: true, profiles, environments };
    }

    async function resolve(profile) {
        try {
            const { id, robot } = await selection(profile);
            await terminalDirectory(stub(id), { empty: true });
            return { allowed: true, profile: { id: profile, label: robot.name, home: `terminal/${id}` } };
        } catch { return { allowed: false }; }
    }

    async function prepare(profile) {
        if (prepareOperations.has(profile)) return prepareOperations.get(profile);
        const operation = (async () => {
            const selected = await selection(profile);
            const tools = await toolCache.prepareShellTools();
            const bundle = await runtimeBundle.prepare();
            await homeOperation(selected.id, 'shell', { codingAgents: selected.robot.codingAgents,
                binPath: tools.binPath, cacheRoot: toolCache.root });
            await ensureTerminalStub(paths, selected.id);
            for (const directory of [path.dirname(stateRoot), stateRoot]) await terminalDirectory(directory, { create: true });
            const stat = await terminalDirectory(stub(selected.id), { empty: true });
            const descriptor = { profile, id: selected.id, environment: selected.environment,
                workspaceRoot: paths.workspaceRoot, dataDir: paths.dataDir, binPath: tools.binPath,
                cacheRoot: toolCache.root, alaEntry: bundle.ala.entry, bwrap: bundle.bwrap.bin,
                stub: { path: stub(selected.id), dev: stat.dev, ino: stat.ino } };
            const temporary = path.join(stateRoot, '.' + randomUUID());
            await fs.writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, recordPath(profile));
            return { ok: true, id: profile, label: selected.robot.name,
                root: `.data/roboWorkAgent/terminal/${selected.id}` };
        })();
        prepareOperations.set(profile, operation);
        try { return await operation; } finally { prepareOperations.delete(profile); }
    }

    async function handle(req, res, url, access) {
        const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
        const authority = terminalProfileAccess(access);
        if (!authority.ok) return reply(403, { ok: false, error: authority.error });
        const pathname = url.pathname.replace(/^\/base-agent-additional-server\/roboWorkAgent\/3001/u, '');
        const body = access.body ? JSON.parse(access.body.toString('utf8') || '{}') : {};
        if (pathname === '/api/terminal-profiles' && req.method === 'GET') return reply(200, await catalog());
        if (pathname === '/api/terminal-profiles/resolve' && req.method === 'POST') {
            if (!body || Object.keys(body).sort().join(',') !== 'id,version' || body.version !== 1) return reply(400, { ok: false, error: 'Invalid terminal profile request' });
            return reply(200, await resolve(body.id));
        }
        const match = pathname.match(/^\/api\/terminal-profiles\/([^/]+)\/prepare$/u);
        if (match && req.method === 'POST') {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return reply(400, { ok: false, error: 'Invalid terminal preparation request' });
            return reply(200, await prepare(decodeURIComponent(match[1])));
        }
        return reply(404, { ok: false, error: 'not_found' });
    }
    return { handle, catalog, resolve, prepare };
}
