import {
    DECISION_MCP_NAME, DECISION_TASK_TYPE, EXECUTION_TASK_TYPES, MAX_DECISION_STEPS,
    MAX_IDLE_DECISION_TURNS, MAX_INSTRUCTION_LENGTH, MAX_LOG_TAIL, MAX_RESULT_LENGTH,
    TERMINAL_FLOW_STATUSES, TERMINAL_INVOCATION_STATES,
} from './constants.mjs';
import { WorkflowRegistry, normalizeWorkflow, workflowCatalogEntry } from './workflow-registry.mjs';
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

function boundError(error) {
    return error ? String(error).slice(0, 4096) : null;
}

function buildDecisionPrompt(flow) {
    const lines = [
        'You are the decision robot for a RoboFlow task flow. You decide every step and act only through the mounted workflow skill MCP tools.',
        `Flow id: ${flow.id}`,
        `Workflow: ${flow.workflowName} (${flow.workflowTypeId})`,
        `Objective: ${flow.objective}`,
        `Working folder: ${flow.folder}`,
        '',
        'Available members (use the member id):',
    ];
    for (const member of flow.members) {
        const role = member.role ? ` · ${member.role}` : '';
        const decider = member.id === flow.decisionMemberId ? ' [decision member]' : '';
        lines.push(`- ${member.id}: ${member.robotName} · ${member.executionType}${role}${decider}`);
    }
    if (flow.steps.length) {
        lines.push('', 'History:');
        for (const step of flow.steps) {
            const runs = flow.invocations.filter((invocation) => invocation.step === step.index);
            lines.push(`Step ${step.index} (decision ${step.state}):`);
            if (!runs.length) lines.push('- no robot launched');
            for (const run of runs) {
                lines.push(`- ${run.memberId} (${run.robotName}/${run.executionType}) [${run.state}] instruction: ${run.instruction}`);
                if (run.summary) lines.push(`  summary: ${run.summary}`);
                if (run.error) lines.push(`  error: ${run.error}`);
            }
        }
    }
    lines.push('', 'You have the RoboFlow MCP tools mounted. Use roboflow_flow_state to inspect the flow, roboflow_launch_robot to launch one configured member robot with an instruction (non-blocking), and roboflow_finish_flow to complete the objective. Launch the member robots you need for this step, then stop; RoboFlow calls you again after those robots finish. Call roboflow_finish_flow with the final result only when the objective is fully met.');
    return lines.join('\n');
}

export class RoboFlowService {
    constructor(options = {}) {
        this.robotStore = options.robotStore;
        this.runtimeManager = options.runtimeManager;
        this.skillsets = options.skillsets || options.runtimeManager?.skillsets || null;
        // Optional MCP server descriptor (name=url) injected only into decision
        // tasks so the decision robot can call the RoboFlow tools natively.
        this.decisionMcpServers = options.decisionMcpServers || null;
        this.registry = options.registry || new WorkflowRegistry({ directory: options.workflowsDirectory });
        this.store = options.store || new TaskFlowStore({ directory: options.flowsDirectory });
        this.bindings = new Map();
        this.chains = new Map();
    }

    async initialize() {
        await this.registry.initialize();
        await this.store.initialize();
        await this._recoverInterrupted();
    }

    // Runtime tasks live only in memory, so a flow that was still running when the
    // service restarted can never advance again. Mark it failed; there is no
    // migration of in-flight work.
    async _recoverInterrupted() {
        for (const flow of await this.store.list()) {
            if (TERMINAL_FLOW_STATUSES.includes(flow.status)) continue;
            const activeInvocations = flow.invocations.filter((invocation) => !TERMINAL_INVOCATION_STATES.includes(invocation.state));
            const activeSteps = (flow.steps || []).filter((step) => !['completed', 'failed', 'stopped'].includes(step.state));
            if (activeInvocations.length === 0 && activeSteps.length === 0) continue;
            await this.store.update(flow.id, (current) => {
                current.status = 'failed';
                current.error = 'interrupted by service restart';
                current.finishedAt = new Date().toISOString();
                for (const invocation of current.invocations) {
                    if (TERMINAL_INVOCATION_STATES.includes(invocation.state)) continue;
                    invocation.state = 'interrupted';
                    invocation.endedAt = new Date().toISOString();
                    invocation.error = 'interrupted by service restart';
                }
                for (const step of current.steps || []) {
                    if (['completed', 'failed', 'stopped'].includes(step.state)) continue;
                    step.state = 'failed';
                    step.endedAt = new Date().toISOString();
                    step.error = 'interrupted by service restart';
                }
            });
            await this.store.appendEvent(flow.id, { type: 'flow-recovered', invocations: activeInvocations.length, steps: activeSteps.length });
        }
    }

