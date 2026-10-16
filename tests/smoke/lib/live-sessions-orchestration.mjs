import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readLiveSkillsCodeHashes, createLiveSkillsRuntimeReader } from './copilot-live-skills-runtime.mjs';
import { delegationContractFiles } from './copilot-workflow-delegation-runtime.mjs';
import { inspectNestedContainer, workspaceHash } from './webtty-runtime-evidence.mjs';
import { rejectShadows } from './local-snapshot-bindings.mjs';
import { projectLiveSessionError } from './live-sessions-diagnostics.mjs';

export function buildOrchestrationDiagnosticsBundle({ fsApi = fs } = {}) {
    const modules = [
        { file: 'security.mjs', imports: [], exports: ['collectSecrets', 'createRedactor', 'findSecretLeaks'] },
        { file: 'redacted-trace.mjs', imports: ["import { collectSecrets } from './security.mjs';"],
            builtins: ["import { execFile } from 'node:child_process';", "import fs from 'node:fs/promises';", "import os from 'node:os';",
                "import path from 'node:path';", "import { promisify } from 'node:util';"],
            exports: ['discoverPlaywrightInputActionValues', 'findTraceCredentialResidue', 'redactTraceText', 'stopAndAttachRedactedTrace'] },
        { file: 'release-gate-failures.mjs', imports: ["import { createRedactor } from './security.mjs';"], exports: ['createReleaseGateFailureCollector'] },
        { file: 'live-sessions-diagnostics.mjs', imports: ["import { createRedactor, findSecretLeaks } from './security.mjs';",
            "import { redactTraceText, findTraceCredentialResidue } from './redacted-trace.mjs';",
            "import { createReleaseGateFailureCollector } from './release-gate-failures.mjs';"], exports: ['projectLiveSessionError', 'createLiveSessionFinalizer'] },
    ];
    const hashes = {}, chunks = [];
    for (const module of modules) {
        const file = fileURLToPath(new URL(module.file, import.meta.url));
        assert.equal(fsApi.realpathSync(file), file);
        const fd = fsApi.openSync(file, fsApi.constants.O_RDONLY | fsApi.constants.O_NOFOLLOW | fsApi.constants.O_NONBLOCK);
        let source;
        try {
            const before = fsApi.fstatSync(fd);
            assert.ok(before.isFile() && before.nlink === 1 && before.size <= 128 * 1024);
            const bytes = fsApi.readFileSync(fd), after = fsApi.fstatSync(fd);
            assert.ok(bytes.length === before.size && ['size', 'ino', 'dev', 'mtimeMs', 'ctimeMs'].every(key => before[key] === after[key]));
            hashes[module.file] = crypto.createHash('sha256').update(bytes).digest('hex');
            source = bytes.toString('utf8');
        } finally { fsApi.closeSync(fd); }
        const exports = [...source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)\(/gm)].map(match => match[1]).sort();
        assert.deepEqual(exports, [...module.exports].sort(), 'Canonical diagnostics export graph changed.');
        for (const line of module.imports) {
            assert.equal(source.split(line).length, 2, 'Canonical diagnostics relative import changed.');
            source = source.replace(line, '');
        }
        assert.ok(!/^import .*from ['"](?:\.|\/)/m.test(source), 'Unapproved diagnostics dependency.');
        assert.deepEqual([...source.matchAll(/^import .*$/gm)].map(match => match[0]), module.builtins || [], 'Canonical diagnostics builtin graph changed.');
        source = source.replace(/^export (?=(?:async )?function )/gm, '');
        assert.ok(!/^export /m.test(source), 'Unapproved diagnostics export.');
        chunks.push(`// Canonical ${module.file}\n${source}`);
    }
    const source = chunks.join('\n');
    return { source, hashes, sha256: crypto.createHash('sha256').update(source).digest('hex') };
}

// The alternate collector is a unit-only injection point. Production always
// serializes the exact exported metadata collector with its fixed defaults.
export function buildOrchestrationProgram(options, { collector = readLiveSessionOrchestration,
    diagnostics = buildOrchestrationDiagnosticsBundle() } = {}) {
    const source = `${diagnostics.source}\nconst readLiveSkillsCodeHashes = ${readLiveSkillsCodeHashes.toString()};\nconst projectOrchestrationRecords = ${projectOrchestrationRecords.toString()};\nconst snapshotWalFiles = ${snapshotWalFiles.toString()};\nconst assertWalFileFences = ${assertWalFileFences.toString()};\nconst readOrchestrationTranscripts = ${readOrchestrationTranscripts.toString()};\n(${collector.toString()})(${JSON.stringify(options)}).catch(error => {\nconst safe = projectLiveSessionError(error);\nprocess.stdout.write(JSON.stringify({ version: 1, kind: 'live-session-orchestration-error', error: safe }));\nprocess.exitCode = 1;\n});`;
    assert.ok(Buffer.byteLength(source) < 128 * 1024, 'Bounded orchestration program exceeds Linux single-argument capacity.');
    return source;
}

export function decodeOrchestrationProcessResult(result, { env = process.env } = {}) {
    const stdout = Object.getOwnPropertyDescriptor(result || {}, 'stdout')?.value;
    if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 256 * 1024) throw new Error('Invalid bounded orchestration process response.');
    let payload;
    try { payload = JSON.parse(stdout); } catch { throw new Error('Invalid bounded orchestration process JSON; raw process errors withheld.'); }
    if (payload?.version === 1 && payload.kind === 'live-session-orchestration-error') {
        const safe = projectLiveSessionError(payload.error, { env });
        throw Object.assign(new Error(`Read-only orchestration subprocess failed.\n${JSON.stringify(safe)}`, { cause: safe }), { name: 'OrchestrationEvidenceError' });
    }
    if (Object.getOwnPropertyDescriptor(result || {}, 'code')?.value !== undefined) throw new Error('Orchestration process failed without safe diagnostic evidence.');
    return validateOrchestrationObservation(payload);
}

