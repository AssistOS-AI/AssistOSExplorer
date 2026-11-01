import { createHumanInputChannel } from './human-input-channel.mjs';
import { registerProject, saveTaskExecution, findProjectRecord } from './project-storage.mjs';
import { requireWorkspaceRoot } from './workspace-root.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentEnvironments } from './agent-environments.mjs';
import { resolveAlaCommand } from './ala-command.mjs';
import { DATA_DIR } from './constants.mjs';
import { DESKTOP_TASK_INSTRUCTIONS } from '../copilot/src/lib/prompts.mjs';
import { emailInstructions, robotEmailAddress } from './robot-email.mjs';
import { RESUME_REOBSERVE_INSTRUCTION } from './workstation-control-adapter.mjs';
import { robotCodingAgents } from './coding-agents.mjs';
import { RoboWorkClient } from './run-client.mjs';

const GUI_MODES = new Set(['desktop', 'browser']);
const ALA_FAILURE_DETAIL_LIMIT = 4096;
const TASK_LOG_TAIL_LIMIT = 1024 * 1024;
const TASK_RESULT_LIMIT = 1024 * 1024;
const ALA_EVENT_PREFIX = '@@ALA_EVENT@@';
const OWNER_PRINCIPAL = /^user:.+/u;
const TRANSCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MESSAGE_TIMEOUT_MS = 35000;
function appendTail(previous, chunk, limit) {
    const next = `${previous}${chunk}`;
    return next.length > limit ? next.slice(-limit) : next;
}

function createAlaProgressParser(onText, onEvent = () => {}) {
    let buffered = '';
    const decoder = new StringDecoder('utf8');
    let pendingFinal = null;
    const consumeLine = (line, terminated) => {
        if (!line.startsWith(ALA_EVENT_PREFIX)) {
            onText(`${line}${terminated ? '\n' : ''}`);
            return;
        }
        try {
            const event = JSON.parse(line.slice(ALA_EVENT_PREFIX.length));
            onEvent(event);
            if (event?.type === 'coding-agent-final' && typeof event.message === 'string') {
                if (pendingFinal !== null) onText(pendingFinal, { outputKind: 'assistant', outputComplete: true });
                pendingFinal = event.message;
            }
            if (event?.type === 'coding-agent-message' && typeof event.message === 'string') onText(event.message, event);
        } catch {
            onText(`${line}${terminated ? '\n' : ''}`);
        }
    };
    return {
        push(chunk) {
            buffered += decoder.write(chunk);
            let newline = buffered.indexOf('\n');
            while (newline >= 0) {
                consumeLine(buffered.slice(0, newline), true);
                buffered = buffered.slice(newline + 1);
                newline = buffered.indexOf('\n');
            }
        },
        finish() {
            buffered += decoder.end();
            if (buffered) consumeLine(buffered, false);
            buffered = '';
        },
    };
}

function alaFailureMessage(exit, output) {
    const normalized = String(output || '').replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').trim();
    const detail = normalized.length > ALA_FAILURE_DETAIL_LIMIT
        ? `…${normalized.slice(-ALA_FAILURE_DETAIL_LIMIT)}`
        : normalized;
    return detail ? `ALA exited with ${exit}: ${detail}` : `ALA exited with ${exit}`;
}

function normalizeBasePath(value) {
    const raw = String(value || '/').trim();
    const leading = raw.startsWith('/') ? raw : `/${raw}`;
    return leading.endsWith('/') ? leading : `${leading}/`;
}

function robotSessionUrl(publicBasePath, robotId) {
    return `/base-agent-additional-server/roboWorkAgent/3001/api/robots/${robotId}/session/`;
}

