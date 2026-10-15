import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { projectOrchestrationRecords, assertObserverWindow, assertOwnedSettlement, terminateOwnedFlow,
    snapshotWalFiles, assertWalFileFences, assertIdleWalReadmarkDelta, buildOrchestrationDiagnosticsBundle,
    buildOrchestrationProgram, decodeOrchestrationProcessResult, createOrchestrationReader,
    inspectOuterOrchestrationBinding } from './live-sessions-orchestration.mjs';
import { createLiveSessionFinalizer } from './live-sessions-diagnostics.mjs';
import { createLiveSkillsRuntimeReader, readLiveSkillsCodeHashes, readLiveSkillsSnapshot, program } from './copilot-live-skills-runtime.mjs';
import { delegationProgram, readDelegationSnapshot } from './copilot-workflow-delegation-runtime.mjs';
import { collectCopilotReleaseEvidence } from './copilot-release-evidence.mjs';

const outerId = 'a'.repeat(64);
function outerInspection() {
    return { Id: outerId, State: { StartedAt: '2026-10-16T10:00:00.123456789Z', Running: true, Pid: 1234 },
        Image: 'b'.repeat(64), Mounts: [
            { Type: 'bind', Source: '/workspace', Destination: '/workspace', RW: true, Options: ['rbind'] },
            { Type: 'volume', Name: 'runtime', Source: '/volumes/runtime', Destination: '/var/lib/containers', RW: true },
        ], Config: { Env: ['PRIVATE_TOKEN=neutral-private-value'], Labels: { private: 'neutral-private-label' } } };
}

test('outer binding reads full container JSON without Podman templates and preserves only the frozen projection', async () => {
    const inspected = outerInspection(), calls = [];
    const binding = await inspectOuterOrchestrationBinding(outerId, { execute: async (command, args, limits) => {
        calls.push({ command, args, limits });
        if (args.includes('--format')) throw new Error("Error: template: inspect:1:24: executing inspect at <.Id>: can't evaluate field Id in type interface {}");
        assert.equal(command, 'podman');
        assert.deepEqual(args, ['container', 'inspect', outerId]);
        return { stdout: JSON.stringify([inspected]) };
    } });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].limits, { timeout: 8000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    assert.deepEqual(binding, { id: outerId, startedAt: inspected.State.StartedAt, running: true,
        image: inspected.Image, mounts: inspected.Mounts });
    assert.deepEqual(Object.keys(binding).sort(), ['id', 'image', 'mounts', 'running', 'startedAt']);
    assert.ok(!JSON.stringify(binding).includes('neutral-private'));
    assert.ok(!JSON.stringify(binding).includes('Pid'));
});

test('outer binding rejects malformed, ambiguous, foreign and incomplete container inspections with safe errors', async t => {
    const safeError = error => {
        assert.equal(error.message, 'Bounded outer orchestration binding could not be inspected.');
        assert.equal(error.cause, undefined);
        assert.deepEqual(Object.keys(error), []);
        assert.ok(!error.stack.includes('neutral-private'));
        return true;
    };
    const invalid = {
        'malformed JSON': '{"Config":{"Env":["neutral-private-value"]}',
        'truncated template output': '{"id":',
        'object instead of array': JSON.stringify(outerInspection()),
        'null result': 'null',
        'empty array': '[]',
        'multiple matches': JSON.stringify([outerInspection(), outerInspection()]),
        'null row': '[null]',
        'wrong kind': JSON.stringify([{ Id: outerId, RepoTags: ['neutral-private-image'] }]),
        'wrong ID': JSON.stringify([{ ...outerInspection(), Id: 'c'.repeat(64) }]),
        'short ID': JSON.stringify([{ ...outerInspection(), Id: outerId.slice(0, 12) }]),
        'missing state': JSON.stringify([{ ...outerInspection(), State: undefined }]),
        'missing start time': JSON.stringify([{ ...outerInspection(), State: { Running: true } }]),
        'empty start time': JSON.stringify([{ ...outerInspection(), State: { StartedAt: '', Running: true } }]),
        'missing running': JSON.stringify([{ ...outerInspection(), State: { StartedAt: 'neutral' } }]),
        'coerced running': JSON.stringify([{ ...outerInspection(), State: { StartedAt: 'neutral', Running: 'true' } }]),
        'missing image': JSON.stringify([{ ...outerInspection(), Image: undefined }]),
        'empty image': JSON.stringify([{ ...outerInspection(), Image: '' }]),
        'missing mounts': JSON.stringify([{ ...outerInspection(), Mounts: undefined }]),
        'wrong mounts kind': JSON.stringify([{ ...outerInspection(), Mounts: {} }]),
        'null mount': JSON.stringify([{ ...outerInspection(), Mounts: [null] }]),
        'missing mount destination': JSON.stringify([{ ...outerInspection(), Mounts: [{ Type: 'bind' }] }]),
        'oversized stdout': ' '.repeat(1024 * 1024 + 1),
        'nontext stdout': Buffer.from('[]'),
    };
    for (const [name, stdout] of Object.entries(invalid)) await t.test(name, async () => {
        await assert.rejects(inspectOuterOrchestrationBinding(outerId, { execute: async () => ({ stdout }) }), safeError);
    });
    await t.test('subprocess errors cannot expose stdout, stderr, command or causes', async () => {
        const raw = Object.assign(new Error('neutral-private-command'), { stdout: 'neutral-private-stdout',
            stderr: 'neutral-private-stderr', cause: new Error('neutral-private-cause') });
        await assert.rejects(inspectOuterOrchestrationBinding(outerId, { execute: async () => { throw raw; } }), safeError);
    });
    await t.test('invalid selected IDs fail before invoking any command', async () => {
        let calls = 0;
        for (const id of [undefined, null, 123, '', 'box-name', outerId.slice(0, 12), 'A'.repeat(64), '--help', `${outerId}\n`]) {
            await assert.rejects(inspectOuterOrchestrationBinding(id, { execute: async () => { calls += 1; } }), safeError);
        }
        assert.equal(calls, 0);
    });
});

