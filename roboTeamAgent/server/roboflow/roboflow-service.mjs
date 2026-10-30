import { Subflows, CONTINUE_PROMPT } from './subflows.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { RoboFlowDatabase } from './database.mjs';
import { WorkflowRegistry } from './workflow-registry.mjs';
import { FLOWS_FOLDER } from './workflow-files.mjs';
import { TaskFlowStore } from './task-flow-store.mjs';
import { ScheduleStore } from './schedule-store.mjs';
import { ScheduleFolders } from './schedule-folders.mjs';
import { RunFolders, jobFolderName } from './run-folders.mjs';
import { WorkflowScheduler } from './workflow-scheduler.mjs';
import { normalizeWorkflow, invalid, textField, graphDiagnostics, isCoordinator, resolveWorkflowObjective, assertRunnable } from './graph.mjs';
import { coverage, matchRobot, robotSelections, discoverWorkflowSkillsets } from './skill-matching.mjs';
import { parseRoute, parseWorkflowResponse, workflowResponseContext } from './result-parser.mjs';
import { generationPrompt, routingPrompt, buildWorkflowTaskPrompt, creatorPrompt } from '../../copilot/src/lib/prompts.mjs';
import { presetGraph, readPresets } from './workflow-presets.mjs';
import { requiredDocumentationRepository } from '../required-skills.mjs';
import { EXECUTION_TASK_TYPES, EXECUTION_TYPES } from './constants.mjs';
import { robotCodingAgents, GUI_CODING_AGENTS } from '../coding-agents.mjs';
import { COORDINATOR_BASE_ENV } from '../worker-coordinator/hop.mjs';
import { createWorkerClient, stopOperationId } from '../worker-coordinator/worker-client.mjs';
import { phaseOriginId } from '../worker-coordinator/flow-origins.mjs';
import { isReferenceId } from '../worker-coordinator/identities.mjs';
import { parentBindingFor, registerDerivedBinding } from '../worker-coordinator/background.mjs';
import { classifyPhase } from './worker-reconciliation.mjs';

