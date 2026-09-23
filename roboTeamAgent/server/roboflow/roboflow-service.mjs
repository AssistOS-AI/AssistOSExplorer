import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RoboFlowDatabase } from './database.mjs';
import { WorkflowRegistry } from './workflow-registry.mjs';
import { TaskFlowStore } from './task-flow-store.mjs';
import { normalizeWorkflow, invalid, textField, graphDiagnostics } from './graph.mjs';
import { coverage, matchRobot, robotSelections, discoverWorkflowSkillsets } from './skill-matching.mjs';
import { routingPrompt, parseRoute, extractJson } from './result-parser.mjs';
import { ensureDefaultWorkflow } from './default-workflow.mjs';
import { EXECUTION_TASK_TYPES, EXECUTION_TYPES, WORKFLOWS_DIR } from './constants.mjs';
import { robotCodingAgents, GUI_CODING_AGENTS } from '../coding-agents.mjs';

const terminal = state => ['completed', 'failed', 'stopped', 'interrupted'].includes(state);
const missing = () => Object.assign(new Error('workflow run not found'), { statusCode: 404 });

// Prepended to the user's description for graph generation; ALA has no separate
// system-instruction option.
function generationPrompt(catalog) {
    return [
        'You are a workflow planner. For the user task, produce an optimal directed graph: split the task into smaller tasks that each make sense, and find the execution paths that can lead the task to completion. A task can have several possible execution paths, not only a linear one.',
        'Every task is executed by a coding agent and must declare exactly one execution type:',
        '- terminal: the usual CLI coding-agent mode;',
        '- desktop: coding agents with computer-use MCP tools operating a virtual desktop;',
        '- browser: coding agents with browser-use MCP tools operating a DuckDuckGo browser, to navigate the web and browse sites.',
        'Return one JSON object with no prose and do not execute the workflow. Fields: name, description, entryTaskId, tasks, edges, layout. Each task has a unique id, name, description, skillsets (array of exact catalog IDs) and executionType (terminal, desktop or browser). Each edge has a unique id, sourceTaskId, targetTaskId and no description. Write task descriptions that let a branching task select its outgoing edge. All endpoints and the entry task must exist. Cycles are allowed. Never choose robots and never generate the reserved default workflow. Layout is optional.',
        `Catalog: ${JSON.stringify(catalog?.skillsets || [])}.`,
        'Example: {"name":"Report","description":"Produce a report","entryTaskId":"research","tasks":[{"id":"research","name":"Research","description":"Open DuckDuckGo and collect sources about the topic","skillsets":[],"executionType":"browser"},{"id":"report","name":"Report","description":"Write the report from the collected sources","skillsets":[],"executionType":"terminal"}],"edges":[{"id":"done","sourceTaskId":"research","targetTaskId":"report"}]}',
    ].join('\n');
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
        if (!Number.isSafeInteger(this.maxVisits) || this.maxVisits < 1) throw new Error('Workflow visit limit must be a positive integer');
        this.discover = options.discoverSkillsets || (() => discoverWorkflowSkillsets(this.skillsets?.repositoriesClient));
        this.bindings = new Map();
        this.chains = new Map();
        this.generations = new Map();
    }
    async initialize() {
        await this.registry.initialize();
        await ensureDefaultWorkflow(this.registry);
        for (const flow of await this.store.list()) if (!terminal(flow.status)) await this.store.update(flow.id, current => {
            current.status = 'failed'; current.error = 'interrupted by service restart'; current.finishedAt = new Date().toISOString();
            for (const instance of current.instances) if (!terminal(instance.state)) { instance.state = 'interrupted'; instance.error = current.error; instance.endedAt = current.finishedAt; }
        });
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
            ...task, name: task.name || 'Draft task', description: task.description || 'Draft task description' })) });
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
    async _dispatch(id) {
        let flow = await this.store.get(id);
        if (!flow || terminal(flow.status)) return;
        const instance = flow.instances.find(item => item.id === flow.currentInstanceId);
        const node = flow.graph.tasks.find(task => task.id === instance.taskId);
        try {
            if (flow.instances.length > this.maxVisits) throw new Error('maximum task visits reached');
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
                response: await this.store.readOutput(id, visit.id, 'result') });
            const task = JSON.stringify({ instruction: 'Execute only the task identified by currentTaskId, following its description and the objective. Use previousFinalResponses as context. Do not execute other graph nodes. Return a final answer, following routing instructions only when supplied.', objective: flow.objective, currentTaskId: node.id, graph: flow.graph, previousFinalResponses: previous });
            if (Buffer.byteLength(task, 'utf8') > 1024 * 1024) throw new Error('Workflow final-response context exceeds the 1 MiB input limit');
            const outgoing = flow.graph.edges.filter(edge => edge.sourceTaskId === node.id);
            const runtimeTaskId = crypto.randomUUID();
            await this.store.update(id, current => {
                const visit = current.instances.find(item => item.id === instance.id);
                Object.assign(visit, { robotId: robot.id, robotName: robot.name, executionType: mode, runtimeTaskId,
                    logRef: `.achilles-cli/roboflow/${id}/${instance.id}.log`, resultRef: `.achilles-cli/roboflow/${id}/${instance.id}.result` });
            });
            this.bindings.set(runtimeTaskId, { flowId: id, instanceId: instance.id });
            const skillSets = node.skillsets.map(identity => robotSelections(robot).find(set => set.id === identity).selector);
            await this._startTask(robot, { cwd: flow.folder, task, taskType: EXECUTION_TASK_TYPES[mode], runtimeTaskId, skillSets,
                requiredWorkflowSkillsets: node.skillsets, systemPrompt: outgoing.length > 1 ? routingPrompt(flow.graph, node.id) : '' });
        } catch (error) { await this._fail(id, error.message); }
    }
    async _startTask(robot, { skillSets = [], taskType = 'simple', ...request }) {
        const start = (current, selection) => this.runtimeManager.startTask(current, taskType, { ...request, skillPolicyRef: selection?.policyId,
            alaSessionId: selection?.policyId, ca: 'auto' });
        if (!this.skillsets) return start(robot);
        return this.skillsets.start(robot, { cwd: request.cwd, skillSets, skills: [], task: request.task, ca: 'auto' }, start);
    }
    async _fail(id, message, status = 'failed') {
        const flow = await this.store.get(id);
        if (!flow || terminal(flow.status)) return;
        for (const instance of flow.instances) if (!terminal(instance.state) && instance.runtimeTaskId) {
            this.bindings.delete(instance.runtimeTaskId);
            const robot = await this.robotStore.getByName(instance.robotName);
            if (robot) { try { await this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[instance.executionType], instance.runtimeTaskId); } catch { /* Runtime may already be terminal. */ } }
        }
        await this.store.update(id, current => {
            current.status = status; current.error = message; current.finishedAt = new Date().toISOString();
            for (const visit of current.instances) if (!terminal(visit.state)) { visit.state = status; visit.error = message; visit.endedAt = current.finishedAt; }
        });
    }
    async stopFlow(id) { return this._serialize(id, async () => { if (!await this.store.get(id)) throw missing(); await this._fail(id, 'Stopped by user', 'stopped'); return this.getFlow(id); }); }
    async stopInstance(id, instanceId) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            const instance = flow.instances.find(item => item.id === instanceId);
            if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
            if (terminal(instance.state)) return this.getFlow(id);
            if (instance.runtimeTaskId) {
                this.bindings.delete(instance.runtimeTaskId);
                const robot = await this.robotStore.getByName(instance.robotName);
                if (robot) { try { await this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[instance.executionType], instance.runtimeTaskId); } catch { /* Runtime may already be terminal. */ } }
            }
            await this.store.update(id, current => {
                const visit = current.instances.find(item => item.id === instanceId);
                visit.state = 'stopped'; visit.error = 'Stopped by user'; visit.endedAt = new Date().toISOString();
            });
            await this._fail(id, 'Stopped by user', 'stopped');
            return this.getFlow(id);
        });
    }
    async _completed(binding, event) {
        const flow = await this.store.get(binding.flowId);
        if (!flow || terminal(flow.status)) return;
        const instance = flow.instances.find(item => item.id === binding.instanceId);
        if (!instance || terminal(instance.state)) return;
        if (event.state !== 'completed' || event.error) return this._fail(flow.id, event.error || `Task ${instance.taskId} ${event.state}`);
        await this.store.writeOutput(flow.id, instance.id, event.result || '', 'result');
        const outgoing = flow.graph.edges.filter(edge => edge.sourceTaskId === instance.taskId);
        const edge = outgoing.length > 1 ? parseRoute(event.result, flow.graph, instance.taskId).edge : outgoing[0];
        await this.store.update(flow.id, current => {
            const visit = current.instances.find(item => item.id === instance.id);
            visit.state = 'completed'; visit.endedAt = new Date().toISOString(); visit.nextEdgeId = edge?.id || null;
            if (!edge) { current.status = 'completed'; current.finishedAt = visit.endedAt; }
            else { const next = this._instance(edge.targetTaskId, current.instances.length); current.instances.push(next); current.currentInstanceId = next.id; }
        });
        if (edge) await this._dispatch(flow.id);
    }
    onRuntimeTaskEvent(event) {
        const generation = this.generations.get(event?.taskId);
        if (generation) { if (event.kind === 'terminal') { this.generations.delete(event.taskId); event.state === 'completed' && !event.error ? generation.resolve(event.result) : generation.reject(new Error(event.error || 'Graph generation failed')); } return; }
        const binding = this.bindings.get(event?.taskId);
        if (!binding) return;
        if (event.kind === 'terminal') this.bindings.delete(event.taskId);
        void this._serialize(binding.flowId, async () => {
            const flow = await this.store.get(binding.flowId);
            if (!flow || terminal(flow.status)) return;
            if (event.kind === 'progress') await this.store.writeOutput(flow.id, binding.instanceId, event.chunk);
            else if (event.kind === 'state') await this.store.update(flow.id, current => {
                const instance = current.instances.find(item => item.id === binding.instanceId);
                if (instance && !terminal(instance.state)) { instance.state = event.state; instance.startedAt ||= new Date().toISOString(); }
            });
            else if (event.kind === 'terminal') await this._completed(binding, event);
        }).catch(error => this._serialize(binding.flowId, () => this._fail(binding.flowId, error.message)).catch(() => {}));
    }
    async listFlows({ folder } = {}) { return (await this.store.list()).filter(flow => !folder || flow.folder === folder); }
    async getFlow(id, { logMode = 'none' } = {}) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        for (const instance of flow.instances) {
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
    async getInvocationLog(id, instanceId) { return this.store.readOutput(id, instanceId); }
    async generationCwd(folder) {
        if (folder) return this.runtimeManager.resolveCwd(folder);
        let directory = await this.runtimeManager.resolveCwd(this.workspaceRoot);
        for (const segment of ['.achilles-cli', 'roboflow-generation']) {
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
            const graph = normalizeWorkflow(extractJson(await completed));
            const known = new Set(catalog.skillsets.map(set => set.id));
            if (graph.tasks.some(task => task.skillsets.some(id => !known.has(id)))) throw invalid('Generated graph contains an unknown skillset');
            return { graph, coverage: coverage(graph, await this.robotStore.list()), diagnostics: [...catalog.diagnostics, ...graphDiagnostics(graph)] };
        } finally { this.generations.delete(runtimeTaskId); signal?.removeEventListener('abort', abort); }
    }
    async close() { for (const generation of this.generations.values()) generation.reject(new Error('Service stopped')); this.generations.clear(); await Promise.allSettled(this.chains.values()); this.bindings.clear(); this.database.close(); }
}