test('outer binding keeps stopped state and all generation and mount changes visible to the surrounding fences', async () => {
    const read = record => inspectOuterOrchestrationBinding(outerId, { execute: async () => ({ stdout: JSON.stringify([record]) }) });
    const baseline = await read(outerInspection());
    for (const mutate of [
        record => { record.State.StartedAt = '2026-10-16T10:01:00Z'; },
        record => { record.State.Running = false; },
        record => { record.Image = 'c'.repeat(64); },
        record => { record.Mounts.push({ Type: 'bind', Source: '/foreign', Destination: '/workspace/selected', RW: true }); },
        record => { record.Mounts[1].RW = false; },
        record => { record.Mounts[0].Options = ['ro']; },
    ]) {
        const changed = outerInspection(); mutate(changed);
        assert.notDeepEqual(await read(changed), baseline);
    }
    const stopped = outerInspection(); stopped.State.Running = false;
    assert.equal((await read(stopped)).running, false);
    const unmounted = outerInspection(); unmounted.Mounts = [];
    assert.deepEqual((await read(unmounted)).mounts, []);
});

test('orchestration reader carries the verifier path across the actual runtime and release collector boundary', async t => {
    const fallback = fileURLToPath(new URL('../../../../ploinky/tests/release/verifyCopilot421Bundle.mjs', import.meta.url));
    for (const override of [undefined, '/neutral/pinned/verify-release.mjs', 'relative-verifier.mjs']) {
        await t.test(override || 'canonical fallback', async () => {
            const stopped = new Error('neutral verifier load reached');
            let loaded;
            const env = { SMOKE_PLOINKY_BOX_CONTAINER: 'neutral-box', SMOKE_BOX_BASE_URL: 'http://localhost:19082',
                SMOKE_WORKSPACE_ROOT: '/neutral/fixture', SMOKE_RELEASE_MANIFEST: '/neutral/release.json',
                ...(override ? { SMOKE_COPILOT_RELEASE_VERIFIER: override } : {}) };
            const input = { release: { applicationBaseURL: env.SMOKE_BOX_BASE_URL } };
            const createRuntimeReader = options => createLiveSkillsRuntimeReader(options, {
                fsApi: { realpathSync: value => value },
                collectRelease: options => collectCopilotReleaseEvidence({ ...options,
                    loadVerifier: async filename => { loaded = filename; throw stopped; } }),
                runCommand: async () => { throw new Error('No container command is allowed at this boundary.'); },
            });
            if (override && !path.isAbsolute(override)) {
                await assert.rejects(createOrchestrationReader(input, { env, createRuntimeReader }), /requires an absolute release verifier path/);
                assert.equal(loaded, undefined);
            } else {
                await assert.rejects(createOrchestrationReader(input, { env, createRuntimeReader }), error => error === stopped);
                assert.equal(loaded, override || fallback);
            }
        });
    }
});

const cwd = '/workspace/selected', robotId = 'default-123456', ownerPrincipal = 'user:owner';
const options = { cwd, robotId, ownerPrincipal, frontSessionId: 'front', requestDigest: 'request-digest', requirePhase: true,
    baseline: { sessions: [], turns: [], tasks: [], flows: [], phases: [], executions: [] } };
function fixture() {
    return { sessions: [
        { sessionId: 'front', cwd, robotId, metadataObserved: true, backend: 'opencode', turns: [{ turnId: 'launch', assistantMessageId: 'assistant', userDigest: 'request-digest', nativeObserved: true, status: 'completed' }] },
        { sessionId: 'worker', cwd, robotId, metadataObserved: true, backend: 'opencode', turns: [{ turnId: 'execute', assistantMessageId: 'worker-assistant', userDigest: 'worker-digest', status: 'running' }] },
    ], tasks: [{ id: 'task_background', sessionId: 'front', turnId: 'launch', assistantMessageId: 'assistant', targetAgent: 'roboTeamAgent', toolName: 'roboflow_start_flow', flowId: 'flow_0123456789abcdef01234567' }],
    flows: [{ id: 'flow_0123456789abcdef01234567', folder: cwd, ownerPrincipal, workflowTypeId: 'default', status: 'running',
        instances: [{ id: 'phase', robotId, runtimeTaskId: 'runtime', state: 'running' }] }],
    executions: [{ taskId: 'runtime', alaSessionId: 'worker', robotId, cwd, ownerPrincipal, flowId: 'flow_0123456789abcdef01234567', instanceId: 'phase', state: 'running', turns: [{ turnId: 'execute', status: 'running', followUpDigests: [] }] }] };
}

