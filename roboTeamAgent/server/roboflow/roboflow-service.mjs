import { ensureCodeDevelopmentWorkflow } from './code-development-workflow.mjs';
import { Subflows, CONTINUE_PROMPT } from './subflows.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RoboFlowDatabase } from './database.mjs';
import { WorkflowRegistry } from './workflow-registry.mjs';
import { TaskFlowStore } from './task-flow-store.mjs';
import { normalizeWorkflow, invalid, textField, graphDiagnostics, isCoordinator } from './graph.mjs';
import { coverage, matchRobot, robotSelections, discoverWorkflowSkillsets } from './skill-matching.mjs';
import { parseRoute, parseWorkflowResponse, workflowResponseContext } from './result-parser.mjs';
import { generationPrompt, descriptionRevisionPrompt, routingPrompt, buildWorkflowTaskPrompt, creatorPrompt } from '../../copilot/src/lib/prompts.mjs';
import { ensureDefaultWorkflow } from './default-workflow.mjs';
import { EXECUTION_TASK_TYPES, EXECUTION_TYPES, WORKFLOWS_DIR } from './constants.mjs';
import { robotCodingAgents, GUI_CODING_AGENTS } from '../coding-agents.mjs';

const terminal = state => ['completed', 'failed', 'paused', 'terminated'].includes(state);
const missing = () => Object.assign(new Error('workflow run not found'), { statusCode: 404 });

// A run has one status. Running wins over everything, then pause, then failure:
// there is no partially paused run while any phase is still active.
function deriveFlowStatus(instances) {
    const states = instances.map(instance => instance.state);
    if (states.some(state => ['queued', 'starting', 'running', 'pausing'].includes(state))) return 'running';
    if (states.some(state => state === 'paused')) return 'paused';
    if (states.some(state => state === 'failed')) return 'failed';
    return 'completed';
}

