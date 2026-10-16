import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { isWebchatMessageEnvelope, normalizeWebchatMessage, shouldEmitWebchatOutput } from './webchatEnvelope.mjs';
import { materializeWebchatContext } from './webchatResources.mjs';
import { formatWebchatError } from './webchatError.mjs';
import { createWebchatWorkspaceFileIndex } from './webchatWorkspaceFiles.mjs';
import { parseWebchatInteractionResponse } from '../../permissions/protocol.mjs';
import { createCurrentSessionEnvelope, createSelectedSessionEnvelope, createSessionListEnvelope } from './webchatSessionState.mjs';
import { createWebchatSkillsEnvelope } from '../skills/workspaceSkillsState.mjs';
import { createWebchatRuntimeStateEnvelope } from './webchatRuntimeState.mjs';
import { createProgressLineBuffer, createWebchatProgressEnvelope, codingAgentLabel } from './webchatProgressState.mjs';
import { executeRuntimeCommand } from '../cli/cliRuntimeCommands.mjs';
import { handleWebchatControlChunk, isWebchatEscapeControlChunk } from './webchatControl.mjs';
import { createSanitizer } from '../skillRuntimePolicy.mjs';
import { errorFields, logDiagnostic } from '../storage/copilotDiagnostics.mjs';

function target(context) {
    return {
        ...(context.sourceTabId ? { targetTabId: context.sourceTabId } : {}),
        ...(context.sourcePageInstanceId ? { targetPageInstanceId: context.sourcePageInstanceId } : {}),
    };
}

export function emitSessionUpdate(session, context = {}, { write = (value) => process.stdout.write(value), event = 'updated' } = {}) {
    write(`${JSON.stringify({ ...createCurrentSessionEnvelope(session), event, ...target(context) })}\n`);
}

export async function attachTaskToSession(sessionStore, task, origin, { webchat = false, write } = {}) {
    if (!origin?.sessionId || !origin.assistantMessageId || !task?.id) return null;
    const { session } = await sessionStore.insertTask(origin.sessionId, origin.assistantMessageId, task.id);
    if (webchat) emitSessionUpdate(session, origin, { write });
    return session;
}

function captureContext(message, workingDir) {
    const materialized = materializeWebchatContext(message, { workingDir });
    return {
        workingDir, rawText: message.rawText,
        invocationToken: message.invocationToken,
        sourceTabId: message.sourceTabId, sourcePageInstanceId: message.sourcePageInstanceId,
        attachments: message.attachments, references: message.references,
        webchatAttachments: message.attachments, webchatReferences: message.references,
        webchatResources: materialized.resources, webchatPaths: materialized.paths,
        webchatResourceWarnings: materialized.warnings,
        webchatOrigin: { ...message.origin, type: 'semantic-copilot', surface: 'webchat',
            agent: 'roboTeamAgent', robot: process.env.ROBOTEAM_COPILOT_ROBOT_NAME, working_directory: workingDir },
    };
}

