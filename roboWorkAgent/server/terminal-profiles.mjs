import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { directoryIdentity, fail, robotId } from './robot-paths.mjs';
import { CODING_AGENT_NAMES, robotCodingAgents } from './coding-agents.mjs';
import { TOOL_SESSION_CHECK_MS } from './constants.mjs';
import { NATIVE_SESSION_ID, codingSessionArguments, presetsSessionId } from './coding-sessions.mjs';

export const TERMINAL_PROFILE_ADMIN_REQUIRED = 'administrator access by a signed-in user is required';
// RoboTeam creates this robot and never deletes it; a launch without a robot name uses it.
export const DEFAULT_ROBOT_NAME = 'default';
const ROBOT_REFERENCE = /^[^\u0000-\u001f\u007f]{1,80}$/u;
const CONVERSATION_DESCRIPTOR_LIFETIME_MS = 24 * 60 * 60_000;
export function terminalProfileAccess(access) {
    return access?.ok === true && access.internal === false && access.canAdmin === true
        && typeof access.principal === 'string' && /^user:.+/u.test(access.principal)
        ? { ok: true } : { ok: false, status: 403, error: TERMINAL_PROFILE_ADMIN_REQUIRED };
}

// `<robot>.<environment>` opens the robot shell; `<robot>.<environment>.<coding agent>` opens that coding agent in the
// same sandbox instead of the shell. A fourth part names its conversation: `r-<id>` resumes the native session <id>,
// `n-<id>` opens a new one under the identifier <id> chosen in advance.
export function parseTerminalProfile(value) {
    if (typeof value !== 'string' || value.length > 128) throw fail('INVALID_INPUT', 'Invalid terminal profile');
    const parts = value.split('.');
    if (parts.length < 2 || parts.length > 4 || !/^[A-Za-z0-9_-]{1,96}$/u.test(parts[1])
        || (parts.length >= 3 && !CODING_AGENT_NAMES.includes(parts[2]))) throw fail('INVALID_INPUT', 'Invalid terminal profile');
    const session = parts[3] === undefined ? null : parts[3].match(/^([rn])-(.+)$/u);
    if (parts.length === 4 && (!session || !NATIVE_SESSION_ID.test(session[2]))) throw fail('INVALID_INPUT', 'Invalid terminal profile');
    return { id: robotId(parts[0]), key: parts[1], codingAgent: parts[2] || null,
        resume: session?.[1] === 'r' ? session[2] : null, sessionId: session?.[1] === 'n' ? session[2] : null };
}

function plainBody(body, keys) {
    return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === [...keys].sort().join(',');
}

const validRobot = robot => robot === null || (typeof robot === 'string' && ROBOT_REFERENCE.test(robot));
const validAgent = codingAgent => typeof codingAgent === 'string' && /^[a-z][a-z0-9-]{0,31}$/u.test(codingAgent);
// The workspace-relative folder the caller works in; '' is the workspace root.
const validDirectory = directory => typeof directory === 'string' && directory.length <= 4096 && !/[\u0000-\u001f\u007f\\]/u.test(directory)
    && !directory.startsWith('/') && !directory.split('/').some(segment => segment === '..' || segment === '.');

