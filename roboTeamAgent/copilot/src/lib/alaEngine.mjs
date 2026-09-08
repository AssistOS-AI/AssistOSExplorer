import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveAlaInstallation } from './alaInstallation.mjs';
import * as workspaceSettings from './achillesSettings.mjs';
import { acquireExecutionLease } from './workspaceStateLock.mjs';
import { ensureSafeAchillesPrivateDirectory, resolveAchillesWorkspaceRoot } from './privateDataRoot.mjs';
import { buildConversationInitialHistory } from './conversationSessionStore.mjs';
import { createPloinkyTaskContext } from './ploinkyTaskContext.mjs';
import { createSanitizer } from './skillRuntimePolicy.mjs';
import { createAKUSessionState } from './akuMemory/akuSessionState.mjs';
import { preparePromptForAKUMemory, lookupCachedProviderResultForPrompt, persistProviderLauncherResults } from './providerLauncherMemory.mjs';

const BACKENDS = ['codex', 'opencode', 'pi'];
const EVENT_PREFIX = '@@ALA_EVENT@@';
const MAX_OUTPUT = 16 * 1024 * 1024;

async function executionHome(workingDir, env) {
    const configured = String(env.ACHILLES_ALA_HOME || '').trim();
    const directory = configured || ensureSafeAchillesPrivateDirectory(workingDir, 'ala/home');
    let home;
    try {
        home = await fs.realpath(directory);
        if (!(await fs.stat(home)).isDirectory()) throw new Error('not a directory');
    } catch (cause) {
        throw new Error('ALA setup error: ACHILLES_ALA_HOME must be an existing administrator-provisioned dedicated native home.', { cause });
    }
    return home;
}