export class RuntimeManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || DATA_DIR);
        this.publicBasePath = normalizeBasePath(options.publicBasePath);
        this.alaCommand = resolveAlaCommand(options.alaCommand);
        this.workspaceRoot = path.resolve(options.workspaceRoot ?? requireWorkspaceRoot());
        this.hostWorkspaceRoot = options.hostWorkspaceRoot ? path.resolve(options.hostWorkspaceRoot) : null;
        this.spawnImpl = options.spawnImpl || spawn;
        this.roboWork = options.roboWork || new RoboWorkClient();
        this.robotStore = options.robotStore || null;
        this.proxySettings = {
            useProxy: async () => (await this.roboWork.call('proxy_assignments', { robotIds: [] })).useProxy,
            setUseProxy: async useProxy => (await this.roboWork.call('proxy_settings_set', { useProxy })).useProxy,
        };
        this.agentEnvironments = options.agentEnvironments || new AgentEnvironments({ call: this.roboWork.call.bind(this.roboWork) });
        this.sessions = new Map();
        this.tasks = new Map();
        this.latestTask = new Map();
        this.activeTasks = new Map();
        this.taskQueues = new Map();
        this.manualControl = new Map();
        this.pending = new Map();
        this.shuttingDown = false;
        this.messageWaiters = new Map();
        this.deletedRobots = new Set();
        this.skillsets = options.skillsets || null;
        this.seedChain = new Map();
        // Optional observational hook used by RoboFlow. It never changes task
        // storage or semantics; it only forwards progress and lifecycle events.
        this.taskObserver = typeof options.taskObserver === 'function' ? options.taskObserver : null;
        this.messageTimeoutMs = Number.isSafeInteger(options.messageTimeoutMs) && options.messageTimeoutMs > 0
            ? options.messageTimeoutMs : MESSAGE_TIMEOUT_MS;
        // Owner records live in project folders that robot containers can
        // write. A persisted owner is trusted only with a binding made under
        // this service start's secret; anything else is the system owner.
        this.ownerKey = options.ownerKey
            ? crypto.createHmac('sha256', String(options.ownerKey)).update('roboteam-live-sessions-owner-v1').digest() : null;
    }

    _ownerBinding(robotId, alaSessionId, ownerPrincipal) {
        if (!this.ownerKey || !ownerPrincipal) return null;
        return crypto.createHmac('sha256', this.ownerKey).update(JSON.stringify(['v1', robotId, alaSessionId, ownerPrincipal])).digest('base64url');
    }

    _boundOwner(record) {
        const owner = record?.request?.ownerPrincipal;
        const expected = this._ownerBinding(record?.robotId, record?.alaSessionId, owner);
        if (!expected || typeof record.ownerBinding !== 'string' || record.ownerBinding.length !== expected.length) return null;
        return crypto.timingSafeEqual(Buffer.from(record.ownerBinding), Buffer.from(expected)) ? owner : null;
    }

    setTaskObserver(observer) {
        this.taskObserver = typeof observer === 'function' ? observer : null;
        for (const task of this.tasks.values()) if (task.attachRun) {
            this._emitTaskEvent({ kind: 'admitted', robotId: task.robotId, robotName: task.robotName || task.robotId, taskId: task.taskId,
                type: task.type, state: task.state, cwd: task.request.cwd, ownerPrincipal: task.request.ownerPrincipal || null,
                workflowRunId: task.request.workflowRunId || null, workflowInstanceId: task.request.workflowInstanceId || null });
        }
    }

    _emitTaskEvent(event) {
        if (!this.taskObserver) return;
        try { this.taskObserver(event); }
        catch (error) { console.error('[roboTeamAgent] task observer failed:', error?.message || error); }
    }

    // Each execution attempt reports one terminal event, whichever path ends
    // it: its own run, or a stop or shutdown before it ever started.
    _emitTaskTerminal(task, fields) {
        if (task.terminalEmitted) return;
        task.terminalEmitted = true;
        this._emitTaskEvent({ kind: 'terminal', robotId: task.robotId, taskId: task.taskId, ...fields });
    }

    // Message failures carry a typed outcome for Live Sessions; the message
    // text is unchanged for existing callers.
    _messageFailure(outcome, message) {
        return Object.assign(new Error(message), { code: `TASK_MESSAGE_${outcome.toUpperCase()}`, liveOutcome: outcome });
    }

    // Server-bound transcript location of a task's turn, once its turn started.
    taskTranscriptRef(robotId, taskId) {
        const task = this.tasks.get(taskId);
        if (!task || task.robotId !== robotId || !task.transcriptRef) return null;
        return { cwd: task.request.cwd, sessionId: task.alaSessionId, assistantMessageId: task.transcriptRef.assistantMessageId };
    }

    async prepareOpenCode(robotId, { seed = true } = {}) {
        const robot = await this.robotStore?.get(robotId);
        return this.roboWork.call('robot_ensure', { robotId, name: robot?.name || robotId,
            codingAgents: robotCodingAgents(robot || {}), seed });
    }

    seedOpenCodeInBackground(robot) {
        void this.roboWork.call('robot_ensure', { robotId: robot.id, name: robot.name,
            codingAgents: robotCodingAgents(robot) }).catch(error => console.warn(error.message));
    }

    async initialize() {
        const { robots } = await this.roboWork.call('robot_status', {});
        for (const robot of robots || []) {
            if (robot.gui?.state === 'running') this.sessions.set(robot.id, { robotId: robot.id, ...robot.gui });
        }
        const runs = await this.roboWork.call('run_list', {});
        for (const run of runs) {
            if (run.tag?.kind !== 'task') continue;
            const robot = await this.robotStore?.get(run.robotId);
            if (!robot || !run.tag.taskId || !run.tag.request) continue;
            const request = { ...run.tag.request, runtimeTaskId: run.tag.taskId,
                alaSessionId: run.tag.sessionId, resumeSession: true,
                ...(run.tag.ownerPrincipal ? { ownerPrincipal: run.tag.ownerPrincipal } : {}) };
            const task = this._newTask(robot, run.tag.type, request);
            task.attachRun = run.runId;
            task.attachContext = { runId: run.runId, turnId: run.tag.turnId,
                userMessageId: run.tag.userMessageId, assistantMessageId: run.tag.assistantMessageId };
            task.runId = run.runId;
            task.remoteState = run.state;
            task.robotName = robot.name;
            task.startedAt = run.startedAt;
        }
    }

    resumeAttachedTasks() {
        for (const task of this.tasks.values()) {
            if (!task.attachRun || task.state !== 'queued') continue;
            const gui = GUI_MODES.has(task.type);
            if (gui) this.activeTasks.set(task.robotId, task.taskId);
            void this.robotStore.get(task.robotId).then(async robot => {
                try { await this._runTask(robot, task); }
                finally {
                    if (gui && this.activeTasks.get(task.robotId) === task.taskId) this.activeTasks.delete(task.robotId);
                    if (gui) queueMicrotask(() => void this._drainTaskQueue(robot));
                }
            }).catch(error => console.error(`[roboTeamAgent] could not reattach task: ${error.message}`));
        }
    }

    recoveredTask(taskId) {
        const task = this.tasks.get(taskId);
        return task?.attachRun ? task : null;
    }

    _serialize(robotId, operation) {
        const previous = this.pending.get(robotId) || Promise.resolve();
        const current = previous.catch(() => {}).then(() => {
            if (this.deletedRobots.has(robotId)) throw new Error('robot was deleted');
            return operation();
        });
        this.pending.set(robotId, current);
        return current.finally(() => { if (this.pending.get(robotId) === current) this.pending.delete(robotId); });
    }

    async resolveCwd(value) {
        const requested = String(value || '').trim();
        if (!requested || !path.isAbsolute(requested)) throw new Error('cwd must be an absolute workspace path');
        let candidate = path.resolve(requested);
        try { candidate = await fs.realpath(candidate); } catch (error) {
            if (!this.hostWorkspaceRoot || !candidate.startsWith(`${this.hostWorkspaceRoot}${path.sep}`)) throw error;
            candidate = await fs.realpath(path.join(this.workspaceRoot, path.relative(this.hostWorkspaceRoot, candidate)));
        }
        const root = await fs.realpath(this.workspaceRoot);
        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('cwd must stay inside the enabled Ploinky workspace');
        const relative = path.relative(root, candidate);
        if (['.data', '.ploinky'].includes(relative.split(path.sep)[0])) throw new Error('cwd is reserved controller storage');
        if (!(await fs.stat(candidate)).isDirectory()) throw new Error('cwd must reference a directory');
        return candidate;
    }

    status(robotId) {
        const session = this.sessions.get(robotId);
        const task = this.taskStatus(robotId);
        const queueDepth = (this.taskQueues.get(robotId) || []).filter((id) => this.tasks.get(id)?.state === 'queued').length;
        return session ? { state: session.state, mode: session.mode, startedAt: session.startedAt, sessionUrl: session.sessionUrl, task, queueDepth } : { state: 'stopped', task, queueDepth };
    }

    activePort(robotId) { return this.sessions.get(robotId)?.sessionPort || null; }

    hasUnfinishedTasks(robotId) {
        return Array.from(this.tasks.values()).some((task) => task.robotId === robotId
            && ['queued', 'starting', 'running', 'pausing'].includes(task.state));
    }

    async ensureContainer(robot, mode, cwdValue, options = {}) {
        return this._serialize(robot.id, async () => {
            const active = this.activeTaskStatus(robot.id);
            if (active && active.taskId !== options.taskId && ['starting', 'running'].includes(active.state)) {
                throw new Error('Stop the active task before changing its workstation');
            }
            const cwd = cwdValue ? await this.resolveCwd(cwdValue) : undefined;
            const session = await this.roboWork.call('gui_ensure', { robotId: robot.id, mode,
                ...(cwd ? { cwd } : {}), codingAgents: robotCodingAgents(robot), allowReplace: Boolean(options.taskId) });
            this.sessions.set(robot.id, { robotId: robot.id, ...session });
            return session;
        });
    }

    async openDesktop(robot, cwd) {
        const session = await this.ensureContainer(robot, 'desktop', cwd);
        return { state: session.state, mode: session.mode, sessionUrl: session.sessionUrl };
    }

    start(robot, mode) { return this.ensureContainer(robot, mode, null).then(() => this.status(robot.id)); }
    stop(robotId) {
        const session = this.sessions.get(robotId);
        return session ? this.stopContainer(robotId, session.mode) : Promise.resolve({ state: 'stopped' });
    }

    _newTask(robot, type, request, trackLatest = true) {
        const task = {
            taskId: request.runtimeTaskId || (!request.alaSessionId && request.skillSelection?.catalogId) || crypto.randomUUID(), robotId: robot.id, type, state: 'queued',
            createdAt: new Date().toISOString(), request, logTail: '', logSeq: 0,
            logTruncated: false, result: '', error: null,
            child: null, cancelRequested: false,
            ...(GUI_MODES.has(type) ? { sessionUrl: robotSessionUrl(this.publicBasePath, robot.id) } : {}),
        };
        if (this.tasks.has(task.taskId)) throw new Error('Task id is already in use.');
        task.alaSessionId = request.alaSessionId || task.taskId;
        const ownerBinding = this._ownerBinding(robot.id, task.alaSessionId, request.ownerPrincipal);
        if (ownerBinding) task.ownerBinding = ownerBinding;
        task.pendingMessages = [];
        this.tasks.set(task.taskId, task);
        if (trackLatest) this.latestTask.set(robot.id, task.taskId);
        return task;
    }

    _enqueueTask(robot, type, request, { first = false } = {}) {
        if (this.deletedRobots.has(robot.id)) throw new Error('robot was deleted');
        request = structuredClone(request);
        // Owner and workflow phase are fixed when work is admitted. Only a
        // signed user principal is kept; anything else is the system owner.
        if (typeof request.ownerPrincipal !== 'string' || !OWNER_PRINCIPAL.test(request.ownerPrincipal)) delete request.ownerPrincipal;
        if (typeof request.workflowInstanceId !== 'string' || !request.workflowInstanceId) delete request.workflowInstanceId;
        // A new GUI request after all previous GUI work was paused explicitly
        // returns control to automation. Keep the pause while old work remains.
        if (GUI_MODES.has(type) && this.manualControl.has(robot.id)
            && ![...this.tasks.values()].some(task => task.robotId === robot.id
                && GUI_MODES.has(task.type) && ['queued', 'starting', 'running', 'pausing'].includes(task.state))) {
            this.manualControl.delete(robot.id);
        }
        const task = this._newTask(robot, type, request);
        this._emitTaskEvent({ kind: 'admitted', robotId: robot.id, robotName: robot.name, taskId: task.taskId, type, state: 'queued',
            cwd: typeof request.cwd === 'string' ? request.cwd : null, ownerPrincipal: request.ownerPrincipal || null,
            workflowRunId: typeof request.workflowRunId === 'string' && request.workflowRunId ? request.workflowRunId : null,
            workflowInstanceId: request.workflowInstanceId || null });
        if (type === 'simple') {
            queueMicrotask(() => { if (!this.shuttingDown) void this._runTask(robot, task); });
            return { taskId: task.taskId, state: task.state, queuePosition: 0 };
        }
        const queue = this.taskQueues.get(robot.id) || [];
        if (first) queue.unshift(task.taskId);
        else queue.push(task.taskId);
        this.taskQueues.set(robot.id, queue);
        queueMicrotask(() => void this._drainTaskQueue(robot));
        return {
            taskId: task.taskId,
            state: task.state,
            queuePosition: this.taskQueuePosition(task),
            ...(task.sessionUrl ? { sessionUrl: task.sessionUrl } : {}),
        };
    }

    startTask(robot, type, request) {
        return this._enqueueTask(robot, type, request);
    }

    async _drainTaskQueue(robot) {
        if (this.shuttingDown || this.activeTasks.has(robot.id) || this.manualControl.has(robot.id)) return;
        const queue = this.taskQueues.get(robot.id) || [];
        let task = null;
        while (queue.length > 0 && !task) {
            const candidate = this.tasks.get(queue.shift());
            if (candidate?.state === 'queued' && !candidate.cancelRequested) task = candidate;
        }
        if (queue.length === 0) this.taskQueues.delete(robot.id);
        else this.taskQueues.set(robot.id, queue);
        if (!task) return;
        this.activeTasks.set(robot.id, task.taskId);
        try {
            await this._runTask(robot, task);
        } finally {
            if (this.activeTasks.get(robot.id) === task.taskId) this.activeTasks.delete(robot.id);
            queueMicrotask(() => void this._drainTaskQueue(robot));
        }
    }

    taskQueuePosition(task) {
        if (!task || task.state !== 'queued') return 0;
        const index = (this.taskQueues.get(task.robotId) || []).indexOf(task.taskId);
        return index < 0 ? 0 : index + 1;
    }

    guiBusy(robotId) {
        return this.manualControl.has(robotId) || [...this.tasks.values()].some(task => task.robotId === robotId && GUI_MODES.has(task.type) && ['queued', 'starting', 'running', 'pausing'].includes(task.state));
    }

    async _runTask(robot, task) {
        if (task.cancelRequested || task.state !== 'queued') return;
        let humanInputChannel, forcedFailure;
        const appendProgress = (chunk, output = {}) => {
            const previousLength = task.logTail.length;
            task.logTail = appendTail(task.logTail, chunk, TASK_LOG_TAIL_LIMIT);
            if (task.logTail.length < previousLength + String(chunk).length) task.logTruncated = true;
            task.logSeq += 1;
            this._emitTaskEvent({ kind: 'progress', robotId: robot.id, taskId: task.taskId, chunk: String(chunk), outputKind: output.outputKind, outputComplete: output.outputComplete === true, outputId: output.outputId, replayed: output.replayed === true });
        };
        try {
            task.state = 'starting';
            task.startedAt = new Date().toISOString();
            this._emitTaskEvent({ kind: 'state', robotId: robot.id, taskId: task.taskId, state: 'starting' });
            const cwd = await this.resolveCwd(task.request.cwd);
            task.request.cwd = registerProject(this, cwd);
            if (task.cancelRequested) throw new Error('task was paused');
            if (task.request.requiredWorkflowSkillsets && this.skillsets) {
                const currentRobot = await this.skillsets.robotStore.get(robot.id);
                const { matchRobot } = await import('./roboflow/skill-matching.mjs');
                if (!currentRobot || !matchRobot(currentRobot, { skillsets: task.request.requiredWorkflowSkillsets })) throw new Error('Robot skillsets changed while queued');
                robot = currentRobot;
            }
            const requestedAgent = task.request.ca || 'auto';
            const selectedAgents = robotCodingAgents(robot);
            if (requestedAgent !== 'auto' && !selectedAgents.includes(requestedAgent)) {
                throw new Error(`Coding agent ${requestedAgent} is not enabled for this robot`);
            }
            const codingAgent = requestedAgent;
            if (GUI_MODES.has(task.type)) {
                const session = await this.ensureContainer(robot, task.type, cwd, { taskId: task.taskId });
                task.sessionUrl = session.sessionUrl;
            }
            if (task.cancelRequested) throw new Error('task was paused');
            await this.roboWork.call('robot_ensure', { robotId: robot.id, name: robot.name, codingAgents: selectedAgents });
            await this._saveTask(task);
            const args = ['--cwd', cwd];
            const environment = task.type === 'simple' && task.request.environment ? task.request.environment : null;
            if (environment) {
                await this.agentEnvironments.require(environment);
                args.push('--environment', environment);
            }
            if (GUI_MODES.has(task.type)) args.push('--gui', task.type);
            if (task.attachRun) args.push('--attach-run', task.attachRun);
            if (codingAgent !== 'auto') args.push('--ca', codingAgent);
            args.push('--session-id', task.alaSessionId, '--control-stdin');
            if (task.request.resumeSession) args.push('--resume-session');
            if (task.request.workflowRunId) args.push('--workflow-execution');
            // Catalog capture belongs to the wrapper's actual execution boundary after queue/cache wait.
            if (this.skillsets) {
                const policyId = task.request.skillPolicyRef || task.alaSessionId;
                await this.skillsets.policies.ensure(robot, policyId, { legacy: task.request.skillSelection });
                task.request.skillPolicyRef = policyId;
                if (task.request.skillSelection) task.legacySkillSelection = task.request.skillSelection;
                delete task.request.skillSelection;
                await this._saveTask(task);
            }
            // A stop during any wait above ends this attempt before it runs; a
            // paused attempt is never turned back into a running one.
            if (task.cancelRequested || task.state !== 'starting') throw new Error('task was paused');
            if (task.request.model) args.push('--model', task.request.model);
            if (task.request.effort) args.push('--effort', task.request.effort);
            const requestedMcp = Array.isArray(task.request.mcpServers)
                ? task.request.mcpServers.join(',') : String(task.request.mcpServers || '');
            const mcpServers = requestedMcp;
            if (mcpServers) args.push('--MCPServers', mcpServers);
            task.state = 'running';
            this._emitTaskEvent({ kind: 'state', robotId: robot.id, taskId: task.taskId, state: 'running' });
            await Promise.resolve();
            const childEnv = { ...process.env, ALA_EVENT_STREAM: '1',
                ROBOTEAM_TASK_TAG: JSON.stringify({ taskId: task.taskId, type: task.type, robotName: robot.name,
                    request: task.request, ownerPrincipal: task.request.ownerPrincipal || null }),
                ...(task.attachContext?.assistantMessageId ? { ROBOTEAM_ATTACH_RUN: JSON.stringify(task.attachContext) } : {}) };
            delete childEnv.ROBOTEAM_HUMAN_INPUT_DIRECTORY;
            if (task.request.allowsHumanInput) {
                if (!this.requestHumanInput) throw new Error('Workflow human-input handler is unavailable');
                humanInputChannel = await createHumanInputChannel({
                    request: input => this.requestHumanInput(task.taskId, input),
                    stop: () => this.stopTask(robot, task.type, task.taskId),
                });
                childEnv.ROBOTEAM_HUMAN_INPUT_DIRECTORY = humanInputChannel.directory;
            }
            delete childEnv.ROBOTEAM_INTERNAL_TOKEN;
            delete childEnv.ROBOTEAM_TASK_SKILL_SELECTION;
            // Only Browser and Desktop tasks work in the robot's Chromium, where its mailbox is signed in.
            const emailAddress = GUI_MODES.has(task.type) ? robotEmailAddress(robot) : null;
            if (task.cancelRequested) throw new Error('task was paused');
            const child = this.spawnImpl(process.execPath, [fileURLToPath(new URL('./robot-task.mjs', import.meta.url)),
                '--robot', robot.name, ...args], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
            task.child = child;
            child.stdin?.on('error', () => {});
            // The task prompt is the first control record. The copilot engine adds
            // the caller's system instructions when it opens the native session.
            const systemPrompt = [task.type === 'desktop' ? DESKTOP_TASK_INSTRUCTIONS : '', emailAddress ? emailInstructions(emailAddress) : '',
                task.request.systemPrompt].filter(Boolean).join('\n\n');
            child.stdin?.write(`${JSON.stringify({ type: 'prompt', prompt: task.request.task,
                ...(systemPrompt ? { systemPrompt } : {}) })}\n`);
            const resultDecoder = new StringDecoder('utf8');
            let resultBytes = 0;
            child.stdout?.on('data', (chunk) => {
                resultBytes += Buffer.byteLength(chunk);
                if (resultBytes > TASK_RESULT_LIMIT) task.resultOverflow = true;
                else task.result += resultDecoder.write(chunk);
            });
            const progressParser = createAlaProgressParser(appendProgress, (event) => {
                if (event.type === 'run-started' && typeof event.runId === 'string') task.runId = event.runId;
                if (event.type === 'task-failed' && typeof event.message === 'string') forcedFailure ||= new Error(event.message);
                if (event.type === 'skill-catalog') task.skillExecution = { revision: event.revision, policyVersion: event.policyVersion };
                // Only the identifiers of the first turn are kept, never the event body.
                if (event.type === 'turn-started' && !task.transcriptRef
                    && TRANSCRIPT_ID.test(String(event.assistantMessageId)) && TRANSCRIPT_ID.test(String(event.turnId))) {
                    task.transcriptRef = { assistantMessageId: event.assistantMessageId, turnId: event.turnId };
                }
                if (event.type === 'messages-cancelled') appendProgress(`\nCancelled ${event.count} queued message(s).\n`);
                if (event.type === 'session-ready') {
                    task.controlReady = true;
                    for (const message of task.pendingMessages.splice(0)) {
                        child.stdin?.write(`${JSON.stringify(message)}\n`);
                    }
                }
                if (event.type === 'message-accepted' || event.type === 'message-rejected') {
                    const waiter = this.messageWaiters.get(event.id);
                    if (waiter && waiter.taskId === task.taskId) {
                        this.messageWaiters.delete(event.id);
                        clearTimeout(waiter.timer);
                        if (event.type === 'message-rejected') waiter.reject(this._messageFailure('rejected', event.error));
                        else waiter.resolve({ delivery: event.delivery });
                    }
                    appendProgress(`\nMessage ${event.id}: ${event.delivery || event.error}\n`);
                }
            });
            child.stderr?.on('data', (chunk) => progressParser.push(chunk));
            await new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code, signal) => {
                    progressParser.finish();
                    task.result += resultDecoder.end();
                    if (forcedFailure) return reject(forcedFailure);
                    if (task.resultOverflow) return reject(new Error('Final response exceeds the 1 MiB limit'));
                    if (code === 130) task.state = 'paused';
                    if (code === 0) resolve();
                    else reject(new Error(alaFailureMessage(signal || code, `${task.logTail}${task.result}`)));
                });
            });
            if (!task.cancelRequested) task.state = 'completed';
            task.completedAt = new Date().toISOString();
        } catch (error) {
            if (forcedFailure || task.state !== 'paused') {
                error = forcedFailure || error;
                task.state = 'failed'; task.error = String(error?.message || error); task.completedAt = new Date().toISOString();
            }
        } finally {
            await humanInputChannel?.close().catch(() => {});
            task.child = null;
            task.controlReady = false;
            for (const [id, waiter] of this.messageWaiters) {
                if (waiter.taskId !== task.taskId) continue;
                clearTimeout(waiter.timer);
                waiter.reject(this._messageFailure('run_ended', 'Task ended before the message was acknowledged.'));
                this.messageWaiters.delete(id);
            }
            await this._saveTask(task).catch(() => {});
            if (['completed', 'failed', 'paused'].includes(task.state)) {
                this._emitTaskTerminal(task, {
                    state: task.state,
                    result: task.result, error: task.error || (task.resultOverflow ? 'Final response exceeds the 1 MiB limit' : null),
                    ...(forcedFailure ? { forcedFailure: true } : {}),
                });
            }
        }
    }

    async _saveTask(task) {
        if (!['desktop', 'browser', 'simple'].includes(task.type)) return;
        if (!task.request?.cwd) return;
        const cwd = await this.resolveCwd(task.request.cwd);
        registerProject(this, cwd);
        saveTaskExecution(this, { ...task, request: { ...task.request, cwd } });
    }

    async sendTaskMessage(robot, taskId, prompt) {
        const task = this.tasks.get(taskId);
        if (!task || task.robotId !== robot.id || !['queued', 'starting', 'running'].includes(task.state)) {
            throw this._messageFailure('run_ended', 'Task is no longer running; continue it instead.');
        }
        const message = String(prompt || '').trim();
        if (!message || message.length > 32768) throw this._messageFailure('rejected', 'Message must contain 1 to 32768 characters.');
        const command = { type: 'message', id: crypto.randomUUID(), message };
        if (!task.controlReady) {
            if (task.pendingMessages.length >= 100) throw this._messageFailure('rejected', 'Task message queue is full.');
            task.pendingMessages.push(command);
            return { delivery: 'queued', messageId: command.id };
        }
        const response = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.messageWaiters.delete(command.id);
                reject(this._messageFailure('unknown', 'Message acknowledgement timed out; delivery is unknown.'));
            }, this.messageTimeoutMs);
            this.messageWaiters.set(command.id, { resolve, reject, timer, taskId });
        });
        task.child.stdin.write(`${JSON.stringify(command)}\n`);
        return { ...await response, messageId: command.id };
    }

    taskStatus(robotId, taskId = null) {
        const id = taskId || this.activeTasks.get(robotId) || this.latestTask.get(robotId);
        const task = id ? this.tasks.get(id) : null;
        if (!task || task.robotId !== robotId) return null;
        const { child, request, cancelRequested, pendingMessages, controlReady, transcriptRef, terminalEmitted, ownerBinding, ...status } = task;
        return { ...status, cwd: request.cwd,
            skillPolicyRef: request.skillPolicyRef || null,
            skillExecution: task.skillExecution ? structuredClone(task.skillExecution) : null,
            skillSelection: request.skillSelection ? structuredClone(request.skillSelection) : null,
            queuePosition: this.taskQueuePosition(task),
            ...(task.state === 'queued' && GUI_MODES.has(task.type) && this.manualControl.has(robotId)
                ? { blockedReason: 'manual-control' } : {}) };
    }

    activeTaskStatus(robotId) {
        const id = this.activeTasks.get(robotId);
        return id ? this.taskStatus(robotId, id) : null;
    }

    stopTask(robot, expectedType = null, taskId = null, { manualControl = false } = {}) {
        if (!taskId && expectedType === 'simple') {
            const candidates = [...this.tasks.values()].filter((task) => task.robotId === robot.id
                && task.type === 'simple' && ['queued', 'starting', 'running'].includes(task.state));
            if (candidates.length > 1) throw new Error('Multiple CLI tasks are running; specify taskId.');
            taskId = candidates[0]?.taskId || null;
        }
        const target = taskId ? this.taskStatus(robot.id, taskId) : this.activeTaskStatus(robot.id);
        if (target && expectedType && target.type !== expectedType
            && ['queued', 'starting', 'running'].includes(target.state)) {
            throw new Error(`robot has an active ${target.type} task, not a ${expectedType} task`);
        }
        const operation = this._newTask(robot, `stop-${expectedType || 'task'}`, {}, false);
        operation.state = 'running';
        queueMicrotask(() => {
            const internal = target ? this.tasks.get(target.taskId) : null;
            if (internal && (!expectedType || internal.type === expectedType)) {
                if (manualControl && GUI_MODES.has(internal.type)
                    && this.activeTasks.get(robot.id) === internal.taskId) {
                    this.manualControl.set(robot.id, internal.taskId);
                }
                const neverStarted = internal.state === 'queued';
                internal.cancelRequested = true;
                internal.state = 'paused'; internal.completedAt = new Date().toISOString(); this._stopTaskChild(internal);
                // A queued attempt never reaches its run's terminal report.
                if (neverStarted) this._emitTaskTerminal(internal, { state: 'paused', result: internal.result, error: internal.error });
            }
            operation.state = 'completed'; operation.completedAt = new Date().toISOString();
        });
        return { taskId: operation.taskId, state: operation.state };
    }

    _stopTaskChild(task) {
        if (task.runId) void this.roboWork.call('run_stop', { runId: task.runId, signal: 'SIGTERM' }).catch(() => {});
        if (task.child?.stdin?.write) task.child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
        else task.child?.kill('SIGINT');
    }

    takeControl(robot, taskId) {
        return this.stopTask(robot, null, taskId, { manualControl: true });
    }

    // Every continuation is a new attempt with its own task id. Its owner is the
    // original owner (never the caller); a phase association is set only by
    // RoboFlow, which names the phase it resumes.
    async resumeTask(robot, taskId, prompt = '', { runtimeTaskId = null, workflowInstanceId = null } = {}) {
        if (!/^[0-9a-f-]{36}$/u.test(String(taskId))) throw new Error('Invalid task id.');
        let internal = this.tasks.get(taskId);
        let owner = internal?.request?.ownerPrincipal;
        if (internal?.attachRun && ['queued', 'starting', 'running'].includes(internal.state)) return { taskId: internal.taskId, state: internal.state, runId: internal.attachRun };
        if (!internal) {
            const file = findProjectRecord(this, 'task', taskId);
            if (!file) throw new Error('Task execution record is unavailable in registered projects.');
            const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try { internal = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
            if (internal.taskId !== taskId) throw new Error('Task execution record identity mismatch.');
            if (['starting', 'running'].includes(internal.state)) internal.state = 'paused';
            owner = this._boundOwner(internal);
        }
        if (internal.robotId !== robot.id || !['desktop', 'browser', 'simple'].includes(internal.type)
            || !['paused', 'completed', 'failed'].includes(internal.state)) {
            throw new Error('Robot has no matching task to continue.');
        }
        await this.assertHumanInputAnswered?.(taskId, internal.request.workflowRunId);
        const message = String(prompt || '').trim() || 'Continue.';
        if (!/^[0-9a-f-]{36}$/u.test(internal.alaSessionId || '')) throw new Error('Task has no recoverable ALA session.');
        if ([...this.tasks.values()].some((task) => task.robotId === robot.id
            && task.alaSessionId === internal.alaSessionId && ['queued', 'starting', 'running'].includes(task.state))) {
            throw new Error('This conversation already has an active execution.');
        }
        if (message.length > 32768) throw new Error('Continuation prompt is too long.');
        if (this.manualControl.has(robot.id) && this.manualControl.get(robot.id) !== taskId) {
            throw new Error('Resume the task currently under manual control before continuing another task.');
        }
        if (this.skillsets) {
            const policyId = internal.request.skillPolicyRef || internal.alaSessionId;
            // A current conversation policy always wins over a terminal task's old request.
            await this.skillsets.policies.ensure(robot, policyId, { legacy: internal.request.skillSelection });
            internal.request.skillPolicyRef = policyId;
            internal.legacySkillSelection ||= internal.request.skillSelection;
            delete internal.request.skillSelection;
            await this._saveTask(internal);
        }
        const { runtimeTaskId: previousTaskId, workflowInstanceId: previousPhase, ownerPrincipal: storedOwner, ...inherited } = internal.request;
        const resumed = this._enqueueTask(robot, internal.type, {
            ...inherited,
            alaSessionId: internal.alaSessionId, resumeSession: true,
            ...(owner ? { ownerPrincipal: owner } : {}),
            ...(runtimeTaskId ? { runtimeTaskId } : {}),
            ...(workflowInstanceId ? { workflowInstanceId } : {}),
            task: GUI_MODES.has(internal.type) ? `${message}\n\n${RESUME_REOBSERVE_INSTRUCTION}` : message,
        }, { first: this.manualControl.get(robot.id) === taskId });
        if (this.manualControl.get(robot.id) === taskId) this.manualControl.delete(robot.id);
        queueMicrotask(() => void this._drainTaskQueue(robot));
        return resumed;
    }

    sessionUrl(robotId, mode) {
        const session = this.sessions.get(robotId);
        if (!session || session.mode !== mode || session.state !== 'running') throw new Error(`${mode} container is not running`);
        return session.sessionUrl;
    }

    async stopContainer(robotId, mode) {
        return this._serialize(robotId, async () => {
            const session = this.sessions.get(robotId);
            if (!session) return { state: 'stopped' };
            if (session.mode !== mode) throw new Error(`robot slot is occupied by its ${session.mode} container`);
            const active = this.activeTaskStatus(robotId);
            if (active && active.type === mode && ['queued', 'starting', 'running'].includes(active.state)) throw new Error(`stop the ${mode} task before its container`);
            await this.roboWork.call('gui_stop', { robotId, mode });
            this.sessions.delete(robotId);
            return { state: 'stopped' };
        });
    }

    async logs(robotId, tail = 200) {
        return (await this.roboWork.call('gui_logs', { robotId, tail })).logs;
    }

    async deleteRobot(robotId, remove) {
        if (this.pending.has(robotId) || this.sessions.has(robotId) || this.activeTasks.has(robotId)
            || this.hasUnfinishedTasks(robotId)) throw new Error('stop the robot and its queued tasks before deleting it');
        this.deletedRobots.add(robotId);
        // A seed or shell preparation in flight finishes (or aborts) before the folder is removed;
        // anything queued afterwards sees deletedRobots and does nothing.
        await this.seedChain.get(robotId)?.catch(() => {});
        try { await this.roboWork.call('robot_delete', { robotId }); await remove(); }
        catch (error) { this.deletedRobots.delete(robotId); throw error; }
        this.manualControl.delete(robotId);
        this.taskQueues.delete(robotId);
        this.latestTask.delete(robotId);
        for (const [id, task] of this.tasks) if (task.robotId === robotId) this.tasks.delete(id);
    }

    async stopAll() {
        this.shuttingDown = true;
        for (const task of this.tasks.values()) task.child?.stdin?.write(JSON.stringify({ type: 'detach' }) + '\n');
        // Wrapper processes may exit. Native runs and GUI resources belong to
        // RoboWork and remain alive across this controller restart.
    }

}

export const runtimeManagerInternals = { alaFailureMessage, createAlaProgressParser, normalizeBasePath, robotSessionUrl };
