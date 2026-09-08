import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    ensureAchillesPrivateDataRoot,
    resolveAchillesPrivateDataRoot,
} from './privateDataRoot.mjs';
import { withWorkspaceMutation } from './workspaceStateLock.mjs';

const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const DEFAULT_TASK_LIMIT = 10;
const MAX_TASK_LIMIT = 100;
const LOG_TAIL_LINES = 5;
const LOG_TAIL_BYTES = 2 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_FINAL_OUTPUT_RANGES = 1000;
const JOURNAL_NAME = 'agent_tasks';
const LOG_DIRECTORY_NAME = 'task_logs';
const CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatOptional(candidate) {
    try {
        return fs.lstatSync(candidate);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function assertSafeDirectory(candidate, root) {
    const stat = lstatOptional(candidate);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Task history storage is unsafe.');
    }
    const real = fs.realpathSync(candidate);
    if (!isInside(root, real)) {
        throw new Error('Task history storage is unsafe.');
    }
    return real;
}

function assertSafeFile(candidate, root) {
    const stat = lstatOptional(candidate);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Task history storage is unsafe.');
    }
    const real = fs.realpathSync(candidate);
    if (!isInside(root, real)) {
        throw new Error('Task history storage is unsafe.');
    }
    return { path: real, stat };
}

function resolveTaskStorage(workingDir, { includeLogs = false } = {}) {
    const workspace = fs.realpathSync(workingDir);
    const privateDataRoot = resolveAchillesPrivateDataRoot(workspace);
    const achillesDirectory = assertSafeDirectory(privateDataRoot, path.dirname(privateDataRoot));
    if (!achillesDirectory) return null;
    const history = assertSafeDirectory(path.join(achillesDirectory, 'tasks'), achillesDirectory);
    if (!history) return null;
    const journal = assertSafeFile(path.join(history, JOURNAL_NAME), history);
    const logDirectory = includeLogs
        ? assertSafeDirectory(path.join(history, LOG_DIRECTORY_NAME), history)
        : null;
    return {
        history,
        journalPath: journal?.path || '',
        logDirectory,
    };
}

function ensureTaskStorage(workingDir) {
    const workspace = fs.realpathSync(workingDir);
    const achillesDirectory = ensureAchillesPrivateDataRoot(workspace);
    const history = path.join(achillesDirectory, 'tasks');
    const logDirectory = path.join(history, LOG_DIRECTORY_NAME);
    for (const directory of [history, logDirectory]) {
        let stat = lstatOptional(directory);
        if (!stat) {
            try { fs.mkdirSync(directory, { mode: 0o700 }); }
            catch (error) { if (error?.code !== 'EEXIST') throw error; }
            stat = lstatOptional(directory);
        }
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Task history storage is unsafe.');
        }
        if (!isInside(achillesDirectory, fs.realpathSync(directory))) {
            throw new Error('Task history storage is unsafe.');
        }
    }
    const journalPath = path.join(history, JOURNAL_NAME);
    assertSafeFile(journalPath, history);
    return { history, journalPath, logDirectory };
}

function validTimestamp(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
}

function normalizeContinuation(raw, fallbackTargetAgent = '') {
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
    const targetAgent = String(raw.targetAgent || fallbackTargetAgent || '').trim().slice(0, 160);
    const toolName = String(raw.toolName || '').trim();
    const handle = String(raw.handle || '').trim();
    if (!targetAgent || !TOOL_NAME_RE.test(toolName)) return null;
    if (handle && !CONTINUATION_HANDLE_RE.test(handle)) return null;
    return {
        version: 1,
        targetAgent,
        toolName,
        ...(TOOL_NAME_RE.test(raw.messageToolName || '') ? { messageToolName: raw.messageToolName } : {}),
        ...(handle ? { handle } : {}),
    };
}

function normalizeTaskModel(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const key = String(raw.key || raw.id || '').trim().slice(0, 300);
    const model = String(raw.model || '').trim().slice(0, 300);
    const provider = String(raw.provider || '').trim().slice(0, 160);
    const label = String(raw.label || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!key || !model) return null;
    return {
        key,
        model,
        ...(provider ? { provider } : {}),
        ...(label ? { label } : {}),
    };
}