export function snapshotWalFiles(databaseFile, io = fs) {
    return ['-wal', '-shm'].map(suffix => {
        const file = databaseFile + suffix;
        const before = io.lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || io.realpathSync(file) !== file) throw new Error('Read-only SQLite requires existing regular WAL sidecars.');
        const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK);
        try {
            const stat = io.fstatSync(fd), after = io.lstatSync(file);
            if (!stat.isFile() || stat.nlink !== 1 || ['ino', 'dev'].some(key => before[key] !== stat[key] || stat[key] !== after[key])
                || stat.size > 256 * 1024 * 1024 || suffix === '-shm' && (stat.size < 32768 || stat.size % 32768 !== 0)) {
                throw new Error('Read-only SQLite sidecar changed or has invalid geometry.');
            }
            return { file, suffix, ino: stat.ino, dev: stat.dev, size: stat.size };
        } finally { io.closeSync(fd); }
    });
}

export function assertWalFileFences(before, after) {
    if (before.length !== 2 || after.length !== 2) throw new Error('Read-only SQLite sidecar inventory changed.');
    before.forEach((file, index) => {
        const current = after[index];
        if (['file', 'suffix', 'ino', 'dev'].some(key => current[key] !== file[key])
            || file.suffix === '-shm' && current.size !== file.size) throw new Error('Read-only SQLite sidecar identity or shared-memory geometry changed.');
    });
}

// Neutral idle-writer probes distinguish SQLite's five shared read marks from
// durable records and lock payload. This is not a live database equality rule.
export function assertIdleWalReadmarkDelta(before, after, endianness) {
    if (!Buffer.isBuffer(before) || !Buffer.isBuffer(after) || before.length !== after.length || before.length < 128
        || !['LE', 'BE'].includes(endianness)) throw new Error('Invalid neutral WAL-index evidence.');
    const changedOffsets = [];
    for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) {
        if (index < 100 || index >= 120) throw new Error('Observer changed bytes outside SQLite shared read marks.');
        changedOffsets.push(index);
    }
    const decode = bytes => Array.from({ length: 5 }, (_, index) => endianness === 'LE'
        ? bytes.readUInt32LE(100 + index * 4) : bytes.readUInt32BE(100 + index * 4));
    return { endianness, changedOffsets, readmarksBefore: decode(before), readmarksAfter: decode(after) };
}

// Kept independent of I/O so neutral fixtures exercise the same correlation
// that the deployed read-only program uses.
export function projectOrchestrationRecords(records, options) {
    const fail = message => { throw new Error(`Live Sessions orchestration: ${message}`); };
    const { cwd, robotId, frontSessionId, requestDigest, ownerPrincipal, baseline = null, requirePhase = false } = options;
    const id = value => {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('invalid durable ID');
        return value;
    };
    const bounded = rows => {
        if (!Array.isArray(rows) || rows.length > 512) fail('unbounded durable inventory');
        return rows;
    };
    const sessions = bounded(records.sessions), tasks = bounded(records.tasks), flows = bounded(records.flows), executions = bounded(records.executions);
    const unique = values => {
        if (new Set(values).size !== values.length) fail('duplicate durable identity');
        return values.sort();
    };
    const census = {
        sessions: unique(sessions.map(session => id(session.sessionId))),
        turns: unique(sessions.flatMap(session => bounded(session.turns).map(turn => `${id(session.sessionId)}:${id(turn.turnId)}`))),
        tasks: unique(tasks.map(task => id(task.id))),
        flows: unique(flows.map(flow => id(flow.id))),
        phases: unique(flows.flatMap(flow => bounded(flow.instances).map(phase => `${id(flow.id)}:${id(phase.id)}`))),
        executions: unique(executions.map(execution => `${id(execution.alaSessionId)}:${id(execution.taskId)}`)),
    };
    for (const session of sessions) if (session.cwd !== cwd || session.turns.length && session.robotId !== robotId) fail('foreign conversation context');
    for (const flow of flows) if (flow.folder !== cwd || flow.ownerPrincipal !== ownerPrincipal) fail('foreign folder or owner');
    for (const execution of executions) if (execution.cwd !== cwd || execution.robotId !== robotId) fail('foreign runtime context');
    if (!frontSessionId) return { census, front: null, task: null, flow: null, phase: null, execution: null };
    id(frontSessionId);
    const fronts = sessions.filter(session => session.sessionId === frontSessionId);
    if (fronts.length !== 1) fail('selected front conversation missing');
    const frontSession = fronts[0];
    if (!frontSession.metadataObserved) fail('selected front has no conversation metadata');
    const selectedTurns = frontSession.turns.filter(turn => turn.userDigest === requestDigest);
    if (selectedTurns.length > 1) fail('duplicate selected request');
    const turn = selectedTurns[0];
    if (!turn) {
        if (requirePhase) fail('selected request missing');
        return { census, front: null, task: null, flow: null, phase: null, execution: null };
    }
    if (baseline?.turns.includes(`${frontSessionId}:${turn.turnId}`)) fail('stale selected front turn');
    const front = { sessionId: frontSessionId, cwd, robotId, backend: frontSession.backend, ...turn };
    const linked = tasks.filter(task => task.sessionId === frontSessionId && task.turnId === turn.turnId
        && task.assistantMessageId === turn.assistantMessageId);
    if (linked.length > 1) fail('multiple background tasks for selected turn');
    const task = linked[0] || null;
    if (!task) {
        if (requirePhase) fail('background task missing');
        return { census, front, task: null, flow: null, phase: null, execution: null };
    }
    if (task.targetAgent !== 'roboTeamAgent' || task.toolName !== 'roboflow_start_flow' || !task.flowId) fail('wrong background target');
    if (baseline?.tasks.includes(task.id)) fail('stale background task');
    const matches = flows.filter(flow => flow.id === task.flowId);
    if (matches.length !== 1) fail('linked flow missing');
    const flow = matches[0];
    if (flow.workflowTypeId !== 'default' || baseline?.flows.includes(flow.id)) fail('wrong or stale workflow');
    if (requirePhase && baseline && flows.filter(value => !baseline.flows.includes(value.id)).length !== 1) fail('unexplained workflow launch');
    if (flow.instances.length > 1) fail('multiple workflow phases');
    const phase = flow.instances[0] || null;
    const workers = phase ? executions.filter(execution => execution.taskId === phase.runtimeTaskId
        && execution.flowId === flow.id && execution.instanceId === phase.id) : [];
    if (workers.length > 1) fail('duplicate runtime execution');
    const execution = workers[0] || null;
    if (execution && (phase.robotId !== robotId || execution.turns.length !== 1
        || execution.ownerPrincipal !== ownerPrincipal)) fail('inconsistent worker identity');
    if (execution) {
        const conversation = sessions.find(session => session.sessionId === execution.alaSessionId);
        if (!conversation?.metadataObserved || !conversation.turns.some(turn => turn.turnId === execution.turns[0]?.turnId)) fail('runtime conversation/turn link missing');
    }
    if (requirePhase && (!phase || !execution || !execution.turns[0])) fail('phase runtime or native turn missing');
    return { census, front, task, flow, phase, execution };
}

