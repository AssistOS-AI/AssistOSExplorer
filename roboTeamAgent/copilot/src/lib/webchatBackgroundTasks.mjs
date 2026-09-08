import crypto from 'node:crypto';
import { resolveAchillesPrivateDataRoot } from './privateDataRoot.mjs';
import { acquireExecutionLease } from './workspaceStateLock.mjs';
import { getSkillRuntimeOrigin, runWithSkillRuntimeOrigin } from './skillTaskOrigin.mjs';
import {
    appendTaskLogEntry as persistTaskLogEntry,
    beginTaskContinuation,
    claimTaskContinuation,
    markTaskContinuationUncertain,
    getTask,
    ingestTaskEvent,
    readOngoingTasks,
    readTaskLog,
    readWorkspaceTasks,
    setTaskModel as persistTaskModel,
} from './workspaceTasks.mjs';

const TASK_POLL_INTERVAL_MS = 2000;
const DESCRIPTION_LIMIT = 240;

const observers = new WeakMap();

function observeTasks(module, workingDir, callback) {
    let state = observers.get(module);
    if (!state) {
        state = { listeners: new Set() };
        state.remove = module.setAgentTaskObserver((task) => {
            const origin = getSkillRuntimeOrigin();
            const root = origin?.workingDir ? resolveAchillesPrivateDataRoot(origin.workingDir) : null;
            const listeners = [...state.listeners].filter((entry) => !root || entry.root === root);
            if (listeners.length !== 1) throw new Error('task_origin_workspace_required');
            return listeners[0].callback(task, origin);
        });
        observers.set(module, state);
    }
    const entry = { root: resolveAchillesPrivateDataRoot(workingDir), callback };
    state.listeners.add(entry);
    return () => {
        state.listeners.delete(entry);
        if (!state.listeners.size) {
            state.remove();
            observers.delete(module);
        }
    };
}

function association(origin) {
    const result = {};
    for (const key of ['sessionId', 'assistantMessageId', 'turnId']) {
        if (typeof origin?.[key] === 'string' && origin[key]) result[key] = origin[key];
    }
    return result;
}