function normalizeExecution(raw) {
    const model = normalizeTaskModel(raw?.model);
    return model ? { model } : null;
}

function normalizeFinalOutputRange(raw, fallbackTurn = 1) {
    if (!raw || typeof raw !== 'object') return null;
    const turn = Number.isSafeInteger(raw.turn) && raw.turn > 0
        ? raw.turn
        : fallbackTurn;
    if (!Number.isSafeInteger(turn) || turn < 1) return null;
    if (!Number.isSafeInteger(raw.offset) || raw.offset < 0) return null;
    if (!Number.isSafeInteger(raw.length) || raw.length < 1) return null;
    return { turn, offset: raw.offset, length: raw.length };
}

function mergeFinalOutputRanges(...collections) {
    const byTurn = new Map();
    for (const collection of collections) {
        if (!Array.isArray(collection)) continue;
        for (const raw of collection.slice(-MAX_FINAL_OUTPUT_RANGES)) {
            const range = normalizeFinalOutputRange(raw);
            if (range) byTurn.set(range.turn, range);
        }
    }
    return [...byTurn.values()]
        .sort((left, right) => left.turn - right.turn || left.offset - right.offset)
        .slice(-MAX_FINAL_OUTPUT_RANGES);
}

function normalizeFinalOutputRanges(raw) {
    const declared = Array.isArray(raw?.finalOutputRanges)
        ? raw.finalOutputRanges
        : [];
    const legacy = normalizeFinalOutputRange({
        turn: raw?.turn,
        offset: raw?.finalOutputOffset,
        length: raw?.finalOutputLength,
    });
    return mergeFinalOutputRanges(declared, legacy ? [legacy] : []);
}

function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || !TASK_ID_RE.test(String(raw.id || ''))) {
        return null;
    }
    const status = ['ongoing', 'finished', 'stopped', 'error'].includes(raw.status)
        ? raw.status
        : 'ongoing';
    const now = new Date().toISOString();
    const createdAt = validTimestamp(raw.createdAt) || now;
    const continuation = normalizeContinuation(raw.continuation, raw.targetAgent);
    const finalOutputRanges = normalizeFinalOutputRanges(raw);
    const execution = normalizeExecution(raw.execution);
    const association = {};
    for (const key of ['sessionId', 'assistantMessageId', 'turnId']) {
        if (typeof raw[key] === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(raw[key])) association[key] = raw[key];
    }
    return {
        version: 1,
        ...association,
        ...(raw.continuationAttempt?.id && ['pending', 'uncertain', 'committed'].includes(raw.continuationAttempt.status)
            ? { continuationAttempt: {
                id: String(raw.continuationAttempt.id).slice(0, 200),
                status: raw.continuationAttempt.status,
                startedAt: validTimestamp(raw.continuationAttempt.startedAt),
                error: String(raw.continuationAttempt.error || '').slice(0, 1000),
                message: String(raw.continuationAttempt.message || '').slice(0, 32768),
            } } : {}),
        id: String(raw.id),
        targetAgent: String(raw.targetAgent || '').slice(0, 160),
        remoteTaskId: String(raw.remoteTaskId || '').slice(0, 200),
        toolName: String(raw.toolName || '').slice(0, 160),
        description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        status,
        remoteStatus: String(raw.remoteStatus || '').slice(0, 80),
        createdAt,
        updatedAt: validTimestamp(raw.updatedAt) || now,
        executionStartedAt: validTimestamp(raw.executionStartedAt) || createdAt,
        turn: Number.isSafeInteger(raw.turn) && raw.turn > 0 ? raw.turn : 1,
        error: String(raw.error || '').trim().slice(0, 1000),
        finalOutputOffset: Number.isSafeInteger(raw.finalOutputOffset) && raw.finalOutputOffset >= 0
            ? raw.finalOutputOffset
            : null,
        finalOutputLength: Number.isSafeInteger(raw.finalOutputLength) && raw.finalOutputLength > 0
            ? raw.finalOutputLength
            : 0,
        ...(finalOutputRanges.length ? { finalOutputRanges } : {}),
        ...(raw.logRetention === 'full' ? { logRetention: 'full' } : {}),
        ...(continuation ? { continuation } : {}),
        ...(execution ? { execution } : {}),
        ...(Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}),
    };
}

