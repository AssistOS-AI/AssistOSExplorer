import { CODING_AGENT_NAMES } from './coding-agents.mjs';
import { DEFAULT_OPENCODE_MODEL } from './agent-model-config.mjs';

// Model discovery is a worker utility. RoboTeam keeps only desired selections and forwards catalog reads.
export const MODEL_LISTING_UNAVAILABLE = 'model_listing_unavailable';
export const MODEL_LISTING_MESSAGE = 'Model listing is available after the worker model-listing update.';

// The effort names of the agents whose levels are the same for every model, so a save can be checked without a listing. Pi: the
// level names of ALA's pi.mjs (piModelDetails); Claude Code: `--effort low|medium|high|xhigh|max` (PLAN-claude-code.md). A model
// may advertise fewer of them; the worker validates the exact set when it runs. Codex and OpenCode advertise efforts per model
// only (Codex `supportedReasoningEfforts`, OpenCode model variants), so no static set exists for them.
export const STATIC_EFFORTS = Object.freeze({
    pi: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    claude: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
});

// The agent a robot uses, from RoboTeam's record: the first enabled coding agent (the robot's only one when it has one).
export function robotCodingAgent(robot) {
    return (Array.isArray(robot?.codingAgents) ? robot.codingAgents : [])[0] || null;
}

export function modelListingUnavailable() {
    return Object.assign(new Error(MODEL_LISTING_MESSAGE), { statusCode: 409, publicCode: MODEL_LISTING_UNAVAILABLE });
}

export class RobotModels {
    constructor({ robotStore, runtimeManager, workerClient = null } = {}) {
        this.store = robotStore;
        this.runtime = runtimeManager;
        this.worker = workerClient;
    }
    // The robot's configured selection from RoboTeam's record (the one-agent robot's model and effort kept as desired state for the
    // worker); nothing is loaded from ALA or from the robot's old home.
    async config(robot) {
        const current = (await this.store.get(robot.id)) || robot;
        const agent = robotCodingAgent(current);
        const selection = current.selection && typeof current.selection === 'object' ? current.selection : {};
        return { codingAgent: agent,
            models: agent && typeof selection.model === 'string' ? { [agent]: selection.model } : {},
            efforts: agent && typeof selection.effort === 'string' ? { [agent]: selection.effort } : {},
            defaultModels: { opencode: DEFAULT_OPENCODE_MODEL } };
    }
    async list(robot, agent) {
        if (!CODING_AGENT_NAMES.includes(agent)) throw Object.assign(new Error('Unknown coding agent'), { statusCode: 400 });
        if (!this.worker || !robot.worker?.robotId) throw modelListingUnavailable();
        try { return await this.worker.models(robot.worker.robotId, agent); } catch (error) {
            throw Object.assign(new Error(error.message), { statusCode: error.status ?? 503, publicCode: error.code });
        }
    }
    // Bound robots use exact worker metadata even for saved efforts. Static levels support settings before a worker binding exists.
    async validateEffort(robot, agent, model, effort) {
        if (typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(effort)) {
            throw Object.assign(new Error('Invalid effort'), { statusCode: 400 });
        }
        if (this.worker && robot.worker?.robotId) {
            const catalog = await this.list(robot, agent);
            const selected = catalog.models.find((entry) => entry.id === model);
            if (!selected || !selected.efforts.includes(effort)) throw Object.assign(new Error(`Unsupported effort for ${agent}`), { statusCode: 400 });
            return;
        }
        const levels = STATIC_EFFORTS[agent];
        if (levels) {
            if (!levels.includes(effort)) throw Object.assign(new Error(`Unsupported effort for ${agent}`), { statusCode: 400 });
            return;
        }
        const saved = robot?.selection;
        if (robotCodingAgent(robot) === agent && saved?.model === model && saved?.effort === effort) return;
        throw modelListingUnavailable();
    }
}