test('exact durable chain correlates distinct front, flow, execution and native IDs', () => {
    const records = fixture(), snapshot = projectOrchestrationRecords(records, options);
    assert.equal(snapshot.front.turnId, 'launch');
    assert.equal(snapshot.execution.turns[0].turnId, 'execute');
    assert.notEqual(snapshot.front.sessionId, snapshot.execution.alaSessionId);
    assertObserverWindow(snapshot, projectOrchestrationRecords(records, options));
    assert.equal(JSON.stringify(snapshot).includes('prompt'), false);
});

test('missing, duplicate, stale, foreign and inconsistent durable links fail closed', async t => {
    const cases = {
        'missing front': value => { value.sessions.shift(); },
        'unbacked front': value => { value.sessions[0].metadataObserved = false; },
        'missing runtime conversation': value => { value.sessions.pop(); },
        'foreign runtime owner': value => { value.executions[0].ownerPrincipal = 'user:foreign'; },
        'duplicate request': value => { value.sessions[0].turns.push({ ...value.sessions[0].turns[0], turnId: 'extra' }); },
        'missing background': value => { value.tasks = []; },
        'wrong assistant': value => { value.tasks[0].assistantMessageId = 'other'; },
        'wrong turn': value => { value.tasks[0].turnId = 'other'; },
        'wrong target': value => { value.tasks[0].targetAgent = 'other'; },
        'duplicate launch': value => { value.tasks.push({ ...value.tasks[0], id: 'another' }); },
        'foreign folder': value => { value.flows[0].folder = '/foreign/selected'; },
        'wrong owner': value => { value.flows[0].ownerPrincipal = 'user:foreign'; },
        'wrong workflow': value => { value.flows[0].workflowTypeId = 'custom'; },
        'missing phase': value => { value.flows[0].instances = []; },
        'duplicate phase': value => { value.flows[0].instances.push({ ...value.flows[0].instances[0], id: 'another' }); },
        'wrong runtime': value => { value.executions[0].taskId = 'other'; },
        'wrong flow link': value => { value.executions[0].flowId = 'other'; },
        'wrong instance link': value => { value.executions[0].instanceId = 'other'; },
        'wrong worker robot': value => { value.executions[0].robotId = 'foreign'; },
        'multiple native turns': value => { value.executions[0].turns.push({ turnId: 'extra' }); },
        'invalid ID': value => { value.sessions[0].sessionId = '../foreign'; },
        'overlong metadata': value => { value.sessions[0].turns = Array(513).fill(value.sessions[0].turns[0]); },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, () => {
        const records = fixture(); mutate(records);
        assert.throws(() => projectOrchestrationRecords(records, options));
    });
    for (const [kind, stale] of [['turns', 'front:launch'], ['tasks', 'task_background'], ['flows', 'flow_0123456789abcdef01234567']]) {
        assert.throws(() => projectOrchestrationRecords(fixture(), { ...options, baseline: { ...options.baseline, [kind]: [stale] } }), /stale/);
    }
});

test('complete census detects a short-lived extra durable turn after observers', () => {
    const records = fixture(), before = projectOrchestrationRecords(records, options);
    records.sessions[1].turns.push({ turnId: 'short-lived', userDigest: 'extra', status: 'completed' });
    const after = projectOrchestrationRecords(records, options);
    assert.throws(() => assertObserverWindow(before, after), /short-lived durable execution/);
});

test('settlement retains cwd for live workers, viewers, paused or foreign flows', () => {
    const snapshot = projectOrchestrationRecords(fixture(), options), expected = { cwd, ownerPrincipal, flowId: snapshot.flow.id };
    assert.throws(() => assertOwnedSettlement(snapshot, expected, []), /settle/);
    snapshot.flow.status = 'terminated'; snapshot.flow.instances[0].state = 'terminated';
    assertOwnedSettlement(snapshot, expected, [], [{ status: 'stopped', viewerCount: 0 }]);
    assert.throws(() => assertOwnedSettlement(snapshot, expected, [{ pid: 123 }]));
    assert.throws(() => assertOwnedSettlement(snapshot, expected, [], [{ status: 'stopped', viewerCount: 1 }]));
    assert.throws(() => assertOwnedSettlement(snapshot, { ...expected, ownerPrincipal: 'user:foreign' }, []));
});