export function readWorkspaceTasks(workingDir) {
    const storage = resolveTaskStorage(workingDir);
    if (!storage?.journalPath) return [];
    const tasks = new Map();
    const raw = fs.readFileSync(storage.journalPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const task = normalizeTask(JSON.parse(line));
            if (!task) continue;
            const existing = tasks.get(task.id);
            if (existing && task.turn < existing.turn) continue;
            if (existing && task.turn === existing.turn && task.remoteTaskId && existing.remoteTaskId
                && task.remoteTaskId !== existing.remoteTaskId) continue;
            if (existing && TERMINAL_STATUSES.has(existing.status) && task.status === 'ongoing'
                && task.turn <= existing.turn) {
                continue;
            }
            const finalOutputRanges = mergeFinalOutputRanges(
                existing?.finalOutputRanges,
                task.finalOutputRanges,
            );
            tasks.set(task.id, {
                ...existing,
                ...task,
                ...(finalOutputRanges.length ? { finalOutputRanges } : {}),
                ...(existing?.continuation?.handle && !task.continuation?.handle
                    ? { continuation: existing.continuation }
                    : {}),
            });
        } catch (_) {
            // Ignore malformed or incomplete append-only journal entries.
        }
    }
    return [...tasks.values()].sort((left, right) => {
        return (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
    });
}

export function readOngoingTasks(workingDir) {
    return readWorkspaceTasks(workingDir).filter((task) => {
        return task.status === 'ongoing' && task.targetAgent && task.remoteTaskId;
    });
}