export function assertObserverWindow(before, after) {
    assert.deepEqual(after.census, before.census, 'Observers must not create even a short-lived durable execution.');
    for (const key of ['sessionId', 'turnId']) assert.equal(after.front?.[key], before.front?.[key]);
    for (const key of ['alaSessionId', 'taskId']) assert.equal(after.execution?.[key], before.execution?.[key]);
    assert.equal(after.execution?.turns[0]?.turnId, before.execution?.turns[0]?.turnId);
}

export function assertOwnedSettlement(snapshot, { cwd, ownerPrincipal, flowId }, census, rows = []) {
    assert.equal(snapshot.flow?.id, flowId);
    assert.equal(snapshot.flow.folder, cwd);
    assert.equal(snapshot.flow.ownerPrincipal, ownerPrincipal);
    assert.ok(['terminated', 'completed', 'failed'].includes(snapshot.flow.status), 'Owned flow must settle before deleting its cwd.');
    assert.ok(snapshot.flow.instances.every(phase => ['terminated', 'completed', 'failed', 'paused'].includes(phase.state)));
    assert.deepEqual(census, [], 'Scoped native census must be empty before cwd deletion.');
    assert.ok(rows.every(row => ['finished', 'failed', 'stopped', 'lost'].includes(row.status) && row.viewerCount === 0),
        'Owned public rows must be terminal with zero viewers.');
}