/** Connections select by tab, while each in-flight request captures its delivery page. */
export function createWebchatDispatcher(runtime, { write = (value) => process.stdout.write(value), afterAnswer = async () => {} } = {}) {
    const connections = new Map();
    const running = new Set();
    const active = new Map();
    const send = (envelope, context = {}) => write(`${JSON.stringify({ ...envelope, ...target(context) })}\n`);
    const update = (session, context) => emitSessionUpdate(session, context, { write });
    const track = (promise) => {
        running.add(promise);
        promise.finally(() => running.delete(promise)).catch(() => {});
        promise.then(null, (error) => logDiagnostic(runtime.workingDir, 'webchat.track.rejected', errorFields(error)));
        return promise;
    };
    const fail = (error, context, sessionId) => {
        const text = createSanitizer(context, process.env)(error?.name === 'AbortError' || error?.exitCode === 130 ? '[cancelled]' : formatWebchatError(error, { publicBaseUrl: context.webchatOrigin?.publicBaseUrl }));
        if (context.sourceTabId) send({ __webchatSession: 1, version: 1, event: 'error', sessionId, error: text }, context);
        else write(`${text}\n`);
    };
    // A conversation that cannot run (for example, its agent is no longer enabled
    // for the robot) reports why in the chat; the runtime stays up for a new session.
    const publishModel = async (session, context) => {
        let selection;
        try {
            selection = runtime.engine.getModel ? await runtime.engine.getModel({ sessionId: session.sessionId })
                : { backend: session.engine?.backend, model: null };
        } catch (error) {
            send(createWebchatRuntimeStateEnvelope(null, { backend: null }), context);
            fail(error, context, session.sessionId);
            return;
        }
        send(createWebchatRuntimeStateEnvelope(selection.model, { backend: selection.backend || null, effort: selection.effort }), context);
    };
    const connectionFor = (context) => {
        const key = context.sourceTabId || 'legacy';
        if (!connections.has(key)) {
            const connection = { sessionId: null, markdownEnabled: runtime.renderMarkdown !== false };
            connection.chain = runtime.sessionStore.ensureCurrentSession().then(async (session) => {
                connection.sessionId = session.sessionId;
                send(createCurrentSessionEnvelope(session), context);
                await publishModel(session, context);
            });
            connections.set(key, connection);
        }
        return connections.get(key);
    };
    const execute = async (message, context, connection) => {
        const sessionId = connection.sessionId;
        const sanitize = createSanitizer(context, process.env);
        const controller = new AbortController();
        const operationId = crypto.randomUUID();
        const operation = { controller, context, sessionId };
        active.set(operationId, operation);
        const input = message.rawText.trim();
        const isSlash = input.startsWith('/');
        const isExec = /^\/exec(?:\s|$)/.test(input);
        const turnKind = !isSlash ? 'turn' : isExec ? 'exec' : 'command';
        const diag = (event, extra = {}) => logDiagnostic(runtime.workingDir, `webchat.${event}`,
            { turnId: operationId, kind: turnKind, sessionId, sourceTabId: context.sourceTabId || null, ...extra });
        diag('execute.start', { activeOperations: active.size });
        const emitOutput = shouldEmitWebchatOutput(message, { isSlashCommand: isSlash });
        let commandTurn = null;
        let engineStarted = false;
        const sendProgress = (reason, extra) => {
            const envelope = createWebchatProgressEnvelope(reason, extra);
            if (envelope) send(envelope, context);
        };
        const agentLines = createProgressLineBuffer((line) => sendProgress(line, { type: 'coding-agent-message' }));
        const onEvent = async (event) => {
            if (event.type === 'turn-started') {
                engineStarted = true;
                update(event.session, context);
            }
            if (event.type === 'progress' && event.reason) {
                sendProgress(event.reason);
            } else if (event.type === 'coding-agent-selected') {
                sendProgress(`Routing to ${codingAgentLabel(event.agent)}`, { type: 'coding-agent' });
            } else if (event.type === 'coding-agent-message') {
                agentLines.push(event);
            } else if (event.type === 'agentlib-tool') {
                sendProgress(event.message || event.reason, { tool: event.tool || '', type: event.type });
            }
            if (event.type === 'coding-agent-selected' && connection.sessionId === sessionId) {
                send(createWebchatRuntimeStateEnvelope(event.model, { backend: event.agent, effort: event.effort }), context);
            }
            if (event.type === 'diagnostic' && (runtime.debug || runtime.verbose)) console.error(event.message);
        };
        const emit = (kind, payload) => {
            if (kind === 'selected') {
                send(createSelectedSessionEnvelope(payload), context);
                track(publishModel(payload, context).catch((error) => fail(error, context, payload.sessionId)));
            } else if (kind === 'list') send(createSessionListEnvelope(payload), context);
            else if (kind === 'runtime') send(createWebchatRuntimeStateEnvelope(payload.model, { backend: payload.backend, effort: payload.effort }), context);
            else if (kind === 'skills') send(createWebchatSkillsEnvelope(payload.skillState, {
                event: payload.skillStateEvent || 'list', operation: payload.skillOperation || null, error: payload.error || '',
            }), context);
        };
        try {
            if (isSlash && !isExec && message.visible !== false) {
                commandTurn = await runtime.sessionStore.beginCommand({ sessionId, text: sanitize(message.rawText),
                    attachments: sanitize(message.attachments), references: sanitize(message.references), turnId: operationId });
                Object.assign(context, { sessionId, turnId: operationId, assistantMessageId: commandTurn.assistantMessageId });
                update(commandTurn.session, context);
            }
            const result = isSlash
                ? await executeRuntimeCommand({ runtime, connection: isExec ? { ...connection, sessionId } : connection, input, context, signal: controller.signal, onEvent, emit })
                : await runtime.engine.executeTurn({ sessionId, turnId: operationId, prompt: message.text.trim(), context, signal: controller.signal, onEvent });
            const output = sanitize(result.outputText ?? result.output ?? '');
            if (commandTurn) {
                const session = await runtime.sessionStore.completeCommand(sessionId, commandTurn.assistantMessageId, output);
                update(session, context);
            } else if (engineStarted) update(runtime.sessionStore.loadSession(sessionId), context);
            else if (isExec && output && emitOutput) fail(new Error(output), context, sessionId);
            if (!isSlash) await runtime.historyManager.add(message.rawText);
            await afterAnswer();
            if (!context.sourceTabId && emitOutput && output) write(`${output}\n`);
            diag('execute.end', { engineStarted });
        } catch (error) {
            // Tab-bound errors after the engine started are not shown to the user, so record them here.
            const reported = Boolean(emitOutput && (!engineStarted || !context.sourceTabId));
            diag('execute.error', { engineStarted, failCalled: reported, hasCommandTurn: Boolean(commandTurn),
                aborted: controller.signal.aborted, ...errorFields(error) });
            if (commandTurn) {
                await runtime.sessionStore.completeTurn(sessionId, commandTurn.assistantMessageId,
                    sanitize(formatWebchatError(error, { publicBaseUrl: context.webchatOrigin?.publicBaseUrl })),
                    { status: controller.signal.aborted || error?.name === 'AbortError' || error?.exitCode === 130 ? 'interrupted' : 'failed' });
                update(runtime.sessionStore.loadSession(sessionId), context);
            } else if (engineStarted) update(runtime.sessionStore.loadSession(sessionId), context);
            if (emitOutput && (!engineStarted || !context.sourceTabId)) fail(error, context, sessionId);
        } finally { active.delete(operationId); diag('execute.finally', { activeOperations: active.size }); }
    };
    return {
        receive(raw) {
            const response = parseWebchatInteractionResponse(raw);
            if (response) {
                let source = {};
                try { source = JSON.parse(raw); } catch { /* Legacy parser accepts only JSON responses. */ }
                runtime.webchatController.resolve(response, source);
                return;
            }
            let control;
            try { control = JSON.parse(raw); } catch { /* Plain text is a prompt. */ }
            if (control?.__webchatControl === 1 && control.type === 'stop') {
                for (const operation of active.values()) {
                    if (operation.sessionId !== connections.get(control.sourceTabId || 'legacy')?.sessionId) continue;
                    if (control.sourceTabId && operation.context.sourceTabId === control.sourceTabId
                        && (!control.sourcePageInstanceId || operation.context.sourcePageInstanceId === control.sourcePageInstanceId)) operation.controller.abort();
                }
                return;
            }
            if (isWebchatEscapeControlChunk(raw)) {
                if (active.size === 1) handleWebchatControlChunk(raw, { isProcessing: true, abortController: active.values().next().value.controller });
                return;
            }
            const message = normalizeWebchatMessage(raw);
            if (!message.rawText.trim()) return;
            const context = captureContext(message, runtime.workingDir);
            const connection = connectionFor(context);
            // Only selection/control commands serialize. Turns acquire their own session lease
            // and must not block another conversation or conceal duplicate-turn contention.
            const startsTurn = !message.rawText.trim().startsWith('/') || /^\/exec(?:\s|$)/.test(message.rawText.trim());
            logDiagnostic(runtime.workingDir, 'webchat.input.received', {
                kind: startsTurn ? (/^\/exec(?:\s|$)/.test(message.rawText.trim()) ? 'exec' : 'turn') : 'command',
                sessionId: connection.sessionId, sourceTabId: context.sourceTabId || null,
                activeOperations: active.size, runningPromises: running.size });
            connection.chain = connection.chain.then(() => {
                const execution = track(execute(message, context, connection));
                if (!startsTurn) return execution;
            }).catch((error) => {
                logDiagnostic(runtime.workingDir, 'webchat.chain.error', { sessionId: connection.sessionId, ...errorFields(error) });
                fail(error, context, connection.sessionId);
            });
            track(connection.chain);
        },
        async drain() {
            while (running.size) await Promise.allSettled([...running]);
        },
        cancel() {
            for (const operation of active.values()) operation.controller.abort();
        },
    };
}