function appendMetadata(journalPath, task) {
    fs.appendFileSync(journalPath, `${JSON.stringify(task)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function taskPaths(logDirectory, taskId) {
    if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('invalid_task_id');
    return {
        logPath: path.join(logDirectory, `${taskId}.log`),
        cursorPath: path.join(logDirectory, `${taskId}.cursor.json`),
    };
}

function atomicWriteJson(filePath, value) {
    assertSafeFile(filePath, path.dirname(filePath));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
        assertSafeFile(filePath, path.dirname(filePath));
        fs.renameSync(temporaryPath, filePath);
    } finally {
        try { fs.unlinkSync(temporaryPath); } catch (_) { }
    }
}

function readCursor(cursorPath) {
    const file = assertSafeFile(cursorPath, path.dirname(cursorPath));
    if (!file) return { tail: '', seq: null, sourceId: '' };
    const parsed = JSON.parse(fs.readFileSync(file.path, 'utf8'));
    return {
        tail: typeof parsed.tail === 'string' ? parsed.tail : '',
        seq: parsed.seq != null && Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : null,
        sourceId: typeof parsed.sourceId === 'string' ? parsed.sourceId.slice(0, 200) : '',
    };
}

function overlapDelta(previousTail, nextTail) {
    if (!nextTail) return '';
    if (!previousTail) return nextTail;
    if (nextTail.startsWith(previousTail)) return nextTail.slice(previousTail.length);
    const maximum = Math.min(previousTail.length, nextTail.length);
    for (let size = maximum; size > 0; size -= 1) {
        if (previousTail.slice(-size) === nextTail.slice(0, size)) return nextTail.slice(size);
    }
    return `\n[task log source truncated or restarted]\n${nextTail}`;
}

function appendTaskLog(logPath, text, { retainFull = false } = {}) {
    if (!text) return '';
    assertSafeFile(logPath, path.dirname(logPath));
    fs.appendFileSync(logPath, text, { encoding: 'utf8', mode: 0o600 });
    const raw = fs.readFileSync(logPath);
    if (retainFull || raw.length <= MAX_LOG_BYTES) return text;
    const marker = Buffer.from('[older task log content truncated]\n', 'utf8');
    const kept = raw.subarray(Math.max(0, raw.length - (MAX_LOG_BYTES - marker.length)));
    fs.writeFileSync(logPath, Buffer.concat([marker, kept]), { mode: 0o600 });
    return text;
}

function ingestLog(logDirectory, task, rawLog = {}) {
    const { logPath, cursorPath } = taskPaths(logDirectory, task.id);
    const cursor = readCursor(cursorPath);
    const tail = typeof rawLog.tail === 'string' ? rawLog.tail : '';
    const seq = rawLog.seq != null && Number.isFinite(Number(rawLog.seq)) ? Number(rawLog.seq) : null;
    const sourceId = String(rawLog.sourceId || task.remoteTaskId || '').slice(0, 200);
    const sameSource = !sourceId || !cursor.sourceId || sourceId === cursor.sourceId;
    if (sameSource && seq !== null && cursor.seq !== null && seq <= cursor.seq) {
        return { appended: '', nextOffset: null };
    }
    const appended = tail && (seq === null || cursor.seq === null || seq !== cursor.seq || tail !== cursor.tail)
        ? overlapDelta(sameSource ? cursor.tail : '', tail)
        : '';
    appendTaskLog(logPath, appended, { retainFull: task.logRetention === 'full' });
    atomicWriteJson(cursorPath, { tail, seq, sourceId, truncated: rawLog.truncated === true });
    let nextOffset = 0;
    try { nextOffset = fs.readFileSync(logPath, 'utf8').length; } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return { appended, nextOffset };
}

function locateFinalOutput(logDirectory, taskId, finalOutput, minimumOffset = 0) {
    if (typeof finalOutput !== 'string' || !finalOutput) return { offset: null, length: 0 };
    const { logPath } = taskPaths(logDirectory, taskId);
    const file = assertSafeFile(logPath, logDirectory);
    const text = file ? fs.readFileSync(file.path, 'utf8') : '';
    for (const candidate of [finalOutput, finalOutput.trim()].filter(Boolean)) {
        const offset = text.lastIndexOf(candidate);
        if (offset >= minimumOffset) return { offset, length: candidate.length };
    }
    return { offset: null, length: 0 };
}

function persistFinalOutput(logDirectory, task, finalOutput) {
    const currentRange = task.finalOutputRanges?.find((range) => range.turn === task.turn);
    if (currentRange) {
        return { output: currentRange, appended: '', nextOffset: null };
    }
    const text = typeof finalOutput === 'string' ? finalOutput.trim() : '';
    if (!text) return { output: { offset: null, length: 0 }, appended: '', nextOffset: null };
    const minimumOffset = (task.finalOutputRanges || [])
        .filter((range) => range.turn < task.turn)
        .reduce((maximum, range) => Math.max(maximum, range.offset + range.length), 0);
    let output = locateFinalOutput(logDirectory, task.id, text, minimumOffset);
    if (output.offset !== null) return { output, appended: '', nextOffset: null };

    const { logPath } = taskPaths(logDirectory, task.id);
    const file = assertSafeFile(logPath, logDirectory);
    const existingLog = file ? fs.readFileSync(file.path, 'utf8') : '';
    const separator = existingLog ? (existingLog.endsWith('\n') ? '\n' : '\n\n') : '';
    const appended = `${separator}[task result]\n${text}\n`;
    appendTaskLog(logPath, appended, { retainFull: task.logRetention === 'full' });
    output = locateFinalOutput(logDirectory, task.id, text, minimumOffset);
    return {
        output,
        appended,
        nextOffset: fs.readFileSync(logPath, 'utf8').length,
    };
}

export async function ingestTaskEvent(workingDir, envelope) {
    return withWorkspaceMutation(workingDir, () => {
    const { journalPath, logDirectory } = ensureTaskStorage(workingDir);
    const incoming = normalizeTask(envelope?.task);
    if (!incoming) throw new Error('invalid_task_event');
    const existing = readWorkspaceTasks(workingDir).find((task) => task.id === incoming.id) || null;
    const staleTurn = existing && incoming.turn !== existing.turn;
    const staleSource = existing && (incoming.targetAgent !== existing.targetAgent
        || incoming.remoteTaskId !== existing.remoteTaskId);
    const invalidRegression = existing && TERMINAL_STATUSES.has(existing.status)
        && incoming.status !== existing.status;
    const staleTimestamp = existing && validTimestamp(envelope?.task?.updatedAt)
        && Date.parse(incoming.updatedAt) < Date.parse(existing.updatedAt);
    const wrongLogSource = envelope?.log?.sourceId && envelope.log.sourceId !== incoming.remoteTaskId;
    if (staleTurn || staleSource || invalidRegression || staleTimestamp || wrongLogSource) {
        return { task: existing, logAppend: '', rejected: true };
    }
    if (envelope?.log) {
        const cursor = readCursor(taskPaths(logDirectory, incoming.id).cursorPath);
        const seq = envelope.log.seq;
        if (seq != null && Number.isFinite(Number(seq)) && cursor.seq !== null
            && cursor.sourceId === incoming.remoteTaskId && Number(seq) < cursor.seq) {
            return { task: existing, logAppend: '', rejected: true };
        }
    }
    const finalOutputRanges = mergeFinalOutputRanges(
        existing?.finalOutputRanges,
        incoming.finalOutputRanges,
    );
    let task = {
        ...existing,
        ...incoming,
        ...Object.fromEntries(['sessionId', 'assistantMessageId', 'turnId']
            .filter((key) => existing?.[key]).map((key) => [key, existing[key]])),
        ...(finalOutputRanges.length ? { finalOutputRanges } : {}),
        ...(existing?.continuation?.handle && !incoming.continuation?.handle
            ? { continuation: existing.continuation }
            : {}),
    };
    let logUpdate = envelope?.log
        ? ingestLog(logDirectory, task, { ...envelope.log, sourceId: task.remoteTaskId })
        : { appended: '', nextOffset: null };
    if (TERMINAL_STATUSES.has(task.status)) {
        const persistedFinal = persistFinalOutput(logDirectory, task, envelope?.finalOutput);
        const finalOutput = persistedFinal.output;
        if (persistedFinal.appended) {
            logUpdate = {
                appended: `${logUpdate.appended}${persistedFinal.appended}`,
                nextOffset: persistedFinal.nextOffset,
            };
        }
        const nextRanges = mergeFinalOutputRanges(
            task.finalOutputRanges,
            finalOutput.offset === null ? [] : [{
                turn: task.turn,
                offset: finalOutput.offset,
                length: finalOutput.length,
            }],
        );
        task = {
            ...task,
            finalOutputOffset: finalOutput.offset ?? task.finalOutputOffset,
            finalOutputLength: finalOutput.length || task.finalOutputLength,
            ...(nextRanges.length ? { finalOutputRanges: nextRanges } : {}),
        };
    }
    const metadataChanged = !existing || JSON.stringify(existing) !== JSON.stringify(task);
    if (metadataChanged) appendMetadata(journalPath, task);
    return {
        task,
        logAppend: logUpdate.appended,
        ...(Number.isInteger(logUpdate.nextOffset) ? { logOffset: logUpdate.nextOffset } : {}),
    };
    });
}

export function getTask(workingDir, taskId) {
    if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('invalid_task_id');
    return readWorkspaceTasks(workingDir).find((task) => task.id === taskId) || null;
}

export async function setTaskModel(workingDir, taskId, modelSelection) {
    return withWorkspaceMutation(workingDir, () => {
    const { journalPath, logDirectory } = ensureTaskStorage(workingDir);
    const existing = getTask(workingDir, taskId);
    if (!existing) throw new Error('task_not_found');
    if (!TERMINAL_STATUSES.has(existing.status)) throw new Error('task_not_terminal');
    if (['pending', 'uncertain'].includes(existing.continuationAttempt?.status)) throw new Error('task_continuation_requires_reconciliation');
    if (!existing.continuation?.handle) throw new Error('task_not_continuable');
    const model = normalizeTaskModel(modelSelection);
    if (!model) throw new Error('invalid_task_model');
    const updated = {
        ...existing,
        execution: { model },
        updatedAt: new Date().toISOString(),
    };
    appendMetadata(journalPath, updated);
    const displayName = stripTerminalControls(model.label || model.key || model.model)
        .replace(/\s+/g, ' ')
        .trim();
    const existingLog = readTaskLog(workingDir, taskId).text;
    const separator = existingLog && !existingLog.endsWith('\n') ? '\n' : '';
    const logAppend = `${separator}switched model to: ${displayName}\n`;
    const { logPath } = taskPaths(logDirectory, taskId);
    appendTaskLog(logPath, logAppend, { retainFull: true });
    const logOffset = fs.readFileSync(logPath, 'utf8').length;
    return { ...updated, logAppend, logOffset };
    });
}

export async function appendTaskLogEntry(workingDir, taskId, message) {
    return withWorkspaceMutation(workingDir, () => {
    const { logDirectory } = ensureTaskStorage(workingDir);
    const existing = getTask(workingDir, taskId);
    if (!existing) throw new Error('task_not_found');
    const text = stripTerminalControls(message).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) throw new Error('task_log_message_required');
    const existingLog = readTaskLog(workingDir, taskId).text;
    const separator = existingLog && !existingLog.endsWith('\n') ? '\n' : '';
    const logAppend = `${separator}${text}\n`;
    const { logPath } = taskPaths(logDirectory, taskId);
    appendTaskLog(logPath, logAppend, { retainFull: true });
    const logOffset = fs.readFileSync(logPath, 'utf8').length;
    return { ...existing, logAppend, logOffset };
    });
}

export function readTaskLog(workingDir, taskId, offset = 0) {
    const storage = resolveTaskStorage(workingDir, { includeLogs: true });
    if (!storage?.logDirectory) return { text: '', nextOffset: 0, reset: false };
    const { logPath } = taskPaths(storage.logDirectory, taskId);
    const file = assertSafeFile(logPath, storage.logDirectory);
    const text = file ? fs.readFileSync(file.path, 'utf8') : '';
    const requested = Math.max(0, Number.parseInt(offset, 10) || 0);
    const reset = requested > text.length;
    const start = reset ? 0 : requested;
    return { text: text.slice(start), nextOffset: text.length, reset };
}

export async function beginTaskContinuation(workingDir, taskId, { remoteTaskId, message, updatedAt, attemptId } = {}) {
    return withWorkspaceMutation(workingDir, () => {
    const { journalPath, logDirectory } = ensureTaskStorage(workingDir);
    const existing = getTask(workingDir, taskId);
    if (!existing) throw new Error('task_not_found');
    if (!TERMINAL_STATUSES.has(existing.status)) throw new Error('task_not_terminal');
    if (!existing.continuation?.handle) throw new Error('task_not_continuable');
    if (['pending', 'uncertain'].includes(existing.continuationAttempt?.status)
        && existing.continuationAttempt.id !== attemptId) throw new Error('task_continuation_requires_reconciliation');
    const nextRemoteTaskId = String(remoteTaskId || '').trim().slice(0, 200);
    if (!nextRemoteTaskId || nextRemoteTaskId === existing.remoteTaskId) throw new Error('invalid_remote_task_id');
    const now = validTimestamp(updatedAt) || new Date().toISOString();
    const next = {
        ...existing,
        ...(attemptId ? { continuationAttempt: { ...existing.continuationAttempt, status: 'committed' } } : {}),
        remoteTaskId: nextRemoteTaskId,
        status: 'ongoing',
        remoteStatus: 'pending',
        updatedAt: now,
        executionStartedAt: now,
        turn: existing.turn + 1,
        error: '',
        finalOutputOffset: null,
        finalOutputLength: 0,
        logRetention: 'full',
    };
    appendMetadata(journalPath, next);
    const { logPath, cursorPath } = taskPaths(logDirectory, taskId);
    const prompt = stripTerminalControls(message).trim().split(/\r?\n/)
        .map((line) => `you> ${line}`)
        .join('\n');
    appendTaskLog(logPath, `\n${prompt}\n\n`, { retainFull: true });
    atomicWriteJson(cursorPath, { tail: '', seq: null, sourceId: nextRemoteTaskId, truncated: false });
    return next;
    });
}

export async function claimTaskContinuation(workingDir, taskId, attemptId, message) {
    return withWorkspaceMutation(workingDir, () => {
        const { journalPath } = ensureTaskStorage(workingDir);
        const task = getTask(workingDir, taskId);
        if (!task) throw new Error('task_not_found');
        if (['pending', 'uncertain'].includes(task.continuationAttempt?.status)) throw new Error('task_continuation_requires_reconciliation');
        if (!TERMINAL_STATUSES.has(task.status)) throw new Error('task_not_terminal');
        if (!task.continuation?.handle) throw new Error('task_not_continuable');
        const next = { ...task, continuationAttempt: { id: attemptId, status: 'pending',
            startedAt: new Date().toISOString(), message: String(message || '').slice(0, 32768), error: '' } };
        appendMetadata(journalPath, next);
        return next;
    });
}

export async function markTaskContinuationUncertain(workingDir, taskId, attemptId) {
    return withWorkspaceMutation(workingDir, () => {
        const { journalPath } = ensureTaskStorage(workingDir);
        const task = getTask(workingDir, taskId);
        if (task?.continuationAttempt?.id !== attemptId || task.continuationAttempt.status === 'committed') return task;
        const next = { ...task, continuationAttempt: { ...task.continuationAttempt, status: 'uncertain',
            error: 'Remote continuation outcome is unknown; reconcile the remote task before retrying.' } };
        appendMetadata(journalPath, next);
        return next;
    });
}

function stripTerminalControls(value) {
    return String(value || '')
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function readTaskLogTail(workingDir, taskId) {
    if (!TASK_ID_RE.test(taskId)) return { text: '', truncated: false };
    const storage = resolveTaskStorage(workingDir, { includeLogs: true });
    if (!storage?.logDirectory) return { text: '', truncated: false };
    const log = assertSafeFile(path.join(storage.logDirectory, `${taskId}.log`), storage.logDirectory);
    if (!log) return { text: '', truncated: false };

    const bytesToRead = Math.min(log.stat.size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const descriptor = fs.openSync(log.path, 'r');
    try {
        fs.readSync(descriptor, buffer, 0, bytesToRead, log.stat.size - bytesToRead);
    } finally {
        fs.closeSync(descriptor);
    }
    const normalized = stripTerminalControls(buffer.toString('utf8')).replace(/\s+$/, '');
    if (!normalized) return { text: '', truncated: log.stat.size > bytesToRead };
    const lines = normalized.split(/\r?\n/);
    const selected = lines.slice(-LOG_TAIL_LINES);
    return {
        text: selected.join('\n'),
        truncated: log.stat.size > bytesToRead || lines.length > selected.length,
    };
}

function parseTaskLimit(rawArgs) {
    const value = String(rawArgs || '').trim().toLowerCase();
    if (!value) return DEFAULT_TASK_LIMIT;
    if (value === 'all') return Infinity;
    if (!/^\d+$/.test(value)) {
        throw new Error('Usage: /tasks [count|all]\n  count must be between 1 and 100.');
    }
    const count = Number.parseInt(value, 10);
    if (count < 1 || count > MAX_TASK_LIMIT) {
        throw new Error('Usage: /tasks [count|all]\n  count must be between 1 and 100.');
    }
    return count;
}

function escapeMarkdownInline(value) {
    return stripTerminalControls(value)
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/([\\`*_[\]{}()#+.!|>\-])/g, '\\$1');
}

function formatTimestamp(value) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return 'unknown';
    return new Date(timestamp).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function safeLogFence(value) {
    return stripTerminalControls(value).replace(/```/g, '`\u200b``');
}

function capUtf8Tail(value, maximumBytes) {
    const buffer = Buffer.from(value, 'utf8');
    if (buffer.length <= maximumBytes) return value;
    return buffer.subarray(buffer.length - maximumBytes)
        .toString('utf8')
        .replace(/^\uFFFD+/, '');
}

function userSafeTaskRead(operation) {
    try {
        return operation();
    } catch (error) {
        if (error?.message === 'Task history storage is unsafe.') throw error;
        const code = typeof error?.code === 'string' ? error.code : 'read_failed';
        throw new Error(`Unable to read task history (${code}).`);
    }
}

export function formatWorkspaceTaskSummary(workingDir, rawArgs = '') {
    const limit = parseTaskLimit(rawArgs);
    const tasks = userSafeTaskRead(() => readWorkspaceTasks(workingDir));
    if (tasks.length === 0) {
        return 'No background tasks found for this workspace.';
    }

    const selected = Number.isFinite(limit) ? tasks.slice(0, limit) : tasks;
    const scope = selected.length === tasks.length
        ? `Showing all ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`
        : `Showing ${selected.length} of ${tasks.length} tasks.`;
    const output = ['## Background tasks', '', scope];

    selected.forEach((task, index) => {
        const name = task.description || task.toolName || task.id;
        const agent = task.targetAgent || 'unknown';
        output.push('', `${index + 1}. **${task.status}** — ${escapeMarkdownInline(name)}`);
        output.push(`   Agent: ${escapeMarkdownInline(agent)} · Updated: ${formatTimestamp(task.updatedAt)}`);
        if (task.error) {
            output.push(`   Error: ${escapeMarkdownInline(task.error)}`);
        }
        if (TERMINAL_STATUSES.has(task.status)) {
            const tail = userSafeTaskRead(() => readTaskLogTail(workingDir, task.id));
            if (tail.text) {
                output.push('', '   Final log:', '```text');
                if (tail.truncated) output.push('[earlier log output omitted]');
                output.push(safeLogFence(capUtf8Tail(tail.text, LOG_TAIL_BYTES)), '```');
            }
        }
    });
    return output.join('\n');
}

export function formatWorkspaceTaskDetail(workingDir, taskId) {
    const task = userSafeTaskRead(() => getTask(workingDir, String(taskId || '').trim()));
    if (!task) throw new Error('Task not found.');
    const log = userSafeTaskRead(() => readTaskLogTail(workingDir, task.id));
    const name = task.description || task.toolName || task.id;
    const output = [
        `## ${escapeMarkdownInline(name)}`,
        '',
        `Task: ${task.id}`,
        `Status: ${task.status}`,
        `Remote status: ${task.remoteStatus || 'unknown'}`,
        `Agent: ${escapeMarkdownInline(task.targetAgent || 'unknown')}`,
        `Updated: ${formatTimestamp(task.updatedAt)}`,
    ];
    if (task.error) output.push(`Error: ${escapeMarkdownInline(task.error)}`);
    output.push('', 'Latest log:', '```text');
    if (log.truncated) output.push('[earlier log output omitted]');
    output.push(safeLogFence(log.text || 'No log output yet.'), '```');
    return output.join('\n');
}

export function buildTaskCompletions(workingDir, action = 'view') {
    const tasks = readWorkspaceTasks(workingDir).filter((task) => {
        if (action === 'stop') return task.status === 'ongoing';
        if (action === 'continue' || action === 'model' || action === 'login') {
            return TERMINAL_STATUSES.has(task.status) && Boolean(task.continuation?.handle);
        }
        return true;
    });
    return tasks.map((task) => ({
        value: task.id,
        label: task.description || task.toolName || task.id,
        description: [task.status, task.remoteStatus, task.id].filter(Boolean).join(' · '),
    }));
}

export const __testables = {
    LOG_TAIL_BYTES,
    LOG_TAIL_LINES,
    MAX_TASK_LIMIT,
    MAX_LOG_BYTES,
    MAX_FINAL_OUTPUT_RANGES,
    TERMINAL_STATUSES,
    capUtf8Tail,
    ensureTaskStorage,
    ingestLog,
    locateFinalOutput,
    mergeFinalOutputRanges,
    normalizeContinuation,
    normalizeExecution,
    normalizeTaskModel,
    normalizeFinalOutputRanges,
    normalizeTask,
    overlapDelta,
    parseTaskLimit,
    readTaskLogTail,
    stripTerminalControls,
    userSafeTaskRead,
};