// Serialized into the exact deployed runtime. No store initialization, control
// operation, provider request, prompt, reasoning, or complete log leaves it.
export async function readLiveSessionOrchestration(options, { fsApi, codeRoot = '/code', dataRoot = '/data',
    emit = value => process.stdout.write(JSON.stringify(value)) } = {}) {
    const assert = (await import('node:assert/strict')).default;
    const fs = fsApi || await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { createHash } = await import('node:crypto');
    const digest = text => createHash('sha256').update(text).digest('hex');
    const { cwd, workspaceRoot, expectedRepository, contractFiles, contractHashes, expectedAla, robotId, ownerPrincipal } = options;
    assert.equal(path.dirname(cwd), workspaceRoot);
    for (const directory of [workspaceRoot, cwd]) { assert.equal(fs.realpathSync(directory), directory); assert.ok(fs.lstatSync(directory).isDirectory()); }
    assert.match(robotId, /^[a-z0-9][a-z0-9-]{2,63}$/);
    assert.match(ownerPrincipal, /^user:.{1,200}$/);
    const hashes = await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi });
    assert.deepEqual(hashes, contractHashes);
    const read = (file, root, limit = 4 * 1024 * 1024, decode = null) => {
        assert.ok(file.startsWith(`${root}/`));
        assert.equal(fs.realpathSync(file), file);
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const before = fs.fstatSync(fd);
            assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit);
            assert.equal(fs.realpathSync(`/proc/self/fd/${fd}`), file, 'Actual evidence descriptor escaped its scoped path.');
            const value = decode ? decode(fd) : fs.readFileSync(fd);
            const after = fs.fstatSync(fd);
            assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs);
            assert.equal(fs.realpathSync(`/proc/self/fd/${fd}`), file, 'Actual evidence descriptor changed during read.');
            if (decode) return value;
            assert.equal(value.length, before.size);
            return value.toString('utf8');
        } finally { fs.closeSync(fd); }
    };
    const json = (file, root) => JSON.parse(read(file, root));
    const entries = directory => {
        if (!fs.existsSync(directory)) return [];
        assert.equal(fs.realpathSync(directory), directory);
        const values = fs.readdirSync(directory, { withFileTypes: true });
        assert.ok(values.length <= 512);
        for (const entry of values) assert.ok(!entry.isSymbolicLink());
        return values;
    };
    const { resolveAlaCommand } = await import(pathToFileURL(`${codeRoot}/server/ala-command.mjs`).href);
    assert.equal(fs.realpathSync(process.env.ACHILLES_ALA_COMMAND || resolveAlaCommand()), expectedAla.command);
    for (const [file, sha256] of Object.entries(expectedAla.hashes)) assert.equal(digest(read(`${expectedAla.root}/${file}`, expectedAla.root)), sha256);
    const { ConversationSessionStore } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/storage/conversationSessionStore.mjs`).href);
    const { alaTranscript, alaSessionsRoot } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/execution/alaTranscript.mjs`).href);
    const { readWorkspaceTasks } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/tasks/workspaceTasks.mjs`).href);
    const { workflowIdForTask } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/webchat/webchatWorkflowStatus.mjs`).href);
    const store = new ConversationSessionStore({ workingDir: cwd });
    const metadataSessions = entries(`${cwd}/.roboteam/sessions`).filter(entry => /^[a-f0-9-]{36}$/.test(entry.name))
        .filter(entry => !options.frontOnly || entry.name === options.frontSessionId).map(entry => {
            const metadata = json(store.sessionPath(entry.name), cwd);
            assert.equal(metadata.version, 2); assert.equal(metadata.sessionId, entry.name);
            assert.equal(metadata.cwd, cwd, 'Conversation cwd must equal the selected folder before transcript access.');
            assert.ok(Array.isArray(metadata.turns) && metadata.turns.length <= 512);
            if (metadata.engine !== undefined) {
                assert.equal(metadata.engine?.type, 'ala'); assert.equal(metadata.engine.version, 1);
                assert.equal(metadata.engine.sessionId, entry.name);
                assert.equal(metadata.engine.cwd, cwd, 'Conversation engine cwd must remain confined before transcript access.');
                assert.ok(metadata.engine.backend === null || ['claude', 'codex', 'opencode', 'pi'].includes(metadata.engine.backend));
                if (metadata.turns.length) assert.equal(metadata.engine.robotId, robotId);
            } else assert.equal(metadata.turns.length, 0, 'Recorded turns require their actual engine binding.');
            const identifiers = new Set();
            for (const turn of metadata.turns) for (const key of ['turnId', 'userMessageId', 'assistantMessageId']) {
                assert.match(turn[key] || '', /^[a-f0-9-]{36}$/);
                assert.ok(!identifiers.has(turn[key])); identifiers.add(turn[key]);
            }
            return metadata;
        });
    const transcripts = readOrchestrationTranscripts({ directory: `${alaSessionsRoot(cwd)}/sessions`,
        frontOnly: options.frontOnly, frontSessionId: options.frontSessionId }, {
        fsApi: fs, hostname: (await import('node:os')).hostname(), uid: process.geteuid(),
        transcriptPath: id => alaTranscript.sessionTranscriptPath(alaSessionsRoot(cwd), id),
        readTranscript: file => read(file, cwd, 16 * 1024 * 1024, fd => alaTranscript.readTranscriptRecordsSync(fd)),
        foldTranscript: records => alaTranscript.foldTranscript(records),
    });
    const { nativeSessions } = transcripts;
    const emitObservation = result => {
        const pendingSessionIds = transcripts.finish();
        emit(pendingSessionIds.length ? { version: 1, kind: 'live-session-orchestration-incomplete', codeHashes: hashes,
            pendingSessionIds, reason: 'transcript-publication-pending' }
            : { ...result, codeHashes: hashes, transcriptObservation: { status: 'complete', sessionIds: [...nativeSessions.keys()].sort() } });
    };
    if (transcripts.pendingSessionIds.length) {
        assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi }), hashes);
        for (const [file, sha256] of Object.entries(expectedAla.hashes)) assert.equal(digest(read(`${expectedAla.root}/${file}`, expectedAla.root)), sha256);
        emitObservation();
        return;
    }
    const sessions = metadataSessions.map(metadata => {
        const native = nativeSessions.get(metadata.sessionId);
        return { sessionId: metadata.sessionId, cwd: metadata.engine?.cwd || metadata.cwd, robotId: metadata.engine?.robotId, metadataObserved: true,
            backend: native?.agent || metadata.engine?.backend || null,
            turns: metadata.turns.map(turn => {
                const actual = native?.turns.find(value => value.turnId === turn.turnId);
                return { turnId: turn.turnId, assistantMessageId: turn.assistantMessageId,
                    userDigest: digest(actual?.user ?? turn.userText ?? ''), status: actual?.status || turn.status,
                    nativeObserved: Boolean(actual), followUpDigests: (actual?.followUps || []).map(value => digest(value.text)) };
            }).concat((native?.turns || []).filter(turn => !metadata.turns.some(value => value.turnId === turn.turnId))
                .map(turn => ({ turnId: turn.turnId, assistantMessageId: turn.turnId, userDigest: digest(turn.user || ''),
                    status: turn.status, nativeObserved: true, followUpDigests: turn.followUps.map(value => digest(value.text)) }))) };
    });
    if (options.frontOnly) {
        const result = projectOrchestrationRecords({ sessions, tasks: [], flows: [], executions: [] }, options);
        assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi }), hashes);
        for (const [file, sha256] of Object.entries(expectedAla.hashes)) assert.equal(digest(read(`${expectedAla.root}/${file}`, expectedAla.root)), sha256);
        emitObservation(result);
        return;
    }
    // ALA can persist a turn before a conversation config is visible. Include
    // it in the census even when it is not the selected foreground session.
    for (const native of nativeSessions.values()) if (!sessions.some(session => session.sessionId === native.id)) {
        sessions.push({ sessionId: native.id, cwd, robotId, backend: native.agent, metadataObserved: false, turns: native.turns.map(turn => ({ turnId: turn.turnId,
            assistantMessageId: turn.turnId, userDigest: digest(turn.user || ''), status: turn.status, nativeObserved: true })) });
    }
    for (const entry of entries(`${cwd}/.roboteam/tasks`)) {
        if (/^task_[a-f0-9]{24}$/.test(entry.name)) read(`${cwd}/.roboteam/tasks/${entry.name}/task.json`, cwd);
    }
    const tasks = readWorkspaceTasks(cwd).map(task => ({ id: task.id, targetAgent: task.targetAgent, toolName: task.toolName,
        sessionId: task.sessionId, turnId: task.turnId, assistantMessageId: task.assistantMessageId,
        flowId: workflowIdForTask(task), status: task.status }));
    const { DatabaseSync } = await import('node:sqlite');
    const { TaskFlowStore } = await import(pathToFileURL(`${codeRoot}/server/roboflow/task-flow-store.mjs`).href);
    const databaseFile = `${dataRoot}/roboflow/roboflow.sqlite`;
    assert.equal(fs.realpathSync(databaseFile), databaseFile);
    assert.ok(fs.lstatSync(databaseFile).isFile() && fs.lstatSync(databaseFile).size <= 64 * 1024 * 1024);
    const walFiles = snapshotWalFiles(databaseFile, fs);
    let db, flows, primaryFailure, hasPrimary = false;
    const settlementFailures = [];
    try {
        db = new DatabaseSync(databaseFile, { readOnly: true });
        db.exec('BEGIN');
        const ids = db.prepare('SELECT id FROM workflow_runs').all();
        assert.ok(ids.length <= 2048);
        const flowStore = new TaskFlowStore({ database: { db, file: databaseFile } });
        flows = ids.map(row => flowStore.getSync(row.id)).filter(flow => flow.folder === cwd || tasks.some(task => task.flowId === flow.id))
            .map(flow => ({ id: flow.id, workflowTypeId: flow.workflowTypeId, folder: flow.folder,
                ownerPrincipal: flow.ownerPrincipal, status: flow.status,
                instances: flow.instances.map(phase => ({ id: phase.id, robotId: phase.robotId,
                    runtimeTaskId: phase.runtimeTaskId, state: phase.state })) }));
        db.exec('COMMIT');
    } catch (error) { primaryFailure = error; hasPrimary = true; }
    finally {
        try { db?.close(); } catch (error) { settlementFailures.push(new Error('Read-only SQLite connection settlement failed.', { cause: error })); }
        try { assertWalFileFences(walFiles, snapshotWalFiles(databaseFile, fs)); }
        catch (error) { settlementFailures.push(new Error('Read-only SQLite sidecar fence failed.', { cause: error })); }
    }
    if (hasPrimary || settlementFailures.length) throw new AggregateError([...(hasPrimary ? [primaryFailure] : []), ...settlementFailures], 'Read-only SQLite query/settlement failed.');
    const executions = [];
    for (const entry of entries(`${cwd}/.roboteam/tasks`)) {
        if (!/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const definition = json(`${cwd}/.roboteam/tasks/${entry.name}/task.json`, cwd);
        assert.equal(definition.id, entry.name);
        for (const execution of entries(`${cwd}/.roboteam/tasks/${entry.name}/executions`)) {
            assert.match(execution.name, /^[a-f0-9-]{36}\.json$/);
            const record = json(`${cwd}/.roboteam/tasks/${entry.name}/executions/${execution.name}`, cwd);
            assert.equal(record.alaSessionId, entry.name);
            assert.equal(record.taskId, execution.name.slice(0, -5));
            assert.equal(record.robotId, definition.robotId);
            for (const key of ['cwd', 'workflowRunId', 'workflowInstanceId', 'runtimeTaskId', 'ownerPrincipal']) assert.equal(record.request[key], definition.request[key]);
            const native = nativeSessions.get(entry.name);
            executions.push({ taskId: record.taskId, alaSessionId: record.alaSessionId, robotId: record.robotId, state: record.state, backend: native?.agent || null,
                cwd: record.request.cwd, flowId: record.request.workflowRunId, instanceId: record.request.workflowInstanceId, ownerPrincipal: record.request.ownerPrincipal,
                turns: (native?.turns || []).map(turn => ({ turnId: turn.turnId, status: turn.status,
                    followUpDigests: turn.followUps.map(value => digest(value.text)) })) });
        }
    }
    const result = projectOrchestrationRecords({ sessions, tasks, flows, executions }, options);
    assert.deepEqual(await readLiveSkillsCodeHashes({ expectedRepository, contractFiles }, { codeRoot, fsApi }), hashes);
    for (const [file, sha256] of Object.entries(expectedAla.hashes)) assert.equal(digest(read(`${expectedAla.root}/${file}`, expectedAla.root)), sha256);
    emitObservation(result);
}

