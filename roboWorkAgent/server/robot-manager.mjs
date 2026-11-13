import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CODING_AGENT_NAMES, normalizeCodingAgents, codingAgentEnvironment, openCodeVersion } from './coding-agents.mjs';
import { fail, robotId, homeTarget } from './robot-paths.mjs';
import { buildPrivateLaunch, capturePrivateLaunch } from './launch.mjs';
import { ensureTerminalStub, removeTerminalState } from './terminal-profiles.mjs';
import { robotStatus } from './home-op.mjs';
import { nativeEnvironment } from './native-environment.mjs';
import { validateMetadata, validateToken } from './git-credentials.mjs';

const STATUS_CONCURRENCY = 8;

async function realDirectory(directory) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('UNSAFE_STORAGE', 'Robot storage is unsafe', 500);
}

const present = file => fs.lstat(file).then(() => true, error => { if (error.code !== 'ENOENT') throw error; return false; });

export class RobotManager {
    constructor({ paths, toolCache, homeOperation, soulGateway, alaEntry, captureLaunch = capturePrivateLaunch, readStatus = null,
        gitCredentials = null, log = message => console.log(message) }) {
        Object.assign(this, { paths, toolCache, homeOperation, soulGateway, alaEntry, captureLaunch, gitCredentials, log });
        // A status only reads a home, so it runs in the service with the robot's own environment instead of a helper process.
        this.readStatus = readStatus || ((id, input) => {
            const home = this.paths.home(id);
            return robotStatus(home, input, { alaEntry: process.env.ROBOWORK_ALA_ENTRY || this.alaEntry,
                env: nativeEnvironment({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, home) });
        });
        this.operations = new Map(); this.runs = null; this.gui = null; this.alaUnavailable = false;
    }

    async initialize() {
        await fs.mkdir(this.paths.dataDir, { recursive: true, mode: 0o700 });
        await realDirectory(path.join(this.paths.dataDir, 'robots'));
    }

    serialized(id, work) {
        robotId(id);
        const previous = this.operations.get(id) || Promise.resolve();
        const pending = previous.catch(() => {}).then(work);
        this.operations.set(id, pending);
        void pending.finally(() => { if (this.operations.get(id) === pending) this.operations.delete(id); }).catch(() => {});
        return pending;
    }

    async require(id) {
        robotId(id);
        try {
            const metadata = JSON.parse(await fs.readFile(path.join(this.paths.robot(id), 'label'), 'utf8'));
            if (metadata.id !== id) throw new Error();
            return metadata;
        } catch { throw fail('UNKNOWN_ROBOT', 'Unknown robotId', 404); }
    }

    async write(record) {
        const directory = this.paths.robot(record.id);
        const temporary = path.join(directory, '.label-' + randomUUID());
        await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, path.join(directory, 'label'));
    }

    async ensure(input) {
        return this.serialized(input.robotId, async () => {
            const codingAgents = normalizeCodingAgents(input.codingAgents);
            if (input.seed !== undefined && typeof input.seed !== 'boolean') throw fail('INVALID_INPUT', 'seed must be a boolean');
            if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw fail('INVALID_INPUT', 'Invalid robot name');
            for (const directory of [this.paths.robot(input.robotId), this.paths.home(input.robotId),
                path.join(this.paths.robot(input.robotId), 'run'), this.paths.soul(input.robotId)]) await realDirectory(directory);
            const record = { id: input.robotId, name: input.name.trim(), codingAgents };
            const tools = input.seed === false ? null : await this.toolCache.prepareShellTools(codingAgents);
            const version = tools ? openCodeVersion(tools) : null;
            const template = version ? await this.toolCache.prepareOpenCodePlugin(version) : null;
            await this.homeOperation(input.robotId, 'ensure', { codingAgents, binPath: tools?.binPath,
                cacheRoot: this.toolCache.root, openCodePlugin: template,
                runtimeEnv: codingAgentEnvironment(tools?.agents || {}, { PATH: '/usr/local/bin:/usr/bin:/bin' }, this.toolCache.root) });
            await this.write(record);
            await this.soulGateway.prepare(this.paths.soul(input.robotId));
            // A credential socket that cannot open must not keep the robot from starting; set reopens it.
            await this.serveGitCredentials(input.robotId).catch(error => console.error(`[git-credentials] socket for robot=${input.robotId} could not be opened: ${error.code || 'FAILED'}`));
            await ensureTerminalStub(this.paths, input.robotId, { empty: false });
            return { homeTarget: homeTarget(input.robotId) };
        });
    }

    async config({ robotId: id }) {
        const record = await this.require(id);
        const tools = await this.toolCache.prepareCodingAgents(record.codingAgents);
        return this.homeOperation(id, 'config', { runtimeEnv: codingAgentEnvironment(tools, { PATH: '/usr/local/bin:/usr/bin:/bin' }, this.toolCache.root) });
    }