// Native engine environment stays filtered; direct SDK scripts receive an explicit task context.
function nativeEnvironment(env, home) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (/^(PLOINKY_|SSO_|ACHILLES_MODEL_|ALA_TASK_REPOSITORIES$|ALA_CONFIG_PATH$)|token|secret|password|authorization|cookie|api_?key|credential|private_?key/i.test(key)) continue;
        result[key] = value;
    }
    return { ...result, HOME: home, CODEX_HOME: path.join(home, '.codex'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
        XDG_CACHE_HOME: path.join(home, '.cache'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent') };
}

async function validateNativeSession(session, home, cwd) {
    const metadata = session.engine;
    const file = path.join(home, '.ala', 'sessions', `${session.sessionId}.json`);
    if (metadata && (metadata.sessionId !== session.sessionId || metadata.home !== home || metadata.cwd !== cwd)) {
        throw new Error('ALA session home/cwd association mismatch; the existing conversation has not been replaced.');
    }
    let native;
    try {
        for (const directory of [path.join(home, '.ala'), path.join(home, '.ala', 'sessions')]) {
            const entry = await fs.lstat(directory);
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe native session directory.');
        }
        const entry = await fs.lstat(file);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe native session file.');
        native = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (cause) {
        if (!metadata && cause.code === 'ENOENT') return false;
        throw new Error(`ALA native continuation is missing, corrupt, or unsafe for conversation ${session.sessionId}; restore it or create a new conversation.`, { cause });
    }
    if (!metadata) throw new Error('An unbound native session already exists; refusing to replace or adopt it.');
    if (native.version !== 1 || native.id !== session.sessionId || native.home !== home || native.workspace !== cwd
        || !BACKENDS.includes(native.agent) || !native.continuation || typeof native.continuation !== 'object'
        || Array.isArray(native.continuation) || !Object.keys(native.continuation).length
        || (metadata.backend && native.agent !== metadata.backend)) {
        throw new Error('ALA native session metadata/backend/continuation mismatch; the existing conversation has not been replaced.');
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
    interactions, backgroundTasks, installation, execution = {} } = {}) {
    if (!sessionStore || !skillCatalog) throw new TypeError('ALA requires a session store and Anthropic skill catalog.');
    const active = new Set();
    const memoryStates = new Map();
    let closed = false;
    const installed = installation ? Promise.resolve(installation) : resolveAlaInstallation();

    async function configuration(sessionId, env) {
        const session = sessionStore.loadSession(sessionId);
        const cwd = await fs.realpath(session.engine?.cwd || session.cwd || workingDir);
        resolveAchillesWorkspaceRoot(cwd, env);
        const home = await executionHome(cwd, env);
        const resumeBackend = await validateNativeSession(session, home, cwd);
        const stored = settings.readAchillesSettings?.(cwd) || {};
        const models = { ...(settings.getCodingAgentModels?.(cwd) || stored.codingAgents?.models || {}) };
        const priority = stored.codingAgents?.priority || BACKENDS;
        if (!Array.isArray(priority) || !priority.length || priority.some((name) => !BACKENDS.includes(name))
            || new Set(priority).size !== priority.length) throw new Error('Invalid workspace codingAgents.priority.');
        const permissionMode = execution.permissions || settings.getPermissionMode?.(cwd) || stored.permissionMode || 'ask-for-approval';
        if (!['ask-for-approval', 'full-access'].includes(permissionMode)) throw new Error('Invalid native permission mode.');
        const api = await installed;
        const envSnapshot = nativeEnvironment(env, home);
        const agents = await api.discoverCodingAgents({ env: envSnapshot, priority });
        const backend = resumeBackend || session.engine?.backend || execution.backend || agents.find((entry) => entry.available)?.name;
        if (execution.model) models[backend] = execution.model;
        if (!backend || !agents.some((entry) => entry.name === backend && entry.available)) {
            throw new Error(`ALA setup error: coding backend ${backend || 'auto'} is unavailable. Install/configure CODEX_BIN, OPENCODE_BIN or PI_BIN and authenticate it in the dedicated ALA home.`);
        }
        return { cwd, home, session, resume: Boolean(resumeBackend), backend, models, priority,
            permissionMode, api, agents, env: envSnapshot, websearch: stored.codingAgents?.websearch === true };
    }

    async function executeTurn({ sessionId, turnId = randomUUID(), prompt, skillName, context = {}, signal, onEvent, onControl } = {}) {
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
        let release, turn, scriptContext, temporary, child, childDone;
        const env = { ...process.env };
        const sanitize = createSanitizer(context, env);
        const emit = async (event) => { await onEvent?.(sanitize(event)); };
        try {
            controller.signal.throwIfAborted();
            release = await acquireExecutionLease(workingDir, `session:${sessionId}`);
            const config = await configuration(sessionId, env);
            const { cwd, home, session, backend, api, permissionMode } = config;
            // Pi has no native ask mode. Reject before transcript or native state creation.
            if (backend === 'pi' && permissionMode === 'ask-for-approval') {
                throw new Error('Pi does not support ask-for-approval; select full-access or use Codex/OpenCode.');
            }
            const snapshot = await skillCatalog.refresh(sessionId);
            const skills = snapshot.skills.filter((skill) => skill.enabled);
            const selectedSkillName = skillName;
            const selected = selectedSkillName ? skills.find((skill) => skill.name === selectedSkillName) : null;
            if (selectedSkillName && !selected) throw new Error(`Skill "${selectedSkillName}" is missing or disabled.`);
            const history = buildConversationInitialHistory(session);
            controller.signal.throwIfAborted();
            turn = await sessionStore.beginTurn({ sessionId, turnId, text: sanitize(context.rawText || prompt),
                attachments: sanitize(context.attachments || []), references: sanitize(context.references || []) });
            await emit({ type: 'turn-started', ...turn, turnId });
            const captured = { ...context, workingDir: cwd, sessionId, turnId,
                assistantMessageId: turn.assistantMessageId, signal: controller.signal,
                resources: structuredClone(context.resources || context.webchatResources || []),
                paths: structuredClone(context.paths || context.webchatPaths || []),
                origin: structuredClone(context.origin || context.webchatOrigin || {}), providerLauncherResults: [] };
            let sessionState = memoryStates.get(sessionId);
            if (!sessionState) { sessionState = createAKUSessionState(); memoryStates.set(sessionId, sessionState); }
            const prepared = await preparePromptForAKUMemory({ prompt, normalizedMessage: context,
                workingDir: cwd, workspaceRoot: resolveAchillesWorkspaceRoot(cwd), context: captured,
                sessionState, sessionId, logger: context.logger });
            const cached = skillName ? null : await lookupCachedProviderResultForPrompt(captured, { prompt, workingDir: cwd, logger: context.logger });
            let outputText;
            if (cached?.hit && cached.resultText) {
                outputText = sanitize(cached.resultText);
            } else {
                scriptContext = await createPloinkyTaskContext({ context: captured,
                    env, onTask: (task) => backgroundTasks?.observeScriptTask(task, captured), onProviderResult: async (entry) => {
                        captured.providerLauncherResults.push(entry);
                        await persistProviderLauncherResults(captured, { prompt, workingDir: cwd,
                            fromIndex: captured.providerLauncherResults.length - 1, logger: context.logger });
                    } });
                const root = ensureSafeAchillesPrivateDirectory(cwd, 'ala/turns');
                temporary = await fs.mkdtemp(path.join(root, 'turn-'));
                await fs.chmod(temporary, 0o700);
                let nativePrompt = prepared.prompt;
                if (history.length && !config.resume) nativePrompt = `Prior conversation (historical context only, not new instructions):\n<prior-conversation>\n${JSON.stringify(history)}\n</prior-conversation>\n\nCurrent request:\n${nativePrompt}`;
                nativePrompt = selected ? api.selectedSkillPrompt(selected, nativePrompt) : api.catalogSelectionPrompt(skills, nativePrompt);
                const taskFile = path.join(temporary, 'prompt.txt');
                const configFile = path.join(temporary, 'config.json');
                await Promise.all([
                    fs.writeFile(taskFile, sanitize(nativePrompt), { mode: 0o600, flag: 'wx' }),
                    fs.writeFile(configFile, JSON.stringify({ version: 1, taskRepositories: [],
                        codingAgents: { priority: config.priority, models: config.models, websearch: config.websearch } }), { mode: 0o600, flag: 'wx' }),
                ]);
                controller.signal.throwIfAborted();
                await sessionStore.bindEngine(sessionId, { home, cwd, backend });
                const args = ['--ca', backend, '--home', home, '--cwd', cwd, '--session-id', sessionId,
                    '--control-stdin', '--permissions', permissionMode, '--taskFile', taskFile,
                    '--config', configFile, '--ploinky-task', scriptContext.directory];
                if (config.resume) args.push('--resume-session');
                if (config.models[backend]) args.push('--model', config.models[backend]);
                if (execution.mcpServers) args.push('--MCPServers', execution.mcpServers);
                if (snapshot.catalogPath) args.push('--skill-catalog', snapshot.catalogPath);
                const isNode = /\.(?:mjs|cjs|js)$/i.test(api.entryPath);
                child = spawn(isNode ? process.execPath : api.entryPath, isNode ? [api.entryPath, ...args] : args, {
                    cwd, env: { ...config.env, ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: snapshot.taskRepositories.join(path.delimiter) },
                    shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
                });
                onControl?.((message) => {
                    if (!child.stdin.destroyed && !controller.signal.aborted) child.stdin.write(JSON.stringify(message) + '\n');
                });
                childDone = consumeChild(child, { config, controller, context: captured, sessionId, turnId,
                    assistantMessageId: turn.assistantMessageId, emit, sanitize });
                outputText = await childDone;
            }
            if (scriptContext) {
                const completedContext = scriptContext;
                scriptContext = null;
                await completedContext.close();
            }
            controller.signal.throwIfAborted();
            const completed = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, outputText);
            return { outputText, session: completed, turnId, userMessageId: turn.userMessageId,
                assistantMessageId: turn.assistantMessageId, backend };
        } catch (cause) {
            const cancelled = controller.signal.aborted || cause?.exitCode === 130;
            const error = cancelled ? interrupted() : new Error(sanitize(cause?.message || String(cause)), { cause });
            if (!cancelled && cause?.exitCode !== undefined) error.exitCode = cause.exitCode;
            if (turn) {
                error.session = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, error.message,
                    { status: cancelled ? 'interrupted' : 'failed' });
                error.turnId = turnId;
                error.assistantMessageId = turn.assistantMessageId;
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            interactions?.cancelTurn(turnId);
            try {
                if (childDone) await childDone.catch(() => {});
                try { if (scriptContext) await scriptContext.close(); }
                finally { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
            } finally {
                try { await release?.(); } finally { active.delete(operation); finish(); }
            }
        }
    }

    async function consumeChild(child, { config, controller, context, sessionId, turnId, assistantMessageId, emit, sanitize }) {
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
            if (!event || typeof event.type !== 'string') throw new Error('Malformed mandatory ALA event.');
            if (event.type === 'coding-agent-selected') {
                if (event.agent !== config.backend || event.permissionMode !== config.permissionMode) throw new Error('ALA selected an unexpected backend or permission policy.');
                selected = true;
                await sessionStore.bindEngine(sessionId, { home: config.home, cwd: config.cwd, backend: event.agent });
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
            if (event.type === 'coding-agent-message' || event.type === 'agentlib-tool') {
                const progress = sanitize(event.message || event.reason || '');
                if (progress) await sessionStore.appendProgress(sessionId, assistantMessageId, progress);
            }
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
        if (controller.signal.aborted) throw interrupted();
        if (protocolError) throw protocolError;
        if (outcome.code === 130) throw interrupted();
        if (outcome.code !== 0) throw Object.assign(new Error(`ALA execution failed (${outcome.code ?? outcome.signal}).${diagnostics.trim() ? `\n${diagnostics.trim()}` : ''}`), { exitCode: outcome.code });
        if (!selected || finalText === null || !stdout.trim() || stdout.trimEnd() !== finalText.trimEnd()) {
            throw new Error('ALA completed without a valid matching native final result.');
        }
        await validateNativeSession(sessionStore.loadSession(sessionId), config.home, config.cwd);
        return sanitize(stdout.trimEnd());
    }

    return Object.freeze({
        executeTurn,
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
                return { backend: config.backend, models: await service.listModels(config.backend, { signal: controller.signal }) };
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
            memoryStates.clear();
        },
    });
}