function originKey(origin) {
    return origin?.sessionId && origin?.turnId ? `${origin.sessionId}:${origin.turnId}` : null;
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function localTaskId(targetAgent, remoteTaskId) {
    const digest = crypto.createHash('sha256')
        .update(`${targetAgent}\0${remoteTaskId}`)
        .digest('hex')
        .slice(0, 24);
    return `task_${digest}`;
}

function describeTask(agentName, toolName, args = {}) {
    const candidates = [
        args.taskDescription,
        args.description,
        args.prompt,
        args.query,
        args.task,
    ];
    const selected = candidates.map(trim).find(Boolean) || `${agentName}.${toolName}`;
    const compact = selected.replace(/\s+/g, ' ').trim();
    return compact.length > DESCRIPTION_LIMIT
        ? `${compact.slice(0, DESCRIPTION_LIMIT - 1)}…`
        : compact;
}

function normalizeStatus(status) {
    const value = trim(status).toLowerCase();
    if (value === 'completed') return 'finished';
    if (value === 'cancelled') return 'stopped';
    if (value === 'failed' || value === 'not_found') return 'error';
    return 'ongoing';
}

function normalizeContinuation(raw, targetAgent, fallbackTool = '') {
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
    const toolName = trim(raw.toolName) || trim(fallbackTool);
    const handle = trim(raw.handle);
    if (!toolName) return null;
    return {
        version: 1,
        targetAgent,
        toolName,
        ...(/^[A-Za-z0-9._-]{1,160}$/.test(raw.messageToolName || '') ? { messageToolName: raw.messageToolName } : {}),
        ...(handle ? { handle } : {}),
    };
}

function emitTaskEvent(payload) {
    process.stdout.write(`${JSON.stringify({
        __webchatTask: 1,
        version: 1,
        ...payload,
    })}\n`);
}

function taskResultText(task) {
    const content = task?.result?.content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join('\n');
}

function presentTask(task, taskModelCatalogs = new Map()) {
    if (!task || typeof task !== 'object') return task;
    const modelCompletions = (taskModelCatalogs.get(task.id) || []).map((entry) => ({
        value: entry.key,
        label: entry.label || entry.key,
        description: entry.description || entry.key,
    }));
    const commands = task.continuation?.handle && task.status !== 'ongoing'
        ? [
            {
                name: '/model',
                command: `/task model ${task.id}`,
                description: 'Choose the execution model for this task',
                loadingLabel: 'Loading models…',
                argMatchMode: 'fragment',
                argCompletions: modelCompletions,
            },
            {
                name: '/login',
                command: `/task login ${task.id}`,
                description: 'Connect a provider in this task agent',
                loadingLabel: 'Loading providers…',
            },
        ]
        : [];
    return { ...task, commands };
}

export async function createWebchatBackgroundTaskManager({
    workingDir,
    onTaskStarted = null,
    emitProtocol = true,
    onPublish = null,
    agentClientModule: providedAgentClientModule = null,
} = {}) {
    const agentClientModule = providedAgentClientModule || await import('/Agent/client/AgentMcpClient.mjs');
    if (typeof agentClientModule.setAgentTaskObserver !== 'function') {
        throw new Error('Ploinky AgentMcpClient does not support background task observers.');
    }

    const active = new Map();
    const taskModelCatalogs = new Map();
    const taskStartWaiters = new Map();
    const pendingContinuations = new Map();
    let closed = false;

    const notifyTaskStarted = (record, origin) => {
        const key = originKey(origin);
        for (const resolve of taskStartWaiters.get(key) || []) resolve(record);
        taskStartWaiters.delete(key);
    };

    const publish = async (payload, { persist = true } = {}) => {
        let outgoing = payload;
        if (persist && payload?.task) {
            const stored = await ingestTaskEvent(workingDir, payload);
            if (stored.rejected) return stored;
            outgoing = { ...payload, ...stored };
        }
        if (outgoing?.task) outgoing = { ...outgoing, task: presentTask(outgoing.task, taskModelCatalogs) };
        if (Array.isArray(outgoing?.tasks)) {
            outgoing = { ...outgoing, tasks: outgoing.tasks.map((task) => presentTask(task, taskModelCatalogs)) };
        }
        if (typeof onPublish === 'function') await onPublish(outgoing);
        if (emitProtocol) emitTaskEvent(outgoing);
        return outgoing;
    };

    const schedulePoll = (record, getTaskStatus, delay = TASK_POLL_INTERVAL_MS) => {
        if (closed || record.terminal || record.timer) return;
        record.timer = setTimeout(() => {
            record.timer = null;
            void poll(record, getTaskStatus);
        }, delay);
    };

    const poll = async (record, getTaskStatus) => {
        if (closed || record.terminal) return;
        const previousStatus = record.remoteStatus;
        const previousSeq = record.logSeq;
        try {
            const task = await getTaskStatus();
            if (closed || record.terminal) return;
            const remoteStatus = trim(task?.status) || 'running';
            const status = normalizeStatus(remoteStatus);
            const logSeq = task?.logSeq != null && Number.isFinite(Number(task.logSeq)) ? Number(task.logSeq) : null;
            let changed = record.remoteStatus !== remoteStatus || record.logSeq !== logSeq;
            record.remoteStatus = remoteStatus;
            record.logSeq = logSeq;
            record.status = status;
            const resultContinuation = normalizeContinuation(
                task?.result?.metadata?.continuation || task?.liveContinuation,
                record.targetAgent,
                record.continuation?.toolName,
            );
            if (resultContinuation?.handle) {
                changed ||= JSON.stringify(record.continuation) !== JSON.stringify(resultContinuation);
                record.continuation = resultContinuation;
            }
            if (changed) {
                const finalOutput = status === 'ongoing' ? '' : taskResultText(task);
                const outgoing = await publish({
                    event: 'update',
                    task: {
                        id: record.id,
                        targetAgent: record.targetAgent,
                        remoteTaskId: record.remoteTaskId,
                        toolName: record.toolName,
                        description: record.description,
                        status,
                        remoteStatus,
                        createdAt: record.createdAt,
                        updatedAt: task?.updatedAt || new Date().toISOString(),
                        executionStartedAt: record.executionStartedAt,
                        turn: record.turn,
                        error: trim(task?.error),
                        ...(record.continuation ? { continuation: record.continuation } : {}),
                        ...(record.logRetention === 'full' ? { logRetention: 'full' } : {}),
                    },
                    log: {
                        tail: typeof task?.logTail === 'string' ? task.logTail : '',
                        seq: logSeq,
                        truncated: task?.logTruncated === true,
                    },
                    ...(finalOutput ? { finalOutput } : {}),
                });
                if (outgoing.rejected && (outgoing.task?.turn !== record.turn
                    || outgoing.task?.remoteTaskId !== record.remoteTaskId || outgoing.task?.status !== 'ongoing')) {
                    record.terminal = true;
                    if (active.get(record.id) === record) active.delete(record.id);
                    return;
                }
            }
            if (status !== 'ongoing') {
                record.terminal = true;
                if (active.get(record.id) === record) active.delete(record.id);
                return;
            }
        } catch (error) {
            record.remoteStatus = previousStatus;
            record.logSeq = previousSeq;
            const message = trim(error?.message).toLowerCase();
            if (message.includes('not_found') || message.includes('task not found') || message.includes('status 404')) {
                record.status = 'error';
                record.terminal = true;
                if (active.get(record.id) === record) active.delete(record.id);
                await publish({
                    event: 'update',
                    task: {
                        ...record,
                        timer: undefined,
                        terminal: undefined,
                        status: 'error',
                        remoteStatus: 'not_found',
                        updatedAt: new Date().toISOString(),
                        error: 'Task not found on target agent.',
                    },
                });
                return;
            }
            console.warn(`[webchat-tasks] Unable to poll or persist ${record.id}: ${error?.code || 'task_poll_failed'}`);
        }
        schedulePoll(record, getTaskStatus);
    };

    const watch = async ({ agentName, taskId, toolName, arguments: args, metadata, getTaskStatus }, existing = null, origin = null) => {
        if (closed) throw new Error('task_manager_closed');
        const id = existing?.id || localTaskId(agentName, taskId);
        const previous = active.get(id);
        if (previous?.remoteTaskId === taskId) return previous;
        if (previous) {
            previous.terminal = true;
            clearTimeout(previous.timer);
            active.delete(id);
        }
        const now = new Date().toISOString();
        const continuation = existing?.continuation || normalizeContinuation(
            metadata?.continuationCapability,
            agentName,
        );
        const record = {
            id,
            ...association(existing || origin),
            targetAgent: agentName,
            remoteTaskId: taskId,
            toolName: trim(toolName) || trim(metadata?.toolName),
            description: existing?.description || describeTask(agentName, toolName, args),
            status: 'ongoing',
            remoteStatus: trim(metadata?.status) || existing?.remoteStatus || 'pending',
            createdAt: existing?.createdAt || metadata?.createdAt || now,
            updatedAt: metadata?.updatedAt || now,
            executionStartedAt: existing?.executionStartedAt || metadata?.createdAt || now,
            turn: existing?.turn || 1,
            logSeq: null,
            continuation,
            logRetention: metadata?.logRetention === 'full' || existing?.logRetention === 'full'
                ? 'full'
                : 'bounded',
            terminal: false,
            timer: null,
        };
        active.set(id, record);
        const outgoing = await ingestTaskEvent(workingDir, { task: record });
        if (outgoing.rejected) {
            record.terminal = true;
            if (active.get(id) === record) active.delete(id);
            return outgoing.task;
        }
        if (!existing && origin?.sessionId && origin?.assistantMessageId && typeof onTaskStarted === 'function') {
            try {
                await onTaskStarted(record, Object.freeze({ ...association(origin), workingDir,
                    sourceTabId: trim(origin.sourceTabId), sourcePageInstanceId: trim(origin.sourcePageInstanceId) }));
            } catch {
                console.warn(`[webchat-tasks] Unable to attach ${id} to its conversation; task observation continues.`);
            }
        }
        try {
            await publish({ event: existing ? 'reattached' : 'started', task: outgoing.task,
                ...association(existing || origin) }, { persist: false });
        } catch {
            console.warn(`[webchat-tasks] Unable to publish ${id}; task observation continues.`);
        } finally {
            if (!existing) notifyTaskStarted(record, origin);
            schedulePoll(record, getTaskStatus, 0);
        }
        return record;
    };

    const removeObserver = observeTasks(agentClientModule, workingDir, async (task, origin) => {
        const pending = pendingContinuations.get(origin?.continuationOperationId);
        let existing = getTask(workingDir, localTaskId(task.agentName, task.taskId));
        let continuationLog = null;
        if (pending) {
            if (pending.targetAgent !== task.agentName || pending.toolName !== task.toolName
                || pending.handle !== trim(task.arguments?.handle)) throw new Error('continuation_origin_mismatch');
            const previousLogOffset = readTaskLog(workingDir, pending.taskId).nextOffset;
            existing = await beginTaskContinuation(workingDir, pending.taskId, {
                remoteTaskId: task.taskId, message: pending.message,
                updatedAt: task.metadata?.updatedAt, attemptId: pending.attemptId,
            });
            continuationLog = readTaskLog(workingDir, pending.taskId, previousLogOffset);
            pending.startedTask = existing;
        }
        const record = await watch(task, existing, origin);
        if (pending) pending.startedTask = getTask(workingDir, record.id) || record;
        if (pending) {
            await publish({
                event: 'continued', task: pending.startedTask,
                logAppend: continuationLog?.text || '', logOffset: continuationLog?.nextOffset || 0,
            }, { persist: false });
        }
        return {
            detached: true,
            id: record.id,
            description: record.description,
        };
    });

    const reattachTimer = setTimeout(() => {
        if (closed) return;
        let ongoingTasks = [];
        try {
            ongoingTasks = readOngoingTasks(workingDir);
        } catch (error) {
            console.warn(`[webchat-tasks] Unable to read task journal: ${error.message}`);
            return;
        }
        for (const task of ongoingTasks) {
            void agentClientModule.createAgentClient(task.targetAgent).then(async (client) => {
                await client.ensureAgentRunning(task.targetAgent, { mode: 'global' });
                await watch({
                    agentName: task.targetAgent,
                    taskId: task.remoteTaskId,
                    toolName: task.toolName,
                    arguments: { description: task.description },
                    metadata: task,
                    getTaskStatus: () => client.getTaskStatus(task.remoteTaskId),
                }, task);
            }).catch((error) => {
                console.warn(`[webchat-tasks] Unable to reattach ${task.id}: ${error.message}`);
            });
        }
    }, 250);

    return {
        activeCount: () => active.size,
        async observeScriptTask(task, origin) {
            if (!task || typeof task.agentName !== 'string' || typeof task.taskId !== 'string'
                || typeof task.toolName !== 'string') throw new Error('invalid_script_task_receipt');
            const client = await agentClientModule.createAgentClient(task.agentName);
            // Verify the returned task through the authenticated SDK before attaching it.
            const status = await client.getTaskStatus(task.taskId);
            if (!status || status.status === 'not_found') throw new Error('script_task_not_found');
            return watch({ ...task, getTaskStatus: () => client.getTaskStatus(task.taskId) }, null, origin);
        },
        createTaskStartWaiter(origin = getSkillRuntimeOrigin()) {
            const key = originKey(origin);
            if (!key) throw new Error('task_origin_turn_required');
            let resolveWaiter;
            const promise = new Promise((resolve) => {
                resolveWaiter = resolve;
            });
            if (!taskStartWaiters.has(key)) taskStartWaiters.set(key, new Set());
            taskStartWaiters.get(key).add(resolveWaiter);
            return {
                promise,
                cancel() {
                    const waiters = taskStartWaiters.get(key);
                    waiters?.delete(resolveWaiter);
                    if (!waiters?.size) taskStartWaiters.delete(key);
                },
            };
        },
        async listTasks() {
            const tasks = readWorkspaceTasks(workingDir);
            await publish({ event: 'list', tasks }, { persist: false });
            return tasks;
        },
        async viewTask(taskId) {
            const task = getTask(workingDir, taskId);
            if (!task) throw new Error('task_not_found');
            const log = readTaskLog(workingDir, taskId);
            await publish({ event: 'view', task, log }, { persist: false });
            return { task, log };
        },
        async stopTask(taskId) {
            const task = getTask(workingDir, taskId);
            if (!task) throw new Error('task_not_found');
            if (task.status !== 'ongoing') throw new Error('task_not_running');
            const client = await agentClientModule.createAgentClient(task.targetAgent);
            const remote = await client.cancelTask(task.remoteTaskId);
            const updated = {
                ...task,
                status: normalizeStatus(remote?.status),
                remoteStatus: trim(remote?.status) || task.remoteStatus,
                updatedAt: remote?.updatedAt || new Date().toISOString(),
                error: trim(remote?.error),
            };
            const outgoing = await publish({ event: 'update', task: updated });
            const record = active.get(taskId);
            if (record) {
                record.status = outgoing.task.status;
                record.remoteStatus = outgoing.task.remoteStatus;
                record.updatedAt = outgoing.task.updatedAt;
                record.error = outgoing.task.error;
                if (outgoing.task.status !== 'ongoing') {
                    record.terminal = true;
                    if (record.timer) clearTimeout(record.timer);
                    record.timer = null;
                }
            }
            if (outgoing.task.status !== 'ongoing') active.delete(taskId);
            await publish({ event: 'action', action: 'stop', ok: true, task: outgoing.task }, { persist: false });
            return outgoing.task;
        },
        async continueTask(taskId, message, origin = getSkillRuntimeOrigin()) {
            const release = await acquireExecutionLease(workingDir, `task-continuation:${taskId}`);
            try {
            const task = getTask(workingDir, taskId);
            if (!task) throw new Error('task_not_found');
            if (['pending', 'uncertain'].includes(task.continuationAttempt?.status)) throw new Error('task_continuation_requires_reconciliation');
            if (task.status === 'ongoing') {
                if (!task.continuation?.handle || !task.continuation?.messageToolName) throw new Error('task_live_input_unavailable');
                const prompt = trim(message);
                if (!prompt || prompt.length > 32768) throw new Error('invalid_task_message');
                const client = await agentClientModule.createAgentClient(task.continuation.targetAgent);
                const response = await client.callTool(task.continuation.messageToolName, {
                    handle: task.continuation.handle, prompt,
                });
                const text = response?.content?.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
                const receipt = text ? JSON.parse(text) : response;
                if (response?.isError || !['delivered', 'queued'].includes(receipt?.delivery)) {
                    throw new Error(receipt?.error || 'task_message_not_acknowledged');
                }
                const log = await persistTaskLogEntry(workingDir, taskId, `User (${receipt.delivery}): ${prompt}`);
                await publish({ event: 'action', action: 'continue', ok: true, task: getTask(workingDir, taskId),
                    delivery: receipt.delivery, logAppend: log.logAppend, logOffset: log.logOffset }, { persist: false });
                return { ...task, delivery: receipt.delivery };
            }
            if (!task.continuation?.handle) throw new Error('task_not_continuable');
            const prompt = trim(message);
            if (prompt.length > 32768) throw new Error('invalid_task_message');
            if (!prompt) throw new Error('continuation_message_required');
            const client = await agentClientModule.createAgentClient(task.continuation.targetAgent);
            await client.ensureAgentRunning(task.continuation.targetAgent, { mode: 'global' });
            const attemptId = crypto.randomUUID();
            const operationOrigin = Object.freeze({ ...origin, workingDir, continuationOperationId: attemptId });
            const pending = {
                attemptId,
                taskId,
                targetAgent: task.continuation.targetAgent,
                toolName: task.continuation.toolName,
                handle: task.continuation.handle,
                message: prompt,
                startedTask: null,
            };
            await claimTaskContinuation(workingDir, taskId, attemptId, prompt);
            pendingContinuations.set(attemptId, pending);
            try {
                await runWithSkillRuntimeOrigin(operationOrigin, () => client.callToolWithoutWait(task.continuation.toolName, {
                    handle: task.continuation.handle,
                    prompt,
                    ...(task.execution?.model?.model ? { model: task.execution.model.model } : {}),
                    ...(task.execution?.model?.provider ? { provider: task.execution.model.provider } : {}),
                }));
                if (!pending.startedTask) throw new Error('continuation_did_not_start_task');
                await publish({
                    event: 'action',
                    action: 'continue',
                    ok: true,
                    task: pending.startedTask,
                }, { persist: false });
                return pending.startedTask;
            } catch (error) {
                await markTaskContinuationUncertain(workingDir, taskId, attemptId);
                throw error;
            } finally {
                pendingContinuations.delete(attemptId);
            }
            } finally {
                await release();
            }
        },
        async setTaskModel(taskId, modelSelection) {
            const updated = await persistTaskModel(workingDir, taskId, modelSelection);
            await publish({
                event: 'control',
                action: 'model',
                task: updated,
                logAppend: updated.logAppend,
                logOffset: updated.logOffset,
            }, { persist: false });
            return updated;
        },
        async appendTaskLog(taskId, message, action = 'control') {
            const updated = await persistTaskLogEntry(workingDir, taskId, message);
            await publish({
                event: 'control',
                action,
                task: updated,
                logAppend: updated.logAppend,
                logOffset: updated.logOffset,
            }, { persist: false });
            return updated;
        },
        async setTaskModelCatalog(taskId, models) {
            const task = getTask(workingDir, taskId);
            if (!task) throw new Error('task_not_found');
            const normalized = Array.isArray(models)
                ? models.slice(0, 2000).map((entry) => {
                    const key = trim(entry?.key).slice(0, 300);
                    if (!key) return null;
                    return {
                        key,
                        label: trim(entry?.label).slice(0, 300) || key,
                        description: trim(entry?.description).slice(0, 500),
                    };
                }).filter(Boolean)
                : [];
            taskModelCatalogs.set(taskId, normalized);
            await publish({
                event: 'control',
                action: 'models',
                ok: true,
                task,
            }, { persist: false });
            return normalized;
        },
        async reportActionError(action, taskId, error) {
            let task = null;
            try { task = getTask(workingDir, taskId); } catch (_) { }
            if (!task) return;
            await publish({
                event: 'action',
                action,
                ok: false,
                task,
                error: trim(error?.message || error) || 'task_action_failed',
            }, { persist: false });
        },
        close() {
            closed = true;
            clearTimeout(reattachTimer);
            removeObserver();
            for (const record of active.values()) {
                if (record.timer) clearTimeout(record.timer);
            }
            taskStartWaiters.clear();
            active.clear();
            taskModelCatalogs.clear();
        },
    };
}

export const __testables = {
    TASK_POLL_INTERVAL_MS,
    describeTask,
    localTaskId,
    normalizeStatus,
    normalizeContinuation,
    taskResultText,
    presentTask,
    readOngoingTasks,
};