    async configSet(input) {
        return this.serialized(input.robotId, async () => {
            const record = await this.require(input.robotId);
            const codingAgents = normalizeCodingAgents(input.codingAgents);
            if (input.codingAgent !== undefined && !codingAgents.includes(input.codingAgent)) throw fail('INVALID_INPUT', 'Invalid coding agent');
            const result = await this.homeOperation(input.robotId, 'config_set', input);
            await this.write({ ...record, codingAgents });
            return result;
        });
    }

    async status({ robotIds, includeLogins = false } = {}) {
        if (robotIds !== undefined && (!Array.isArray(robotIds) || robotIds.length > 10000)) throw fail('INVALID_INPUT', 'Invalid robotIds');
        const ids = robotIds || await fs.readdir(path.join(this.paths.dataDir, 'robots'));
        const results = new Array(ids.length);
        let next = 0;
        const worker = async () => {
            while (next < ids.length) {
                const index = next++;
                const id = ids[index];
                // One registry entry RoboWork does not know must not take every other robot's status with it.
                const record = await this.require(id).catch(error => { if (error.code !== 'UNKNOWN_ROBOT') throw error; return null; });
                if (!record) continue;
                const { alaUnavailable = false, ...status } = await this.readStatus(id, { includeLogins, codingAgents: record.codingAgents });
                results[index] = { alaUnavailable, robot: { id, ...status, gui: this.gui ? await this.gui.status(id) : { state: 'stopped', mode: null, sessionUrl: null, cwd: null } } };
            }
        };
        await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, ids.length) }, worker));
        const answered = results.filter(Boolean);
        // Logins are reported as absent while ALA is unavailable; the failure is logged once until ALA answers again.
        if (answered.length) {
            const alaUnavailable = answered.some(entry => entry.alaUnavailable);
            if (alaUnavailable && !this.alaUnavailable) console.error('RoboWork: ALA is unavailable, so robot logins are reported as absent');
            this.alaUnavailable = alaUnavailable;
        }
        return { robots: answered.map(entry => entry.robot) };
    }

    async models({ robotId: id, agent, cwd }) {
        await this.require(id);
        // The settings dialog lists models for a draft selection before it is saved (DS006), so any
        // known coding agent is accepted here; prepareCodingAgents installs the requested one.
        if (!CODING_AGENT_NAMES.includes(agent)) throw fail('INVALID_INPUT', 'Coding agent is unavailable');
        const workingDirectory = cwd !== undefined ? await this.paths.grant(cwd, 'cwd') : this.paths.home(id);
        const identity = cwd !== undefined ? await this.paths.identity(workingDirectory, 'cwd') : undefined;
        const tools = await this.toolCache.prepareCodingAgents([agent]);
        await this.soulGateway.prepare(this.paths.soul(id));
        // A catalog query runs the coding agent in the same view as a run. One that cannot be shown safely is refused here.
        const workspace = await this.paths.workspaceView(id);
        const directory = path.join(this.paths.dataDir, 'runs', 'models-' + randomUUID());
        await fs.mkdir(directory, { mode: 0o700 });
        let cacheDirectory = this.paths.dataDir;
        for (const segment of ['server-state', 'model-catalog', id]) { cacheDirectory = path.join(cacheDirectory, segment); await realDirectory(cacheDirectory); }
        try {
            const launch = await buildPrivateLaunch({ paths: this.paths, id, directory, command: process.execPath,
                args: [fileURLToPath(new URL('./model-op.mjs', import.meta.url)), JSON.stringify({ alaEntry: this.alaEntry,
                    agent, cwd: workingDirectory, identity, workspace, home: this.paths.home(id), soul: this.paths.soul(id), dataDir: this.paths.dataDir, robotId: id })],
                extraBindings: [[cacheDirectory, cacheDirectory]],
                env: codingAgentEnvironment(tools, { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, this.toolCache.root) });
            const result = await this.captureLaunch(launch);
            return { agent, models: JSON.parse(result.stdout) };
        } catch { throw fail('MODEL_DISCOVERY_FAILED', 'Model discovery failed', 500); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
    }

    async delete({ robotId: id }) {
        return this.serialized(id, async () => {
            // The label may be missing or corrupt, so the robot directory decides whether the robot exists. A repeat delete finds nothing to remove.
            if (!await present(this.paths.robot(id))) throw fail('UNKNOWN_ROBOT', 'Unknown robotId', 404);
            // A link in place of the robot or its home must not send the removal into what it points at.
            await realDirectory(this.paths.robot(id));
            if (await present(this.paths.home(id))) await realDirectory(this.paths.home(id));
            if (this.runs?.list({ robotId: id }).some(run => ['starting', 'running', 'stopping'].includes(run.state))
                || this.gui && (await this.gui.status(id)).state !== 'stopped') throw fail('ROBOT_ACTIVE', 'Stop robot activity before deleting it', 409);
            // A lease that cannot be released for a robot without a label is pruned by the next proxy listing.
            if (this.gui) await this.gui.releaseProxy({ robotId: id }).catch(error => { if (error.code !== 'UNKNOWN_ROBOT') throw error; });
            await this.soulGateway.remove(this.paths.soul(id));
            if (this.gitCredentials) {
                await this.gitCredentials.sockets.remove(id);
                if (await this.gitCredentials.store.remove(id)) this.log(`git credentials removed robot=${id} reason=robot-deleted`);
            }
            if (await present(this.paths.home(id))) {
                await this.homeOperation(id, 'delete', {});
                // Remove the empty mount root without traversing any new robot-written entries.
                await fs.rmdir(this.paths.home(id));
            }
            await fs.rm(path.join(this.paths.dataDir, 'server-state', 'model-catalog', id), { recursive: true, force: true });
            await removeTerminalState(this.paths, id);
            await fs.rm(this.paths.robot(id), { recursive: true, force: true });
            return { deleted: true };
        });
    }

    needGitCredentials() {
        if (!this.gitCredentials) throw fail('GIT_CREDENTIALS_UNAVAILABLE', 'Git credential storage is not configured', 503);
        return this.gitCredentials;
    }

    // Opens the robot's credential socket when it has a stored credential and a run directory to hold the socket.
    async serveGitCredentials(id) {
        if (!this.gitCredentials || !(await this.gitCredentials.store.read(id)).configured) return false;
        if (!await present(this.paths.soul(id))) return false;
        await this.gitCredentials.sockets.prepare(id, this.paths.soul(id));
        return true;
    }

    // Startup: one robot that cannot be served must not keep the others or the service from starting.
    async restoreGitCredentials() {
        if (!this.gitCredentials) return;
        await this.gitCredentials.store.initialize();
        for (const id of await this.gitCredentials.store.ids()) {
            try { if (await present(path.join(this.paths.robot(id), 'label'))) await this.serveGitCredentials(id); }
            catch (error) { console.error(`[git-credentials] socket for robot=${id} could not be opened: ${error.code || 'FAILED'}`); }
        }
    }

    async gitCredentialsStatus({ robotId: id }) {
        robotId(id);
        if (!this.gitCredentials) return { ok: true, configured: false, readable: false, metadata: null, available: false };
        const { configured, readable, metadata, location } = await this.gitCredentials.store.read(id);
        return { ok: true, configured, readable, metadata: configured ? metadata : null, location, available: this.gitCredentials.store.available };
    }

    // The token is stored encrypted outside the robot tree; the home receives only name, email and the helper. The
    // workspace default robot's token goes only into the Ploinky-owned file, so Ploinky and the robot share one copy.
    async gitCredentialsSet(input) {
        return this.serialized(input.robotId, async () => {
            const id = input.robotId;
            const { store, sockets } = this.needGitCredentials();
            const token = validateToken(input.token);
            if (input.workspaceDefault !== undefined && typeof input.workspaceDefault !== 'boolean') throw fail('INVALID_INPUT', 'workspaceDefault must be a boolean');
            const metadata = validateMetadata(input);
            const workspace = input.workspaceDefault === true && store.mirrorAvailable;
            if (!workspace && !store.available) throw fail('GIT_CREDENTIALS_UNAVAILABLE', 'Git credential storage is not configured', 503);
            await this.require(id);
            for (const directory of [path.join(this.paths.robot(id), 'run'), this.paths.soul(id)]) await realDirectory(directory);
            if (workspace) await store.writeWorkspace(id, metadata, token);
            else {
                if (input.workspaceDefault === true) console.error('[git-credentials] the workspace git credential file is not configured; the default robot keeps its token in RoboWork and ploinky git operations keep their anonymous access');
                await store.write(id, metadata, token);
            }
            await this.homeOperation(id, 'git_config_set', { name: metadata.name, email: metadata.email });
            await sockets.prepare(id, this.paths.soul(id));
            this.log(`git credentials saved robot=${id} host=${metadata.host} location=${workspace ? 'workspace' : 'robot'}`);
            return { ok: true, metadata, ...(input.workspaceDefault === true ? { mirrored: workspace } : {}) };
        });
    }

    // The token goes first, so a later failure never leaves a usable token behind; repeating the call cleans the rest.
    async gitCredentialsDelete({ robotId: id, workspaceDefault }) {
        return this.serialized(id, async () => {
            if (workspaceDefault !== undefined && typeof workspaceDefault !== 'boolean') throw fail('INVALID_INPUT', 'workspaceDefault must be a boolean');
            const { store, sockets } = this.needGitCredentials();
            const current = await store.read(id);
            const workspace = workspaceDefault === true || current.location === 'workspace'
                ? await store.removeWorkspaceToken() : false;
            await sockets.remove(id);
            const deleted = await store.remove(id) || workspace;
            const known = await this.require(id).then(() => true, () => false);
            if (known && await present(this.paths.home(id))) await this.homeOperation(id, 'git_config_delete', {});
            this.log(`git credentials removed robot=${id}${workspace ? ' location=workspace' : ''}`);
            return { ok: true, deleted };
        });
    }
}