    // All flow transitions for one flow are serialized so a decision task and a
    // member run can never advance the same flow twice.
    _serialize(flowId, fn) {
        const previous = this.chains.get(flowId) || Promise.resolve();
        const next = previous.then(fn, fn);
        this.chains.set(flowId, next.then(() => {}, () => {}));
        return next;
    }

    // --- Workflow types -----------------------------------------------------

    listWorkflows() {
        return this.registry.list();
    }

    /** Copilot-facing catalog: names, descriptions, participating robots and roles. */
    async listWorkflowCatalog() {
        const workflows = await this.registry.list();
        return workflows.map(workflowCatalogEntry);
    }

    getWorkflow(workflowId) {
        return this.registry.get(workflowId);
    }

    async createWorkflow(input) {
        const normalized = normalizeWorkflow(input);
        for (const member of normalized.members) await this._assertRobotUsable(member.robotName);
        return this.registry.create(normalized);
    }

    async updateWorkflow(workflowId, input) {
        const existing = await this.registry.get(workflowId);
        if (!existing) throw notFound('workflow type not found');
        const normalized = normalizeWorkflow(input, { id: workflowId });
        for (const member of normalized.members) await this._assertRobotUsable(member.robotName);
        const updated = await this.registry.update(workflowId, input);
        if (!updated) throw notFound('workflow type not found');
        return updated;
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

    async startFlow(input) {
        const workflowTypeId = String(input?.workflowTypeId ?? '').trim();
        if (!workflowTypeId) throw invalid('workflowTypeId is required');
        const workflow = await this.registry.get(workflowTypeId);
        if (!workflow) throw notFound('workflow type not found');
        const objective = boundText(input?.objective, 'objective', MAX_INSTRUCTION_LENGTH, { required: true });
        const folder = await this.runtimeManager.resolveCwd(String(input?.folder ?? '').trim());
        const decisionMemberId = workflow.decisionMemberId || workflow.members[0]?.id || '';
        const decisionMember = workflow.members.find((member) => member.id === decisionMemberId) || workflow.members[0];
        if (!decisionMember) throw invalid('workflow has no decision member');
        for (const member of workflow.members) await this._assertRobotUsable(member.robotName);
        const flowId = TaskFlowStore.newFlowId();
        await this.store.create({
            id: flowId,
            workflowTypeId: workflow.id,
            workflowName: workflow.name,
            decisionMemberId: decisionMember.id,
            decisionRobotName: decisionMember.robotName,
            folder,
            objective,
            createdBy: String(input?.createdBy ?? '').trim(),
            members: structuredClone(workflow.members),
        });
        await this.store.update(flowId, (current) => {
            current.status = 'running';
            current.currentStep = 0;
            current.awaitingStep = null;
            current.idleTurns = 0;
        });
        await this.store.appendEvent(flowId, { type: 'flow-started', workflowTypeId: workflow.id, objective });
        void this._serialize(flowId, () => this._advance(flowId, 0))
            .catch((error) => this._serialize(flowId, () => this._failFlow(flowId, String(error?.message || error))).catch(() => {}));
        return this.getFlow(flowId, { logMode: 'none' });
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
        const steps = [];
        for (const step of flow.steps || []) {
            const entry = { ...step };
            if (logMode === 'full') entry.log = await this.store.readLog(flow.id, `step-${step.index}`);
            else if (logMode === 'tail') entry.logTail = (await this.store.readLog(flow.id, `step-${step.index}`, MAX_LOG_TAIL * 4)).slice(-MAX_LOG_TAIL);
            steps.push(entry);
        }
        const events = await this.store.readEvents(flow.id);
        return { ...flow, steps, invocations, events };
    }

    async getInvocationLog(flowId, invocationId) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (flow.invocations.some((invocation) => invocation.id === invocationId)) return this.store.readLog(flowId, invocationId);
        const stepMatch = /^step-(\d+)$/.exec(String(invocationId || ''));
        if (stepMatch && (flow.steps || []).some((step) => step.index === Number(stepMatch[1]))) return this.store.readLog(flowId, invocationId);
        throw notFound('invocation not found');
    }

    // Non-blocking member launch: RoboFlow starts one configured member robot and
    // returns immediately. The decision robot is re-invoked after the run ends.
    async launchMember(flowId, input) {
        return this._serialize(flowId, () => this._launchMember(flowId, input));
    }

