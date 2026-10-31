import fs from 'node:fs/promises';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildNativePrompt, buildTaskPrompt } from '../prompts.mjs';
import * as workspaceSettings from '../config/achillesSettings.mjs';
import { acquireExecutionLease } from '../storage/workspaceStateLock.mjs';
import { errorFields, logDiagnostic } from '../storage/copilotDiagnostics.mjs';
import { ACHILLES_PRIVATE_DIRECTORY_NAME, resolveAchillesWorkspaceRoot } from '../storage/privateDataRoot.mjs';
import { createSanitizer } from '../skillRuntimePolicy.mjs';
import { createLiveTurn } from '../liveSessions/liveTurn.mjs';
import { ALA_BACKENDS, createAlaRecordHandler } from './alaRecordHandler.mjs';
import { STOP_NOT_AUTHORIZED_MESSAGE, detachReason, isDetach, stopReason } from './abortReasons.mjs';
import { isGrantableFolder } from './grantablePaths.mjs';
import { workspaceCodePath } from './workspaceCodePath.mjs';
import { TERMINAL_STATES, WorkerError, stopOperationId } from '../../../../server/worker-coordinator/worker-client.mjs';
import { isOriginId } from '../../../../server/worker-coordinator/identities.mjs';
import { plainStopMessage } from '../../../../server/worker-coordinator/stop-reasons.mjs';

// The worker cutover seam (RoboWork r10 decision M-5). `createWorkerEngine` has alaEngine's public
// interface (`executeTurn`, `getModel`, `setModel`, `listModels`, `close`) but starts no process:
// it builds the same native prompt and ALA inputs, admits them to the worker as a version-2
// admission specification, follows the reference's events and feeds the relayed ALA records
// through the same record handler alaEngine uses, so the streaming events are identical.
//
// A worker failure is an explicit error. There is no fallback to a local ALA run.
//
// Detaching is not stopping (plan sections 9 and 10.2): an abort whose reason is a detach reason
// (RoboTeam shutdown, engine close) stops following and leaves the worker execution running; any
// other abort is the user's stop and is sent to the worker as a `stop` control.
//
// No follow-up bearer credential (decision M-12). An interactive turn opens ONE event subscription
// with the admission grant; if the stream drops it is reattached from its cursor with the next fresh
// grant the user supplies (a later verified envelope), never with a stored or reused one. Each user
// control (stop, message) carries the grant of the request that asked for it. A RoboFlow phase runs
// on the background row: the coordinator identity and its persisted binding authorize its reads,
// events and system-initiated stop, with no user grant.

export const SPEC_VERSION = 2;
const EVENTS_PAGE = 500;
const POLL_MIN_MS = 200;
const POLL_MAX_MS = 2000;
const READ_EVERY_MS = 2000;
const STOP_WAIT_MS = 20000;
const TRANSIENT_WAIT_MS = 60000;
// Reads are idempotent: these answers (a lost reply, an unreachable or refused route, a restarting
// worker) say nothing about the execution, which keeps running on the worker.
const TRANSIENT_CODES = new Set(['worker_stream_dropped', 'worker_reply_unknown', 'worker_unreachable', 'worker_route_unavailable', 'worker_coordinator_unavailable', 'runtime_unavailable']);
const LOOPBACK_MCP = /\bhttps?:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])[:/]/iu;
const EVIDENCE_WAIT_MS = 60000;
// The conversation records its engine binding against this neutral directory: the robot HOME is
// the worker's (decision M-10), and no RoboTeam path is bound or sent.
const WORKER_SESSION_HOME = '/';
// Where every workload sees the worker-hosted channels of its execution (read-only).
const CHANNELS_ROOT = '/run/robo-work/channels';

// Soul Gateway models (`soul-gateway/<id>`, matched case-insensitively) run in the worker only on OpenCode: the worker hosts a model channel
// for them (decision M-26; robo-work/server/runtime/modelChannel.mjs) with its own Soul Gateway identity, and nothing is written to the robot
// HOME. Codex, Claude and Pi have no such channel, so for them the turn is refused here, before admission, and never replaced by the free default.
const isGatewayModel = (model) => typeof model === 'string' && /^soul-gateway\//iu.test(model.trim());

function modelRefusal(model, backend) {
    const error = new WorkerError('model_unavailable_in_worker', 400);
    error.message = `model_unavailable_in_worker: the model "${model}" is served through Soul Gateway, which the worker offers to OpenCode only, not to ${backend}. Choose another model with /model, or /model default for the default model.`;
    return error;
}

// The refusal of a workspace-root working folder, with the message the user sees.
function rootRefusal() {
    const error = new WorkerError('workspace_root_not_granted', 400);
    error.message = 'workspace_root_not_granted: the workspace root cannot be used as a working folder. Pick a project folder inside it, or start without one.';
    return error;
}

// What the chat shows when a stop could not be delivered: the task may still be running, and pressing stop again retries.
function stopNotDelivered(code) {
    return code === 'worker_stop_not_authorized'
        ? STOP_NOT_AUTHORIZED_MESSAGE
        : `Stop not delivered (${code}). The task may still be running; press stop again.`;
}

function interrupted() {
    return Object.assign(new Error('Execution interrupted.'), { name: 'AbortError', code: 'ABORT_ERR', exitCode: 130 });
}

function liveTitle(text) {
    const first = String(text || '').trim().split(/\r?\n/u)[0].trim();
    return first ? `Copilot · ${first.length > 120 ? `${first.slice(0, 119)}…` : first}` : 'Copilot turn';
}

// 22 base64url characters, deterministic in its parts: a retried control is the same operation.
const controlOperationId = (...parts) => crypto.createHash('sha256').update(`roboteam/control/v1\n${parts.join('\n')}`).digest('base64url').slice(0, 22);

