import path from 'node:path';
import { CODING_AGENT_NAMES, codingAgentEnvironment } from './coding-agents.mjs';
import { agentConfigPath, DEFAULT_OPENCODE_MODEL } from './agent-model-config.mjs';
import { workspaceDataPath } from './workspace-paths.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';
import { nativeEnvironment } from '../copilot/src/lib/execution/alaEnvironment.mjs';

export class RobotModels {
    constructor({ robotStore, runtimeManager, installation = resolveAlaInstallation }) {
        this.store = robotStore;
        this.runtime = runtimeManager;
        this.installation = installation;
        this.catalogs = new Map();
    }
    async api() {
        return this.installation({ env: { ...process.env, ACHILLES_ALA_COMMAND: this.runtime.alaCommand || '' } });
    }
    async config(robot) {
        const api = await this.api();
        const file = await agentConfigPath(path.join(this.store.robotPath(robot.id), 'home'));
        const config = await api.loadConfig(file);
        return { codingAgent: config.codingAgent, models: config.models, efforts: config.efforts, defaultModels: { opencode: DEFAULT_OPENCODE_MODEL } };
    }
    async list(robot, agent, { signal } = {}) {
        if (!CODING_AGENT_NAMES.includes(agent)) throw Object.assign(new Error('Unknown coding agent'), { statusCode: 400 });
        signal?.throwIfAborted();
        const tools = await this.runtime.toolCache.prepareCodingAgents([agent]);
        signal?.throwIfAborted();
        if (agent === 'opencode') await this.runtime.prepareOpenCode(robot.id);
        const home = await workspaceDataPath(path.join(this.store.robotPath(robot.id), 'home'), this.runtime.workspaceRoot);
        const api = await this.api();
        const env = nativeEnvironment(codingAgentEnvironment(tools, process.env, this.runtime.toolCache.root), home);
        const agents = await api.discoverCodingAgents({ env });
        signal?.throwIfAborted();
        // The same native catalog service used by /model, scoped to this robot's
        // accounts. Listing never creates a chat or sends an LLM prompt.
        const service = api.createCodingAgentService({ agents, workspace: home, cwd: home, home, env });
        try {
            const models = await service.listModels(agent, { signal, details: true });
            this.catalogs.set(`${robot.id}:${agent}`, { models, time: Date.now() });
            return { agent, models };
        } finally { await service.close(); }
    }
    async validateEffort(robot, agent, model, effort) {
        if (typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(effort)) {
            throw Object.assign(new Error('Invalid effort'), { statusCode: 400 });
        }
        const cached = this.catalogs.get(`${robot.id}:${agent}`);
        const models = cached && Date.now() - cached.time < 300000 ? cached.models
            : (await this.list(robot, agent, { signal: AbortSignal.timeout(90000) })).models;
        const id = model === null && agent === 'opencode' ? DEFAULT_OPENCODE_MODEL : model;
        const entry = models.find(item => typeof item !== 'string' && item.id === id);
        if (!entry?.efforts?.includes(effort)) throw Object.assign(new Error('The selected model does not advertise this effort'), { statusCode: 400 });
    }

}
