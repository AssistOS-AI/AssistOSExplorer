const AGENTS = ['codex', 'opencode', 'pi', 'claude'];

export class RobotModels {
    constructor({ robotStore, runtimeManager }) {
        this.store = robotStore;
        this.runtime = runtimeManager;
    }

    async config(robot) {
        return this.runtime.roboWork.call('robot_config', { robotId: robot.id });
    }

    async list(robot, agent, { signal } = {}) {
        if (!AGENTS.includes(agent)) throw Object.assign(new Error('Unknown coding agent'), { statusCode: 400 });
        signal?.throwIfAborted();
        const result = await this.runtime.roboWork.call('robot_models', { robotId: robot.id, agent }, { timeoutMs: 90000 });
        signal?.throwIfAborted();
        return result;
    }

    async validateEffort(robot, agent, model, effort) {
        if (typeof effort !== 'string' || !/^[a-zA-Z0-9_-]+$/u.test(effort)) throw Object.assign(new Error('Invalid effort'), { statusCode: 400 });
        const [{ models }, config] = await Promise.all([this.list(robot, agent), this.config(robot)]);
        const id = model === null ? config.defaultModels?.[agent] : model;
        const entry = models.find(item => typeof item !== 'string' && item.id === id);
        if (!entry?.efforts?.includes(effort)) throw Object.assign(new Error('The selected model does not advertise this effort'), { statusCode: 400 });
    }
}
