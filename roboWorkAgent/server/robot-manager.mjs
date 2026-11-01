import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeCodingAgents, codingAgentEnvironment, openCodeVersion } from './coding-agents.mjs';
import { fail, robotId, homeTarget } from './robot-paths.mjs';
import { buildPrivateLaunch } from './launch.mjs';

const execFileAsync = promisify(execFile);

async function realDirectory(directory) {
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('UNSAFE_STORAGE', 'Robot storage is unsafe', 500);
}

export class RobotManager {
    constructor({ paths, toolCache, homeOperation, soulGateway, alaEntry, execFileImpl = execFileAsync }) {
        Object.assign(this, { paths, toolCache, homeOperation, soulGateway, alaEntry, execFileImpl });
        this.operations = new Map(); this.runs = null; this.gui = null;
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
            if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw fail('INVALID_INPUT', 'Invalid robot name');
            for (const directory of [this.paths.robot(input.robotId), this.paths.home(input.robotId),
                path.join(this.paths.robot(input.robotId), 'run'), this.paths.soul(input.robotId)]) await realDirectory(directory);
            const record = { id: input.robotId, name: input.name.trim(), codingAgents };
            const tools = await this.toolCache.prepareShellTools(codingAgents);
            const version = openCodeVersion(tools);
            const template = version ? await this.toolCache.prepareOpenCodePlugin(version) : null;
            await this.homeOperation(input.robotId, 'ensure', { codingAgents, binPath: tools.binPath,
                cacheRoot: this.toolCache.root, openCodePlugin: template,
                runtimeEnv: codingAgentEnvironment(tools.agents, { PATH: '/usr/local/bin:/usr/bin:/bin' }, this.toolCache.root) });
            await this.write(record);
            await this.soulGateway.prepare(this.paths.soul(input.robotId));
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
            if (input.effort) {
                const selected = input.codingAgent || codingAgents[0];
                const result = await this.models({ robotId: input.robotId, agent: selected });
                const config = await this.config(input);
                const model = input.model || config.models?.[selected];
                if (!result.models.some(entry => entry.id === model && entry.efforts?.includes(input.effort))) throw fail('INVALID_INPUT', 'The model does not advertise this effort');
            }
            const result = await this.homeOperation(input.robotId, 'config_set', input);
            await this.write({ ...record, codingAgents });
            return result;
        });
    }

    async status({ robotIds, includeLogins = false } = {}) {
        if (robotIds !== undefined && (!Array.isArray(robotIds) || robotIds.length > 10000)) throw fail('INVALID_INPUT', 'Invalid robotIds');
        const ids = robotIds || await fs.readdir(path.join(this.paths.dataDir, 'robots'));
        const robots = [];
        for (const id of ids) {
            const record = await this.require(id);
            const status = await this.homeOperation(id, 'status', { includeLogins, codingAgents: record.codingAgents });
            robots.push({ id, ...status, gui: this.gui ? await this.gui.status(id) : { state: 'stopped', mode: null, sessionUrl: null, cwd: null } });
        }
        return { robots };
    }

    async models({ robotId: id, agent, cwd }) {
        const record = await this.require(id);
        if (!record.codingAgents.includes(agent)) throw fail('INVALID_INPUT', 'Coding agent is unavailable');
        const workingDirectory = cwd !== undefined ? await this.paths.grant(cwd, 'cwd') : this.paths.home(id);
        const tools = await this.toolCache.prepareCodingAgents([agent]);
        await this.soulGateway.prepare(this.paths.soul(id));
        const directory = path.join(this.paths.dataDir, 'runs', 'models-' + randomUUID());
        await fs.mkdir(directory, { mode: 0o700 });
        let cacheDirectory = this.paths.dataDir;
        for (const segment of ['server-state', 'model-catalog', id]) { cacheDirectory = path.join(cacheDirectory, segment); await realDirectory(cacheDirectory); }
        try {
            const launch = await buildPrivateLaunch({ paths: this.paths, id, directory, command: process.execPath,
                args: [fileURLToPath(new URL('./model-op.mjs', import.meta.url)), JSON.stringify({ alaEntry: this.alaEntry,
                    agent, cwd: workingDirectory, home: this.paths.home(id), soul: this.paths.soul(id), dataDir: this.paths.dataDir, robotId: id })],
                extraBindings: [[cacheDirectory, cacheDirectory]],
                env: codingAgentEnvironment(tools, { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, this.toolCache.root) });
            const result = await this.execFileImpl(launch.command, launch.args, { ...launch.options, timeout: 90000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGTERM' });
            return { agent, models: JSON.parse(result.stdout) };
        } catch { throw fail('MODEL_DISCOVERY_FAILED', 'Model discovery failed', 500); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
    }

    async delete({ robotId: id }) {
        return this.serialized(id, async () => {
            await this.require(id);
            if (this.runs?.list({ robotId: id }).some(run => ['starting', 'running', 'stopping'].includes(run.state))
                || this.gui && (await this.gui.status(id)).state !== 'stopped') throw fail('ROBOT_ACTIVE', 'Stop robot activity before deleting it', 409);
            if (this.gui) await this.gui.releaseProxy({ robotId: id });
            await this.soulGateway.remove(this.paths.soul(id));
            await this.homeOperation(id, 'delete', {});
            // Remove the empty mount root without traversing any new robot-written entries.
            await fs.rmdir(this.paths.home(id));
            await fs.rm(this.paths.robot(id), { recursive: true, force: true });
            return { deleted: true };
        });
    }
}
