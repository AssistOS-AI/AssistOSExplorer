import { nativeEnvironment } from './alaEnvironment.mjs';
import { createTaskFailureChannel } from '../../../../server/task-failure-channel.mjs';
import { buildNativePrompt, buildTaskPrompt } from '../prompts.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAlaInstallation } from './alaInstallation.mjs';
import { alaSessionsRoot, readAlaSession } from './alaTranscript.mjs';
import * as workspaceSettings from '../config/achillesSettings.mjs';
import { acquireExecutionLease } from '../storage/workspaceStateLock.mjs';
import { ACHILLES_PRIVATE_DIRECTORY_NAME, resolveAchillesWorkspaceRoot } from '../storage/privateDataRoot.mjs';
import { createPloinkyTaskContext } from '../ploinky/ploinkyTaskContext.mjs';
import { createSanitizer } from '../skillRuntimePolicy.mjs';
import { webchatTurnLogUrl } from '../webchat/webchatTurnLog.mjs';
import { codingAgentLabel } from '../webchat/webchatProgressState.mjs';

const BACKENDS = ['codex', 'opencode', 'pi', 'claude'];
const EVENT_PREFIX = '@@ALA_EVENT@@';
const MAX_OUTPUT = 16 * 1024 * 1024;

async function modelConfigPath(home) {
    const directory = path.join(home, '.ala');
    const file = path.join(directory, 'config.json');
    for (const [entryPath, kind] of [[directory, 'isDirectory'], [file, 'isFile']]) {
        try {
            const entry = await fs.lstat(entryPath);
            if (entry.isSymbolicLink() || !entry[kind]()) throw new Error('Unsafe ALA model configuration path.');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return file;
}

// The ALA home holds ALA's configuration and the coding agents' own state. It
// is the robot home under RoboTeam and the user's home for a standalone CLI.
// Conversations are not stored there; they live in the working folder.
async function executionHome(env) {
    const configured = String(env.ACHILLES_ALA_HOME || '').trim();
    const directory = configured || os.homedir();
    let home;
    try {
        home = await fs.realpath(directory);
        if (!(await fs.stat(home)).isDirectory()) throw new Error('not a directory');
    } catch (cause) {
        throw new Error('ALA setup error: ACHILLES_ALA_HOME must be an existing administrator-provisioned dedicated native home.', { cause });
    }
    return home;
}

// Returns the backend to resume, or false when the conversation has no native
// continuation yet. The continuation is the last one in ALA's transcript.
function validateNativeSession(session, home, cwd) {
    const metadata = session.engine;
    if (metadata && (metadata.sessionId !== session.sessionId || metadata.home !== home || metadata.cwd !== cwd)) {
        throw new Error('ALA session home/cwd association mismatch; the existing conversation has not been replaced.');
    }
    let native;
    try { native = readAlaSession(cwd, session.sessionId); }
    catch (cause) {
        throw new Error(`ALA conversation transcript is corrupt for conversation ${session.sessionId}; restore it or create a new conversation.`, { cause });
    }
    if (!native) {
        if (metadata?.backend) throw new Error(`ALA conversation transcript is missing for conversation ${session.sessionId}; restore it or create a new conversation.`);
        return false;
    }
    if (!metadata) throw new Error('An unbound ALA conversation already exists; refusing to replace or adopt it.');
    if (!native.continuation) return false;
    if (!BACKENDS.includes(native.agent) || typeof native.continuation !== 'object' || Array.isArray(native.continuation)
        || (metadata.backend && native.agent !== metadata.backend)) {
        throw new Error('ALA native session backend/continuation mismatch; the existing conversation has not been replaced.');
    }
    const requiredFields = native.agent === 'codex' ? ['threadId']
        : native.agent === 'pi' ? ['sessionId', 'sessionFile'] : ['sessionId'];
    if (requiredFields.some((field) => typeof native.continuation[field] !== 'string' || !native.continuation[field].trim())) {
        throw new Error('ALA native continuation is corrupt; restore it or create a new conversation.');
    }
    return native.agent;
}

function interrupted() {
    return Object.assign(new Error('Execution interrupted.'), { name: 'AbortError', code: 'ABORT_ERR', exitCode: 130 });
}

export function createAlaEngine({ workingDir, sessionStore, skillCatalog, settings = workspaceSettings,
    interactions, backgroundTasks, installation, execution = {}, webchatLogsBase = '' } = {}) {
    if (!sessionStore || !skillCatalog) throw new TypeError('ALA requires a session store and Anthropic skill catalog.');
    const active = new Set();
    let closed = false;
    const installed = installation ? Promise.resolve(installation) : resolveAlaInstallation();

    async function configuration(sessionId, env) {
        const session = sessionStore.loadSession(sessionId);
        if (session.engine?.robotId && session.engine.robotId !== execution.robotId) {
            throw new Error('This conversation uses another robot. Open it with that robot, or create a new session.');
        }
        const cwd = await fs.realpath(session.engine?.cwd || session.cwd || workingDir);
        const workspaceRoot = resolveAchillesWorkspaceRoot(cwd, env);
        // One persistent native home per robot. The robot home is mounted
        // writable and used directly, so credentials and native sessions never
        // diverge across a per-project copy.
        const home = await executionHome(env);
        const resumeBackend = validateNativeSession(session, home, cwd);
        const stored = settings.readAchillesSettings?.(cwd) || {};
        const permissionMode = execution.permissions || settings.getPermissionMode?.(cwd) || stored.permissionMode || 'full-access';
        if (!['ask-for-approval', 'full-access'].includes(permissionMode)) throw new Error('Invalid native permission mode.');
        const api = await installed;
        // The robot's coding agent, models and efforts live in ALA's config in
        // the robot home; ALA reads it itself, RoboTeam reads it to know the backend.
        const native = api.loadConfig ? await api.loadConfig(await modelConfigPath(home)) : { models: {}, efforts: {} };
        const models = { ...native.models };
        const efforts = { ...native.efforts };
        const envSnapshot = nativeEnvironment(env, home);
        const agents = await api.discoverCodingAgents({ env: envSnapshot });
        const isInstalled = (name) => agents.some((entry) => entry.name === name && entry.available);
        // A native session resumes only on its own agent; the robot may no longer enable it.
        if (resumeBackend && !isInstalled(resumeBackend)) {
            throw new Error(`This conversation used ${codingAgentLabel(resumeBackend)}, which is not enabled for this robot. Create a new session.`);
        }
        // ALA resumes a conversation on its own agent; otherwise it uses the
        // configured agent, then the first available. An explicit task agent or a
        // conversation bound before its first native turn is passed as --ca.
        const requestedBackend = execution.backend || (!resumeBackend && (session.engine?.backend || session.modelOverride?.backend)) || null;
        const backend = resumeBackend || requestedBackend
            || (isInstalled(native.codingAgent) ? native.codingAgent : agents.find((entry) => entry.available)?.name);
        if (session.modelOverride) {
            if (session.modelOverride.backend !== backend) throw new Error('The session model belongs to another coding agent; reset /model or create a new session.');
            models[backend] = session.modelOverride.model;
            if (session.modelOverride.effort) efforts[backend] = session.modelOverride.effort;
            else delete efforts[backend];
        }
        if (execution.model) {
            if (execution.model !== models[backend]) delete efforts[backend];
            models[backend] = execution.model;
        }
        if (!backend || !isInstalled(backend)) {
            throw new Error(`ALA setup error: coding backend ${backend || 'auto'} is unavailable. Install/configure CODEX_BIN, OPENCODE_BIN, PI_BIN or CLAUDE_BIN and authenticate it in the dedicated ALA home.`);
        }
        return { cwd, home, workspaceRoot, session, resume: Boolean(resumeBackend), backend,
            requestedBackend: resumeBackend ? null : requestedBackend, models, efforts, permissionMode, api, agents, env: envSnapshot };
    }

    async function executeTurn({ sessionId, turnId = randomUUID(), prompt, skillName, context = {}, signal, onEvent, onControl } = {}) {
        const responseStarted = performance.now();
        if (closed) throw new Error('ALA engine is closed.');
        if (typeof prompt !== 'string') throw new TypeError('The turn prompt must be text.');
        context = { ...context,
            resources: structuredClone(context.resources || context.webchatResources || []),
            paths: structuredClone(context.paths || context.webchatPaths || []),
            origin: structuredClone(context.origin || context.webchatOrigin || {}),
            attachments: structuredClone(context.attachments || []),
            references: structuredClone(context.references || []) };
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason || interrupted());
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let finish;
        const operation = { controller, done: new Promise((resolve) => { finish = resolve; }) };
        active.add(operation);
        let release, catalogRelease, turn, scriptContext, child, childDone, failureChannel, forcedFailure;
        const env = { ...process.env };
        const sanitize = createSanitizer(context, env);
        const emit = async (event) => { await onEvent?.(sanitize(event)); };
        try {
            controller.signal.throwIfAborted();
            const robotName = String(process.env.ROBOTEAM_COPILOT_ROBOT_NAME || '').trim();
            await emit({ type: 'progress', reason: robotName ? `Connecting to robot "${robotName}"` : 'Connecting to robot' });
            release = await acquireExecutionLease(workingDir, `session:${sessionId}`);
            const config = await configuration(sessionId, env);
            const { cwd, home, backend, api, permissionMode } = config;
            // Pi has no native ask mode. Reject before transcript or native state creation.
            if (backend === 'pi' && permissionMode === 'ask-for-approval') {
                throw new Error('Pi does not support ask-for-approval; select full-access or use Codex, OpenCode or Claude Code.');
            }
            const snapshot = await skillCatalog.refresh(sessionId, { execution: true, cwd });
            catalogRelease = snapshot.release;
            if (snapshot.revision) await emit({ type: 'skill-catalog', revision: snapshot.revision, policyVersion: snapshot.policyVersion });
            for (const diagnostic of snapshot.diagnostics || []) await emit({ type: 'diagnostic', category: 'skill-catalog', message: `${diagnostic.state}: ${diagnostic.message}` });
            const skills = snapshot.skills.filter((skill) => skill.enabled);
            const selectedSkillName = skillName;
            const selected = selectedSkillName ? skills.find((skill) => skill.name === selectedSkillName) : null;
            if (selectedSkillName && !selected) throw new Error(`Skill "${selectedSkillName}" is missing or disabled.`);
            controller.signal.throwIfAborted();
            turn = await sessionStore.beginTurn({ sessionId, turnId, text: sanitize(context.rawText || prompt),
                attachments: sanitize(context.attachments || []), references: sanitize(context.references || []) });
            await emit({ type: 'turn-started', ...turn, turnId });
            const captured = { ...context, workingDir: cwd, sessionId, turnId,
                assistantMessageId: turn.assistantMessageId, signal: controller.signal,
                resources: structuredClone(context.resources || context.webchatResources || []),
                paths: structuredClone(context.paths || context.webchatPaths || []),
                origin: structuredClone(context.origin || context.webchatOrigin || {}) };
            scriptContext = await createPloinkyTaskContext({ context: captured,
                env, onTask: (task) => backgroundTasks?.observeScriptTask(task, captured) });
            let nativePrompt = buildNativePrompt({ prompt, resume: config.resume,
                selectedSkillName: selected?.name, systemPrompt: execution.systemPrompt });
            controller.signal.throwIfAborted();
            await sessionStore.bindEngine(sessionId, { home, cwd, backend, robotId: execution.robotId });
            // ALA reads defaults from the robot home. Only explicit session or
            // task overrides are passed as arguments; no derived config is written.
            const args = ['--home', home, '--cwd', cwd, '--session-id', sessionId,
                '--turn-id', turnId, '--control-stdin', '--permissions', permissionMode,
                '--ignore', path.resolve(cwd, ACHILLES_PRIVATE_DIRECTORY_NAME)];
            if (config.session.modelOverride || execution.model) {
                args.push('--model', config.models[backend], '--effort', config.efforts[backend] || 'default');
            }
            if (config.requestedBackend) args.push('--ca', config.requestedBackend);
            // The workspace is mounted read-only at its canonical path; the writable
            // cwd is the --cwd grant. ALA mounts exactly what it is given.
            if (config.workspaceRoot !== cwd) args.push('--folder', config.workspaceRoot);
            if (snapshot.skillsDirectory) {
                for (const mount of snapshot.mounts || []) args.push('--folder', mount.source, 'at', mount.target, 'expose');
                args.push('--folder', snapshot.skillsDirectory, 'at', path.join(cwd, '.agents', 'skills'), 'expose');
                const claude = path.join(cwd, '.claude');
                const claudeStat = await fs.lstat(claude).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
                // Existing .claude -> .agents aliases already see the same overlay.
                if (!claudeStat?.isSymbolicLink()) args.push('--folder', snapshot.skillsDirectory, 'at', path.join(claude, 'skills'), 'expose');
                else if (await fs.realpath(claude) !== await fs.realpath(path.join(cwd, '.agents'))) {
                    throw new Error('Project .claude symlink must point to .agents for session skills.');
                }
            }
            args.push('--folder', scriptContext.directory, 'as', 'ploinky-runtime');
            if (env.ROBOTEAM_HUMAN_INPUT_DIRECTORY) args.push('--folder', env.ROBOTEAM_HUMAN_INPUT_DIRECTORY, 'as', 'roboflow-human-input');
            const failureSkill = skills.find(skill => skill.name === 'report-task-blocked');
            if (execution.workflowExecution && failureSkill) {
                args.push('--folder', failureSkill.skillDir, 'as', 'report-task-blocked');
                nativePrompt += '\n\nRead /workspace/report-task-blocked/SKILL.md. Use this required skill if missing resources, access or capabilities prevent fulfilling the agreed task and plan.';
                failureChannel = await createTaskFailureChannel({ request: async ({ message }) => {
                    if (!forcedFailure) {
                        forcedFailure = new Error(sanitize(message));
                        try { await emit({ type: 'task-failed', message: forcedFailure.message }); }
                        finally { controller.abort(forcedFailure); }
                    }
                    return {};
                } });
                args.push('--folder', failureChannel.directory, 'as', 'roboteam-task-failure');
            }

            if (config.resume) args.push('--resume-session');
            if (execution.mcpServers) args.push('--MCPServers', execution.mcpServers);

            const isNode = /\.(?:mjs|cjs|js)$/i.test(api.entryPath);
            await emit({ type: 'progress', reason: 'Starting ALA' });
            child = spawn(isNode ? process.execPath : api.entryPath, isNode ? [api.entryPath, ...args] : args, {
                cwd, env: { ...config.env, ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: alaSessionsRoot(cwd) },
                shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
            // The turn prompt is the first control record: ALA starts the coding
            // agent with `prompt` and records `displayText` as the user's message.
            child.stdin.write(`${JSON.stringify({ type: 'prompt', prompt: sanitize(nativePrompt),
                displayText: sanitize(context.rawText || prompt) })}\n`);
            onControl?.((message) => {
                if (message.type === 'message') message = { ...message, displayText: message.message, message: buildTaskPrompt({ task: message.message }) };
                if (!child.stdin.destroyed && !controller.signal.aborted) child.stdin.write(JSON.stringify(message) + '\n');
            });
            childDone = consumeChild(child, { config: { ...config, skillExecution: snapshot.revision ? { revision: snapshot.revision, catalogId: snapshot.catalogId } : null }, controller, context: captured, sessionId, turnId,
                assistantMessageId: turn.assistantMessageId, emit, sanitize });
            const outputText = await childDone;
            if (failureChannel) {
                await failureChannel.close();
                failureChannel = null;
            }
            if (forcedFailure) throw forcedFailure;
            if (scriptContext) {
                const completedContext = scriptContext;
                scriptContext = null;
                await completedContext.close();
            }
            controller.signal.throwIfAborted();
            let finalText = outputText;
            let thinkingUrl = '';
            if (captured.sourceTabId && webchatLogsBase && execution.captureTurnLogs !== false) {
                const recorded = readAlaSession(cwd, sessionId)?.turns.find((entry) => entry.turnId === turnId);
                if (recorded?.messages.length || recorded?.tools.length) {
                    thinkingUrl = webchatTurnLogUrl(webchatLogsBase, sessionId, turn.assistantMessageId);
                    finalText = `${outputText}\n\n[View Thinking](${thinkingUrl})`;
                }
            }
            const completed = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, outputText,
                { durationMs: Math.max(0, Math.round(performance.now() - responseStarted)), thinkingUrl });
            return { outputText: finalText, session: completed, turnId, userMessageId: turn.userMessageId,
                assistantMessageId: turn.assistantMessageId, backend };
        } catch (cause) {
            const cancelled = !forcedFailure && (controller.signal.aborted || cause?.exitCode === 130);
            const error = forcedFailure || (cancelled ? interrupted() : new Error(sanitize(cause?.message || String(cause)), { cause }));
            if (!cancelled && !forcedFailure && cause?.exitCode !== undefined) error.exitCode = cause.exitCode;
            if (turn) {
                error.session = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, error.message,
                    { status: cancelled ? 'interrupted' : 'failed', durationMs: Math.max(0, Math.round(performance.now() - responseStarted)) });
                error.turnId = turnId;
                error.assistantMessageId = turn.assistantMessageId;
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            interactions?.cancelTurn(turnId);
            try {
                if (childDone) await childDone.catch(() => {});
                await failureChannel?.close();
                if (scriptContext) await scriptContext.close();
            } finally {
                try { await catalogRelease?.(); } finally { try { await release?.(); } finally { active.delete(operation); finish(); } }
            }
        }
    }

    async function consumeChild(child, { config, controller, context, sessionId, turnId, emit, sanitize }) {
        let stdout = '', stderr = '', diagnostics = '', finalText = null, selected = false, protocolError = null;
        let queued = Promise.resolve();
        let remainingFinals = 1;
        let killTimer;
        let settled = false;
        const pendingRequests = new Set();
        const decoder = new StringDecoder('utf8');
        const outputDecoder = new StringDecoder('utf8');
        const sendSignal = (name) => {
            if (!child.pid) return;
            try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        };
        const stop = () => {
            if (settled) return;
            sendSignal('SIGINT');
            killTimer ??= setTimeout(() => sendSignal('SIGKILL'), 3000);
            killTimer.unref();
        };
        const fail = (error) => { if (!settled) { protocolError ||= error; stop(); } };
        const reply = (id, optionId) => {
            if (!pendingRequests.delete(id) || settled || child.stdin.destroyed || controller.signal.aborted) return;
            child.stdin.write(`${JSON.stringify({ type: 'interaction-response', id,
                ...(optionId === null ? { cancelled: true } : { optionId }) })}\n`);
        };
        const handle = async (event) => {
            // The wrapper publishes the policy applied to this turn. A pinned envelope may carry an older policy version.
            if (event.type === 'skill-catalog' && config.skillExecution) {
                if (/^[a-f0-9]{64}$/.test(config.skillExecution.catalogId) && event.revision !== config.skillExecution.revision) throw new Error('ALA received a different execution catalog revision.');
                return;
            }
            if (!event || typeof event.type !== 'string') throw new Error('Malformed mandatory ALA event.');
            if (event.type === 'coding-agent-selected') {
                if (event.agent !== config.backend || event.permissionMode !== config.permissionMode) throw new Error('ALA selected an unexpected backend or permission policy.');
                selected = true;
                event = { ...event, effort: config.efforts[config.backend] || null };
                await sessionStore.bindEngine(sessionId, { home: config.home, cwd: config.cwd, backend: event.agent, robotId: execution.robotId });
            } else if (event.type === 'coding-agent-final') {
                if (remainingFinals <= 0 || event.agent !== config.backend || typeof event.message !== 'string') throw new Error('Malformed or duplicate ALA final event.');
                remainingFinals--;
                finalText = event.message;
            } else if (event.type === 'message-accepted' && event.delivery === 'queued') {
                remainingFinals++;
            } else if (event.type === 'session-ready' && event.sessionId !== sessionId) {
                throw new Error('ALA returned a different conversation UUID.');
            } else if (event.type === 'coding-agent-request') {
                if (typeof event.id !== 'string' || event.agent !== config.backend || event.kind !== 'permission'
                    || !Array.isArray(event.options) || !event.options.length
                    || event.options.some((option) => typeof option.id !== 'string' || typeof option.label !== 'string')) {
                    throw new Error('Malformed mandatory ALA permission request.');
                }
                if (pendingRequests.has(event.id)) throw new Error('Duplicate native permission request ID.');
                pendingRequests.add(event.id);
                Promise.resolve().then(() => interactions?.request(sanitize(event), { context, signal: controller.signal, turnId }) ?? null)
                    .then((optionId) => {
                        if (optionId !== null && !event.options.some((option) => option.id === optionId)) throw new Error('Unadvertised native permission response.');
                        reply(event.id, optionId);
                    }).catch(fail);
            } else if (event.type === 'coding-agent-request-resolved') {
                pendingRequests.delete(event.id);
                interactions?.resolve(event.id, event.reason);
            }
            // ALA records coding-agent output in its transcript. Progress is delivered as a transient WebChat status, never persisted on the message.
            await emit(event);
        };
        const line = (value) => {
            if (protocolError) return;
            if (value.length > 1024 * 1024) { fail(new Error('ALA event record exceeded the 1 MiB limit.')); return; }
            if (!value.startsWith(EVENT_PREFIX)) {
                diagnostics = (diagnostics + sanitize(value) + '\n').slice(-32768);
                if (value.trim()) queued = queued.then(() => emit({ type: 'diagnostic', message: sanitize(value) })).catch(fail);
                return;
            }
            let event;
            try { event = JSON.parse(value.slice(EVENT_PREFIX.length)); } catch { fail(new Error('Malformed mandatory ALA event JSON.')); return; }
            queued = queued.then(() => handle(event)).catch(fail);
        };
        controller.signal.addEventListener('abort', stop, { once: true });
        child.stdin.on('error', (error) => { if (!controller.signal.aborted && error.code !== 'EPIPE') fail(error); });
        child.stdout.on('data', (chunk) => {
            if (protocolError) return;
            stdout += outputDecoder.write(chunk);
            if (stdout.length > MAX_OUTPUT) fail(new Error('ALA final output exceeded the 16 MiB limit.'));
        });
        child.stderr.on('data', (chunk) => {
            if (protocolError) return;
            stderr += decoder.write(chunk);
            let end;
            while ((end = stderr.indexOf('\n')) !== -1) { const value = stderr.slice(0, end).replace(/\r$/, ''); stderr = stderr.slice(end + 1); line(value); }
            if (stderr.length > 1024 * 1024) fail(new Error('ALA event record exceeded the 1 MiB limit.'));
        });
        if (controller.signal.aborted) stop();
        let outcome;
        try {
            outcome = await new Promise((resolve) => {
                child.once('error', (error) => { protocolError ||= error; });
                child.once('close', (code, signal) => resolve({ code, signal }));
            });
            stdout += outputDecoder.end();
            stderr += decoder.end();
            if (stderr) line(stderr);
            await queued;
        } finally {
            settled = true;
            pendingRequests.clear();
            clearTimeout(killTimer);
            controller.signal.removeEventListener('abort', stop);
            interactions?.cancelTurn(turnId);
        }
        if (controller.signal.aborted) throw controller.signal.reason || interrupted();
        if (protocolError) throw protocolError;
        if (outcome.code === 130) throw interrupted();
        if (outcome.code !== 0) throw Object.assign(new Error(`ALA execution failed (${outcome.code ?? outcome.signal}).${diagnostics.trim() ? `\n${diagnostics.trim()}` : ''}`), { exitCode: outcome.code });
        if (!selected || finalText === null || !stdout.trim() || stdout.trimEnd() !== finalText.trimEnd()) {
            throw new Error('ALA completed without a valid matching native final result.');
        }
        validateNativeSession(sessionStore.loadSession(sessionId), config.home, config.cwd);
        return sanitize(stdout.trimEnd());
    }

    return Object.freeze({
        executeTurn,
        async getModel({ sessionId } = {}) {
            const config = await configuration(sessionId, { ...process.env });
            return { backend: config.backend, model: config.models[config.backend] || null,
                effort: config.efforts[config.backend] || null };
        },
        async setModel({ sessionId, backend, model, effort = null } = {}) {
            const config = await configuration(sessionId, { ...process.env });
            if (backend !== config.backend) throw new Error('The conversation backend changed; reload /model.');
            await sessionStore.updateSession(sessionId, session => {
                if (model === null) delete session.modelOverride;
                else session.modelOverride = { backend, model, effort };
            });
            const updated = await configuration(sessionId, { ...process.env });
            return { backend: updated.backend, model: updated.models[updated.backend] || null, effort: updated.efforts[updated.backend] || null };
        },
        async listModels({ sessionId, signal } = {}) {
            if (closed) throw new Error('ALA engine is closed.');
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            let finish, service;
            const operation = { controller, done: new Promise((resolve) => { finish = resolve; }) };
            active.add(operation);
            try {
                controller.signal.throwIfAborted();
                const config = await configuration(sessionId, { ...process.env });
                controller.signal.throwIfAborted();
                service = config.api.createCodingAgentService({ agents: config.agents, workspace: config.cwd,
                    cwd: config.cwd, home: config.home, env: config.env, models: config.models });
                return { backend: config.backend, models: await service.listModels(config.backend, { signal: controller.signal, details: true }),
                    model: config.models[config.backend] || null, effort: config.efforts[config.backend] || null };
            } finally {
                signal?.removeEventListener('abort', abort);
                try { await service?.close(); } finally { active.delete(operation); finish(); }
            }
        },
        async close() {
            closed = true;
            const operations = [...active];
            for (const operation of operations) operation.controller.abort(interrupted());
            await Promise.all(operations.map((operation) => operation.done));
        },
    });
}