function jwtExpiry(grant) {
    try { return Number(JSON.parse(Buffer.from(String(grant).split('.')[1], 'base64url').toString('utf8')).exp) * 1000; } catch { return NaN; }
}

// One event row of `references/<id>/events`, in the contract form `{seq, at, kind, ...}`. The
// worker's current state-only rows `{sequence, at, type, data}` are read the same way.
export function normalizeEventRow(row) {
    const kind = row?.kind ?? row?.type;
    const data = row?.data && typeof row.data === 'object' ? row.data : {};
    const sequence = row?.seq ?? row?.sequence;
    if (kind === 'ala') return { sequence, kind, record: row.record ?? data.record ?? data };
    if (kind === 'truncated') return { sequence, kind, dropped: row.dropped ?? data.dropped ?? null, reason: row.reason ?? data.reason ?? 'bound' };
    if (kind === 'state') return { sequence, kind, state: row.state ?? data.state, result: row.result ?? data.result };
    // Channel events the worker records for the skills' callbacks (decision M-14).
    if (kind === 'task-failed') return { sequence, kind, message: row.message ?? data.message };
    if (kind === 'human-input-request') return { sequence, kind, requestId: row.requestId ?? data.requestId, question: row.question ?? data.question, options: row.options ?? data.options };
    if (kind === 'human-input-answered') return { sequence, kind, requestId: row.requestId ?? data.requestId };
    return { sequence, kind: 'unknown' };
}