const terminal = state => ['completed', 'failed', 'paused', 'terminated'].includes(state);
// Live Sessions owner: the signed principal (user:<id>) of the user who started
// the work. Anything else, including internal callers, is the system owner.
export const ownerPrincipalOf = value => typeof value === 'string' && /^user:.+/u.test(value) ? value : null;
const OBSERVED_TASK_EVENTS = new Set(['progress', 'state', 'terminal']);
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
        this.database = options.database || new RoboFlowDatabase(options.databaseFile);
        this.workspaceRoot = options.workspaceRoot || this.runtimeManager?.workspaceRoot || path.dirname(this.database.file);
        this.scheduleFolders = new ScheduleFolders(this.workspaceRoot);
        // Saved workflow types are JSON files in a flows folder next to the database (/data/roboflow/flows), like workspace
        // workflow files; built-in ones ship with the agent.
        this.presets = options.presets || readPresets();
        this.registry = new WorkflowRegistry({ directory: options.workflowsDirectory || path.join(path.dirname(this.database.file), FLOWS_FOLDER),
            presetIds: this.presets.map(preset => preset.id), workspaceRoot: this.workspaceRoot, folders: this.scheduleFolders });
        this.store = new TaskFlowStore({ database: this.database });
        this.runFolders = new RunFolders({ folders: this.scheduleFolders,
            resolveCwd: folder => this.runtimeManager.resolveCwd(folder), now: options.scheduleNow });
        this.schedules = new ScheduleStore({ database: this.database, registry: this.registry,
            resolveCwd: folder => this.runFolders.base(folder),
            defaultFolder: () => this.scheduleFolders.defaultFolder(), now: options.scheduleNow });
        this.scheduler = new WorkflowScheduler({ schedules: this.schedules, flows: this.store,
            startFlow: (input, options) => this.startFlow(input, options), now: options.scheduleNow, pollMs: options.schedulePollMs });
        this.random = options.random || Math.random;
        this.maxVisits = Number(options.maxVisits ?? process.env.ROBOTEAM_WORKFLOW_MAX_VISITS ?? 500);
        this.presetRetryMs = Number(options.presetRetryMs ?? 5000);
        this.closed = false;
        // With the worker coordinator configured, phases run on the worker: a restart queries the worker
        // before touching a phase (plan section 9) instead of resetting it, and derived flow bindings
        // are registered before a phase is admitted.
        const workerMode = options.workerMode ?? String(process.env[COORDINATOR_BASE_ENV] || '').trim() !== '';
        this.worker = workerMode && (options.workerClient || options.workerCoordinator?.hop)
            ? { hop: options.workerCoordinator?.hop || null, client: options.workerClient || createWorkerClient({ hop: options.workerCoordinator.hop }),
                sleep: options.workerSleep || (ms => new Promise(resolve => setTimeout(resolve, ms))), reconcileMs: options.workerReconcileMs ?? 2000 }
            : null;
        this.reconciliation = null;
        this.wakeReconcile = null;
        this.log = options.log || ((line) => console.log(line));
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
        await this.store.initialize();
        for (const preset of this.presets) if (!preset.repositories.length) this.registry.addPreset(presetGraph(preset));
        // Presets that name a repository need the Ploinky marketplace, which may not route to
        // this agent until it is ready (for example during a reinstall). They are loaded in the
        // background so startup never waits for or fails on them.
        this.presetReady = this._loadPresets();
        if (this.worker) this.reconciliation = this._reconcileWorker().catch(error => console.error(`[roboflow] worker reconciliation stopped: ${error.message}`));
        else for (const flow of await this.store.list()) if (flow.status !== 'pending' && !terminal(flow.status)) await this.store.update(flow.id, current => {
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
        this.scheduler.initialize();
    }
    // RoboTeam restart with the worker configured (plan section 9, decision M-5). Every unfinished phase
    // is classified against the worker by its deterministic origin: a phase that finished while RoboTeam
    // was down is committed through the normal completion path (the successor is dispatched once, and a
    // failed phase, including `termination_unverified`, dispatches none); a phase the worker never
    // admitted is paused as before; a running one is followed; a phase whose outcome the worker cannot
    // currently report is left exactly as it is and asked again with backoff. Nothing is reset to
    // paused and no successor is dispatched while an outcome is unknown.
    async _reconcileWorker() {
        const { client, sleep, reconcileMs } = this.worker;
        await sleep(0);
        const unreconciled = new Map();
        const followed = new Set();
        for (const flow of await this.store.list()) {
            if (flow.status === 'pending' || terminal(flow.status)) continue;
            for (const instance of flow.instances) if (!terminal(instance.state)) unreconciled.set(`${flow.id}\n${instance.id}`, { flowId: flow.id, instanceId: instance.id });
        }
        let delay = reconcileMs;
        while (unreconciled.size && !this.closed) {
            let answered = false;
            for (const [key, { flowId, instanceId }] of [...unreconciled]) {
                if (this.closed) return;
                const flow = await this.store.get(flowId);
                const instance = flow?.instances.find(item => item.id === instanceId);
                if (!flow || flow.status === 'terminated' || !instance || terminal(instance.state)) { unreconciled.delete(key); continue; }
                const decision = instance.runtimeTaskId
                    ? await classifyPhase({ client, flow, instance })
                    : { action: 'never_admitted' };
                if (decision.action === 'unknown') continue;
                answered = true;
                // One line for every decision the worker's answer allowed (a running phase once, when it is first seen).
                if (decision.action !== 'running' || !followed.has(key)) {
                    this.log(`[roboflow] reconcile flow=${flowId} phase=${instanceId} decision=${decision.action === 'finished' ? `finished:${decision.endState || decision.event.state}${decision.terminationUnverified ? ' (termination_unverified)' : ''}${decision.endState === 'human-input' && !decision.humanInput ? ' (question not recovered)' : ''}` : decision.action}`);
                    if (decision.action === 'running') followed.add(key);
                }
                if (decision.action === 'running') continue;
                unreconciled.delete(key);
                if (decision.action === 'never_admitted') {
                    await this._serialize(flowId, () => this.store.update(flowId, current => {
                        current.error = 'interrupted by service restart'; current.finishedAt = new Date().toISOString();
                        const visit = current.instances.find(item => item.id === instanceId);
                        if (visit && !terminal(visit.state)) { visit.state = 'paused'; visit.error = current.error; visit.endedAt = current.finishedAt; }
                        current.status = deriveFlowStatus(current.instances);
                    }));
                } else {
                    if (decision.humanInput) await this._recoverHumanInput(flowId, instanceId, decision);
                    else await this._serialize(flowId, () => this._completed({ flowId, instanceId }, decision.event));
                }
            }
            delay = answered ? reconcileMs : Math.min(30000, delay * 2);
            if (unreconciled.size) await Promise.race([sleep(delay), new Promise(resolve => { this.wakeReconcile = resolve; })]);
        }
    }
    async _repositoryRoots(preset) {
        const roots = {};
        for (const name of preset.repositories) {
            if (name !== 'DocumentationSkills') throw new Error(`repository ${name} is not supported in built-in workflows`);
            roots[name] = await requiredDocumentationRepository(this.skillsets);
        }
        return roots;
    }
    async _loadPresets() {
        const reported = new Set();
        while (!this.closed) {
            const pending = this.presets.filter(preset => !this.registry.presets.has(preset.id));
            if (!pending.length) return true;
            for (const preset of pending) {
                try {
                    this.registry.addPreset(presetGraph(preset, await this._repositoryRoots(preset)));
                    if (reported.has(preset.id)) console.log(`[roboflow] ${preset.name} workflow is available.`);
                } catch (error) {
                    if (this.closed) return false;
                    if (!reported.has(preset.id)) console.error(`[roboflow] ${preset.name} workflow is not available yet (${error.message}); retrying every ${this.presetRetryMs} ms.`);
                    reported.add(preset.id);
                }
            }
            if (this.presets.every(preset => this.registry.presets.has(preset.id))) return true;
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
        const graph = normalizeWorkflow({ ...input, name: input.name || 'Draft' });
        return { graph, coverage: coverage(graph, await this.robotStore.list()), diagnostics: graphDiagnostics(graph) };
    }
    async listWorkflows() {
        const robots = await this.robotStore.list();
        return (await this.registry.list()).map(graph => ({ ...graph, coverage: coverage(graph, robots), diagnostics: graphDiagnostics(graph) }));
    }
    async refreshCoverage() { return this.listWorkflows(); }
    // Workflow files that were found but are not workflows: invalid, or with an id already in use.
    workflowFileErrors() { return this.registry.fileErrors; }
    async createWorkflow({ location, ...input }) { const graph = await this.registry.create(input, { location: location || undefined }); return { ...graph, coverage: coverage(graph, await this.robotStore.list()) }; }
    async updateWorkflow(id, input) {
        const graph = await this.registry.update(id, input);
        if (!graph) throw Object.assign(invalid('workflow not found'), { statusCode: 404 });
        return { ...graph, coverage: coverage(graph, await this.robotStore.list()) };
    }
    async deleteWorkflow(id) { return this.registry.remove(id, { beforeRemove: id => this.schedules.assertWorkflowRemovable(id) }); }
    async listSchedules() {
        const root = await this.scheduleFolders.root();
        return this.schedules.listSync().map(job => {
            const { pendingLaunch, ...record } = job;
            delete record.name;
            delete record.ownerPrincipal;
            if (this.runFolders.isLegacyDefault(record.folder, root)) record.folder = path.join(root, 'workflow-runs');
            const workflow = this.registry.getSync(job.workflowTypeId);
            const flow = job.lastFlowId && this.store.getSync(job.lastFlowId);
            return { ...record, folderLabel: this.scheduleFolders.label(record.folder, root), jobFolder: jobFolderName(job.workflowTypeId, job.id), workflowName: workflow?.name || job.workflowTypeId,
                effectiveObjective: job.objective || workflow?.defaultObjective || '',
                lastFlowStatus: flow?.status || null, lastFlowError: flow?.error || null, launching: Boolean(pendingLaunch) };
        });
    }
    async saveSchedule(input, createdBy, id, { ownerPrincipal = null } = {}) {
        const saved = await this.schedules.save(input, createdBy, id, { ownerPrincipal: ownerPrincipalOf(ownerPrincipal) });
        return (await this.listSchedules()).find(job => job.id === saved.id);
    }
    async deleteSchedule(id) { return this.schedules.remove(id); }
    async runScheduleNow(id, revision, createdBy, { ownerPrincipal = null, beforeDispatch } = {}) {
        const flow = await this.scheduler.runNow(id, revision, createdBy, { ownerPrincipal: ownerPrincipalOf(ownerPrincipal), ...(beforeDispatch ? { beforeDispatch } : {}) });
        return { flow, schedule: (await this.listSchedules()).find(job => job.id === id) || null };
    }
    // Scheduled flows record how they were launched and the schedule's binding revision
    // (launch metadata only; the local launch itself is unchanged).
    // `beforeDispatch(flow)` runs once the flow exists and before its first phase is admitted: the
    // request that started a root flow registers the flow's binding with its own grant there. A failure
    // fails the flow (nothing was dispatched) and is rethrown to the caller.
    async startFlow(input, { onCreated, beforeDispatch, scheduleId, scheduledAt, manual = false, scheduleBindingRevision } = {}) {
        const graph = await this.registry.get(input.workflowTypeId);
        if (!graph) throw Object.assign(invalid('workflow not found'), { statusCode: 404 });
        assertRunnable(graph);
        if (graph.kind === 'default' ? !EXECUTION_TYPES.includes(input.executionType) : input.executionType !== undefined) throw invalid('executionType is required only for the default workflow');
        const objective = textField(input.objective, 'objective', 32768);
        resolveWorkflowObjective(graph, objective);
        const allocated = Boolean(scheduleId) || !input.folder;
        const folder = scheduleId ? await this.runFolders.forJob(input.folder, graph.id, scheduleId)
            : allocated ? await this.runFolders.create(input.folder) : await this.runtimeManager.resolveCwd(input.folder);
        let flow;
        try {
            flow = await this.store.createFromWorkflow(this.registry, graph.id, { folder, objective, createdBy: input.createdBy || '',
                ownerPrincipal: ownerPrincipalOf(input.ownerPrincipal),
                ...(scheduleId ? { scheduleId, scheduledAt, scheduledLaunch: manual ? 'manual' : 'cron',
                    ...(Number.isSafeInteger(scheduleBindingRevision) ? { scheduleBindingRevision } : {}) } : {}),
                ...(graph.kind === 'default' ? { executionType: input.executionType } : {}) }, onCreated);
        } catch (error) {
            if (allocated) await this.runFolders.discard(folder);
            throw error;
        }
        await this._serialize(flow.id, async () => {
            if (beforeDispatch) {
                try { await beforeDispatch(flow); }
                catch (error) {
                    await this.store.update(flow.id, current => {
                        current.status = 'failed'; current.error = `Flow could not be registered with the worker: ${error.message}`; current.finishedAt = new Date().toISOString();
                    }).catch(() => {});
                    throw error;
                }
            }
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
    // The robots a phase of this flow may be dispatched to: those matching the node's skillsets, and for a GUI mode those whose
    // coding agents support it.
    async _eligibleRobots(flow, node, mode) {
        const matching = (await this.robotStore.list()).filter(robot => (flow.graph.kind !== 'default' || robot.name === 'default') && matchRobot(robot, node));
        return { matching, eligible: matching.filter(robot => mode === 'terminal' || GUI_CODING_AGENTS.some(agent => robotCodingAgents(robot).includes(agent))) };
    }
    // Every robot any phase of the flow may run on: the ones to prepare on the worker when the starting request holds a grant.
    async flowRobots(flow) {
        const robots = new Map();
        for (const node of flow.graph.tasks) {
            if (isCoordinator(node)) continue;
            const mode = flow.graph.kind === 'default' ? flow.executionType : node.executionType;
            for (const robot of (await this._eligibleRobots(flow, node, mode)).eligible) robots.set(robot.id, robot);
        }
        return [...robots.values()];
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
            const { matching: robots, eligible } = await this._eligibleRobots(flow, node, mode);
            if (!robots.length) throw new Error(`No robot has matching skillsets for task ${node.id}`);
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
            // A child or cron-fired flow's binding derives from its parent's; the coordinator registers it
            // alone. A root flow's binding is registered with its owner's grant by the owner's page.
            if (this.worker) {
                const parentBindingId = parentBindingFor(flow);
                if (parentBindingId) await registerDerivedBinding({ hop: this.worker.hop, bindingId: id, parentBindingId });
            }
            const selections = robotSelections(robot);
            const required = node.skillsets.map(identity => selections.find(set => set.id === identity));
            const skillSets = required.filter(item => item.kind === 'skillset').map(item => item.selector);
            const skills = required.filter(item => item.kind === 'skill').map(item => item.selector);
            const started = await this._startTask(robot, { cwd: flow.folder, task, taskType: EXECUTION_TASK_TYPES[mode], runtimeTaskId, workflowRunId: id,
                workflowInstanceId: instance.id, ownerPrincipal: ownerPrincipalOf(flow.ownerPrincipal), skillSets, skills,
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
    // The question a phase asked while RoboTeam was down, recreated exactly as the live path records it (pending, with the worker's
    // reference and request), and then the phase's end, which marks the execution ended so the question can be answered.
    async _recoverHumanInput(flowId, instanceId, decision) {
        const instance = (await this.store.get(flowId))?.instances.find(item => item.id === instanceId);
        if (!instance?.runtimeTaskId) return;
        const taskId = instance.runtimeTaskId;
        this.bindings.set(taskId, { flowId, instanceId });
        try {
            await this.requestHumanInput(taskId, decision.humanInput);
        } catch (error) {
            // RoboFlow will not take the question (the phase may not ask, or a question is already pending): the phase is paused instead.
            this.bindings.delete(taskId);
            this.log(`[roboflow] reconcile flow=${flowId} phase=${instanceId} question not recorded: ${error.message}`);
            await this._serialize(flowId, () => this._completed({ flowId, instanceId }, decision.event));
            return;
        }
        this.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'completed', result: decision.event.result });
        while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
    }
    // A flow cancel, pause or failure ends the worker's execution of a phase too (decision M-12 (c)). A
    // system-initiated stop (a flow failure, recovery) uses the coordinator identity and the flow binding. A
    // user's pause or terminate (`user.grant`, decision M-12 (b), M-40) carries that request's own grant and
    // never the binding. The operation ID is the one the phase's own child uses, so both are one stop at the
    // worker. Best effort: a phase the worker never admitted, or already ended, needs none, and a stop the
    // worker refuses is logged and left to the worker's own end-of-run handling.
    async _stopWorkerPhase(flow, instance, user = null) {
        if (!this.worker || !instance.runtimeTaskId) return;
        try {
            const origin = phaseOriginId({ flowId: flow.id, instanceId: instance.id, runtimeTaskId: instance.runtimeTaskId });
            if (user && !user.grant) throw Object.assign(new Error('owner_evidence_unavailable'), { code: 'owner_evidence_unavailable' });
            const auth = user ? { grant: user.grant } : { bindingId: flow.id };
            const accepted = await this.worker.client.lookup(origin, auth);
            if (!accepted) return;
            await this.worker.client.control(accepted.referenceId, { operationId: stopOperationId(accepted.referenceId), op: 'stop' }, auth);
        } catch (error) {
            console.error(`[roboflow] worker stop of a phase was not delivered (${error?.code || error?.message}); the phase may still run on the worker`);
            // A user's stop that did not reach the worker is told to that user, never silent.
            if (user && Array.isArray(user.undelivered)) user.undelivered.push({ instanceId: instance.id, code: error?.code || 'worker_stop_undelivered' });
        }
    }
    // `user` is `{ grant }` for a user's pause (the request's own grant), null for a system-initiated failure.
    async _fail(id, message, status = 'failed', user = null) {
        const flow = await this.store.get(id);
        if (!flow || flow.status === 'terminated') return;
        const active = flow.instances.filter(instance => !terminal(instance.state));
        if (!active.length) return;
        if (!flow.pauseRequested && active.some(instance => instance.creatorInstanceId)) {
            await this.store.update(id, current => { current.pauseRequested = true; });
            await this.subflows.pauseChildren(flow, user);
        }
        const started = new Map();
        for (const instance of active) if (instance.runtimeTaskId) {
            this.bindings.delete(instance.runtimeTaskId);
            const robot = await this.robotStore.getByName(instance.robotName);
            if (robot) {
                const runtime = this.runtimeManager.taskStatus?.(robot.id, instance.runtimeTaskId);
                if (runtime?.startedAt) started.set(instance.id, runtime.startedAt);
                try { await this.runtimeManager.stopTask(robot, EXECUTION_TASK_TYPES[instance.executionType], instance.runtimeTaskId, this._userStop(user)); } catch { /* Runtime may already be terminal. */ } }
            await this._stopWorkerPhase(flow, instance, user);
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
    // The stop options of a user-initiated stop: the request's own grant and the mark that a person asked for it, so the phase's
    // task child uses that grant and never the flow binding. Empty for a system stop.
    _userStop(user) {
        return user ? { userInitiated: true, ...(user.grant ? { ownerGrant: user.grant } : {}) } : undefined;
    }
    async pauseFlow(id, user = null) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            if (['pending', 'completed', 'failed', 'terminated'].includes(flow.status)) return this.getFlow(id);
            await this.store.update(id, current => { current.pauseRequested = true; });
            await this.subflows.pauseChildren(flow, user);
            await this._fail(id, 'Paused by user', 'paused', user);
            return this.getFlow(id);
        });
    }
    async terminateFlow(id, user = null) {
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
            const results = await Promise.allSettled(children.map(child => this.terminateFlow(child, user)));
            for (const visit of flow.instances) if (visit.runtimeTaskId && !['completed', 'failed'].includes(visit.state)) {
                this.bindings.delete(visit.runtimeTaskId);
                const robot = await this.robotStore.getByName(visit.robotName);
                if (robot) results.push(await Promise.resolve().then(() => this.runtimeManager.stopTask(
                    robot, EXECUTION_TASK_TYPES[visit.executionType], visit.runtimeTaskId, this._userStop(user)))
                    .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })));
                if (user) await this._stopWorkerPhase(flow, visit, user);
            }
            const failures = results.filter(result => result.status === 'rejected');
            if (failures.length) throw new Error(`Workflow terminated, but stopping execution failed: ${failures.map(item => item.reason.message).join('; ')}`);
            return this.getFlow(id);
        });
    }
    async pauseInstance(id, instanceId, user = null) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        const instance = flow.instances.find(item => item.id === instanceId);
        if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
        if (terminal(instance.state)) return this.getFlow(id);
        return this.pauseFlow(id, user);
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
    // `user.grant` is the messaging request's own grant for the worker `message` control (decision M-12 (b)).
    async messageInstance(id, instanceId, prompt, user = null) {
        const flow = await this.store.get(id);
        if (!flow) throw missing();
        const instance = flow.instances.find(item => item.id === instanceId);
        if (!instance) throw Object.assign(invalid('task instance not found'), { statusCode: 404 });
        if (terminal(instance.state) || !instance.runtimeTaskId) {
            throw Object.assign(invalid('only a running phase accepts a live prompt; continue it instead'), { liveOutcome: 'run_ended' });
        }
        const message = textField(prompt, 'prompt', 32768, true);
        const robot = await this.robotStore.getByName(instance.robotName);
        if (!robot) throw new Error('Robot is unavailable');
        const delivery = await this.runtimeManager.sendTaskMessage(robot, instance.runtimeTaskId, message, user?.grant ? { ownerGrant: user.grant } : undefined);
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
            await this.runtimeManager.resumeTask(robot, previous.runtimeTaskId, message, { runtimeTaskId, workflowInstanceId: instanceId });
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
        // Admission and other observation-only events are for Live Sessions.
        if (!OBSERVED_TASK_EVENTS.has(event?.kind)) return;
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
            // A question asked through the worker keeps the worker's reference and request ID, which its answer control names.
            const worker = input.worker && isReferenceId(input.worker.referenceId) && typeof input.worker.requestId === 'string' && /^[A-Za-z0-9_-]{16,64}$/u.test(input.worker.requestId)
                ? { referenceId: input.worker.referenceId, requestId: input.worker.requestId } : null;
            if (input.worker && !worker) throw invalid('The worker question is not valid');
            const request = { id: crypto.randomUUID(), instanceId: instance.id, runtimeTaskId, question, options,
                status: 'pending', executionEnded: false, createdAt: new Date().toISOString(), ...(worker ? { worker } : {}) };
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
    // `grant` is the answering request's own Router-minted grant (decision M-12 (b)). A question the worker holds is answered to
    // the worker first, once, with that grant; only after the worker accepted it is the continuation dispatched, with a new
    // runtime task (so a new deterministic origin). An answer the worker did not accept is never sent again by RoboTeam: the user
    // answers again, and the same answer is the same operation at the worker.
    async answerHumanInput(id, input, actorId = '', { grant = null } = {}) {
        return this._serialize(id, async () => {
            const flow = await this.store.get(id);
            if (!flow) throw missing();
            const request = flow.humanInput;
            if (request?.status !== 'pending' || input?.requestId !== request.id) throw Object.assign(invalid('This question is no longer waiting for an answer'), { statusCode: 409 });
            if (!request.executionEnded) throw Object.assign(invalid('The robot is still finishing its current execution. Try again shortly.'), { statusCode: 409 });
            const choice = input.option;
            if (!Number.isInteger(choice) || choice < 0 || choice > 3) throw invalid('Choose one of the four answer options');
            const answer = choice === 3 ? textField(input.text, 'answer', 32000, true) : request.options[choice];
            if (request.worker) await this._answerToWorker(request, answer, grant);
            return this._resumeInstance(id, request.instanceId, `My answer to your question is: ${answer}`, request.id, actorId);
        });
    }
    async _answerToWorker(request, answer, grant) {
        if (!this.worker) throw Object.assign(invalid('The worker is not configured for this question'), { statusCode: 503 });
        if (!grant) throw Object.assign(new Error('owner_evidence_unavailable'), { statusCode: 403 });
        const operationId = crypto.createHash('sha256').update(`roboteam/answer/v1\n${request.id}\n${answer}`).digest('base64url').slice(0, 22);
        try {
            await this.worker.client.control(request.worker.referenceId, { operationId, op: 'answer', payload: { requestId: request.worker.requestId, answer } }, { grant });
        } catch (error) {
            throw Object.assign(new Error(error?.code || 'worker_coordinator_unavailable'), { statusCode: error?.status || 503 });
        }
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
    subscribeFlow(id, listener) {
        return this.store.subscribe(event => {
            if (event.kind === 'close' || event.flowId === id || (event.kind === 'flow' && event.parentFlowId === id)) listener(event);
        });
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
            const graph = normalizeWorkflow({ ...parseWorkflowResponse(await completed, { generation: true }), defaultObjective: description });
            const known = new Set(catalog.skillsets.map(set => set.id));
            if (graph.tasks.some(task => task.skillsets.some(id => !known.has(id)))) throw invalid('Generated graph contains an unknown skillset');
            return { graph, coverage: coverage(graph, await this.robotStore.list()), diagnostics: [...catalog.diagnostics, ...graphDiagnostics(graph)] };
        } finally { this.generations.delete(runtimeTaskId); signal?.removeEventListener('abort', abort); }
    }
    // Browser-facing generation: start returns immediately with an id and the
    // page polls generationInfo every couple of seconds for live task logs.
    // Generation only creates a new workflow from the user's prompt; it never revises one being edited.
    async startGeneration(input) {
        const description = textField(input.description, 'description', 32768, true);
        const catalog = await this.catalog();
        const robot = await this.robotStore.getByName('default');
        if (!robot) throw new Error('Default robot is unavailable');
        const cwd = await this.generationCwd(input.folder);
        const record = { id: crypto.randomUUID(), runtimeTaskId: crypto.randomUUID(), robotId: robot.id,
            status: 'running', graph: null, error: null, startedAt: new Date().toISOString(), catalog };
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
            await this._startTask(robot, { cwd, task: description, runtimeTaskId: record.runtimeTaskId, skillSets: [],
                systemPrompt: generationPrompt(record.catalog) });
            const parsed = parseWorkflowResponse(await completed, { generation: true });
            if (record.status === 'cancelled') return;
            const graph = normalizeWorkflow({ ...parsed, defaultObjective: description });
            const known = new Set(record.catalog.skillsets.map(set => set.id));
            if (graph.tasks.some(task => task.skillsets.some(id => !known.has(id)))) throw invalid('Generated graph contains an unknown skillset');
            record.graph = { ...graph, coverage: coverage(graph, await this.robotStore.list()),
                diagnostics: [...record.catalog.diagnostics, ...graphDiagnostics(graph)] };
            record.status = 'completed';
        } catch (error) {
            if (record.status !== 'cancelled') { record.status = 'failed'; record.error = error.message; }
        } finally {
            this.generations.delete(record.runtimeTaskId);
            delete record.catalog;
        }
    }
    generationInfo(id) {
        const record = this.generationTasks.get(id);
        if (!record) return null;
        const log = (this.runtimeManager?.taskStatus?.(record.robotId, record.runtimeTaskId)?.logTail || '').slice(-256 * 1024);
        const info = { id: record.id, status: record.status, log, graph: record.graph, error: record.error };
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
    async close() { this.closed = true; this.wakeReconcile?.(); await this.reconciliation?.catch(() => {}); this.store.closeObservers(); await this.scheduler.close(); clearTimeout(this.presetTimer); this.presetWake?.(); await this.presetReady?.catch(() => {}); this.store.onStatusChange = null; for (const generation of this.generations.values()) generation.reject(new Error('Service stopped')); this.generations.clear(); this.generationTasks.clear(); await Promise.allSettled(this.chains.values()); this.bindings.clear(); this.database.close(); }
}