// The bodies of the coding session routes: exactly these keys, robot a name, an id or null for the default robot.
export function codingSessionInput(route, body) {
    if (route === 'robots') return plainBody(body, []) ? {} : null;
    if (route === 'agents') return plainBody(body, ['robot']) && validRobot(body.robot) ? { robot: body.robot } : null;
    if (route === 'history') {
        return plainBody(body, ['robot', 'codingAgent', 'directory']) && validRobot(body.robot) && validAgent(body.codingAgent)
            && validDirectory(body.directory) ? { robot: body.robot, codingAgent: body.codingAgent, directory: body.directory } : null;
    }
    if (route === 'launch') {
        return plainBody(body, ['robot', 'codingAgent', 'directory', 'resume']) && validRobot(body.robot) && validAgent(body.codingAgent)
            && validDirectory(body.directory) && (body.resume === null || (typeof body.resume === 'string' && NATIVE_SESSION_ID.test(body.resume)))
            ? { robot: body.robot, codingAgent: body.codingAgent, directory: body.directory, resume: body.resume } : null;
    }
    return null;
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

export async function ensureTerminalStub(paths, id, { empty = true } = {}) {
    robotId(id);
    let directory = paths.robotsDir;
    await terminalDirectory(directory);
    for (const segment of [id, 'terminal']) {
        directory = path.join(directory, segment);
        await terminalDirectory(directory, { create: true, empty: empty && segment === 'terminal' });
    }
    return directory;
}

// Removes the stub folder and the prepared descriptors of a deleted robot.
export async function removeTerminalState(paths, id) {
    robotId(id);
    await fs.rm(path.join(paths.robot(id), 'terminal'), { recursive: true, force: true });
    const stateRoot = path.join(paths.dataDir, 'server-state', 'terminal');
    for (const name of await fs.readdir(stateRoot).catch(() => [])) if (name.startsWith(id + '.')) await fs.rm(path.join(stateRoot, name), { force: true });
}

export function createTerminalProfiles({ paths, robots, toolCache, homeOperation, environment, runtimeBundle,
    sessionCatalogs = { argumentsFor: codingSessionArguments, presetsSessionId } }) {
    const stateRoot = path.join(paths.dataDir, 'server-state', 'terminal');
    const stub = id => path.join(paths.robot(id), 'terminal');
    const recordPath = profile => path.join(stateRoot, profile + '.json');
    const prepareOperations = new Map();

    async function selection(profile) {
        const { id, key, codingAgent, resume, sessionId } = parseTerminalProfile(profile);
        // Every supported coding agent is installed in the robot shell, so a terminal may open any of them.
        const robot = await robots.require(id);
        const selected = key === 'default' ? null : (await environment.list()).find(entry => entry.key === key);
        if (key !== 'default' && !selected) throw fail('ENVIRONMENT_UNAVAILABLE', 'Terminal environment is unavailable', 409);
        if (selected) await environment.require(selected.ref, { retry: true });
        return { id, key, codingAgent, resume, sessionId, robot, environment: selected?.ref || null };
    }

    async function knownRobots() {
        const records = [];
        for (const id of await fs.readdir(paths.robotsDir)) {
            if (id.startsWith('.')) continue;
            const record = await robots.require(id).catch(error => { if (error.code !== 'UNKNOWN_ROBOT') throw error; return null; });
            if (record) records.push(record);
        }
        return records;
    }

    // A robot is named by its id or by its name; no name selects the default robot.
    async function findRobot(reference) {
        const records = await knownRobots();
        const wanted = reference === null ? DEFAULT_ROBOT_NAME : reference.trim();
        const byId = reference === null ? undefined : records.find(record => record.id === wanted);
        if (byId) return byId;
        const byName = records.filter(record => String(record.name || '').toLowerCase() === wanted.toLowerCase());
        if (byName.length === 1) return byName[0];
        if (byName.length > 1) {
            throw fail('ROBOT_AMBIGUOUS', `Several robots are named ${wanted}; use one of their ids: ${byName.map(record => record.id).join(', ')}`, 409);
        }
        const known = records.map(record => record.name).sort((a, b) => a.localeCompare(b)).join(', ') || 'none';
        throw fail('UNKNOWN_ROBOT', reference === null
            ? `The default robot does not exist yet; open RoboTeam once to create it. Robots: ${known}`
            : `Unknown robot ${wanted}. Robots: ${known}`, 404);
    }

    async function activeCodingAgent(robot) {
        const enabled = robotCodingAgents(robot);
        try {
            const status = await robots.status({ robotIds: [robot.id] });
            const active = status?.robots?.[0]?.activeAgent;
            return enabled.includes(active) ? active : enabled[0];
        } catch { return enabled[0]; }
    }

    // The same check the robot terminal makes once it starts, answered before anything opens.
    async function requireWorkingFolder(directory) {
        try {
            await paths.interactiveCwd(directory ? path.join(paths.workspaceRoot, ...directory.split('/')) : paths.workspaceRoot);
        } catch (error) {
            throw fail('CWD_REFUSED', `A robot cannot open in ${directory || 'the workspace root'} (${error.message}). `
                + 'Run the command from a project folder inside the workspace, for example `cd <project>`.', 409);
        }
    }

    // Coding sessions offer every supported coding agent, whatever the robot's own runs use.
    function supportedCodingAgent(codingAgent) {
        if (!CODING_AGENT_NAMES.includes(codingAgent)) {
            throw fail('UNKNOWN_CODING_AGENT', `Unknown coding agent ${codingAgent}. Coding agents: ${CODING_AGENT_NAMES.join(', ')}`, 404);
        }
        return codingAgent;
    }

    const absoluteFolder = directory => directory ? path.join(paths.workspaceRoot, ...directory.split('/')) : paths.workspaceRoot;

    // The robots a person may open coding sessions for, the default robot first.
    async function sessionRobots() {
        const records = await knownRobots();
        const isDefault = record => String(record.name || '').toLowerCase() === DEFAULT_ROBOT_NAME;
        records.sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
        return { ok: true, robots: records.map(record => ({ id: record.id, name: record.name, default: isDefault(record) })) };
    }

    async function sessionAgents(input) {
        const robot = await findRobot(input.robot);
        return { ok: true, robot: { id: robot.id, name: robot.name }, active: await activeCodingAgent(robot),
            codingAgents: [...CODING_AGENT_NAMES] };
    }

    // The conversations a person started with this coding agent of the robot in the folder, read from the robot
    // home by the confined home helper.
    async function sessionHistory(input) {
        await requireWorkingFolder(input.directory);
        const robot = await findRobot(input.robot);
        const codingAgent = supportedCodingAgent(input.codingAgent);
        const { sessions } = await homeOperation(robot.id, 'coding_sessions', { codingAgent, cwd: absoluteFolder(input.directory) });
        return { ok: true, robot: { id: robot.id, name: robot.name }, codingAgent, sessions: Array.isArray(sessions) ? sessions : [] };
    }

    // Prepares a coding session for a robot: the caller opens the returned profile like any other terminal profile,
    // in the folder of its choice. A new conversation of an agent that accepts an identifier chosen in advance
    // carries it, so the caller knows which native session the terminal holds.
    async function launch(input) {
        await requireWorkingFolder(input.directory);
        const robot = await findRobot(input.robot);
        const codingAgent = supportedCodingAgent(input.codingAgent);
        const ala = await runtimeBundle.prepareAla();
        const alaPath = ala.path || path.dirname(path.dirname(ala.entry));
        const nativeSessionId = input.resume || (await sessionCatalogs.presetsSessionId(alaPath, codingAgent) ? randomUUID() : null);
        const conversation = input.resume ? `.r-${input.resume}` : nativeSessionId ? `.n-${nativeSessionId}` : '';
        const profile = `${robot.id}.default.${codingAgent}${conversation}`;
        await prepareNow(profile);
        return { ok: true, profile, robot: { id: robot.id, name: robot.name }, codingAgent, nativeSessionId };
    }

    async function catalog() {
        const profiles = [];
        for (const id of await fs.readdir(paths.robotsDir)) {
            if (id.startsWith('.')) continue;
            const record = await robots.require(id).catch(error => { if (error.code !== 'UNKNOWN_ROBOT') throw error; return null; });
            if (!record) continue;
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
            return { allowed: true, profile: { id: profile, label: robot.name, home: { root: 'robots', path: `${id}/terminal` } } };
        } catch { return { allowed: false }; }
    }

    async function resolveLive(profile) {
        try {
            const { id, key, codingAgent } = parseTerminalProfile(profile);
            if (key !== 'default' || codingAgent) return { allowed: false };
            const robot = await robots.require(id);
            await directoryIdentity(paths.home(id));
            return { allowed: true, profile: { id: profile, label: robot.name,
                home: { root: 'robots', path: `${id}/home` } } };
        } catch { return { allowed: false }; }
    }

    // A conversation profile is prepared once per launch; its descriptor is only read when that terminal starts.
    async function pruneConversationDescriptors(now = Date.now()) {
        for (const name of await fs.readdir(stateRoot).catch(() => [])) {
            if (!/^[^.]+\.[^.]+\.[^.]+\.[rn]-[A-Za-z0-9_-]+\.json$/u.test(name)) continue;
            const file = path.join(stateRoot, name);
            const stat = await fs.lstat(file).catch(() => null);
            if (stat?.isFile() && now - stat.mtimeMs > CONVERSATION_DESCRIPTOR_LIFETIME_MS) await fs.rm(file, { force: true });
        }
    }

    async function prepareNow(profile) {
        if (prepareOperations.has(profile)) return prepareOperations.get(profile);
        const operation = (async () => {
            const selected = await selection(profile);
            const tools = await toolCache.prepareShellTools(undefined, { maxAgeMs: TOOL_SESSION_CHECK_MS });
            const bundle = selected.environment ? await runtimeBundle.prepare()
                : { ala: await runtimeBundle.prepareAla(), bwrap: { bin: '/usr/bin/bwrap' } };
            if (selected.environment) await environment.prepare(selected.environment);
            await homeOperation(selected.id, 'shell', { codingAgents: selected.robot.codingAgents,
                binPath: tools.binPath, cacheRoot: toolCache.root });
            await ensureTerminalStub(paths, selected.id);
            for (const directory of [path.dirname(stateRoot), stateRoot]) await terminalDirectory(directory, { create: true });
            const stat = await terminalDirectory(stub(selected.id), { empty: true });
            const alaPath = bundle.ala.path || path.dirname(path.dirname(bundle.ala.entry));
            const codingAgentArgs = selected.resume || selected.sessionId
                ? await sessionCatalogs.argumentsFor(alaPath, selected.codingAgent, { resume: selected.resume, sessionId: selected.sessionId }) : [];
            await pruneConversationDescriptors();
            const descriptor = { profile, id: selected.id, environment: selected.environment,
                workspaceRoot: paths.workspaceRoot, dataDir: paths.dataDir, robotsDir: paths.robotsDir, binPath: tools.binPath,
                cacheRoot: toolCache.root, alaEntry: bundle.ala.entry || path.join(bundle.ala.path, 'bin', 'ala.mjs'), bwrap: bundle.bwrap.bin,
                stub: { path: stub(selected.id), dev: stat.dev, ino: stat.ino },
                ...(selected.codingAgent ? { codingAgent: selected.codingAgent, codingAgentArgs } : {}) };
            const temporary = path.join(stateRoot, '.' + randomUUID());
            await fs.writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, recordPath(profile));
            return { ok: true, id: profile, label: selected.robot.name,
                root: `.data/robots/${selected.id}/terminal` };
        })();
        prepareOperations.set(profile, operation);
        try { return await operation; } finally { prepareOperations.delete(profile); }
    }

    const selectedPreparations = new Map();
    async function prepare(profile) {
        const { key } = parseTerminalProfile(profile);
        if (key === 'default') return prepareNow(profile);
        let entry = selectedPreparations.get(profile);
        if (entry?.state === 'ready') { selectedPreparations.delete(profile); return entry.result; }
        if (entry?.state === 'failed') { selectedPreparations.delete(profile); throw entry.error; }
        if (!entry) {
            // Validate the choice before returning a retry response.
            await selection(profile);
            entry = { state: 'preparing' };
            selectedPreparations.set(profile, entry);
            void prepareNow(profile).then(result => { entry.state = 'ready'; entry.result = result; },
                error => { entry.state = 'failed'; entry.error = error; });
        }
        throw fail('TERMINAL_PREPARING', 'Terminal environment is preparing; retry shortly.', 409);
    }

    async function handle(req, res, url, access) {
        const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
        const authority = terminalProfileAccess(access);
        if (!authority.ok) return reply(403, { ok: false, error: authority.error });
        const pathname = url.pathname.replace(/^\/base-agent-additional-server\/roboWorkAgent\/3001/u, '');
        const body = access.body ? JSON.parse(access.body.toString('utf8') || '{}') : {};
        if (pathname === '/api/terminal-profiles' && req.method === 'GET') return reply(200, await catalog());
        const sessionRoute = pathname.match(/^\/api\/coding-sessions\/(robots|agents|history|launch)$/u);
        if (sessionRoute && req.method === 'POST') {
            const input = codingSessionInput(sessionRoute[1], body);
            if (!input) return reply(400, { ok: false, error: 'Invalid coding session request' });
            const operation = { robots: sessionRobots, agents: sessionAgents, history: sessionHistory, launch }[sessionRoute[1]];
            try { return reply(200, await operation(input)); }
            catch (error) {
                if (!error.statusCode) throw error;
                return reply(error.statusCode, { ok: false, code: error.code, error: error.message });
            }
        }
        if (pathname === '/api/terminal-profiles/resolve' && req.method === 'POST') {
            if (body && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'id,version' && body.version === 1) return reply(200, await resolve(body.id));
            if (body && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'action,id,mode,version'
                && body.version === 2 && body.action === 'resolve' && body.mode === 'live-agent') return reply(200, await resolveLive(body.id));
            return reply(400, { ok: false, error: 'Invalid terminal profile request' });
        }
        const match = pathname.match(/^\/api\/terminal-profiles\/([^/]+)\/prepare$/u);
        if (match && req.method === 'POST') {
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return reply(400, { ok: false, error: 'Invalid terminal preparation request' });
            try { return reply(200, await prepare(decodeURIComponent(match[1]))); }
            catch (error) {
                if (error.code === 'TERMINAL_PREPARING') return reply(409, { ok: false, error: 'TERMINAL_PREPARING', message: error.message });
                throw error;
            }
        }
        return reply(404, { ok: false, error: 'not_found' });
    }
    return { handle, catalog, resolve, resolveLive, prepare, launch, sessionRobots, sessionAgents, sessionHistory };
}