// Locks are private auxiliary producer storage. Only transcripts authorize
// sessions; unresolved publication cannot become an idle snapshot.
export function readOrchestrationTranscripts({ directory, frontOnly, frontSessionId }, {
    fsApi: io, hostname, uid, readTranscript, foldTranscript, transcriptPath = id => `${directory}/${id}.jsonl`,
}) {
    const fail = () => { throw new Error('Invalid private ALA transcript-lock observation.'); };
    const same = (a, b, keys) => keys.every(key => a[key] === b[key]);
    const identityKeys = ['dev', 'ino', 'mode', 'uid', 'gid'];
    const fileKeys = [...identityKeys, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    const stat = file => io.lstatSync(file, { bigint: true });
    const directoryStat = () => {
        if (io.realpathSync(directory) !== directory) fail();
        const value = stat(directory);
        if (!value.isDirectory() || value.uid !== BigInt(uid)) fail();
        return value;
    };
    let parent, leaves;
    try {
        if (!io.existsSync(directory)) return { nativeSessions: new Map(), pendingSessionIds: [], finish: () => [] };
        parent = directoryStat();
        leaves = io.readdirSync(directory, { withFileTypes: true });
        if (leaves.length > 1024) fail();
    } catch { fail(); }
    const fenceParent = () => { if (!same(parent, directoryStat(), identityKeys)) fail(); };
    const inventory = new Map();
    for (const leaf of leaves) {
        const match = /^([a-f0-9-]{36})\.jsonl(\.lock)?$/.exec(leaf.name);
        if (!match || !leaf.isFile() || leaf.isSymbolicLink()) fail();
        const kinds = inventory.get(match[1]) || new Set();
        const kind = match[2] ? 'lock' : 'transcript';
        if (kinds.has(kind)) fail();
        kinds.add(kind); inventory.set(match[1], kinds);
        if (inventory.size > 512) fail();
    }
    const nativeSessions = new Map(), transcripts = new Map(), locks = new Map(), pending = new Set();
    const checkTranscript = (file, before, final = false) => {
        if (io.realpathSync(file) !== file) fail();
        const after = stat(file);
        if (!after.isFile() || after.nlink !== 1n || after.uid !== parent.uid
            || !same(before, after, final ? [...identityKeys, 'nlink'] : fileKeys)) fail();
    };
    try {
        for (const [id, kinds] of inventory) {
            if (frontOnly && id !== frontSessionId) continue;
            const file = transcriptPath(id);
            if (file !== `${directory}/${id}.jsonl`) fail();
            if (kinds.has('transcript')) {
                fenceParent();
                const before = stat(file);
                if (!before.isFile() || before.nlink !== 1n || before.uid !== parent.uid) fail();
                const records = readTranscript(file);
                if (records[0]?.type !== 'session' || records[0]?.id !== id) throw new Error('Invalid ALA transcript session header.');
                checkTranscript(file, before);
                const session = { id, ...foldTranscript(records) };
                if (session.turns.length > 512) fail();
                nativeSessions.set(id, session); transcripts.set(id, { file, before });
            }
            if (!kinds.has('lock')) continue;
            const lock = `${file}.lock`;
            let fd, before, missing = false, failure = false;
            const confirmMissing = () => {
                try { stat(lock); fail(); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                missing = true;
            };
            const pathOrMissing = action => {
                try { return action(); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    confirmMissing();
                }
            };
            try {
                fenceParent();
                try { before = stat(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; missing = true; }
                if (!missing) {
                    const valid = value => value.isFile() && value.nlink === 1n && value.uid === BigInt(uid)
                        && value.uid === parent.uid && (value.mode & 0o7777n) === 0o600n && value.size <= 4096n;
                    if (!valid(before)) fail();
                    const canonical = pathOrMissing(() => io.realpathSync(lock));
                    if (!missing && canonical !== lock) fail();
                    if (!missing) fd = pathOrMissing(() => io.openSync(lock, io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK));
                }
                if (fd !== undefined) {
                    const opened = io.fstatSync(fd, { bigint: true });
                    const unlinkedAtOpen = opened.nlink === 0n;
                    // Unlink changes link count and ctime. Every other FD
                    // identity stays pinned, and the pathname must be absent.
                    const openKeys = unlinkedAtOpen ? fileKeys.filter(key => !['nlink', 'ctimeNs'].includes(key)) : fileKeys;
                    if (!opened.isFile() || !same(before, opened, openKeys)) fail();
                    if (unlinkedAtOpen) confirmMissing();
                    if (!missing) {
                        const actual = pathOrMissing(() => io.realpathSync(`/proc/self/fd/${fd}`));
                        if (!missing && actual !== lock) fail();
                    }
                    const buffer = Buffer.alloc(4097);
                    let length = 0;
                    while (length < buffer.length) {
                        const count = io.readSync(fd, buffer, length, buffer.length - length, null);
                        if (count === 0) break;
                        length += count;
                    }
                    if (length > 4096) fail();
                    const bytes = buffer.subarray(0, length), after = io.fstatSync(fd, { bigint: true });
                    const unlinked = after.nlink === 0n;
                    const readKeys = unlinked ? fileKeys.filter(key => !['nlink', 'ctimeNs'].includes(key)) : fileKeys;
                    if (!same(before, after, readKeys) || BigInt(bytes.length) !== before.size) fail();
                    let owner;
                    try { owner = JSON.parse(bytes.toString('utf8')); } catch { fail(); }
                    if (!owner || Array.isArray(owner) || Object.keys(owner).sort().join(',') !== 'host,pid,start,token'
                        || owner.host !== hostname || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
                        || typeof owner.start !== 'string' || !/^[0-9]+$/.test(owner.start)
                        || typeof owner.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.token)) fail();
                    try {
                        if (io.realpathSync(lock) !== lock || !same(before, stat(lock), fileKeys)) fail();
                        if (io.realpathSync(`/proc/self/fd/${fd}`) !== lock) fail();
                    } catch (error) { if (error.code !== 'ENOENT') throw error; confirmMissing(); }
                    if (unlinked && !missing) fail();
                }
                locks.set(id, { file: lock, before });
                fenceParent();
            } catch { failure = true; }
            finally { if (fd !== undefined) try { io.closeSync(fd); } catch { failure = true; } }
            if (failure) fail();
            if (!transcripts.has(id)) pending.add(id);
            else if (missing) checkTranscript(file, transcripts.get(id).before, true);
        }
        fenceParent();
    } catch (error) {
        if (error.message === 'Invalid ALA transcript session header.') throw error;
        fail();
    }
    return { nativeSessions, pendingSessionIds: [...pending].sort(), finish() {
        try {
            fenceParent();
            for (const { file, before } of transcripts.values()) checkTranscript(file, before, true);
            for (const [id, { file, before }] of locks) {
                try { if (io.realpathSync(file) !== file || !before || !same(before, stat(file), fileKeys)) fail(); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    const transcript = transcripts.get(id);
                    if (transcript) checkTranscript(transcript.file, transcript.before, true);
                    else pending.add(id);
                }
            }
            fenceParent();
            return [...pending].sort();
        } catch { fail(); }
    } };
}

export function validateOrchestrationObservation(payload) {
    const fail = () => { throw new Error('Invalid bounded orchestration observation.'); };
    const ids = values => {
        if (!Array.isArray(values) || values.length > 512 || new Set(values).size !== values.length
            || values.some(value => typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value))) fail();
    };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail();
    if (payload.kind === 'live-session-orchestration-incomplete') {
        if (payload.version !== 1 || Object.keys(payload).sort().join(',') !== 'codeHashes,kind,pendingSessionIds,reason,version'
            || payload.reason !== 'transcript-publication-pending') fail();
        ids(payload.pendingSessionIds);
        if (!payload.pendingSessionIds.length) fail();
    } else {
        if ('kind' in payload || 'version' in payload) fail();
        if (!payload.transcriptObservation || Object.keys(payload.transcriptObservation).sort().join(',') !== 'sessionIds,status'
            || payload.transcriptObservation.status !== 'complete') fail();
        ids(payload.transcriptObservation.sessionIds);
        for (const key of ['census', 'front', 'task', 'flow', 'phase', 'execution']) if (!(key in payload)) fail();
    }
    if (!payload.codeHashes || typeof payload.codeHashes !== 'object' || Array.isArray(payload.codeHashes)
        || Object.values(payload.codeHashes).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail();
    return payload;
}

export async function observeOrchestration(observe, {
    now = () => performance.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const started = now(), deadline = started + 12000, pending = new Set();
    let observations = 0;
    const remaining = () => {
        const value = Math.floor(deadline - now());
        if (!Number.isFinite(value) || value <= 0) throw new Error('Live Sessions orchestration observation deadline expired.');
        return Math.min(12000, value);
    };
    while (observations < 128) {
        remaining(); observations += 1;
        const snapshot = validateOrchestrationObservation(await observe({ remaining, observation: observations }));
        remaining();
        if (snapshot.kind === 'live-session-orchestration-incomplete') {
            for (const id of snapshot.pendingSessionIds) pending.add(id);
            if (pending.size > 512) throw new Error('Live Sessions orchestration pending inventory exceeded its bound.');
        } else {
            if (![...pending].every(id => snapshot.transcriptObservation.sessionIds.includes(id))) {
                throw new Error('Live Sessions orchestration remains incomplete after transcript disappearance.');
            }
            return { ...snapshot, observation: { count: observations, elapsedMs: now() - started, pendingSessionIds: [...pending].sort() } };
        }
        if (observations < 128) await wait(Math.min(100, remaining()));
    }
    throw new Error('Live Sessions orchestration observation count exhausted with incomplete transcripts.');
}


export async function inspectOuterOrchestrationBinding(containerId, { execute = promisify(execFile) } = {}) {
    try {
        assert.match(containerId, /^[a-f0-9]{64}$/);
        const result = await execute('podman', ['container', 'inspect', containerId],
            { timeout: 8000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
        assert.equal(typeof result.stdout, 'string');
        assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
        const rows = JSON.parse(result.stdout);
        assert.ok(Array.isArray(rows) && rows.length === 1);
        const inspected = rows[0];
        assert.equal(inspected?.Id, containerId);
        assert.ok(typeof inspected.State?.StartedAt === 'string' && inspected.State.StartedAt.length > 0);
        assert.equal(typeof inspected.State?.Running, 'boolean');
        assert.ok(typeof inspected.Image === 'string' && inspected.Image.length > 0);
        assert.ok(Array.isArray(inspected.Mounts) && inspected.Mounts.every(mount => mount && typeof mount === 'object'
            && !Array.isArray(mount) && typeof mount.Destination === 'string' && mount.Destination.length > 0));
        // Keep every mount and its fields for the existing shadow/generation
        // fences, while withholding unrelated inspect data such as Config.Env.
        return { id: inspected.Id, startedAt: inspected.State.StartedAt, running: inspected.State.Running,
            image: inspected.Image, mounts: inspected.Mounts };
    } catch { throw new Error('Bounded outer orchestration binding could not be inspected.'); }
}

export async function createOrchestrationReader({ release, evidence, runtime, cwd, robotId, ownerPrincipal }, {
    env = process.env, createRuntimeReader = createLiveSkillsRuntimeReader,
    execute = promisify(execFile), nestedCommand, inspectNested = inspectNestedContainer, now, wait,
} = {}) {
    const guard = await createRuntimeReader({ env, baseURL: release.applicationBaseURL,
        verifierPath: env.SMOKE_COPILOT_RELEASE_VERIFIER
            || fileURLToPath(new URL('../../../../ploinky/tests/release/verifyCopilot421Bundle.mjs', import.meta.url)) });
    const initial = await guard.finish();
    assert.equal(initial.runtime.containerId, runtime.containerId);
    const initialInspection = inspectNested(evidence.outerContainerId, runtime.containerId, nestedCommand);
    const repository = fs.realpathSync(release.repositories.achillesCLI.repositoryPath);
    assert.ok(!repository.includes(`${path.sep}.ploinky${path.sep}repos${path.sep}`));
    const contractFiles = delegationContractFiles(repository);
    const contractHashes = Object.fromEntries(contractFiles.map(file => [file, crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(repository, 'roboTeamAgent', file))).digest('hex')]));
    const inspectOuter = (run = execute) => inspectOuterOrchestrationBinding(evidence.outerContainerId, { execute: run });
    const outerBinding = await inspectOuter();
    assert.equal(outerBinding.id, evidence.outerContainerId); assert.equal(outerBinding.running, true);
    rejectShadows(outerBinding.mounts, [cwd], outerBinding.mounts.filter(mount => mount.Destination === evidence.workspaceRoot), { subject: 'Live Sessions cwd' });
    rejectShadows(initialInspection.Mounts, [cwd], initialInspection.Mounts.filter(mount => mount.Destination === evidence.workspaceRoot), { subject: 'Live Sessions cwd' });
    const fixed = { cwd, workspaceRoot: evidence.workspaceRoot, expectedRepository: repository, contractFiles, contractHashes,
        expectedAla: initial.alaBinding, robotId, ownerPrincipal };
    const diagnostics = buildOrchestrationDiagnosticsBundle();
    assert.equal(evidence.workspaceHash, workspaceHash(evidence.workspaceRoot));
    const capture = async options => {
        // Full binding is frozen before the front observer starts. Its bounded
        // capture fences exact mounts/labels/PID and source hashes without
        // repeating the multi-process release verifier during a short turn.
        if (!options?.frontOnly) assert.deepEqual((await guard.finish()).runtime, initial.runtime);
        let snapshot, primary;
        try {
            snapshot = await observeOrchestration(async ({ remaining }) => {
                const boundedExecute = (command, args, limits) => execute(command, args, { ...limits, timeout: Math.min(limits.timeout, remaining()) });
                const boundedNested = (command, args, limits) => {
                    const timeout = remaining();
                    let output;
                    if (nestedCommand) output = nestedCommand(command, args, { ...limits, timeout });
                    else {
                        const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' });
                        if (result.error) throw new Error('Bounded nested orchestration inspection failed.');
                        if (result.status === 0) {
                            try { output = JSON.parse(result.stdout); }
                            catch { throw new Error('Bounded nested orchestration inspection returned invalid JSON.'); }
                        } else output = { ok: false, status: result.status, stdout: result.stdout, stderr: result.stderr };
                    }
                    remaining();
                    return output;
                };
                assert.deepEqual(await inspectOuter(boundedExecute), outerBinding, 'Outer Box generation or mounts changed during observation.');
                remaining();
                const before = inspectNested(evidence.outerContainerId, runtime.containerId, boundedNested);
                assert.equal(before?.Id, runtime.containerId); assert.equal(before?.State?.Running, true);
                assert.ok(JSON.stringify(before.Mounts) === JSON.stringify(initialInspection.Mounts), 'RoboTeam mounts changed during observation.');
                assert.ok(JSON.stringify(before.Config?.Labels) === JSON.stringify(initialInspection.Config?.Labels), 'RoboTeam generation labels changed.');
                for (const key of ['Pid', 'StartedAt']) assert.equal(before.State[key], initialInspection.State[key]);
                const args = { ...fixed, ...options };
                assert.deepEqual(buildOrchestrationDiagnosticsBundle().hashes, diagnostics.hashes, 'Canonical diagnostics source changed.');
                const script = buildOrchestrationProgram(args, { diagnostics });
                let result;
                try {
                    result = await boundedExecute('podman', ['exec', evidence.outerContainerId, '/usr/bin/podman', 'exec', runtime.containerId,
                        '/usr/local/bin/node', '--input-type=module', '--eval', script], { timeout: 12000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
                } catch (error) { result = error; }
                remaining();
                const observed = decodeOrchestrationProcessResult(result);
                assert.deepEqual(observed.codeHashes, contractHashes);
                const after = inspectNested(evidence.outerContainerId, runtime.containerId, boundedNested);
                for (const key of ['Pid', 'StartedAt', 'Running']) assert.equal(after?.State?.[key], before.State[key]);
                assert.ok(JSON.stringify(after.Mounts) === JSON.stringify(before.Mounts), 'RoboTeam mounts changed during read.');
                assert.ok(JSON.stringify(after.Config?.Labels) === JSON.stringify(before.Config?.Labels), 'RoboTeam generation labels changed during read.');
                assert.equal(after?.Id, before.Id);
                assert.deepEqual(await inspectOuter(boundedExecute), outerBinding, 'Outer Box generation or mounts changed during read.');
                remaining();
                return observed;
            }, { now, wait });
        } catch (error) { primary = error; }
        try { if (!options?.frontOnly) assert.deepEqual((await guard.finish()).runtime, initial.runtime); }
        catch (error) {
            if (primary) throw new AggregateError([primary, error], 'Orchestration observation and binding settlement failed.');
            throw error;
        }
        if (primary) throw primary;
        return snapshot;
    };
    const alaBinding = structuredClone(initial.alaBinding);
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    };
    Object.defineProperty(capture, 'alaBinding', { value: freeze(alaBinding), writable: false, configurable: false });
    return capture;
}

export async function terminateOwnedFlow(page, snapshot, expected) {
    assert.equal(snapshot.flow?.folder, expected.cwd);
    assert.equal(snapshot.flow?.ownerPrincipal, expected.ownerPrincipal);
    assert.equal(snapshot.task?.flowId, snapshot.flow?.id);
    assert.match(snapshot.flow.id, /^flow_[a-f0-9]{24}$/);
    const proofResponse = await page.request.get('/auth/token?agent=roboTeamAgent');
    assert.equal(proofResponse.status(), 200);
    const { browserMutation: proof } = await proofResponse.json();
    assert.equal(proof?.routeKey, 'roboTeamAgent'); assert.equal(proof?.origin, new URL(page.url()).origin);
    assert.ok(proof.csrfToken);
    const response = await page.request.post(`/base-agent-additional-server/roboTeamAgent/3001/api/roboflow/flows/${snapshot.flow.id}/terminate`, {
        headers: { origin: proof.origin, 'x-ploinky-browser-csrf-token': proof.csrfToken }, data: {}, maxRedirects: 0, timeout: 45000,
    });
    assert.equal(response.status(), 200, 'Exact owned workflow termination must settle.');
}