test('cleanup terminates only exact correlated flow through authenticated mutation and preserves unrelated flow', async () => {
    const snapshot = projectOrchestrationRecords(fixture(), options), calls = [], states = new Map([[snapshot.flow.id, 'running'], ['flow_unrelated', 'running']]);
    const page = { url: () => 'http://fixture.test/', request: {
        get: async () => ({ status: () => 200, json: async () => ({ browserMutation: { routeKey: 'roboTeamAgent', origin: 'http://fixture.test', csrfToken: 'proof' } }) }),
        post: async (url, args) => { calls.push({ url, args }); states.set(url.split('/').at(-2), 'terminated'); return { status: () => 200 }; },
    } };
    await terminateOwnedFlow(page, snapshot, { cwd, ownerPrincipal });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/base-agent-additional-server/roboTeamAgent/3001/api/roboflow/flows/${snapshot.flow.id}/terminate`);
    assert.equal(calls[0].args.headers['x-ploinky-browser-csrf-token'], 'proof');
    assert.equal(states.get(snapshot.flow.id), 'terminated');
    assert.equal(states.get('flow_unrelated'), 'running');
    await assert.rejects(terminateOwnedFlow(page, snapshot, { cwd, ownerPrincipal: 'user:foreign' }));
    assert.equal(calls.length, 1);
});

test('WAL sidecar guards reject missing, symlink, replacement, type and shared-memory size changes', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-wal-guards-'))), database = `${root}/database`;
    try {
        fs.writeFileSync(database + '-wal', Buffer.alloc(0)); fs.writeFileSync(database + '-shm', Buffer.alloc(32768));
        const before = snapshotWalFiles(database);
        assertWalFileFences(before, snapshotWalFiles(database));
        assertWalFileFences(before, before.map(file => file.suffix === '-wal' ? { ...file, size: 1234 } : file));
        for (const key of ['ino', 'dev', 'file']) assert.throws(() => assertWalFileFences(before, before.map((file, index) => index ? { ...file, [key]: key === 'file' ? '/other' : file[key] + 1 } : file)));
        assert.throws(() => assertWalFileFences(before, before.map((file, index) => index ? { ...file, size: file.size + 32768 } : file)));
        for (const suffix of ['-wal', '-shm']) {
            const file = database + suffix, saved = fs.readFileSync(file);
            fs.unlinkSync(file); assert.throws(() => snapshotWalFiles(database));
            fs.symlinkSync(database + (suffix === '-wal' ? '-shm' : '-wal'), file);
            assert.throws(() => snapshotWalFiles(database)); fs.unlinkSync(file);
            fs.mkdirSync(file); assert.throws(() => snapshotWalFiles(database)); fs.rmdirSync(file);
            fs.writeFileSync(file, saved);
        }
        fs.writeFileSync(database + '-shm', Buffer.alloc(128)); assert.throws(() => snapshotWalFiles(database));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('idle SQLite exception decodes only readmark bytes and refuses lock/header/geometry mutations', () => {
    const before = Buffer.alloc(32768), after = Buffer.from(before);
    after.writeUInt32LE(1234, 104);
    const delta = assertIdleWalReadmarkDelta(before, after, 'LE');
    assert.deepEqual(delta.changedOffsets, [104, 105]); assert.equal(delta.readmarksAfter[1], 1234);
    for (const offset of [0, 96, 99, 120, 127, 128, 32767]) {
        const changed = Buffer.from(before); changed[offset] = 1;
        assert.throws(() => assertIdleWalReadmarkDelta(before, changed, 'LE'), /outside/);
    }
    assert.throws(() => assertIdleWalReadmarkDelta(before, Buffer.alloc(65536), 'LE'));
});

test('fixed canonical diagnostics bundle preserves its graph and generates a bounded valid production module', () => {
    const bundle = buildOrchestrationDiagnosticsBundle();
    assert.deepEqual(Object.keys(bundle.hashes), ['security.mjs', 'redacted-trace.mjs', 'release-gate-failures.mjs', 'live-sessions-diagnostics.mjs']);
    for (const hash of Object.values(bundle.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
    assert.ok(!/^export /m.test(bundle.source));
    assert.ok(!/^import .*from ['"]\./m.test(bundle.source));
    const source = buildOrchestrationProgram({});
    assert.ok(source.includes('readLiveSessionOrchestration'));
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.throws(() => buildOrchestrationProgram({ overlong: 'x'.repeat(128 * 1024) }), /single-argument capacity/);
    const invalidSource = { ...fs, readFileSync(fd) { return Buffer.from(fs.readFileSync(fd).toString().replace("import { collectSecrets } from './security.mjs';", "import { collectSecrets } from './wrongmod.mjs';")); } };
    assert.throws(() => buildOrchestrationDiagnosticsBundle({ fsApi: invalidSource }), /relative import|dependency/);
});

test('all three serialized collectors embed the exact self-contained hash helper and preserve runtime imports', () => {
    const helper = `const readLiveSkillsCodeHashes = ${readLiveSkillsCodeHashes.toString()};`;
    for (const source of [program(readLiveSkillsSnapshot, {}), buildOrchestrationProgram({}), delegationProgram(readDelegationSnapshot, {})]) {
        assert.ok(source.includes(helper), 'The collector must embed the exact shared helper.');
        assert.equal(source.split(helper).length, 2, 'Embed the helper exactly once.');
        assert.ok(Buffer.byteLength(source) < 128 * 1024);
        assert.match(source, /codeRoot = '\/code'/);
        assert.match(source, /import\(pathToFileURL\(`\$\{codeRoot\}\//);
        assert.doesNotMatch(helper, /import\(['"](?:\/code|\.\/)/);
        const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
        assert.equal(syntax.status, 0, syntax.stderr);
    }
});

test('actual generated subprocess wrapper preserves safe primary and settlement children through host finalization', async () => {
    async function failedCollector() {
        const primary = new Error('query-primary neutral-process-secret-canary\nauthorization: Bearer private-header-canary');
        primary.cause = primary;
        throw new AggregateError([primary, new Error('close-settlement'), new Error('sidecar-fence')], 'query-and-settlement');
    }
    const source = buildOrchestrationProgram({}, { collector: failedCollector });
    const processResult = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
        env: { PATH: process.env.PATH, FIXTURE_SECRET: 'neutral-process-secret-canary' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(processResult.status, 1); assert.equal(processResult.stderr, '');
    assert.ok(!processResult.stdout.includes('neutral-process-secret-canary'));
    assert.ok(!processResult.stdout.includes('private-header-canary'));
    let primary;
    assert.throws(() => decodeOrchestrationProcessResult({ stdout: processResult.stdout, code: 1 }), error => {
        primary = error;
        for (const detail of ['query-primary', 'close-settlement', 'sidecar-fence', 'cyclic error reference']) assert.ok(error.message.includes(detail), detail);
        return true;
    });
    let attachment;
    await assert.rejects(createLiveSessionFinalizer().finish({ attach(_name, args) { attachment = args.body.toString(); } }, primary), error => {
        for (const detail of ['query-primary', 'close-settlement', 'sidecar-fence']) {
            assert.ok(error.message.includes(detail)); assert.ok(attachment.includes(detail));
        }
        assert.ok(!error.message.includes('neutral-process-secret-canary')); assert.ok(!attachment.includes('private-header-canary'));
        return true;
    });
    assert.throws(() => decodeOrchestrationProcessResult({ stdout: 'not JSON', code: 1, stderr: 'private raw process data' }), /raw process errors withheld/);
});

// This runs the exported collector with actual pinned sibling APIs and SQLite.
// Only its I/O/path boundary is injected; production invokes the defaults.
async function actualMetadataFixture({ root, repository, alaRoot, readerURL, hashReaderURL, evidenceDirectory, wrapperFailure = false }) {
    const assert = (await import('node:assert/strict')).default;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { createHash, randomUUID } = await import('node:crypto');
    const { readLiveSessionOrchestration, assertObserverWindow, assertIdleWalReadmarkDelta } = await import(readerURL);
    const { endianness } = await import('node:os');
    const { delegationContractFiles } = await import(hashReaderURL);
    const codeRoot = `${repository}/roboTeamAgent`, cwd = `${root}/selected`, dataRoot = `${root}/data`;
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    for (const directory of [cwd, dataRoot, `${root}/home`]) fs.mkdirSync(directory, { recursive: true });
    const { ConversationSessionStore } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/storage/conversationSessionStore.mjs`).href);
    const { RoboFlowDatabase } = await import(pathToFileURL(`${codeRoot}/server/roboflow/database.mjs`).href);
    const { TaskFlowStore } = await import(pathToFileURL(`${codeRoot}/server/roboflow/task-flow-store.mjs`).href);
    const robotId = 'default-123456', ownerPrincipal = 'user:fixture-owner', prompt = 'neutral delegated objective';
    const frontSessionId = randomUUID(), workerSessionId = randomUUID(), runtimeTaskId = randomUUID();
    const flowId = 'flow_0123456789abcdef01234567', instanceId = 'inv_0123456789abcdef01234567';
    const sessions = new ConversationSessionStore({ workingDir: cwd });
    ConversationSessionStore.prototype.loadSession = () => { throw new Error('Unconfined composed-session reread is forbidden.'); };
    const nativeTurns = new Map();
    for (const [sessionId, text] of [[frontSessionId, prompt], [workerSessionId, 'neutral worker objective']]) {
        const turnId = randomUUID(), assistantMessageId = randomUUID(), userMessageId = randomUUID(), at = new Date().toISOString();
        const file = sessions.sessionPath(sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ version: 2, sessionId, cwd, createdAt: at, updatedAt: at,
            engine: { type: 'ala', version: 1, sessionId, home: `${root}/home`, cwd, backend: 'opencode', robotId },
            turns: [{ turnId, assistantMessageId, userMessageId, timestamp: at, attachments: [], references: [], tasks: [] }] }));
        nativeTurns.set(sessionId, { turnId, assistantMessageId });
        fs.mkdirSync(`${cwd}/.roboteam/.ala/sessions`, { recursive: true });
        const records = [{ type: 'session', id: sessionId, at }, { type: 'continuation', agent: 'opencode', continuation: {}, at },
            { type: 'user', turnId, text, seq: 1, at }];
        fs.writeFileSync(`${cwd}/.roboteam/.ala/sessions/${sessionId}.jsonl`, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    }
    const front = nativeTurns.get(frontSessionId), worker = nativeTurns.get(workerSessionId);
    const taskId = 'task_0123456789abcdef01234567';
    fs.mkdirSync(`${cwd}/.roboteam/tasks/${taskId}`, { recursive: true });
    fs.writeFileSync(`${cwd}/.roboteam/tasks/${taskId}/task.json`, JSON.stringify({ version: 1, id: taskId,
        targetAgent: 'roboTeamAgent', toolName: 'roboflow_start_flow', remoteTaskId: flowId,
        sessionId: frontSessionId, turnId: front.turnId, assistantMessageId: front.assistantMessageId,
        details: { url: `/base-agent-additional-server/roboTeamAgent/3001/roboflow?flowId=${flowId}` }, status: 'ongoing' }));
    const request = { cwd, workflowRunId: flowId, workflowInstanceId: instanceId, runtimeTaskId, ownerPrincipal };
    const execution = { taskId: runtimeTaskId, alaSessionId: workerSessionId, robotId, request, state: 'running' };
    fs.mkdirSync(`${cwd}/.roboteam/tasks/${workerSessionId}/executions`, { recursive: true });
    fs.writeFileSync(`${cwd}/.roboteam/tasks/${workerSessionId}/task.json`, JSON.stringify({ id: workerSessionId, robotId, request }));
    fs.writeFileSync(`${cwd}/.roboteam/tasks/${workerSessionId}/executions/${runtimeTaskId}.json`, JSON.stringify(execution));
    const database = new RoboFlowDatabase(`${dataRoot}/roboflow/roboflow.sqlite`); database.initialize();
    new TaskFlowStore({ database }).saveSync({ id: flowId, workflowTypeId: 'default', folder: cwd, ownerPrincipal, status: 'running',
        instances: [{ id: instanceId, sequence: 1, robotId, runtimeTaskId, state: 'running' }] });
    TaskFlowStore.prototype.initialize = () => { throw new Error('Observer attempted initializing workflow store'); };
    const contractFiles = delegationContractFiles(repository);
    const contractHashes = Object.fromEntries(contractFiles.map(file => [file, hash(fs.readFileSync(`${codeRoot}/${file}`))]));
    const expectedAla = { root: alaRoot, command: `${alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
        .map(file => [file, hash(fs.readFileSync(`${alaRoot}/${file}`))])) };
    // macOS has no /proc/self/fd. This adapter resolves only descriptors opened
    // by the real source-hash reader; all file reads remain real Node fs I/O.
    const descriptors = new Map(), opened = [], readFiles = [];
    const fsApi = { ...fs, openSync(file, flags) { const fd = fs.openSync(file, flags); opened.push(file); descriptors.set(fd, fs.realpathSync(file)); return fd; },
        readFileSync(file, ...args) { readFiles.push(typeof file === 'number' ? descriptors.get(file) : file); return fs.readFileSync(file, ...args); },
        closeSync(fd) { descriptors.delete(fd); fs.closeSync(fd); },
        realpathSync(file) { const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/); return fs.realpathSync(match ? descriptors.get(Number(match[1])) : file); } };
    const options = { cwd, workspaceRoot: root, expectedRepository: repository, contractFiles, contractHashes, expectedAla,
        robotId, ownerPrincipal, frontSessionId, requestDigest: hash(prompt), requirePhase: true,
        baseline: { sessions: [], turns: [], tasks: [], flows: [], phases: [], executions: [] } };
    function tree(directory) {
        const result = {};
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) Object.assign(result, tree(file));
            else { const stat = fs.statSync(file); result[file] = { hash: hash(fs.readFileSync(file)), size: stat.size, mtimeMs: stat.mtimeMs }; }
        }
        return result;
    }
    const shmFile = `${dataRoot}/roboflow/roboflow.sqlite-shm`;
    const before = tree(root), shmBefore = fs.readFileSync(shmFile);
    let first, second;
    await readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi, emit: value => { first = value; } });
    await readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi, emit: value => { second = value; } });
    assertObserverWindow(first, second);
    const after = tree(root), delta = assertIdleWalReadmarkDelta(shmBefore, fs.readFileSync(shmFile), endianness());
    const expected = { ...before, [shmFile]: { ...before[shmFile], hash: after[shmFile].hash } };
    assert.deepEqual(after, expected, 'Idle observer preserves inventory and DB/WAL/session/task bytes; only decoded SHM read marks may change.');
    if (evidenceDirectory) {
        fs.writeFileSync(`${evidenceDirectory}/approved-idle-writer-before.json`, JSON.stringify(before, null, 2));
        fs.writeFileSync(`${evidenceDirectory}/approved-idle-writer-after.json`, JSON.stringify(after, null, 2));
        fs.writeFileSync(`${evidenceDirectory}/approved-idle-writer-readmarks.json`, JSON.stringify(delta, null, 2));
    }
    assert.equal(first.front.turnId, front.turnId); assert.equal(first.execution.turns[0].turnId, worker.turnId);
    assert.equal(first.task.flowId, flowId); assert.equal(first.flow.ownerPrincipal, ownerPrincipal);
    let frontOnly;
    await readLiveSessionOrchestration({ ...options, requirePhase: false, frontOnly: true }, { codeRoot, dataRoot, fsApi, emit: value => { frontOnly = value; } });
    assert.equal(frontOnly.front.turnId, front.turnId); assert.equal(frontOnly.flow, null);
    const afterFront = tree(root);
    assertIdleWalReadmarkDelta(shmBefore, fs.readFileSync(shmFile), endianness());
    assert.deepEqual(afterFront, { ...before, [shmFile]: { ...before[shmFile], hash: afterFront[shmFile].hash } });
    const configFile = sessions.sessionPath(frontSessionId), originalConfig = fs.readFileSync(configFile, 'utf8');
    const foreignRoot = `${root}/foreign`, foreignTranscript = `${foreignRoot}/.roboteam/.ala/sessions/${frontSessionId}.jsonl`;
    fs.mkdirSync(path.dirname(foreignTranscript), { recursive: true });
    fs.writeFileSync(foreignTranscript, 'foreign transcript must never be opened');
    fs.utimesSync(foreignTranscript, new Date(1000), new Date());
    const foreignAtime = fs.statSync(foreignTranscript).atimeMs;
    for (const field of ['cwd', 'engine.cwd']) {
        const metadata = JSON.parse(originalConfig);
        if (field === 'cwd') metadata.cwd = foreignRoot; else metadata.engine.cwd = foreignRoot;
        fs.writeFileSync(configFile, JSON.stringify(metadata)); opened.length = 0;
        await assert.rejects(readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi, emit() {} }), /cwd|confined/);
        assert.ok(!opened.some(file => file.includes('/.ala/sessions/')), 'Reject metadata context before opening any ALA transcript.');
        assert.equal(fs.statSync(foreignTranscript).atimeMs, foreignAtime);
    }
    fs.writeFileSync(configFile, originalConfig);
    opened.length = 0;
    let replacedConfig = false, raceSnapshot;
    const configRaceFs = { ...fsApi, closeSync(fd) {
        const file = descriptors.get(fd); fsApi.closeSync(fd);
        if (file === configFile && !replacedConfig) {
            replacedConfig = true;
            const metadata = JSON.parse(originalConfig); metadata.engine.cwd = foreignRoot;
            fs.writeFileSync(configFile, JSON.stringify(metadata));
        }
    } };
    await readLiveSessionOrchestration({ ...options, requirePhase: false, frontOnly: true }, { codeRoot, dataRoot, fsApi: configRaceFs, emit: value => { raceSnapshot = value; } });
    assert.equal(raceSnapshot.front.cwd, cwd);
    assert.equal(opened.filter(file => file === configFile).length, 1, 'No canonical config reread after its bounded validation.');
    assert.equal(fs.statSync(foreignTranscript).atimeMs, foreignAtime);
    fs.writeFileSync(configFile, originalConfig);
    fs.writeFileSync(`${foreignRoot}/config.json`, originalConfig);
    const sessionDirectory = path.dirname(configFile), savedDirectory = `${sessionDirectory}.saved`;
    let switched = false;
    const pathRaceFs = { ...fsApi, openSync(file, flags) {
        if (file !== configFile || switched) return fsApi.openSync(file, flags);
        switched = true; fs.renameSync(sessionDirectory, savedDirectory); fs.symlinkSync(foreignRoot, sessionDirectory);
        try { return fsApi.openSync(file, flags); }
        finally { fs.unlinkSync(sessionDirectory); fs.renameSync(savedDirectory, sessionDirectory); }
    } };
    readFiles.length = 0;
    await assert.rejects(readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi: pathRaceFs, emit() {} }), /descriptor escaped/);
    assert.ok(!readFiles.some(file => file.startsWith(foreignRoot)), 'Actual opened foreign descriptor is rejected before reading.');
    assert.equal(fs.statSync(foreignTranscript).atimeMs, foreignAtime);
    for (const suffix of ['-wal', '-shm']) {
        const file = `${dataRoot}/roboflow/roboflow.sqlite${suffix}`, bytes = fs.readFileSync(file);
        fs.unlinkSync(file);
        const missingBefore = tree(root);
        await assert.rejects(readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi, emit() {} }));
        assert.deepEqual(tree(root), missingBefore, `Missing ${suffix} must fail before SQLite can create it.`);
        fs.writeFileSync(file, bytes);
    }
    const { DatabaseSync } = await import('node:sqlite');
    const getSync = TaskFlowStore.prototype.getSync, close = DatabaseSync.prototype.close;
    let sidecarReads = 0;
    const fencedFs = { ...fsApi, lstatSync(file) {
        const stat = fsApi.lstatSync(file);
        if (file === shmFile && ++sidecarReads > 2) return { ...stat, ino: stat.ino + 1, isFile: () => true, isSymbolicLink: () => false };
        return stat;
    } };
    try {
        TaskFlowStore.prototype.getSync = () => { throw new Error('neutral primary query failure'); };
        DatabaseSync.prototype.close = function () { close.call(this); throw new Error('neutral close failure'); };
        if (wrapperFailure) await readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi: fencedFs, emit() {} });
        else await assert.rejects(readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi: fencedFs, emit() {} }), error => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 3);
            assert.equal(error.errors[0].message, 'neutral primary query failure');
            assert.equal(error.errors[1].cause.message, 'neutral close failure');
            assert.match(error.errors[2].message, /sidecar fence/);
            return true;
        });
    } finally { TaskFlowStore.prototype.getSync = getSync; DatabaseSync.prototype.close = close; }
    const changedHashes = { ...contractHashes, [contractFiles[0]]: '0'.repeat(64) };
    await assert.rejects(readLiveSessionOrchestration({ ...options, contractHashes: changedHashes }, { codeRoot, dataRoot, fsApi, emit() {} }));
    fs.writeFileSync(`${cwd}/.roboteam/tasks/${workerSessionId}/executions/${runtimeTaskId}.json`, JSON.stringify({ ...execution, request: { ...request, ownerPrincipal: 'user:foreign' } }));
    await assert.rejects(readLiveSessionOrchestration(options, { codeRoot, dataRoot, fsApi, emit() {} }));
    process.stdout.write(JSON.stringify({ actualCanonicalReaders: true, readonlySQLite: true, unchangedRepeatedReads: true,
        readmarkDelta: delta, missingSidecarsFailBeforeOpen: true, queryAndSettlementFailuresPreserved: true,
        foreignTranscriptNeverOpened: true, noConfigReread: true, actualDescriptorRaceRejectedBeforeRead: true,
        frontOnly: true, sourceHashDriftRejected: true, foreignRuntimeOwnerRejected: true }));
    database.close();
}

