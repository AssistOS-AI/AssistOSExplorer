import {
    EXECUTION_TASK_TYPES, MAX_INSTRUCTION_LENGTH, MAX_LOG_TAIL,
    MAX_RESULT_LENGTH, TERMINAL_INVOCATION_STATES,
} from './constants.mjs';
import { WorkflowRegistry, normalizeWorkflow } from './workflow-registry.mjs';
import { TaskFlowStore } from './task-flow-store.mjs';

function invalid(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message) {
    return Object.assign(new Error(message), { statusCode: 404 });
}

function conflict(message) {
    return Object.assign(new Error(message), { statusCode: 409 });
}

function boundText(value, field, limit, { required = false } = {}) {
    const text = String(value ?? '').trim();
    if (required && !text) throw invalid(`${field} is required`);
    if (text.length > limit) throw invalid(`${field} is too long`);
    return text;
}

function summarize(text, limit = MAX_RESULT_LENGTH) {
    const value = String(text ?? '');
    return value.length > limit ? value.slice(value.length - limit) : value;
}

export class RoboFlowService {
    constructor(options = {}) {
        this.robotStore = options.robotStore;
        this.runtimeManager = options.runtimeManager;
        this.skillsets = options.skillsets || options.runtimeManager?.skillsets || null;
        this.registry = options.registry || new WorkflowRegistry({ directory: options.workflowsDirectory });
        this.store = options.store || new TaskFlowStore({ directory: options.flowsDirectory });
        this.bindings = new Map();
        this.waiters = new Map();
    }

    async initialize() {
        await this.registry.initialize();
        await this.store.initialize();
        await this._recoverInterrupted();
    }

    // Runtime tasks are in-memory, so any invocation that was still running when
    // the service restarted can never complete. Mark it interrupted and let the
    // manager decide whether to invoke the member again.
    async _recoverInterrupted() {
        for (const flow of await this.store.list()) {
            if (flow.status !== 'active') continue;
            const active = flow.invocations.filter((invocation) => !TERMINAL_INVOCATION_STATES.includes(invocation.state));
            if (active.length === 0) continue;
            await this.store.update(flow.id, (current) => {
                for (const invocation of current.invocations) {
                    if (TERMINAL_INVOCATION_STATES.includes(invocation.state)) continue;
                    invocation.state = 'interrupted';
                    invocation.endedAt = new Date().toISOString();
                    invocation.error = 'interrupted by service restart';
                }
            });
            await this.store.appendEvent(flow.id, { type: 'flow-recovered', count: active.length });
        }
    }

    // --- Workflow types -----------------------------------------------------

    listWorkflows() {
        return this.registry.list();
    }

    getWorkflow(workflowId) {
        return this.registry.get(workflowId);
    }

    async createWorkflow(input) {
        const normalized = normalizeWorkflow(input);
        for (const member of normalized.members) await this._assertRobotUsable(member.robotName);
        return this.registry.create(normalized);
    }

    async deleteWorkflow(workflowId) {
        return this.registry.remove(workflowId);
    }

    async _assertRobotUsable(robotName) {
        const robot = await this.robotStore.getByName(robotName);
        if (!robot) throw invalid(`workflow member robot does not exist: ${robotName}`);
        return robot;
    }

    // --- Task flows ---------------------------------------------------------

    async createFlow(input) {
        const workflowTypeId = String(input?.workflowTypeId ?? '').trim();
        if (!workflowTypeId) throw invalid('workflowTypeId is required');
        const workflow = await this.registry.get(workflowTypeId);
        if (!workflow) throw notFound('workflow type not found');
        const objective = boundText(input?.objective, 'objective', MAX_INSTRUCTION_LENGTH, { required: true });
        const folder = await this.runtimeManager.resolveCwd(String(input?.folder ?? '').trim());
        const flowId = TaskFlowStore.newFlowId();
        return this.store.create({
            id: flowId,
            workflowTypeId: workflow.id,
            workflowName: workflow.name,
            folder,
            objective,
            createdBy: String(input?.createdBy ?? '').trim(),
            members: structuredClone(workflow.members),
        });
    }

    async listFlows({ folder } = {}) {
        const resolved = folder ? await this.runtimeManager.resolveCwd(folder) : undefined;
        return this.store.list({ folder: resolved });
    }