export function createWorkerEngine({ workingDir, sessionStore, skillCatalog, settings = workspaceSettings, interactions, execution = {},
    webchatLogsBase = '', livePublisher = null, client, provisioner, getRobot, sleep = delay, evidenceWaitMs = EVIDENCE_WAIT_MS,
    stopWaitMs = STOP_WAIT_MS, transientWaitMs = TRANSIENT_WAIT_MS, pollMinMs = POLL_MIN_MS, pollMaxMs = POLL_MAX_MS } = {}) {
    if (!sessionStore || !skillCatalog) throw new TypeError('The worker engine requires a session store and Anthropic skill catalog.');
    if (!client || !provisioner || typeof getRobot !== 'function') throw new TypeError('The worker engine requires a worker client, a robot provisioner and a robot reader.');
    const active = new Set();
    let closed = false;

    const usable = (evidence) => {
        if (evidence?.ok !== true || typeof evidence.grant !== 'string' || !evidence.grant) return false;
        const expiry = jwtExpiry(evidence.grant);
        return !Number.isFinite(expiry) || Date.now() < expiry - 1000;
    };

    // The owner evidence of one turn: a WebChat envelope's verified grant (coordinator-API row), or the
    // flow binding of a RoboFlow phase (background row). Anything else has no evidence at all.
    function authorityFor(owner) {
        // A task child started by `/api/control` holds only the one grant its parent handed it over stdin: it
        // admits with it at once (a task admission under a deterministic origin) and never keeps it.
        if (!owner?.coordinator && owner?.evidence?.ok === true && owner.evidence.grant) {
            const base = owner.evidence;
            const origin = execution.worker?.originRequestId;
            if (!isOriginId(origin)) throw new WorkerError('owner_evidence_unavailable', 403);
            return { mode: 'grant', direct: true, originRequestId: origin, principal: base.principal, best: () => (usable(base) ? base : null) };
        }
        if (owner?.coordinator && owner.evidence?.ok === true && owner.evidence.grant) {
            const base = owner.evidence;
            return {
                mode: 'grant', principal: base.principal,
                // The newest unexpired evidence the user's own envelopes have supplied: a later envelope of
                // this principal, else the turn's own.
                best: () => [owner.freshest?.(base.principal), base].find(usable) ?? null,
            };
        }
        const binding = execution.worker;
        if (binding?.bindingId && isOriginId(binding.originRequestId)) return { mode: 'binding', bindingId: binding.bindingId, originRequestId: binding.originRequestId };
        throw new WorkerError('owner_evidence_unavailable', 403);
    }

    // The auth of a request that is not itself a user control: provisioning, admission, a stream
    // (re)attach, the result read. The newest unexpired grant; a grant lives 30 seconds, so a request
    // arriving later waits (bounded) for the user's next envelope, then ends with a named error. The
    // worker keeps running the execution meanwhile.
    async function grantFor(authority, { signal, wait = evidenceWaitMs } = {}) {
        if (authority.mode === 'binding') return { bindingId: authority.bindingId };
        const deadline = Date.now() + wait;
        for (;;) {
            const evidence = authority.best();
            if (evidence) return { grant: evidence.grant };
            if (Date.now() >= deadline) throw new WorkerError('owner_evidence_expired', 403);
            if (signal?.aborted) throw signal.reason;
            await sleep(500);
        }
    }

    // A user control carries the grant of the request that asked for it (decision M-12 (b)). A
    // background-row stop is system-initiated and carries the coordinator identity and the binding.
    function controlAuth(authority, evidence, { user = true } = {}) {
        if (usable(evidence)) return { grant: evidence.grant };
        if (authority.mode === 'binding' && !user) return { bindingId: authority.bindingId };
        throw new WorkerError('owner_evidence_unavailable', 403);
    }

    async function admit({ authority, owner, auth, robotId, configRevision, sessionId, specification }) {
        if (authority.mode === 'binding' || authority.direct) {
            return client.admit({ originRequestId: authority.originRequestId, robotId, configRevision, kind: 'task', specification }, auth);
        }
        // The evidence is the newest unexpired one: provisioning may have outlived the first grant.
        const evidence = { ...owner.evidence, grant: auth.grant };
        const result = await owner.coordinator.admitTurn(evidence, { conversationId: sessionId, robotId, configRevision, specification });
        if (result.status === 200) return { referenceId: result.body?.taskRef?.id, state: result.body?.state, originRequestId: result.body?.originRequestId };
        // A lost reply: the origin is persisted (the shim settles its row on a later envelope); one lookup
        // with the same grant recovers the reference now.
        if (result.body?.error === 'worker_reply_unknown' && result.body.originRequestId) {
            const found = await client.lookup(result.body.originRequestId, auth).catch(() => null);
            if (found?.referenceId) return { ...found, originRequestId: result.body.originRequestId };
        }
        const { error, ...extra } = result.body || {};
        throw new WorkerError(typeof error === 'string' ? error : 'worker_reply_unknown', result.status || 503, extra);
    }

    // The one-agent robot's model and effort from the worker's robot configuration.
    function seedModels(configuration) {
        const configured = ALA_BACKENDS.includes(configuration?.backend) ? configuration.backend : null;
        const plural = Object.fromEntries(Object.entries(configuration?.settings?.models || {}).filter(([name, model]) => ALA_BACKENDS.includes(name) && typeof model === 'string' && model));
        return {
            configured,
            models: { ...plural, ...(configured && configuration.settings?.model ? { [configured]: configuration.settings.model } : {}) },
            efforts: configured && configuration.settings?.effort ? { [configured]: configuration.settings.effort } : {},
        };
    }

    async function modelState(sessionId) {
        const session = sessionStore.loadSession(sessionId);
        const robot = await getRobot();
        const desired = provisioner.desiredConfiguration(robot);
        let configuration = desired;
        if (robot.worker?.robotId) {
            // What the worker reports is authoritative; the old RoboTeam HOME is never read.
            configuration = (await client.getRobot(robot.worker.robotId, {})).configuration || desired;
        }
        const { configured, models, efforts } = seedModels(configuration);
        const backend = session.engine?.backend || session.modelOverride?.backend || configured;
        if (session.modelOverride && session.modelOverride.backend === backend) {
            models[backend] = session.modelOverride.model;
            if (session.modelOverride.effort) efforts[backend] = session.modelOverride.effort; else delete efforts[backend];
        }
        // Where the shown model comes from: the conversation's own choice, the robot's chosen model, or the default.
        const source = backend && models[backend] ? (session.modelOverride?.backend === backend ? 'selected'
            : (configuration.settings?.modelSource === 'default' ? 'default' : 'selected')) : null;
        return { session, backend, models, efforts, configuration, source };
    }

    async function executeTurn({ sessionId, turnId = randomUUID(), prompt, skillName, context = {}, signal, onEvent, onControl, owner = null } = {}) {
        const responseStarted = performance.now();
        if (closed) throw new Error('The worker engine is closed.');
        if (typeof prompt !== 'string') throw new TypeError('The turn prompt must be text.');
        context = { ...context,
            resources: structuredClone(context.resources || context.webchatResources || []),
            paths: structuredClone(context.paths || context.webchatPaths || []),
            origin: structuredClone(context.origin || context.webchatOrigin || {}),
            attachments: structuredClone(context.attachments || []),
            references: structuredClone(context.references || []) };
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? stopReason());
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let finish;
        const operation = { controller, turnId, stop: null, done: new Promise((resolve) => { finish = resolve; }) };
        active.add(operation);
        let release, catalogRelease, turn, live = null, liveResult = null;
        const phase = (event, extra = {}) => logDiagnostic(workingDir, `turn.${event}`, { sessionId, turnId,
            elapsedMs: Math.round(performance.now() - responseStarted), worker: true, ...extra });
        phase('start');
        const env = { ...process.env };
        const sanitize = createSanitizer(context, env);
        const emit = async (event) => {
            const clean = sanitize(event);
            live?.event(clean);
            await onEvent?.(clean);
        };
        try {
            controller.signal.throwIfAborted();
            const robotName = String(process.env.ROBOTEAM_COPILOT_ROBOT_NAME || '').trim();
            await emit({ type: 'progress', reason: robotName ? `Connecting to robot "${robotName}"` : 'Connecting to robot' });
            release = await acquireExecutionLease(workingDir, `session:${sessionId}`, { label: 'workerEngine.executeTurn' });
            phase('lease.acquired');

            const authority = authorityFor(owner);
            const session = sessionStore.loadSession(sessionId);
            if (session.engine?.robotId && session.engine.robotId !== execution.robotId) {
                throw new Error('This conversation uses another robot. Open it with that robot, or create a new session.');
            }
            const cwd = await fs.realpath(session.engine?.cwd || session.cwd || workingDir);
            const workspaceRoot = resolveAchillesWorkspaceRoot(cwd, env);
            // The workspace root is never granted (base section 4.1): the worker refuses a grant equal to it. A
            // conversation that never picked a project folder runs with no project grant (the worker starts in
            // the robot HOME); a task or phase that explicitly names the root is refused here, before admission.
            const atRoot = cwd === workspaceRoot;
            if (atRoot && execution.cwdExplicit === true) throw rootRefusal();
            const projectCwd = atRoot ? null : cwd;
            const stored = settings.readAchillesSettings?.(cwd) || {};
            const permissionMode = execution.permissions || settings.getPermissionMode?.(cwd) || stored.permissionMode || 'full-access';
            if (!['ask-for-approval', 'full-access'].includes(permissionMode)) throw new Error('Invalid native permission mode.');
            // The worker has no control that answers a native permission request yet.
            if (permissionMode === 'ask-for-approval') throw new WorkerError('worker_permissions_unsupported', 400);

            const ready = await provisioner.ensureReady(await getRobot(), await grantFor(authority, { signal: controller.signal }));
            const resume = Boolean(session.engine?.backend) && (session.messages || []).some((message) => message.role === 'assistant'
                && message.status === 'completed' && message.context !== false);
            const resumeBackend = resume ? session.engine.backend : null;
            const configured = ALA_BACKENDS.includes(ready.configuration?.backend) ? ready.configuration.backend : null;
            const requestedBackend = execution.backend || (!resumeBackend && (session.engine?.backend || session.modelOverride?.backend)) || null;
            const backend = resumeBackend || requestedBackend || configured || null;
            const { models, efforts } = seedModels(ready.configuration);
            if (session.modelOverride && backend && session.modelOverride.backend !== backend) {
                throw new Error('The session model belongs to another coding agent; reset /model or create a new session.');
            }
            // The conversation's own model choice (`/model`) wins over the robot's configured one, as in alaEngine.
            if (session.modelOverride && backend) {
                models[backend] = session.modelOverride.model;
                if (session.modelOverride.effort) efforts[backend] = session.modelOverride.effort; else delete efforts[backend];
            }
            if (execution.model && backend) {
                if (execution.model !== models[backend]) delete efforts[backend];
                models[backend] = execution.model;
            }
            // A Soul Gateway model is served by the worker's model channel to OpenCode only (decision M-26). For any other coding agent it is
            // refused here, before admission, and never replaced by the free default.
            const chosenModel = backend ? models[backend] : null;
            if (backend !== 'opencode' && isGatewayModel(chosenModel)) throw modelRefusal(chosenModel, backend);
            if (backend === 'pi' && permissionMode === 'ask-for-approval') {
                throw new Error('Pi does not support ask-for-approval; select full-access or use Codex, OpenCode or Claude Code.');
            }

            const snapshot = await skillCatalog.refresh(sessionId, { execution: true, cwd });
            catalogRelease = snapshot.release;
            if (snapshot.revision) await emit({ type: 'skill-catalog', revision: snapshot.revision, policyVersion: snapshot.policyVersion });
            for (const diagnostic of snapshot.diagnostics || []) await emit({ type: 'diagnostic', category: 'skill-catalog', message: `${diagnostic.state}: ${diagnostic.message}` });
            const skills = snapshot.skills.filter((skill) => skill.enabled);
            const selected = skillName ? skills.find((skill) => skill.name === skillName) : null;
            if (skillName && !selected) throw new Error(`Skill "${skillName}" is missing or disabled.`);
            controller.signal.throwIfAborted();
            turn = await sessionStore.beginTurn({ sessionId, turnId, text: sanitize(context.rawText || prompt),
                attachments: sanitize(context.attachments || []), references: sanitize(context.references || []) });
            phase('turn.begun');
            live = createLiveTurn(livePublisher, { title: sanitize(liveTitle(context.rawText || prompt)), cwd, owner: context.liveOwner || null,
                robot: robotName || execution.robotId || '', transcriptUrl: '',
                abort: () => controller.abort(stopReason()) });
            await emit({ type: 'turn-started', ...turn, turnId });
            controller.signal.throwIfAborted();
            await sessionStore.bindEngine(sessionId, { home: WORKER_SESSION_HOME, cwd, backend, robotId: execution.robotId });

            // The same native prompt and ALA inputs alaEngine builds. The ALA home is the worker's and
            // no path of the RoboTeam robot home is sent. The task-script context is a RoboTeam-local
            // resource outside the shared workspace and is not sent; the task-failure and human-input
            // channels are the worker's own (below).
            const nativePrompt = buildNativePrompt({ prompt, resume, selectedSkillName: selected?.name, systemPrompt: execution.systemPrompt });
            // Extra folders are explicit read-only grants strictly below the workspace root, never the root and never
            // the project itself: the channel skills only. The session skills overlay
            // (`<project>/.roboteam/sessions/<id>/skills`) is private storage the worker refuses at open, so it is
            // never sent, and neither is any path with a protected component (a managed `.ploinky/repos/<repo>`
            // skill source excepted, which the worker resolves as a skill source). The placement modifiers (`as`,
            // `at`, `expose`) cannot run in the worker, so a source is granted at its own path.
            const candidates = [];
            // Skill mount sources (`snapshot.mounts`) are deliberately never granted: a robot controls the symlinks under its
            // writable project's `.agents/skills`, so a mount source can be another project, a managed repository root or `/`.
            // The worker hosts the task-failure and human-input channels (decision M-14): their skills are ordinary
            // read-only grants (RoboTeam's bundled skills by their managed-repository workspace path) and the prompt
            // names the granted path and the channel directory, which are the same in every workload.
            if (snapshot.mounts?.length) {
                await emit({ type: 'diagnostic', message: 'The selected skills are not available through the worker yet; this turn runs without them.' });
            }
            const channelSkills = [];
            for (const [skillName, channel, wanted] of [['report-task-blocked', 'task-failure', execution.workflowExecution === true],
                ['require-human-input', 'human-input', execution.humanInput === true]]) {
                if (!wanted) continue;
                const skill = skills.find((entry) => entry.name === skillName);
                const hostPath = skill ? await workspaceCodePath(skill.skillDir, { workspaceRoot, env, codeRoot: execution.codeRoot }).catch(() => null) : null;
                if (!hostPath || !isGrantableFolder(workspaceRoot, hostPath)) {
                    await emit({ type: 'diagnostic', message: `The ${skillName} skill is not available through the worker (its folder is not in the shared workspace).` });
                    continue;
                }
                candidates.push(hostPath);
                channelSkills.push({ skillName, channel, hostPath });
            }
            const folders = [];
            let skipped = 0;
            for (const candidate of [...new Set(candidates)]) {
                if (!isGrantableFolder(workspaceRoot, candidate)) { skipped += 1; continue; }
                if (projectCwd && (candidate === projectCwd || candidate.startsWith(`${projectCwd}${path.sep}`))) continue;
                folders.push({ path: candidate, access: 'read' });
            }
            if (skipped) await emit({ type: 'diagnostic', message: `${skipped} folder(s) outside the shared workspace or in private storage are not available through the worker.` });
            const ignore = projectCwd ? [path.resolve(projectCwd, ACHILLES_PRIVATE_DIRECTORY_NAME)] : [];
            // Grant i is `/projects/g<i>` in the worker's plan: the project (when there is one) first, then the folders in order.
            const virtualOf = (hostPath) => `/projects/g${(projectCwd ? 1 : 0) + folders.findIndex((folder) => folder.path === hostPath)}`;
            const channelPrompt = channelSkills.filter((entry) => folders.some((folder) => folder.path === entry.hostPath)).map((entry) => (entry.channel === 'task-failure'
                ? `\n\nRead ${virtualOf(entry.hostPath)}/SKILL.md. Use this required skill if missing resources, access or capabilities prevent fulfilling the agreed task and plan. Its channel here is ${CHANNELS_ROOT}/task-failure: run the script from the skill directory as \`node scripts/run.mjs --directory ${CHANNELS_ROOT}/task-failure --input '<json>'\`.`
                : `\n\nRead ${virtualOf(entry.hostPath)}/SKILL.md. Use this required skill to ask the user for a business decision. Its channel here is ${CHANNELS_ROOT}/human-input: run the script from the skill directory as \`node scripts/run.mjs --directory ${CHANNELS_ROOT}/human-input --input '<json>'\`.`)).join('');
            const overridden = Boolean(session.modelOverride || execution.model);
            const specification = {
                version: SPEC_VERSION,
                prompt: sanitize(nativePrompt + channelPrompt),
                displayText: sanitize(context.rawText || prompt),
                sessionId, turnId, ...(projectCwd ? { cwd: projectCwd } : {}), permissions: permissionMode,
                ...(overridden && backend && models[backend] ? { model: models[backend], effort: efforts[backend] || 'default' } : {}),
                ...(!resume && requestedBackend ? { codingAgent: requestedBackend } : {}),
                ...(resume ? { resume: true } : {}),
                ...(folders.length ? { folders } : {}),
                ...(ignore.length ? { ignore } : {}),
                ...(execution.mcpServers ? { mcpServers: execution.mcpServers } : {}),
                ...(execution.workflowExecution ? { workflowExecution: true } : {}),
                ...(execution.humanInput === true ? { humanInput: true } : {}),
            };
            // GUI tasks carry the address of a RoboTeam-local MCP server, which the worker cannot reach.
            if (LOOPBACK_MCP.test(String(execution.mcpServers || ''))) throw new WorkerError('worker_mcp_loopback_unsupported', 400);
            await emit({ type: 'progress', reason: 'Starting ALA' });
            controller.signal.throwIfAborted();
            const admissionAuth = await grantFor(authority, { signal: controller.signal });
            const admitted = await admit({ authority, owner, auth: admissionAuth,
                robotId: ready.robotId, configRevision: ready.configRevision, sessionId, specification });
            const referenceId = admitted.referenceId;
            phase('admitted', { referenceId });

            let failure = null;
            const records = createAlaRecordHandler({ backend, permissionMode, efforts, sessionId, sanitize, emit, interactions,
                context: { ...context, workingDir: cwd, sessionId, turnId, assistantMessageId: turn.assistantMessageId, signal: controller.signal },
                skillExecution: snapshot.revision ? { revision: snapshot.revision, catalogId: snapshot.catalogId } : null,
                signal: controller.signal, turnId,
                // A native permission request cannot be answered through the worker (refused above).
                reply: () => {},
                fail: (error) => { failure ||= error; },
                bindEngine: (agent) => sessionStore.bindEngine(sessionId, { home: WORKER_SESSION_HOME, cwd, backend: agent, robotId: execution.robotId }) });

            // Message controls: the same record alaEngine writes to ALA stdin, as the worker's `message`
            // control. A user control carries the grant of its own request (`message.owner.evidence`); a
            // message with none is rejected, never sent under another credential.
            const writeControl = (message) => {
                if (message?.type !== 'message' || typeof message.message !== 'string' || controller.signal.aborted) return false;
                const id = typeof message.id === 'string' && message.id ? message.id : randomUUID();
                const payload = { message: buildTaskPrompt({ task: message.message }), displayText: message.message, id };
                void (async () => {
                    try {
                        await client.control(referenceId, { operationId: controlOperationId('message', referenceId, id), op: 'message', payload },
                            controlAuth(authority, message.owner?.evidence));
                    } catch (error) {
                        await emit({ type: 'message-rejected', id, error: error?.code || 'worker_control_failed' }).catch(() => {});
                    }
                })();
                return true;
            };
            onControl?.(writeControl);
            live?.attach(writeControl);

            const outcome = await followReference({ referenceId, authority, controller, operation, records, emit, sanitize, phase, openAuth: admissionAuth, getFailure: () => failure });
            live?.childExited();
            if (failure) throw failure;
            controller.signal.throwIfAborted();
            const outputText = sanitize(String(outcome.outputText ?? '').trimEnd());
            const completed = await sessionStore.completeTurn(sessionId, turn.assistantMessageId, outputText,
                { durationMs: Math.max(0, Math.round(performance.now() - responseStarted)), thinkingUrl: '' });
            phase('completeTurn.done');
            liveResult = { status: 'finished', code: 0 };
            return { outputText, session: completed, turnId, userMessageId: turn.userMessageId,
                assistantMessageId: turn.assistantMessageId, backend: records.backend || backend };
        } catch (cause) {
            phase('catch', errorFields(cause));
            const workerFailure = cause instanceof WorkerError;
            const detached = controller.signal.aborted && isDetach(controller.signal.reason);
            const cancelled = !workerFailure && (controller.signal.aborted || cause?.exitCode === 130 || cause?.name === 'AbortError');
            const error = workerFailure ? cause : cancelled ? (detached ? controller.signal.reason : interrupted())
                : new Error(sanitize(cause?.message || String(cause)), { cause });
            if (!cancelled && !workerFailure && cause?.exitCode !== undefined) error.exitCode = cause.exitCode;
            if (cause?.execution) error.execution = cause.execution;
            if (cause?.taskBlocked) error.taskBlocked = true;
            if (cause?.stoppedByWorker) error.stoppedByWorker = cause.stoppedByWorker;
            if (cause?.workerClassification) Object.assign(error, { workerClassification: cause.workerClassification, terminationUnverified: cause.terminationUnverified === true });
            liveResult = cancelled ? { status: 'stopped', reason: detached ? 'detached' : 'stopped' }
                : { status: 'failed', reason: error.message, ...(Number.isSafeInteger(error.exitCode) ? { code: error.exitCode } : {}) };
            // A detached turn keeps running on the worker; its record stays pending for reattachment.
            if (turn && !detached) {
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
                if (catalogRelease) await catalogRelease();
            } finally {
                try { if (release) await release(); } finally {
                    active.delete(operation); finish();
                    live?.end(liveResult || { status: 'failed', reason: 'The turn ended unexpectedly.' });
                }
            }
        }
    }

    // Follows the reference until it is terminal, feeding ALA records to the shared handler, then
    // returns its result. An interactive turn (grant) uses one event subscription opened with the
    // admission grant; a RoboFlow phase (binding) polls with the coordinator identity and the binding.
    // A user stop is sent once as a `stop` control; a detach leaves the worker running.
    async function followReference({ referenceId, authority, controller, operation, records, emit, sanitize, phase, openAuth, getFailure }) {
        let terminal = false;
        let terminalRow = null;
        let stopSent = false;
        let stopError = null;
        let stopTimedOut = false;
        let stopTimer = null;
        let queued = Promise.resolve();
        const enqueue = (work) => { queued = queued.then(work); return queued; };
        const streamAbort = new AbortController();
        const handled = new WeakSet();
        // The worker accepted the stop but no terminal state arrived within the bound: the execution may still run.
        const stopUnconfirmed = () => new WorkerError('worker_stop_unconfirmed', 504, { execution: 'may_still_run' });
        const detached = () => controller.signal.aborted && isDetach(controller.signal.reason);

        // The stop control: the stopping request's own grant (user stop), or the coordinator identity
        // and binding (a RoboFlow phase's system-initiated stop). Sent once, never retried; one that is
        // not accepted is reported as such, because the execution may then still run.
        const sendStop = async (reason, { user = true } = {}) => {
            if (stopSent) return;
            stopSent = true;
            try {
                await client.control(referenceId, { operationId: stopOperationId(referenceId), op: 'stop' },
                    controlAuth(authority, reason?.owner?.evidence, { user: authority.mode === 'grant' || (user && reason?.userInitiated === true) }));
                stopTimer = setTimeout(() => { if (!terminal) { stopTimedOut = true; streamAbort.abort(); } }, stopWaitMs);
                stopTimer.unref?.();
            } catch (error) {
                stopError = new WorkerError(error?.code === 'forbidden' || error?.code === 'owner_evidence_unavailable' ? 'worker_stop_not_authorized' : (error?.code || 'worker_stop_undelivered'),
                    error?.status || 503, { execution: 'may_still_run' });
                streamAbort.abort();
            }
        };

        // A user's stop pressed in the chat (decisions M-12 (b), M-40). It is a control, not an abort, and it is authorized only by the
        // grant of its own request (the Router's signed stop envelope). No earlier grant is borrowed: a stop without a usable grant of
        // its own (an unsigned control from an older Router, or an expired grant) is not delivered, the turn keeps running, and the user
        // is told to press stop again. The turn stays open until the worker ends the execution; the control is one idempotent operation.
        operation.stop = async (stopOwner = null) => {
            const evidence = usable(stopOwner?.evidence) ? stopOwner.evidence : null;
            try {
                await client.control(referenceId, { operationId: stopOperationId(referenceId), op: 'stop' },
                    controlAuth(authority, evidence, { user: true }));
            } catch (error) {
                const code = error?.code === 'forbidden' || error?.code === 'owner_evidence_unavailable' ? 'worker_stop_not_authorized' : (error?.code || 'worker_stop_undelivered');
                phase('stop.not_delivered', { code });
                return { delivered: false, code, message: stopNotDelivered(code) };
            }
            phase('stop.sent', { referenceId });
            if (!stopSent) {
                stopSent = true;
                stopTimer = setTimeout(() => { if (!terminal) { stopTimedOut = true; streamAbort.abort(); } }, stopWaitMs);
                stopTimer.unref?.();
            }
            return { delivered: true };
        };

        // A protocol or handler failure ends the turn, and the execution with it: alaEngine kills its child
        // here. Best effort, once, with the best credential available; when the stop is not accepted the
        // error says the execution may still run.
        const fatal = async (error) => {
            if (!stopSent) {
                stopSent = true;
                try {
                    const best = authority.mode === 'grant' ? authority.best() : null;
                    await client.control(referenceId, { operationId: stopOperationId(referenceId), op: 'stop' }, controlAuth(authority, best, { user: false }));
                } catch { error.execution = 'may_still_run'; }
            }
            handled.add(error);
            throw error;
        };

        // Channel events (decision M-14): the blocked-task report fails the turn as in the local engine; a human-input
        // question is announced to the caller (RoboFlow pauses the phase on it) and the attempt then ends `human-input`.
        let blocked = null;
        const processRow = async (row) => {
            if (row.kind === 'task-failed') {
                const message = sanitize(String(row.message ?? '')).trim();
                blocked ||= message;
                await emit({ type: 'task-failed', message });
            } else if (row.kind === 'human-input-request') {
                await emit({ type: 'human-input-request', requestId: row.requestId, question: row.question, options: row.options, referenceId });
            } else if (row.kind === 'state') {
                if (TERMINAL_STATES.includes(row.state)) { terminal = true; terminalRow = row; }
            } else if (row.kind === 'ala') {
                await records.handle(row.record);
            } else if (row.kind === 'truncated') {
                // Never silent: the worker bounded the relayed stream here.
                await emit({ type: 'diagnostic', category: 'worker-stream', message: `Worker stream truncated${row.dropped != null ? ` (${row.dropped} dropped)` : ''}: ${row.reason}` });
            }
        };

        // Reads are idempotent and retried with backoff within a bound; a control never is.
        const reading = async (call) => {
            const deadline = Date.now() + transientWaitMs;
            let backoff = pollMinMs;
            for (;;) {
                try {
                    return await call();
                } catch (error) {
                    if (!(error instanceof WorkerError) || !(TRANSIENT_CODES.has(error.code) || error.status === 503)) throw error;
                    if (detached()) throw controller.signal.reason;
                    if (Date.now() >= deadline) { error.execution = 'may_still_run'; throw error; }
                    await sleep(backoff);
                    backoff = Math.min(pollMaxMs, backoff * 2);
                }
            }
        };

        const onAbort = () => {
            if (detached()) streamAbort.abort();
            else void sendStop(controller.signal.reason, { user: true });
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();

        try {
            const result = authority.mode === 'grant'
                ? await followStream()
                : await followPolling();
            return result;
        } finally {
            controller.signal.removeEventListener('abort', onAbort);
            clearTimeout(stopTimer);
            streamAbort.abort();
        }

        // ---- interactive turn: one subscription, reattached from the cursor with a fresh grant ----
        async function followStream() {
            let after = 0;
            let auth = openAuth;
            let backoff = pollMinMs;
            let lastProgress = Date.now();
            while (!terminal) {
                if (detached()) throw controller.signal.reason;
                if (stopError) throw stopError;
                if (stopTimedOut) throw stopUnconfirmed();
                if (getFailure()) await fatal(getFailure());
                if (!auth || (auth.grant && !usable({ ok: true, grant: auth.grant }))) {
                    try { auth = await grantFor(authority, { signal: streamAbort.signal }); }
                    catch (error) {
                        if (detached()) throw controller.signal.reason;
                        if (stopError || stopTimedOut) continue;
                        if (error instanceof WorkerError) error.execution = 'may_still_run';
                        throw error;
                    }
                }
                const opened = auth;
                auth = null;
                try {
                    const lines = await client.subscribe(referenceId, { after }, opened, { signal: streamAbort.signal });
                    for await (const raw of lines) {
                        lastProgress = Date.now();
                        backoff = pollMinMs;
                        if (raw?.gap) {
                            await emit({ type: 'diagnostic', category: 'worker-stream', message: 'Worker stream truncated: events before the retained window were dropped.' });
                            after = Math.max(after, raw.snapshotSequence ?? after);
                            continue;
                        }
                        const row = normalizeEventRow(raw);
                        if (Number.isSafeInteger(row.sequence)) after = Math.max(after, row.sequence);
                        try { await enqueue(() => processRow(row)); } catch (error) { await fatal(error); }
                        if (getFailure()) await fatal(getFailure());
                        if (terminal) break;
                    }
                } catch (error) {
                    if (handled.has(error)) throw error;
                    if (detached()) throw controller.signal.reason;
                    if (stopError || stopTimedOut) continue;
                    if (!(TRANSIENT_CODES.has(error?.code) || error?.status === 503)) throw error;
                    if (Date.now() - lastProgress >= transientWaitMs) {
                        const failed = error instanceof WorkerError ? error : new WorkerError(error.code || 'worker_stream_dropped', 503);
                        failed.execution = 'may_still_run';
                        throw failed;
                    }
                }
                if (terminal) break;
                // The stream ended or dropped before a terminal state: reattach from the cursor, within a bound.
                if (Date.now() - lastProgress >= transientWaitMs) throw new WorkerError('worker_stream_ended', 503, { execution: 'may_still_run' });
                await sleep(backoff);
                backoff = Math.min(pollMaxMs, backoff * 2);
            }
            try { await queued; } catch (error) { await fatal(error); }
            if (getFailure()) await fatal(getFailure());
            // A stop the worker confirmed by ending the execution needs no result, and so no fresh grant.
            if (stopSent && terminalRow && ['cancelled', 'interrupted', 'paused'].includes(terminalRow.state)) throw interrupted();
            if (terminalRow?.result && typeof terminalRow.result === 'object') return outcomeOf({ state: terminalRow.state, result: terminalRow.result }, sanitize, blocked);
            // The result is a read: it needs a fresh grant, so it waits for the user's next envelope. The
            // execution is finished and its result stays retrievable when the user comes back.
            for (;;) {
                let snapshot;
                try {
                    snapshot = await reading(async () => client.read(referenceId, await grantFor(authority, { signal: streamAbort.signal })));
                } catch (error) {
                    if (error instanceof WorkerError && error.code === 'owner_evidence_expired') error.execution = 'finished';
                    throw error;
                }
                if (snapshot.state === 'stopping' || !snapshot.result) { await sleep(backoff); backoff = Math.min(pollMaxMs, backoff * 2); continue; }
                return outcomeOf(snapshot, sanitize, blocked);
            }
        }

        // ---- RoboFlow phase: the coordinator identity and the persisted binding authorize every read ----
        async function followPolling() {
            const auth = { bindingId: authority.bindingId };
            let after = 0;
            let wait = pollMinMs;
            let lastRead = 0;
            for (;;) {
                if (detached()) throw controller.signal.reason;
                if (stopError) throw stopError;
                if (stopTimedOut && !terminal) throw stopUnconfirmed();
                if (getFailure()) await fatal(getFailure());

                const page = await reading(async () => client.events(referenceId, { after, limit: EVENTS_PAGE }, auth));
                let progressed = false;
                if (page.gap) {
                    await emit({ type: 'diagnostic', category: 'worker-stream', message: 'Worker stream truncated: events before the retained window were dropped.' });
                    after = page.snapshotSequence;
                    progressed = true;
                } else {
                    for (const raw of page.events || []) {
                        const row = normalizeEventRow(raw);
                        try { await enqueue(() => processRow(row)); } catch (error) { await fatal(error); }
                        progressed = true;
                    }
                    after = page.nextAfter ?? after;
                }
                try { await queued; } catch (error) { await fatal(error); }
                if (getFailure()) await fatal(getFailure());
                if (!terminal && Date.now() - lastRead >= READ_EVERY_MS) {
                    lastRead = Date.now();
                    const snapshot = await reading(async () => client.read(referenceId, auth));
                    if (TERMINAL_STATES.includes(snapshot.state)) terminal = true;
                }
                if (terminal && !progressed) {
                    const snapshot = await reading(async () => client.read(referenceId, auth));
                    if (snapshot.state === 'stopping' || !snapshot.result) { await sleep(wait); wait = Math.min(pollMaxMs, wait * 2); continue; }
                    return outcomeOf(snapshot, sanitize, blocked);
                }
                if (progressed) wait = pollMinMs;
                else { await sleep(wait); wait = Math.min(pollMaxMs, wait * 2); }
            }
        }
    }

    function outcomeOf(snapshot, sanitize, blocked = null) {
        const result = snapshot.result || {};
        const classification = result.classification ?? snapshot.state;
        if (snapshot.state === 'completed') return { outputText: result.outputText ?? '' };
        // A human-input question ended the attempt: the turn ends normally with the model's last text and RoboFlow waits for the answer.
        if (snapshot.state === 'human-input') return { outputText: result.outputText ?? '', humanInput: result.data?.requestId ?? true };
        // A blocked-task report fails the turn with the model's message, exactly as the local failure channel does.
        if (snapshot.state === 'failed' && (result.data?.reason === 'task_blocked' || blocked)) {
            const error = new Error(sanitize(String(result.data?.message || blocked || 'The task is blocked.')));
            error.exitCode = 1;
            error.taskBlocked = true;
            throw error;
        }
        if (snapshot.state === 'cancelled' || snapshot.state === 'interrupted' || snapshot.state === 'paused') throw interrupted();
        const reason = typeof result.reason === 'string' ? result.reason : (typeof result.data?.reason === 'string' ? result.data.reason : null);
        // The worker stopped the attempt itself (no activity, or the maximum duration): plain words, a failure, never retried here.
        const stopped = plainStopMessage(reason, result.data);
        if (stopped) {
            const error = new Error(stopped);
            error.exitCode = 1;
            error.workerClassification = classification;
            error.stoppedByWorker = reason;
            throw error;
        }
        const error = new Error(sanitize(`Worker execution failed${reason ? ` (${reason})` : ''}.${result.outputText ? `\n${String(result.outputText).slice(-2048)}` : ''}`));
        error.exitCode = 1;
        error.workerClassification = classification;
        // A quarantined process tree is a failure with a recorded reason, never a completion.
        if (reason === 'termination_unverified') error.terminationUnverified = true;
        throw error;
    }

    return Object.freeze({
        executeTurn,
        // The user's stop of a running turn (see `operation.stop`). Before the worker has the execution there is nothing to stop there,
        // so the turn is only cancelled here.
        async stopTurn({ turnId, owner = null } = {}) {
            const operation = [...active].find((entry) => entry.turnId === turnId);
            if (!operation) return { delivered: false, code: 'not_running', message: 'Nothing is running to stop.' };
            if (operation.stop) return operation.stop(owner);
            operation.controller.abort(stopReason({ owner }));
            return { delivered: true, local: true };
        },
        async getModel({ sessionId } = {}) {
            const info = await modelState(sessionId);
            return { backend: info.backend, model: info.backend ? info.models[info.backend] || null : null,
                effort: info.backend ? info.efforts[info.backend] || null : null, modelSource: info.source };
        },
        async setModel({ sessionId, backend, model, effort = null } = {}) {
            const current = await modelState(sessionId);
            if (backend !== current.backend) throw new Error('The conversation backend changed; reload /model.');
            await sessionStore.updateSession(sessionId, (session) => {
                if (model === null) delete session.modelOverride;
                else session.modelOverride = { backend, model, effort };
            });
            return this.getModel({ sessionId });
        },
        // The model catalog needs the coding-agent binaries and the robot HOME, both the worker's.
        async listModels() {
            throw new WorkerError('worker_model_listing_unavailable', 501);
        },
        async close() {
            closed = true;
            const operations = [...active];
            for (const operation of operations) operation.controller.abort(detachReason());
            await Promise.all(operations.map((operation) => operation.done));
        },
    });
}