export class RoboFlowService {
    constructor(options = {}) {
        this.robotStore = options.robotStore;
        this.runtimeManager = options.runtimeManager;
        this.skillsets = options.skillsets || this.runtimeManager?.skillsets;
        this.database = options.database || new RoboFlowDatabase(options.databaseFile || (options.workflowsDirectory ? path.join(options.workflowsDirectory, 'roboflow.sqlite') : undefined));
        this.registry = new WorkflowRegistry({ database: this.database, legacyDirectory: options.workflowsDirectory || WORKFLOWS_DIR });
        this.store = new TaskFlowStore({ database: this.database });
        this.random = options.random || Math.random;
        this.workspaceRoot = options.workspaceRoot || this.runtimeManager?.workspaceRoot || path.dirname(this.database.file);
        this.maxVisits = Number(options.maxVisits ?? process.env.ROBOTEAM_WORKFLOW_MAX_VISITS ?? 500);
        this.presetRetryMs = Number(options.presetRetryMs ?? 5000);
        this.closed = false;
        this.presetTimer = null;
        if (!Number.isSafeInteger(this.maxVisits) || this.maxVisits < 1) throw new Error('Workflow visit limit must be a positive integer');
        this.discover = options.discoverSkillsets || (() => discoverWorkflowSkillsets(this.skillsets?.repositoriesClient));
        this.bindings = new Map();
        if (this.runtimeManager) {
            this.runtimeManager.requestHumanInput = (taskId, input) => this.requestHumanInput(taskId, input);
            this.runtimeManager.assertHumanInputAnswered = async (taskId, workflowRunId) => {
                for (const flow of await this.store.list()) {
                    if (flow.status === 'terminated' && (flow.id === workflowRunId || flow.instances.some(item => item.runtimeTaskId === taskId))) {
                        throw invalid('Terminated workflows cannot be continued');
                    }
                }
                if ((await this.store.list()).some(flow => flow.humanInput?.status === 'pending' && flow.humanInput.runtimeTaskId === taskId)) {
                    throw invalid('Answer the pending human-input question before continuing');
                }
            };
        }
        this.chains = new Map();
        this.subflows = new Subflows(this);
        this.generations = new Map();
        this.generationTasks = new Map();
    }
    async initialize() {
        await this.registry.initialize();
        await this.store.clearLegacyOnce();
        await ensureDefaultWorkflow(this.registry);
        // The preset needs the Ploinky marketplace, which may not route to this
        // agent until it is ready (for example during a reinstall). It is created
        // in the background so startup never waits for or fails on it.
        this.presetReady = this._ensureCodeDevelopmentPreset();
        for (const flow of await this.store.list()) if (flow.status !== 'pending' && !terminal(flow.status)) await this.store.update(flow.id, current => {
            current.error = 'interrupted by service restart'; current.finishedAt = new Date().toISOString();
            for (const instance of current.instances) if (!terminal(instance.state)) { instance.state = 'paused'; instance.error = current.error; instance.endedAt = current.finishedAt; }
            current.status = deriveFlowStatus(current.instances);
        });
        for (const flow of await this.store.list()) if (flow.humanInput?.status === 'pending') await this.store.update(flow.id, current => {
            current.humanInput.executionEnded = true;
            current.status = 'paused';
            const instance = current.instances.find(item => item.id === current.humanInput.instanceId);
            if (instance) { instance.state = 'paused'; instance.endedAt ||= new Date().toISOString(); }
        });
        for (const flow of await this.store.list()) if (flow.status === 'terminated') await this.terminateFlow(flow.id);
        this.store.onStatusChange = flow => {
            if (!flow.parentFlowId) return;
            void this._serialize(flow.parentFlowId, () => this.subflows.reconcile(flow.parentFlowId))
                .catch(error => this._serialize(flow.parentFlowId, () => this._fail(flow.parentFlowId, error.message)).catch(() => {}));
        };
    }
    async _ensureCodeDevelopmentPreset() {
        let reported = false;
        while (!this.closed) {
            try {
                await ensureCodeDevelopmentWorkflow(this.registry, this.skillsets);
                if (reported) console.log('[roboflow] Code Development workflow is available.');
                return true;
            } catch (error) {
                if (this.closed) return false;
                if (!reported) console.error(`[roboflow] Code Development workflow is not available yet (${error.message}); retrying every ${this.presetRetryMs} ms.`);
                reported = true;
            }
            await new Promise((resolve) => {
                this.presetWake = resolve;
                this.presetTimer = setTimeout(resolve, this.presetRetryMs);
            });
            this.presetTimer = null; this.presetWake = null;
        }
        return false;
    }
    _derive(flow) {
        if (flow.status === 'terminated') return;
        flow.status = flow.humanInput?.status === 'pending' ? 'paused' : deriveFlowStatus(flow.instances);
        flow.finishedAt = flow.status === 'running' ? null : new Date().toISOString();
        if (flow.status !== 'failed') flow.error = null;
    }
    _serialize(id, operation) {
        const previous = this.chains.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.chains.set(id, next);
        void next.finally(() => { if (this.chains.get(id) === next) this.chains.delete(id); }).catch(() => {});
        return next;
    }
    async catalog() { return this.discover(); }
    async validateDraft(input) {
        const graph = normalizeWorkflow({ ...input, name: input.name || 'Draft', tasks: input.tasks?.map(task => ({
            ...task, name: task.name || 'Draft task', ...(isCoordinator(task) ? {} : { prompt: task.prompt || 'Draft task prompt' }) })) });
        return { graph, coverage: coverage(graph, await this.robotStore.list()), diagnostics: graphDiagnostics(graph) };
    }
    async listWorkflows() {
        const robots = await this.robotStore.list();
        return (await this.registry.list()).map(graph => ({ ...graph, coverage: coverage(graph, robots), diagnostics: graphDiagnostics(graph) }));
    }
    async refreshCoverage() { return this.listWorkflows(); }
    async createWorkflow(input) { const graph = await this.registry.create(input); return { ...graph, coverage: coverage(graph, await this.robotStore.list()) }; }
    async updateWorkflow(id, input) {
        const graph = await this.registry.update(id, input);
        if (!graph) throw Object.assign(invalid('workflow not found'), { statusCode: 404 });
        return { ...graph, coverage: coverage(graph, await this.robotStore.list()) };
    }
    async deleteWorkflow(id) { return this.registry.remove(id); }
    async startFlow(input) {
        const graph = await this.registry.get(input.workflowTypeId);
        if (!graph) throw Object.assign(invalid('workflow not found'), { statusCode: 404 });
        if (graph.kind === 'default' ? !EXECUTION_TYPES.includes(input.executionType) : input.executionType !== undefined) throw invalid('executionType is required only for the default workflow');
        const folder = await this.runtimeManager.resolveCwd(input.folder);
        const objective = textField(input.objective, 'objective', 32768, true);
        const flow = await this.store.createFromWorkflow(this.registry, graph.id, { folder, objective, createdBy: input.createdBy || '',
            ...(graph.kind === 'default' ? { executionType: input.executionType } : {}) });
        await this._serialize(flow.id, async () => {
            await this._prepareVisit(flow.id, flow.graph.entryTaskId);
            await this._dispatch(flow.id);
        });
        return this.getFlow(flow.id, { logMode: 'none' });
    }
    _instance(taskId, sequence) {
        return { id: TaskFlowStore.newInvocationId(), sequence, taskId, state: 'queued', robotName: null, robotId: null,
            runtimeTaskId: null, nextEdgeId: null, createdAt: new Date().toISOString(), startedAt: null, endedAt: null, error: null };
    }
    async _prepareVisit(id, taskId) {
        await this.store.update(id, flow => {
            const instance = this._instance(taskId, flow.instances.length);
            flow.instances.push(instance); flow.currentInstanceId = instance.id;
        });
    }
    async _dispatch(id, instanceId = null, continuationPrompt = '') {
        let flow = await this.store.get(id);
        if (!flow || terminal(flow.status)) return;
        const instance = flow.instances.find(item => item.id === (instanceId || flow.currentInstanceId));
        if (!instance || instance.state !== 'queued' || instance.runtimeTaskId || flow.pauseRequested) return;
        const node = flow.graph.tasks.find(task => task.id === instance.taskId);
        try {
            if (flow.instances.length > this.maxVisits) throw new Error('maximum task visits reached');
            if (isCoordinator(node)) return await this.subflows.dispatch(flow, instance);
            const mode = flow.graph.kind === 'default' ? flow.executionType : node.executionType;
            const robots = (await this.robotStore.list()).filter(robot => (flow.graph.kind !== 'default' || robot.name === 'default') && matchRobot(robot, node));
            if (!robots.length) throw new Error(`No robot has matching skillsets for task ${node.id}`);
            const eligible = robots.filter(robot => mode === 'terminal' || GUI_CODING_AGENTS.some(agent => robotCodingAgents(robot).includes(agent)));
            if (!eligible.length) throw new Error(`No matching robot supports ${mode} for task ${node.id}`);
            const idle = mode === 'terminal' ? eligible : eligible.filter(robot => !this.runtimeManager.guiBusy?.(robot.id));
            const pool = idle.length ? idle : eligible;
            const robot = pool[Math.min(pool.length - 1, Math.floor(this.random() * pool.length))];
            const previous = [];
            for (const visit of flow.instances) if (visit.state === 'completed') previous.push({ taskId: visit.taskId, instanceId: visit.id,
                ...(visit.creatorInstanceId && visit.childFlowIds
                    ? { response: JSON.stringify(await this.subflows.results(visit.childFlowIds)) }
                    : workflowResponseContext(await this.store.readOutput(id, visit.id, 'result'), flow.graph, visit.taskId)) });
            let previousSubflowFinalResponse;
            if (flow.previousChildFlowId) {
                const preceding = await this.store.get(flow.previousChildFlowId);
                if (preceding?.status !== 'completed') throw invalid('The preceding sub-workflow must complete first');
                const last = preceding.instances.at(-1);
                if (!last) throw invalid('The preceding sub-workflow has no final task');
                previousSubflowFinalResponse = workflowResponseContext(
                    await this.store.readOutput(preceding.id, last.id, 'result'), preceding.graph, last.taskId).response;
            }
            const task = buildWorkflowTaskPrompt({ objective: flow.objective, currentTaskId: node.id, graph: flow.graph,
                previousFinalResponses: previous, continuationPrompt, previousSubflowFinalResponse });
            if (Buffer.byteLength(task, 'utf8') > 1024 * 1024) throw new Error('Workflow final-response context exceeds the 1 MiB input limit');
            const outgoing = flow.graph.edges.filter(edge => edge.sourceTaskId === node.id);
            const runtimeTaskId = crypto.randomUUID();
            await this.store.update(id, current => {
                const visit = current.instances.find(item => item.id === instance.id);
                Object.assign(visit, { robotId: robot.id, robotName: robot.name, executionType: mode, runtimeTaskId,
                    logRef: `.roboteam/roboflow/${id}/${instance.id}.log`, resultRef: `.roboteam/roboflow/${id}/${instance.id}.result` });
            });
            this.bindings.set(runtimeTaskId, { flowId: id, instanceId: instance.id });
            const selections = robotSelections(robot);
            const required = node.skillsets.map(identity => selections.find(set => set.id === identity));
            const skillSets = required.filter(item => item.kind === 'skillset').map(item => item.selector);
            const skills = required.filter(item => item.kind === 'skill').map(item => item.selector);
            const started = await this._startTask(robot, { cwd: flow.folder, task, taskType: EXECUTION_TASK_TYPES[mode], runtimeTaskId, workflowRunId: id, skillSets, skills,
                requiredWorkflowSkillsets: node.skillsets, workflowCreator: node.creator === true, allowsHumanInput: node.allowsHumanInput === true,
                systemPrompt: [node.creator ? creatorPrompt(flow.graph, node.id, await this.subflows.catalog()) : outgoing.length > 1 ? routingPrompt(flow.graph, node.id) : '',
                    node.allowsHumanInput ? 'For a blocking business decision not answered by the prompt or context, use the required require-human-input skill. After its script succeeds, end this execution immediately without a route or creator plan; RoboFlow will wait for the user answer.' : ''].filter(Boolean).join('\n\n') });
            if (started?.sessionUrl) await this.store.update(id, current => {
                const visit = current.instances.find(item => item.id === instance.id);
                if (visit) visit.sessionUrl = started.sessionUrl;
            });
        } catch (error) { await this._fail(id, error.message); }
    }
    async _startTask(robot, { skillSets = [], skills = [], taskType = 'simple', workflowCreator = false, allowsHumanInput = false, ...request }) {
        const start = (current, selection) => this.runtimeManager.startTask(current, taskType, { ...request, allowsHumanInput, skillPolicyRef: selection?.policyId,
            alaSessionId: selection?.policyId, ca: 'auto' });
        if (!this.skillsets) return start(robot);
        return this.skillsets.start(robot, { cwd: request.cwd, skillSets, skills, task: request.task, ca: 'auto', workflowCreator, allowsHumanInput }, start);
    }
    async _fail(id, message, status = 'failed') {
        const flow = await this.store.get(id);
        if (!flow || flow.status === 'terminated') return;
        const active = flow.instances.filter(instance => !terminal(instance.state));
        if (!active.length) return;
        if (!flow.pauseRequested && active.some(instance => instance.creatorInstanceId)) {
            await this.store.update(id, current => { current.pauseRequested = true; });
            await this.subflows.pauseChildren(flow);
        }
        const started = new Map();
        for (const instance of active) if (instance.runtimeTaskId) {
            this.bindings.delete(instance.runtimeTaskId);
            const robot = await this.robotStore.getByName(instance.robotName);
            if (robot) {
                const runtime = this.runtimeManager.taskStatus?.(robot.id, instance.runtimeTaskId);
                if (runtime?.startedAt) started.set(instance.id, runtime.startedAt);
                try { await this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[instance.executionType], instance.runtimeTaskId); } catch { /* Runtime may already be terminal. */ } }
        }
        await this.store.update(id, current => {
            current.error = message; current.finishedAt = new Date().toISOString();
            for (const visit of current.instances) if (!terminal(visit.state)) {
                visit.startedAt ||= started.get(visit.id) || null;
                visit.state = status; visit.error = message; visit.endedAt = current.finishedAt;
            }
            current.status = deriveFlowStatus(current.instances);
        });
    }
    async pauseFlow(id) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            if (['pending', 'completed', 'failed', 'terminated'].includes(flow.status)) return this.getFlow(id);
            await this.store.update(id, current => { current.pauseRequested = true; });
            await this.subflows.pauseChildren(flow);
            await this._fail(id, 'Paused by user', 'paused');
            return this.getFlow(id);
        });
    }
    async terminateFlow(id) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            // Persist the irreversible gate before stopping processes or visiting children.
            await this.store.update(id, current => {
                current.status = 'terminated'; current.pauseRequested = true;
                current.terminatedAt ||= new Date().toISOString();
                current.finishedAt = current.terminatedAt; current.error = null;
                if (current.humanInput?.status === 'pending') current.humanInput.status = 'cancelled';
                for (const visit of current.instances) if (visit.state !== 'completed') {
                    visit.state = 'terminated'; visit.endedAt ||= current.finishedAt;
                }
            });
            const children = [...new Set(flow.instances.flatMap(item => item.childFlowIds || []))];
            const results = await Promise.allSettled(children.map(child => this.terminateFlow(child)));
            for (const visit of flow.instances) if (visit.runtimeTaskId && !['completed', 'failed'].includes(visit.state)) {
                this.bindings.delete(visit.runtimeTaskId);
                const robot = await this.robotStore.getByName(visit.robotName);
                if (robot) results.push(await Promise.resolve().then(() => this.runtimeManager.stopTask(
                    robot, EXECUTION_TASK_TYPES[visit.executionType], visit.runtimeTaskId))
                    .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })));
            }
            const failures = results.filter(result => result.status === 'rejected');
            if (failures.length) throw new Error(`Workflow terminated, but stopping execution failed: ${failures.map(item => item.reason.message).join('; ')}`);
            return this.getFlow(id);
        });
    }
    async pauseInstance(id, instanceId) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        const instance = flow.instances.find(item => item.id === instanceId);
        if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
        if (terminal(instance.state)) return this.getFlow(id);
        return this.pauseFlow(id);
    }
    async resumeFlow(id) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            if (flow.humanInput?.status === 'pending') throw invalid('Answer the pending human-input question before resuming');
            await this.subflows.assertCanContinue(flow);
            if (!flow.instances.some(item => item.state === 'paused')) return this.getFlow(id);
            await this.store.update(id, current => { current.pauseRequested = false; });
            const errors = [];
            try { await this.subflows.resumeChildren(flow); } catch (error) { errors.push(error.message); }
            const results = await Promise.allSettled(flow.instances.filter(item => item.state === 'paused'
                && !isCoordinator(flow.graph.tasks.find(task => task.id === item.taskId)))
                .map(item => this._resumeInstance(id, item.id, CONTINUE_PROMPT)));
            errors.push(...results.filter(item => item.status === 'rejected').map(item => item.reason.message));
            await this.subflows.reconcile(id);
            if (errors.length) throw new Error(errors.join('; '));
            return this.getFlow(id);
        });
    }
    async messageInstance(id, instanceId, prompt) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        const instance = flow.instances.find(item => item.id === instanceId);
        if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
        if (terminal(instance.state) || !instance.runtimeTaskId) throw invalid('only a running phase accepts a live prompt; continue it instead');
        const message = textField(prompt, 'prompt', 32768, true);
        const robot = await this.robotStore.getByName(instance.robotName);
        if (!robot) throw new Error('Robot is unavailable');
        const delivery = await this.runtimeManager.sendTaskMessage(robot, instance.runtimeTaskId, message);
        await this.store.writeOutput(id, instanceId, `\n${message.split(/\r?\n/).map(line => `you> ${line}`).join('\n')}\n\n`);
        return { ...delivery, flow: await this.getFlow(id) };
    }
    async resumeInstance(id, instanceId, prompt) {
        const flow = await this.store.get(id);
        const instance = flow?.instances.find(item => item.id === instanceId);
        if (instance && isCoordinator(flow.graph.tasks.find(task => task.id === instance.taskId))) return this.resumeFlow(id);
        return this._serialize(id, () => this._resumeInstance(id, instanceId, prompt));
    }
    async _resumeInstance(id, instanceId, prompt, humanInputId = null, answeredBy = '') {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        if (flow.humanInput?.status === 'pending' && flow.humanInput.id !== humanInputId) throw invalid('Answer the pending human-input question before continuing');
        await this.subflows.assertCanContinue(flow);
        const instance = flow.instances.find(item => item.id === instanceId);
        if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
        if (!['paused', 'completed', 'failed'].includes(instance.state)) throw invalid('only a paused, completed or failed phase can continue');
        const message = textField(prompt, 'prompt', 32768, false);
        if (['paused', 'failed'].includes(instance.state) && !instance.startedAt
            && !isCoordinator(flow.graph.tasks.find(task => task.id === instance.taskId))) {
            this.bindings.delete(instance.runtimeTaskId);
            await this.store.update(id, current => {
                const phase = current.instances.find(item => item.id === instanceId);
                phase.state = 'queued'; phase.runtimeTaskId = null; phase.error = null; phase.endedAt = null;
                current.currentInstanceId = instanceId; current.pauseRequested = false; this._derive(current);
            });
            await this._dispatch(id, instanceId, message);
            return this.getFlow(id);
        }
        const robot = await this.robotStore.getByName(instance.robotName);
        if (!robot) throw new Error('Robot is unavailable');
        const previous = { runtimeTaskId: instance.runtimeTaskId, state: instance.state, error: instance.error, endedAt: instance.endedAt };
        const runtimeTaskId = crypto.randomUUID();
        await this.store.update(id, current => {
            const visit = current.instances.find(item => item.id === instanceId);
            if (humanInputId) current.humanInput = { ...current.humanInput, status: 'answered', answer: message.slice('My answer to your question is: '.length), answeredAt: new Date().toISOString(), answeredBy };
            visit.runtimeTaskId = runtimeTaskId; visit.state = 'running'; visit.error = null; visit.endedAt = null;
            current.status = deriveFlowStatus(current.instances); current.finishedAt = null; current.error = null; current.pauseRequested = false;
        });
        this.bindings.set(runtimeTaskId, { flowId: id, instanceId, manual: true });
        try {
            await this.runtimeManager.resumeTask(robot, previous.runtimeTaskId, message, { runtimeTaskId });
        } catch (error) {
            this.bindings.delete(runtimeTaskId);
            await this.store.update(id, current => {
                const visit = current.instances.find(item => item.id === instanceId);
                if (humanInputId) current.humanInput = flow.humanInput;
                visit.runtimeTaskId = previous.runtimeTaskId; visit.state = previous.state; visit.error = previous.error; visit.endedAt = previous.endedAt;
                current.status = deriveFlowStatus(current.instances);
                if (current.status !== 'running') current.finishedAt = current.finishedAt || new Date().toISOString();
            }).catch(() => {});
            throw error;
        }
        if (message) await this.store.writeOutput(id, instanceId, `\n${message.split(/\r?\n/).map(line => `you> ${line}`).join('\n')}\n\n`);
        return this.getFlow(id);
    }
    async _completed(binding, event) {
        const flow = await this.store.get(binding.flowId);
        if (!flow || flow.status === 'terminated') return;
        const instance = flow.instances.find(item => item.id === binding.instanceId);
        if (!instance || (terminal(instance.state) && !(event.forcedFailure && instance.state === 'paused'))) return;
        if (event.forcedFailure && event.state === 'failed') {
            await this.store.update(flow.id, current => {
                const visit = current.instances.find(item => item.id === instance.id);
                visit.state = 'failed'; visit.error = event.error; visit.endedAt = new Date().toISOString();
                if (current.humanInput?.runtimeTaskId === event.taskId) current.humanInput = null;
                current.error = event.error;
                this._derive(current);
            });
            return;
        }
        if (flow.humanInput?.status === 'pending' || (terminal(flow.status) && !binding.manual)) return;
        if (event.state === 'paused') return this._fail(flow.id, event.error || `Task ${instance.taskId} paused`, 'paused');
        if (event.state !== 'completed' || event.error) return this._fail(flow.id, event.error || `Task ${instance.taskId} ${event.state}`, 'failed');
        await this.store.writeOutput(flow.id, instance.id, event.result || '', 'result');
        const node = flow.graph.tasks.find(task => task.id === instance.taskId);
        const outgoing = flow.graph.edges.filter(edge => edge.sourceTaskId === instance.taskId);
        const plan = node.creator ? await this.subflows.plan(flow, instance, event.result) : null;
        const edge = plan?.edge || (outgoing.length > 1 ? parseRoute(event.result, flow.graph, instance.taskId).edge : outgoing[0]);
        await this._advance(flow.id, instance.id, edge, plan);
    }
    async _advance(id, instanceId, edge, plan = null) {
        await this.store.update(id, current => {
            const visit = current.instances.find(item => item.id === instanceId);
            visit.state = 'completed'; visit.endedAt = new Date().toISOString(); visit.nextEdgeId = edge?.id || null;
            if (edge) {
                const next = this._instance(edge.targetTaskId, current.instances.length);
                current.instances.push(next); current.currentInstanceId = next.id;
                if (plan?.plans) this.subflows.createChildren(current, visit, next, plan);
            }
            this._derive(current);
        });
        if (edge) await this._dispatch(id);
    }
    onRuntimeTaskEvent(event) {
        const generation = this.generations.get(event?.taskId);
        if (generation) { if (event.kind === 'terminal') { this.generations.delete(event.taskId); event.state === 'completed' && !event.error ? generation.resolve(event.result) : generation.reject(new Error(event.error || 'Graph generation failed')); } return; }
        const binding = this.bindings.get(event?.taskId);
        if (!binding) return;
        if (event.kind === 'terminal') this.bindings.delete(event.taskId);
        void this._serialize(binding.flowId, async () => {
            const flow = await this.store.get(binding.flowId);
            if (!flow || flow.status === 'terminated') return;
            const visit = flow.instances.find(item => item.id === binding.instanceId);
            if (!visit || visit.runtimeTaskId !== event.taskId) return;
            if (event.kind === 'terminal' && event.forcedFailure) return this._completed(binding, event);
            if (flow.humanInput?.status === 'pending' && flow.humanInput.runtimeTaskId === event.taskId) {
                if (event.kind === 'progress') await this.store.writeOutput(flow.id, visit.id, event.chunk, 'log', { assistant: event.outputKind === 'assistant', complete: event.outputComplete, outputId: event.outputId });
                if (event.kind === 'terminal') {
                    let outputUnavailable = false;
                    try { await this.store.writeOutput(flow.id, visit.id, event.result || '', 'result'); }
                    catch { outputUnavailable = true; }
                    await this.store.update(flow.id, current => {
                        current.humanInput.executionEnded = true;
                        const phase = current.instances.find(item => item.id === visit.id);
                        phase.state = 'paused'; phase.endedAt = new Date().toISOString();
                        if (outputUnavailable) phase.outputUnavailable = true;
                        current.status = 'paused';
                    });
                }
                return;
            }
            if (terminal(flow.status) && !binding.manual) return;
            if (event.kind === 'progress') await this.store.writeOutput(flow.id, binding.instanceId, event.chunk, 'log', { assistant: event.outputKind === 'assistant', complete: event.outputComplete, outputId: event.outputId });
            else if (event.kind === 'state') await this.store.update(flow.id, current => {
                const instance = current.instances.find(item => item.id === binding.instanceId);
                if (instance && !terminal(instance.state)) { instance.state = event.state; instance.startedAt ||= new Date().toISOString(); }
            });
            else if (event.kind === 'terminal') await this._completed(binding, event);
        }).catch(error => this._serialize(binding.flowId, () => this._fail(binding.flowId, error.message)).catch(() => {}));
    }
    async listFlows({ folder } = {}) { return (await this.store.list()).filter(flow => !folder || flow.folder === folder); }
    async requestHumanInput(runtimeTaskId, input) {
        const binding = this.bindings.get(runtimeTaskId);
        if (!binding) throw invalid('This workflow execution is no longer active');
        const question = textField(input?.question, 'question', 8000, true);
        if (!Array.isArray(input.options) || input.options.length !== 3) throw invalid('Exactly three options are required');
        const options = input.options.map(option => textField(option, 'option', 2000, true));
        if (new Set(options).size !== 3) throw invalid('Options must be distinct');
        return this._serialize(binding.flowId, async () => {
            const flow = await this.store.get(binding.flowId);
            const instance = flow?.instances.find(item => item.id === binding.instanceId);
            if (!instance || instance.runtimeTaskId !== runtimeTaskId
                || !flow.graph.tasks.find(task => task.id === instance.taskId)?.allowsHumanInput) throw invalid('Human input is not allowed for this execution');
            if (flow.humanInput?.status === 'pending') {
                if (flow.humanInput.runtimeTaskId === runtimeTaskId && flow.humanInput.question === question
                    && JSON.stringify(flow.humanInput.options) === JSON.stringify(options)) return { id: flow.humanInput.id };
                throw invalid('A human-input question is already pending');
            }
            if (flow.status !== 'running' || terminal(instance.state) || flow.pauseRequested) throw invalid('This workflow execution is no longer active');
            const request = { id: crypto.randomUUID(), instanceId: instance.id, runtimeTaskId, question, options,
                status: 'pending', executionEnded: false, createdAt: new Date().toISOString() };
            await this.store.update(flow.id, current => {
                current.humanInput = request;
                current.status = 'paused'; current.finishedAt = request.createdAt; current.error = null;
                const visit = current.instances.find(item => item.id === instance.id);
                visit.startedAt ||= request.createdAt;
                visit.state = 'paused'; visit.endedAt = request.createdAt;
            });
            return { id: request.id };
        });
    }
    async answerHumanInput(id, input, actorId = '') {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            const request = flow.humanInput;
            if (request?.status !== 'pending' || input?.requestId !== request.id) throw Object.assign(invalid('This question is no longer waiting for an answer'), { statusCode: 409 });
            if (!request.executionEnded) throw Object.assign(invalid('The robot is still finishing its current execution. Try again shortly.'), { statusCode: 409 });
            const choice = input.option;
            if (!Number.isInteger(choice) || choice < 0 || choice > 3) throw invalid('Choose one of the four answer options');
            const answer = choice === 3 ? textField(input.text, 'answer', 32000, true) : request.options[choice];
            return this._resumeInstance(id, request.instanceId, `My answer to your question is: ${answer}`, request.id, actorId);
        });
    }
    async getFlow(id, { logMode = 'none' } = {}) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        for (const instance of flow.instances) {
            if (instance.childFlowIds) instance.subflows = await Promise.all(instance.childFlowIds.map(async childId => {
                const child = await this.store.get(childId);
                return child ? { id: child.id, workflowName: child.workflowName, status: child.status, error: child.error,
                    elapsedMs: child.elapsedMs, activeSince: child.activeSince, createdAt: child.createdAt, finishedAt: child.finishedAt }
                    : { id: childId, status: 'unavailable' };
            }));
            if (instance.state === 'completed') {
                try { instance.finalResponse = await this.store.readOutput(id, instance.id, 'result'); }
                catch { instance.outputUnavailable = true; }
            }
            if (logMode !== 'none') {
                try { const log = await this.store.readOutput(id, instance.id); instance.log = logMode === 'tail' ? log.slice(-8192) : log; }
                catch { instance.outputUnavailable = true; }
            }
        }
        if (flow.status === 'completed') flow.result = flow.instances.at(-1)?.finalResponse || '';
        return flow;
    }
    async getInvocationLog(id, instanceId) {
        try { return await this.store.readOutput(id, instanceId); }
        catch (error) {
            if (error.code === 'ENOENT') return '';
            throw error;
        }
    }
    async generationCwd(folder) {
        if (folder) return this.runtimeManager.resolveCwd(folder);
        let directory = await this.runtimeManager.resolveCwd(this.workspaceRoot);
        for (const segment of ['.roboteam', 'roboflow-generation']) {
            directory = path.join(directory, segment);
            await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe graph generation directory');
        }
        return this.runtimeManager.resolveCwd(directory);
    }
    async generateWorkflow(input, { signal } = {}) {
        const description = textField(input.description, 'description', 32768, true);
        const catalog = await this.catalog();
        const robot = await this.robotStore.getByName('default');
        if (!robot) throw new Error('Default robot is unavailable');
        const cwd = await this.generationCwd(input.folder);
        const runtimeTaskId = crypto.randomUUID();
        let resolve, reject;
        const completed = new Promise((res, rej) => { resolve = res; reject = rej; });
        void completed.catch(() => {});
        this.generations.set(runtimeTaskId, { resolve, reject });
        const abort = () => { this.generations.delete(runtimeTaskId); try { Promise.resolve(this.runtimeManager.stopTask(robot, 'simple', runtimeTaskId)).catch(() => {}); } catch { /* Already stopped. */ } reject(new Error('Graph generation cancelled')); };
        signal?.addEventListener('abort', abort, { once: true });
        try {
            signal?.throwIfAborted();
            await this._startTask(robot, { cwd, task: description, runtimeTaskId, skillSets: [], systemPrompt: generationPrompt(catalog) });
            const graph = normalizeWorkflow(parseWorkflowResponse(await completed, { generation: true }));
            const known = new Set(catalog.skillsets.map(set => set.id));
            if (graph.tasks.some(task => task.skillsets.some(id => !known.has(id)))) throw invalid('Generated graph contains an unknown skillset');
            return { graph, coverage: coverage(graph, await this.robotStore.list()), diagnostics: [...catalog.diagnostics, ...graphDiagnostics(graph)] };
        } finally { this.generations.delete(runtimeTaskId); signal?.removeEventListener('abort', abort); }
    }
    // Browser-facing generation: start returns immediately with an id and the
    // page polls generationInfo every couple of seconds for live task logs.
    async startGeneration(input) {
        const description = textField(input.description, 'description', 32768, true);
        let revision;
        if (input.workflow !== undefined) {
            if (input.workflow?.readOnly || ['default', 'code-development'].includes(input.workflow?.id)) throw invalid('Read-only workflows cannot be regenerated');
            const previousDescription = textField(input.previousDescription, 'previousDescription', 4000);
            const workflow = normalizeWorkflow({ ...input.workflow, description: previousDescription });
            textField(description, 'description', 4000, true);
            revision = { previousDescription, description, workflow };
        }
        const catalog = await this.catalog();
        const robot = await this.robotStore.getByName('default');
        if (!robot) throw new Error('Default robot is unavailable');
        const cwd = await this.generationCwd(input.folder);
        const record = { id: crypto.randomUUID(), runtimeTaskId: crypto.randomUUID(), robotId: robot.id,
            status: 'running', graph: null, error: null, startedAt: new Date().toISOString(), catalog, ...(revision ? { revision } : {}) };
        this.generationTasks.set(record.id, record);
        void this._runGeneration(record, robot, cwd, description).catch(() => {});
        return { id: record.id };
    }
    async _runGeneration(record, robot, cwd, description) {
        let resolve, reject;
        const completed = new Promise((res, rej) => { resolve = res; reject = rej; });
        void completed.catch(() => {});
        this.generations.set(record.runtimeTaskId, { resolve, reject });
        try {
            await this._startTask(robot, { cwd, task: record.revision ? JSON.stringify(record.revision) : description, runtimeTaskId: record.runtimeTaskId, skillSets: [],
                systemPrompt: record.revision ? descriptionRevisionPrompt(record.catalog) : generationPrompt(record.catalog) });
            const parsed = parseWorkflowResponse(await completed, { generation: true, revision: Boolean(record.revision) });
            if (record.status === 'cancelled') return;
            if (record.revision) {
                if (typeof parsed.regenerate !== 'boolean') throw invalid('Description revision requires a boolean regenerate decision');
                record.reason = textField(parsed.reason, 'reason', 4000, true);
                record.regenerate = parsed.regenerate;
            }
            if (!record.revision || record.regenerate) {
                const graph = normalizeWorkflow(record.revision ? { ...parsed, id: record.revision.workflow.id,
                    name: record.revision.workflow.name, description: record.revision.description } : parsed);
                const known = new Set(record.catalog.skillsets.map(set => set.id));
                if (graph.tasks.some(task => task.skillsets.some(id => !known.has(id)))) throw invalid('Generated graph contains an unknown skillset');
                record.graph = { ...graph, coverage: coverage(graph, await this.robotStore.list()),
                    diagnostics: [...record.catalog.diagnostics, ...graphDiagnostics(graph)] };
            }
            record.status = 'completed';
        } catch (error) {
            if (record.status !== 'cancelled') { record.status = 'failed'; record.error = error.message; }
        } finally {
            this.generations.delete(record.runtimeTaskId);
            delete record.catalog;
            delete record.revision;
        }
    }
    generationInfo(id) {
        const record = this.generationTasks.get(id);
        if (!record) return null;
        const log = (this.runtimeManager?.taskStatus?.(record.robotId, record.runtimeTaskId)?.logTail || '').slice(-256 * 1024);
        const info = { id: record.id, status: record.status, log, graph: record.graph, error: record.error,
            ...(typeof record.regenerate === 'boolean' ? { regenerate: record.regenerate, reason: record.reason } : {}) };
        if (terminal(record.status)) this.generationTasks.delete(id);
        return info;
    }
    cancelGeneration(id) {
        const record = this.generationTasks.get(id);
        if (!record) return null;
        if (record.status === 'running') {
            record.status = 'cancelled';
            record.error = 'Graph generation cancelled';
            this.generations.get(record.runtimeTaskId)?.reject(new Error(record.error));
            try { Promise.resolve(this.runtimeManager?.stopTask?.({ id: record.robotId }, 'simple', record.runtimeTaskId)).catch(() => {}); } catch { /* Runtime may already be terminal. */ }
        }
        const info = { id: record.id, status: record.status, graph: record.graph, error: record.error };
        this.generationTasks.delete(id);
        return info;
    }
    async close() { this.closed = true; clearTimeout(this.presetTimer); this.presetWake?.(); this.store.onStatusChange = null; for (const generation of this.generations.values()) generation.reject(new Error('Service stopped')); this.generations.clear(); this.generationTasks.clear(); await Promise.allSettled(this.chains.values()); this.bindings.clear(); this.database.close(); }
}