    async getFlow(flowId, { logMode = 'tail' } = {}) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        return this._publicFlow(flow, logMode);
    }

    async _publicFlow(flow, logMode) {
        const invocations = [];
        for (const invocation of flow.invocations) {
            const entry = { ...invocation };
            if (logMode === 'full') entry.log = await this.store.readLog(flow.id, invocation.id);
            else if (logMode === 'tail') entry.logTail = (await this.store.readLog(flow.id, invocation.id, MAX_LOG_TAIL * 4)).slice(-MAX_LOG_TAIL);
            invocations.push(entry);
        }
        const events = await this.store.readEvents(flow.id);
        return { ...flow, invocations, events };
    }

    async getInvocationLog(flowId, invocationId) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (!flow.invocations.some((invocation) => invocation.id === invocationId)) throw notFound('invocation not found');
        return this.store.readLog(flowId, invocationId);
    }

    async invokeMember(flowId, input) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (flow.status !== 'active') throw conflict('task flow is not active');
        const memberSelector = String(input?.member ?? input?.memberId ?? input?.robotName ?? '').trim();
        if (!memberSelector) throw invalid('member is required');
        const member = flow.members.find((entry) => entry.id === memberSelector)
            || flow.members.find((entry) => entry.robotName === memberSelector);
        if (!member) throw invalid(`member is not part of this workflow: ${memberSelector}`);
        const instruction = boundText(input?.instruction ?? input?.task, 'instruction', MAX_INSTRUCTION_LENGTH, { required: true });
        const robot = await this._assertRobotUsable(member.robotName);
        const cwd = input?.cwd ? await this.runtimeManager.resolveCwd(String(input.cwd)) : flow.folder;
        const invocationId = TaskFlowStore.newInvocationId();

        await this.store.update(flowId, (current) => {
            if (current.invocations.length >= 500) throw conflict('task flow invocation limit reached');
            current.invocations.push({
                id: invocationId,
                memberId: member.id,
                robotName: member.robotName,
                executionType: member.executionType,
                skillSets: member.skillSets,
                skills: member.skills,
                instruction,
                cwd,
                runtimeTaskId: null,
                state: 'queued',
                startedAt: new Date().toISOString(),
                endedAt: null,
                summary: null,
                error: null,
                logBytes: 0,
            });
        });
        await this.store.appendEvent(flowId, { type: 'invocation-created', invocationId, memberId: member.id, robotName: member.robotName, executionType: member.executionType });

        let started;
        try {
            started = await this._startRuntimeTask(robot, member, { cwd, instruction });
        } catch (error) {
            await this.store.update(flowId, (current) => {
                const invocation = current.invocations.find((entry) => entry.id === invocationId);
                if (invocation) {
                    invocation.state = 'failed';
                    invocation.endedAt = new Date().toISOString();
                    invocation.error = String(error?.message || error);
                }
            });
            await this.store.appendEvent(flowId, { type: 'invocation-failed', invocationId, error: String(error?.message || error) });
            throw error;
        }

        this.bindings.set(started.taskId, { flowId, invocationId });
        await this.store.update(flowId, (current) => {
            const invocation = current.invocations.find((entry) => entry.id === invocationId);
            if (invocation) {
                invocation.runtimeTaskId = started.taskId;
                invocation.state = started.state === 'queued' ? 'queued' : 'running';
            }
        });
        await this.store.appendEvent(flowId, { type: 'invocation-started', invocationId, runtimeTaskId: started.taskId });
        return { invocationId, runtimeTaskId: started.taskId, robotName: member.robotName, executionType: member.executionType, state: started.state };
    }

    _startRuntimeTask(robot, member, { cwd, instruction }) {
        const taskType = EXECUTION_TASK_TYPES[member.executionType];
        const startRuntime = (current, policyId) => this.runtimeManager.startTask(current, taskType, {
            cwd,
            task: instruction,
            skillPolicyRef: policyId,
            alaSessionId: policyId || undefined,
            model: null,
            ca: 'auto',
        });
        if (!this.skillsets) return Promise.resolve(startRuntime(robot, null));
        return this.skillsets.start(robot, {
            cwd,
            task: instruction,
            skillSets: member.skillSets,
            skills: member.skills,
            ca: 'auto',
        }, (current, selection) => startRuntime(current, selection.policyId));
    }

    async finishFlow(flowId, result) {
        const summary = boundText(result, 'result', MAX_INSTRUCTION_LENGTH);
        const flow = await this.store.update(flowId, (current) => {
            if (current.status !== 'active') throw conflict('task flow is not active');
            current.status = 'done';
            current.finishedAt = new Date().toISOString();
            current.result = summary;
            return current;
        });
        await this.store.appendEvent(flowId, { type: 'flow-finished', result: summary });
        return flow;
    }

    async stopFlow(flowId) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (flow.status !== 'active') throw conflict('task flow is not active');
        const active = flow.invocations.filter((invocation) => !TERMINAL_INVOCATION_STATES.includes(invocation.state) && invocation.runtimeTaskId);
        for (const invocation of active) {
            const robot = await this.robotStore.getByName(invocation.robotName);
            if (!robot) continue;
            try {
                this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[invocation.executionType], invocation.runtimeTaskId);
            } catch {
                // The runtime task may already be terminal; stopping the flow still proceeds.
            }
        }
        await this.store.update(flowId, (current) => {
            current.status = 'stopped';
            current.finishedAt = new Date().toISOString();
            for (const invocation of current.invocations) {
                if (TERMINAL_INVOCATION_STATES.includes(invocation.state)) continue;
                invocation.state = 'stopped';
                invocation.endedAt = new Date().toISOString();
                if (invocation.runtimeTaskId) this.bindings.delete(invocation.runtimeTaskId);
                this._resolveWaiter(invocation.id, { state: 'stopped', summary: null, error: null });
            }
        });
        await this.store.appendEvent(flowId, { type: 'flow-stopped' });
        return this.store.get(flowId);
    }

    // --- Runtime observation ------------------------------------------------

    onRuntimeTaskEvent(event) {
        const binding = event?.taskId ? this.bindings.get(event.taskId) : null;
        if (!binding) return;
        if (event.kind === 'progress') {
            if (event.chunk) void this.store.appendLog(binding.flowId, binding.invocationId, event.chunk).catch(() => {});
            return;
        }
        if (event.kind === 'state') {
            void this._updateInvocationState(binding, event.state).catch(() => {});
            return;
        }
        if (event.kind === 'terminal') void this._finishInvocation(binding, event).catch(() => {});
    }

    async _updateInvocationState(binding, state) {
        if (!['starting', 'running'].includes(state)) return;
        await this.store.update(binding.flowId, (current) => {
            const invocation = current.invocations.find((entry) => entry.id === binding.invocationId);
            if (invocation && !TERMINAL_INVOCATION_STATES.includes(invocation.state)) invocation.state = state;
        });
    }

    async _finishInvocation(binding, event) {
        this.bindings.delete(event.taskId);
        const state = TERMINAL_INVOCATION_STATES.includes(event.state) ? event.state : 'failed';
        const summary = summarize(event.result);
        await this.store.update(binding.flowId, (current) => {
            const invocation = current.invocations.find((entry) => entry.id === binding.invocationId);
            if (invocation) {
                invocation.state = state;
                invocation.endedAt = new Date().toISOString();
                invocation.summary = summary;
                invocation.error = event.error ? String(event.error).slice(0, 4096) : null;
            }
        });
        await this.store.appendEvent(binding.flowId, {
            type: 'invocation-terminal', invocationId: binding.invocationId, state, summary: summary.slice(0, 2000),
        });
        this._resolveWaiter(binding.invocationId, { state, summary, error: event.error || null });
    }

    _resolveWaiter(invocationId, value) {
        const waiter = this.waiters.get(invocationId);
        if (!waiter) return;
        this.waiters.delete(invocationId);
        waiter.resolve(value);
    }

    waitForInvocation(flowId, invocationId, { timeoutMs = 0 } = {}) {
        const flow = this.store.get(flowId);
        return flow.then((current) => {
            if (!current) throw notFound('task flow not found');
            const invocation = current.invocations.find((entry) => entry.id === invocationId);
            if (!invocation) throw notFound('invocation not found');
            if (TERMINAL_INVOCATION_STATES.includes(invocation.state)) {
                return { state: invocation.state, summary: invocation.summary, error: invocation.error };
            }
            return new Promise((resolve, reject) => {
                this.waiters.set(invocationId, { resolve, reject });
                if (timeoutMs > 0) {
                    setTimeout(() => {
                        if (this.waiters.has(invocationId)) {
                            this.waiters.delete(invocationId);
                            resolve({ state: 'running', summary: null, error: null, pending: true });
                        }
                    }, timeoutMs).unref?.();
                }
            });
        });
    }

    async close() {
        for (const waiter of this.waiters.values()) waiter.resolve({ state: 'interrupted', summary: null, error: 'service stopped' });
        this.waiters.clear();
        this.bindings.clear();
    }
}

export const roboflowServiceInternals = { invalid, notFound, conflict, summarize };