export async function runWebchatInteractive(runtime) {
    const workspaceFileIndex = createWebchatWorkspaceFileIndex({ workingDir: runtime.workingDir });
    await workspaceFileIndex.start();
    const dispatcher = createWebchatDispatcher(runtime, {
        afterAnswer: () => workspaceFileIndex.refresh({ afterCurrent: true }),
    });
    emitSessionUpdate(runtime.initialSession, {}, { event: 'current' });
    // Each tab connection reports a failing conversation; startup must not exit on it.
    const selection = runtime.engine.getModel
        ? await runtime.engine.getModel({ sessionId: runtime.initialSession.sessionId }).catch(() => ({ backend: null, model: null })) : null;
    const backend = selection ? selection.backend || null : runtime.initialSession.engine?.backend || null;
    process.stdout.write(`${JSON.stringify(createWebchatRuntimeStateEnvelope(
        selection?.model || null, { backend, effort: selection?.effort },
    ))}\n`);
    const decoder = new StringDecoder('utf8');
    let partial = '';
    let pending = [];
    let timer = null;
    const flush = () => {
        clearTimeout(timer);
        timer = null;
        if (pending.length) dispatcher.receive(pending.join('\n'));
        pending = [];
    };
    const line = (value) => {
        if (isWebchatMessageEnvelope(value) || parseWebchatInteractionResponse(value) || value.includes('__webchatControl') || value.includes('\x1b')) {
            flush();
            dispatcher.receive(value);
        } else { pending.push(value); clearTimeout(timer); timer = setTimeout(flush, 150); }
    };
    const stop = () => dispatcher.cancel();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const wasRaw = process.stdin.isRaw;
    try {
        if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
        for await (const chunk of process.stdin) {
            const text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            if (text.includes('\x1b')) { dispatcher.receive('\x1b'); continue; }
            partial += text.replace(/\r\n/g, '\n');
            let newline;
            while ((newline = partial.indexOf('\n')) !== -1) {
                line(partial.slice(0, newline));
                partial = partial.slice(newline + 1);
            }
        }
        partial += decoder.end();
        if (partial) line(partial);
        flush();
        runtime.webchatController.dispose();
        await dispatcher.drain();
    } finally {
        clearTimeout(timer);
        dispatcher.cancel();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        if (process.stdin.isTTY) process.stdin.setRawMode?.(Boolean(wasRaw));
        workspaceFileIndex.stop();
    }
}