    async _launchMember(flowId, input) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (TERMINAL_FLOW_STATUSES.includes(flow.status)) throw conflict('task flow is not running');
        const memberSelector = String(input?.member ?? input?.memberId ?? input?.robotName ?? '').trim();
        if (!memberSelector) throw invalid('member is required');
        const member = flow.members.find((entry) => entry.id === memberSelector)
            || flow.members.find((entry) => entry.robotName === memberSelector);
        if (!member) throw invalid(`member is not part of this workflow: ${memberSelector}`);
        const instruction = boundText(input?.instruction ?? input?.task, 'instruction', MAX_INSTRUCTION_LENGTH, { required: true });
        const robot = await this._assertRobotUsable(member.robotName);
        const cwd = input?.cwd ? await this.runtimeManager.resolveCwd(String(input.cwd)) : flow.folder;
        const invocationId = TaskFlowStore.newInvocationId();
        const step = Number(flow.currentStep || 0);

        await this.store.update(flowId, (current) => {
            if (current.invocations.length >= 500) throw conflict('task flow invocation limit reached');
            current.invocations.push({
                id: invocationId,
                step,
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
        await this.store.appendEvent(flowId, { type: 'member-created', invocationId, memberId: member.id, robotName: member.robotName, executionType: member.executionType, step });

        let started;
        try {
            started = await this._startTask(robot, {
                cwd,
                task: instruction,
                taskType: EXECUTION_TASK_TYPES[member.executionType],
                skillSets: member.skillSets,
                skills: member.skills,
            });
        } catch (error) {
            await this.store.update(flowId, (current) => {
                const invocation = current.invocations.find((entry) => entry.id === invocationId);
                if (invocation) {
                    invocation.state = 'failed';
                    invocation.endedAt = new Date().toISOString();
                    invocation.error = boundError(error?.message || error);
                }
            });
            await this.store.appendEvent(flowId, { type: 'member-failed', invocationId, error: String(error?.message || error) });
            throw error;
        }

        this.bindings.set(started.taskId, { flowId, kind: 'member', invocationId, step });
        await this.store.update(flowId, (current) => {
            const invocation = current.invocations.find((entry) => entry.id === invocationId);
            if (invocation) {
                invocation.runtimeTaskId = started.taskId;
                invocation.state = started.state === 'queued' ? 'queued' : 'running';
            }
        });
        await this.store.appendEvent(flowId, { type: 'member-started', invocationId, runtimeTaskId: started.taskId, step });
        return { invocationId, runtimeTaskId: started.taskId, robotName: member.robotName, executionType: member.executionType, state: started.state, step };
    }

    async _startTask(robot, { cwd, task, taskType, skillSets = [], skills = [], mcpServers = null }) {
        const start = (current, policyId) => this.runtimeManager.startTask(current, taskType, {
            cwd,
            task,
            skillPolicyRef: policyId,
            alaSessionId: policyId || undefined,
            ...(mcpServers ? { mcpServers } : {}),
            model: null,
            ca: 'auto',
        });
        if (!this.skillsets) return Promise.resolve(start(robot, null));
        return this.skillsets.start(robot, { cwd, task, skillSets, skills, ca: 'auto' },
            (current, selection) => start(current, selection.policyId));
    }

    // --- Decision loop ------------------------------------------------------

    async _advance(flowId, stepIndex) {
        const flow = await this.store.get(flowId);
        if (!flow || TERMINAL_FLOW_STATUSES.includes(flow.status)) return;
        const member = flow.members.find((entry) => entry.id === flow.decisionMemberId) || flow.members[0];
        if (!member) return this._failFlow(flowId, 'workflow has no decision member');
        const robot = await this._assertRobotUsable(member.robotName);
        const prompt = buildDecisionPrompt({ ...flow, currentStep: stepIndex });
        await this.store.update(flowId, (current) => {
            current.currentStep = stepIndex;
            current.awaitingStep = null;
            current.steps.push({
                index: stepIndex,
                robotName: member.robotName,
                state: 'queued',
                requested: [],
                summary: null,
                error: null,
                startedAt: new Date().toISOString(),
                endedAt: null,
            });
        });
        await this.store.appendEvent(flowId, { type: 'decision-created', step: stepIndex, robotName: member.robotName });
        let started;
        try {
            started = await this._startTask(robot, {
                cwd: flow.folder,
                task: prompt,
                taskType: DECISION_TASK_TYPE,
                skillSets: member.skillSets,
                skills: member.skills,
                mcpServers: this.decisionMcpServers,
            });
        } catch (error) {
            await this._failFlow(flowId, `decision task failed to start: ${error?.message || error}`);
            return;
        }
        this.bindings.set(started.taskId, { flowId, kind: 'decision', step: stepIndex });
        await this.store.update(flowId, (current) => {
            const step = current.steps.find((entry) => entry.index === stepIndex);
            if (step) { step.taskId = started.taskId; step.state = 'running'; }
        });
        await this.store.appendEvent(flowId, { type: 'decision-started', step: stepIndex, runtimeTaskId: started.taskId });
    }

    async _afterDecisionStep(flowId, stepIndex) {
        const flow = await this.store.get(flowId);
        if (!flow || TERMINAL_FLOW_STATUSES.includes(flow.status)) return;
        if (Number(flow.currentStep) !== Number(stepIndex)) return; // already advanced
        const runs = flow.invocations.filter((invocation) => invocation.step === stepIndex);
        const pending = runs.filter((invocation) => !TERMINAL_INVOCATION_STATES.includes(invocation.state));
        if (pending.length) {
            await this.store.update(flowId, (current) => { current.awaitingStep = stepIndex; });
            await this.store.appendEvent(flowId, { type: 'decision-awaiting', step: stepIndex, count: pending.length });
            return;
        }
        if (runs.length === 0) {
            const idle = Number(flow.idleTurns || 0) + 1;
            if (idle >= MAX_IDLE_DECISION_TURNS) {
                await this._failFlow(flowId, 'decision robot produced no actions');
                return;
            }
            await this.store.update(flowId, (current) => { current.idleTurns = idle; });
        } else {
            await this.store.update(flowId, (current) => { current.idleTurns = 0; });
        }
        const next = stepIndex + 1;
        if (next >= MAX_DECISION_STEPS) {
            await this._failFlow(flowId, 'maximum decision steps reached');
            return;
        }
        await this._advance(flowId, next);
    }

    async _onDecisionTerminal(binding, event) {
        const state = event.state === 'completed' ? 'completed' : 'failed';
        const summary = summarize(event.result);
        await this.store.update(binding.flowId, (current) => {
            const step = current.steps.find((entry) => entry.index === binding.step);
            if (step) {
                step.state = state;
                step.summary = summary;
                step.error = boundError(event.error);
                step.endedAt = new Date().toISOString();
            }
        });
        await this.store.appendEvent(binding.flowId, { type: 'decision-terminal', step: binding.step, state });
        if (state === 'failed') {
            await this._failFlow(binding.flowId, event.error || 'decision robot failed');
            return;
        }
        await this._afterDecisionStep(binding.flowId, binding.step);
    }

    async _onMemberTerminal(binding, event) {
        const state = TERMINAL_INVOCATION_STATES.includes(event.state) ? event.state : 'failed';
        const summary = summarize(event.result);
        await this.store.update(binding.flowId, (current) => {
            const invocation = current.invocations.find((entry) => entry.id === binding.invocationId);
            if (invocation) {
                invocation.state = state;
                invocation.endedAt = new Date().toISOString();
                invocation.summary = summary;
                invocation.error = boundError(event.error);
            }
        });
        await this.store.appendEvent(binding.flowId, { type: 'member-terminal', invocationId: binding.invocationId, step: binding.step, state });
        const flow = await this.store.get(binding.flowId);
        if (!flow || TERMINAL_FLOW_STATUSES.includes(flow.status)) return;
        const step = (flow.steps || []).find((entry) => entry.index === binding.step);
        if (!step || !['completed', 'failed'].includes(step.state)) return;
        const runs = flow.invocations.filter((invocation) => invocation.step === binding.step);
        if (runs.some((invocation) => !TERMINAL_INVOCATION_STATES.includes(invocation.state))) return;
        await this.store.update(binding.flowId, (current) => { current.awaitingStep = null; });
        await this._afterDecisionStep(binding.flowId, binding.step);
    }

    async finishFlow(flowId, result) {
        return this._serialize(flowId, () => this._finishFlow(flowId, result));
    }

    async _finishFlow(flowId, result) {
        const summary = boundText(result, 'result', MAX_INSTRUCTION_LENGTH);
        const flow = await this.store.update(flowId, (current) => {
            if (TERMINAL_FLOW_STATUSES.includes(current.status)) throw conflict('task flow is not running');
            current.status = 'completed';
            current.finishedAt = new Date().toISOString();
            current.result = summary;
            current.error = null;
            return current;
        });
        await this.store.appendEvent(flowId, { type: 'flow-finished', result: summary });
        return flow;
    }

    async stopFlow(flowId) {
        return this._serialize(flowId, () => this._stopFlow(flowId));
    }

    async _stopFlow(flowId) {
        const flow = await this.store.get(flowId);
        if (!flow) throw notFound('task flow not found');
        if (TERMINAL_FLOW_STATUSES.includes(flow.status)) throw conflict('task flow is not running');
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
        for (const step of flow.steps || []) {
            if (!step.taskId || ['completed', 'failed', 'stopped'].includes(step.state)) continue;
            const robot = await this.robotStore.getByName(step.robotName);
            if (!robot) continue;
            try {
                this.runtimeManager.stopTask(robot, DECISION_TASK_TYPE, step.taskId);
            } catch {
                // Ignore an already-terminal decision task.
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
            }
            for (const step of current.steps || []) {
                if (['completed', 'failed', 'stopped'].includes(step.state)) continue;
                step.state = 'stopped';
                step.endedAt = new Date().toISOString();
                if (step.taskId) this.bindings.delete(step.taskId);
            }
        });
        await this.store.appendEvent(flowId, { type: 'flow-stopped' });
        return this.store.get(flowId);
    }

    async _failFlow(flowId, message) {
        const flow = await this.store.get(flowId);
        if (!flow || TERMINAL_FLOW_STATUSES.includes(flow.status)) return;
        for (const invocation of flow.invocations) {
            if (TERMINAL_INVOCATION_STATES.includes(invocation.state) || !invocation.runtimeTaskId) continue;
            const robot = await this.robotStore.getByName(invocation.robotName);
            if (!robot) continue;
            try { this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[invocation.executionType], invocation.runtimeTaskId); } catch { /* terminal already */ }
        }
        for (const step of flow.steps || []) {
            if (!step.taskId || ['completed', 'failed', 'stopped'].includes(step.state)) continue;
            const robot = await this.robotStore.getByName(step.robotName);
            if (!robot) continue;
            try { this.runtimeManager.stopTask(robot, DECISION_TASK_TYPE, step.taskId); } catch { /* terminal already */ }
        }
        await this.store.update(flowId, (current) => {
            current.status = 'failed';
            current.error = String(message || 'workflow failed');
            current.finishedAt = new Date().toISOString();
            for (const invocation of current.invocations) {
                if (TERMINAL_INVOCATION_STATES.includes(invocation.state)) continue;
                invocation.state = 'failed';
                invocation.endedAt = new Date().toISOString();
                invocation.error = current.error;
            }
            for (const step of current.steps || []) {
                if (['completed', 'failed', 'stopped'].includes(step.state)) continue;
                step.state = 'failed';
                step.endedAt = new Date().toISOString();
                step.error = current.error;
            }
        });
        await this.store.appendEvent(flowId, { type: 'flow-failed', error: String(message || 'workflow failed') });
    }

    // --- Runtime observation ------------------------------------------------

    onRuntimeTaskEvent(event) {
        const binding = event?.taskId ? this.bindings.get(event.taskId) : null;
        if (!binding) return;
        const enqueue = (fn) => {
            void this._serialize(binding.flowId, fn).catch((error) => {
                void this._serialize(binding.flowId, () => this._failFlow(binding.flowId, String(error?.message || error))).catch(() => {});
            });
        };
        if (event.kind === 'progress') {
            if (!event.chunk) return;
            if (binding.kind === 'decision') {
                enqueue(() => this.store.appendLog(binding.flowId, `step-${binding.step}`, event.chunk));
            } else {
                enqueue(() => this.store.appendLog(binding.flowId, binding.invocationId, event.chunk));
            }
            return;
        }
        if (event.kind === 'state') {
            if (!['starting', 'running'].includes(event.state)) return;
            if (binding.kind === 'decision') {
                enqueue(async () => {
                    await this.store.update(binding.flowId, (current) => {
                        const step = current.steps.find((entry) => entry.index === binding.step);
                        if (step && !['completed', 'failed', 'stopped'].includes(step.state)) step.state = event.state;
                    });
                });
            } else {
                enqueue(async () => {
                    await this.store.update(binding.flowId, (current) => {
                        const invocation = current.invocations.find((entry) => entry.id === binding.invocationId);
                        if (invocation && !TERMINAL_INVOCATION_STATES.includes(invocation.state)) invocation.state = event.state;
                    });
                });
            }
            return;
        }
        if (event.kind === 'terminal') {
            this.bindings.delete(event.taskId);
            enqueue(() => (binding.kind === 'decision'
                ? this._onDecisionTerminal(binding, event)
                : this._onMemberTerminal(binding, event)));
        }
    }

    async close() {
        this.bindings.clear();
        this.chains.clear();
    }
}

export const roboflowServiceInternals = { invalid, notFound, conflict, summarize, buildDecisionPrompt };