// An explicit external probe keeps ordinary Explorer unit tests self-contained.
// Both source inputs must be pinned copies, supplied by the verification job.
if (process.env.LIVE_SESSIONS_ORCHESTRATION_SOURCE || process.env.LIVE_SESSIONS_ORCHESTRATION_ALA) test('actual canonical metadata readers and read-only SQLite preserve neutral fixture files and reject drift', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-orchestration-api-')));
    const repository = process.env.LIVE_SESSIONS_ORCHESTRATION_SOURCE;
    const alaRoot = process.env.LIVE_SESSIONS_ORCHESTRATION_ALA;
    try {
        assert.ok(repository && path.isAbsolute(repository) && alaRoot && path.isAbsolute(alaRoot), 'The external metadata probe needs both exact source paths.');
        assert.ok(fs.existsSync(`${repository}/roboTeamAgent/server/roboflow/task-flow-store.mjs`), 'Canonical AchillesCLI source fixture prerequisite is missing.');
        assert.ok(fs.existsSync(`${alaRoot}/bin/ala.mjs`), 'Canonical ALA transcript source fixture prerequisite is missing.');
        const args = { root, repository, alaRoot, evidenceDirectory: process.env.LIVE_SESSIONS_ORCHESTRATION_EVIDENCE_DIR,
            readerURL: new URL('./live-sessions-orchestration.mjs', import.meta.url).href,
            hashReaderURL: new URL('./copilot-workflow-delegation-runtime.mjs', import.meta.url).href };
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `(${actualMetadataFixture.toString()})(${JSON.stringify(args)}).catch(error => { console.error(error.stack); process.exitCode=1; });`], {
            env: { PATH: process.env.PATH, ACHILLES_ALA_COMMAND: `${alaRoot}/bin/ala.mjs`, PLOINKY_WORKSPACE_ROOT: root }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).actualCanonicalReaders, true);
        if (args.evidenceDirectory) fs.writeFileSync(`${args.evidenceDirectory}/actual-probe-contracts.json`, result.stdout);
        const failureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-orchestration-wire-')));
        try {
            const program = buildOrchestrationProgram({ ...args, root: failureRoot, wrapperFailure: true }, { collector: actualMetadataFixture });
            const failed = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
                env: { PATH: process.env.PATH, ACHILLES_ALA_COMMAND: `${alaRoot}/bin/ala.mjs`, PLOINKY_WORKSPACE_ROOT: failureRoot },
                encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
            });
            assert.equal(failed.status, 1);
            const payload = JSON.parse(failed.stdout);
            assert.equal(payload.kind, 'live-session-orchestration-error');
            assert.equal(payload.error.errors.length, 3);
            if (args.evidenceDirectory) fs.writeFileSync(`${args.evidenceDirectory}/actual-wrapper-failure.json`, failed.stdout);
            let primary;
            assert.throws(() => decodeOrchestrationProcessResult({ stdout: failed.stdout, code: 1 }), error => { primary = error; return true; });
            let attachment;
            await assert.rejects(createLiveSessionFinalizer().finish({ attach(_name, options) { attachment = options.body.toString(); } }, primary), error => {
                for (const detail of ['neutral primary query failure', 'neutral close failure', 'sidecar fence failed']) {
                    assert.ok(error.message.includes(detail), detail); assert.ok(attachment.includes(detail), detail);
                }
                return true;
            });
        } finally { fs.rmSync(failureRoot, { recursive: true, force: true }); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
