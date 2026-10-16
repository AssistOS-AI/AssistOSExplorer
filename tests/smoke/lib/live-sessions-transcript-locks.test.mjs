import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readOrchestrationTranscripts, observeOrchestration, decodeOrchestrationProcessResult,
    createOrchestrationReader, readLiveSessionOrchestration, buildOrchestrationProgram } from './live-sessions-orchestration.mjs';
import { delegationContractFiles } from './copilot-workflow-delegation-runtime.mjs';
import { projectLiveSessionError, createLiveSessionFinalizer } from './live-sessions-diagnostics.mjs';

const repository = process.env.LIVE_SESSIONS_ORCHESTRATION_SOURCE;
const alaRoot = process.env.LIVE_SESSIONS_ORCHESTRATION_ALA;
assert.ok(repository && path.isAbsolute(repository) && fs.existsSync(`${repository}/roboTeamAgent/server/ala-command.mjs`),
    'Qualified transcript-lock checks require LIVE_SESSIONS_ORCHESTRATION_SOURCE with pinned canonical AchillesCLI sources.');
assert.ok(alaRoot && path.isAbsolute(alaRoot) && fs.existsSync(`${alaRoot}/src/session-state.mjs`),
    'Qualified transcript-lock checks require LIVE_SESSIONS_ORCHESTRATION_ALA with pinned canonical ALA sources.');
const transcript = await import(pathToFileURL(`${alaRoot}/src/transcript.mjs`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canary = 'f6f57599-8390-4e41-8b77-b8f603e89bc2';
const owner = () => ({ host: os.hostname(), pid: process.pid, start: '123456', token: canary });
const codeHashes = { fixture: 'a'.repeat(64) };
const pending = ids => ({ version: 1, kind: 'live-session-orchestration-incomplete', codeHashes,
    pendingSessionIds: ids, reason: 'transcript-publication-pending' });
const complete = ids => ({ codeHashes, transcriptObservation: { status: 'complete', sessionIds: ids },
    census: { sessions: ids }, front: null, task: null, flow: null, phase: null, execution: null });

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-locks-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = `${root}/sessions`, id = randomUUID(), descriptors = new Map();
    fs.mkdirSync(directory, { mode: 0o700 });
    const file = `${directory}/${id}.jsonl`, lock = `${file}.lock`;
    const io = { ...fs,
        openSync(file, ...args) { const fd = fs.openSync(file, ...args); descriptors.set(fd, file); return fd; },
        closeSync(fd) { try { return fs.closeSync(fd); } finally { descriptors.delete(fd); } },
        realpathSync(file) {
            const match = String(file).match(/^\/proc\/self\/fd\/(\d+)$/);
            // Test-only descriptor adapter on platforms without procfs. Actual
            // canonical-producer qualification below requires Linux and real fs.
            return fs.realpathSync(process.platform !== 'linux' && match ? descriptors.get(Number(match[1])) : file);
        },
    };
    const writeTranscript = (sessionId = id) => fs.writeFileSync(file,
        JSON.stringify({ seq: 1, type: 'session', id: sessionId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const writeLock = (value = owner()) => fs.writeFileSync(lock, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
    const read = (fsApi = io, extra = {}) => readOrchestrationTranscripts({ directory }, { fsApi, uid: process.geteuid(), hostname: os.hostname(),
        transcriptPath: id => transcript.sessionTranscriptPath(path.dirname(directory), id),
        readTranscript: file => transcript.readTranscriptRecordsSync(file), foldTranscript: records => transcript.foldTranscript(records), ...extra });
    return { root, directory, id, file, lock, io, descriptors, read, writeTranscript, writeLock };
}

test('paired locks are auxiliary, canonical transcript records remain authoritative, and idle reads preserve bytes', t => {
    const f = fixture(t); f.writeTranscript();
    const without = f.read(); assert.deepEqual(without.finish(), []);
    f.writeLock(); const before = fs.readFileSync(f.lock);
    const first = f.read(), second = f.read();
    assert.deepEqual(first.nativeSessions, without.nativeSessions);
    assert.deepEqual(second.nativeSessions, without.nativeSessions);
    assert.deepEqual(first.finish(), []); assert.deepEqual(second.finish(), []);
    assert.deepEqual(fs.readFileSync(f.lock), before);
    assert.equal(f.descriptors.size, 0);
    assert.ok(!JSON.stringify([...first.nativeSessions]).includes(canary));
});

test('lock-only publication and disappearance never create a session or erase pending identity', t => {
    const f = fixture(t); f.writeLock();
    const first = f.read(); assert.equal(first.nativeSessions.size, 0);
    assert.deepEqual(first.pendingSessionIds, [f.id]);
    fs.unlinkSync(f.lock); assert.deepEqual(first.finish(), [f.id]);
    f.writeTranscript(); const second = f.read(); assert.deepEqual(second.finish(), []);
    assert.deepEqual([...second.nativeSessions.keys()], [f.id]);
});

test('malformed owner, size, type, mode and namespace states fail privately with all descriptors closed', async t => {
    const mutations = {
        empty: f => f.writeLock(''), partial: f => f.writeLock('{'),
        '4096 malformed bytes': f => f.writeLock('x'.repeat(4096)), '4097 bytes': f => f.writeLock('x'.repeat(4097)),
        'zero PID': f => f.writeLock({ ...owner(), pid: 0 }), 'unsafe PID': f => f.writeLock({ ...owner(), pid: Number.MAX_SAFE_INTEGER + 1 }),
        'string PID': f => f.writeLock({ ...owner(), pid: '1' }), 'negative PID': f => f.writeLock({ ...owner(), pid: -1 }),
        'empty start': f => f.writeLock({ ...owner(), start: '' }), 'nondecimal start': f => f.writeLock({ ...owner(), start: '1x' }),
        'numeric start': f => f.writeLock({ ...owner(), start: 123 }), 'wrong UUID': f => f.writeLock({ ...owner(), token: 'private-invalid-token' }),
        'non-v4 UUID': f => f.writeLock({ ...owner(), token: 'f6f57599-8390-1e41-8b77-b8f603e89bc2' }),
        'foreign host': f => f.writeLock({ ...owner(), host: 'private-foreign-host' }),
        'missing key': f => { const value = owner(); delete value.token; f.writeLock(value); },
        'extra key': f => f.writeLock({ ...owner(), privateCanary: 'private-extra-owner' }),
        array: f => f.writeLock('[]'), null: f => f.writeLock('null'),
        'wrong mode': f => { f.writeLock(); fs.chmodSync(f.lock, 0o644); },
        symlink: f => { f.writeLock(); fs.renameSync(f.lock, `${f.root}/target`); fs.symlinkSync(`${f.root}/target`, f.lock); },
        hardlink: f => { f.writeLock(); fs.linkSync(f.lock, `${f.root}/linked`); },
        directory: f => fs.mkdirSync(f.lock),
        recovery: f => { f.writeLock(); fs.writeFileSync(`${f.lock}.recovery`, 'private-recovery-canary'); },
        'unknown suffix': f => fs.writeFileSync(`${f.file}.unknown`, 'private-unknown-canary'),
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
        const f = fixture(t); f.writeTranscript(); mutate(f);
        let failure;
        assert.throws(() => f.read(), error => { failure = error; return error.message === 'Invalid private ALA transcript-lock observation.'; });
        assert.equal(f.descriptors.size, 0);
        const safe = JSON.stringify(projectLiveSessionError(failure));
        assert.ok(!safe.includes(canary)); assert.ok(!safe.includes('private-extra-owner')); assert.ok(!safe.includes('private-foreign-host'));
        let attachment;
        await assert.rejects(createLiveSessionFinalizer().finish({ attach(_name, args) { attachment = args.body.toString(); } }, failure));
        assert.ok(!attachment.includes(canary)); assert.ok(!attachment.includes('private-extra-owner'));
    });
});

test('4096-byte valid owner is accepted without projecting its padding or token', t => {
    const f = fixture(t), bytes = JSON.stringify(owner()); f.writeTranscript();
    f.writeLock(bytes + ' '.repeat(4096 - Buffer.byteLength(bytes)));
    const read = f.read(); assert.deepEqual(read.finish(), []);
    assert.ok(!JSON.stringify([...read.nativeSessions]).includes(canary));
});

test('ordinary transcript appends after its bounded read preserve canonical trailing-partial semantics', t => {
    const f = fixture(t); f.writeTranscript(); f.writeLock();
    const read = f.read(); fs.appendFileSync(f.file, '{"seq":2,"type":');
    assert.deepEqual(read.finish(), []);
    const appended = f.read(); assert.deepEqual(appended.finish(), []);
    assert.deepEqual(appended.nativeSessions, read.nativeSessions);
});

test('header mismatch and cross-session lock cannot lend transcript authority', t => {
    const f = fixture(t); f.writeTranscript(randomUUID()); f.writeLock();
    assert.throws(() => f.read(), /header/);
    f.writeTranscript(); const other = randomUUID(); fs.renameSync(f.lock, `${f.directory}/${other}.jsonl.lock`);
    const read = f.read(); assert.deepEqual(read.pendingSessionIds, [other]); assert.deepEqual(read.finish(), [other]);
});

test('sessions keep 512 logical and 1024 paired physical leaf capacity', t => {
    const f = fixture(t);
    for (let index = 0; index < 512; index += 1) {
        const id = randomUUID();
        fs.writeFileSync(`${f.directory}/${id}.jsonl`, JSON.stringify({ type: 'session', id }) + '\n', { mode: 0o600 });
        fs.writeFileSync(`${f.directory}/${id}.jsonl.lock`, JSON.stringify(owner()), { mode: 0o600 });
    }
    const read = f.read(); assert.equal(read.nativeSessions.size, 512); assert.deepEqual(read.finish(), []);
    fs.writeFileSync(`${f.directory}/${randomUUID()}.jsonl.lock`, JSON.stringify(owner()), { mode: 0o600 });
    assert.throws(() => f.read(), /Invalid private/);
    fs.unlinkSync(fs.readdirSync(f.directory).filter(name => name.endsWith('.jsonl')).map(name => `${f.directory}/${name}`)[0]);
    assert.throws(() => f.read(), /Invalid private/);
});

test('file and parent replacement, same-size mutation, foreign UID and I/O failures refuse without FD leaks', async t => {
    for (const stage of ['open', 'read', 'stat', 'close', 'replace', 'parent', 'mutate', 'uid']) await t.test(stage, t => {
        const f = fixture(t); f.writeTranscript(); f.writeLock();
        const io = { ...f.io,
            openSync(file, ...args) {
                if (file === f.lock && stage === 'open') throw new Error(canary);
                if (file === f.lock && stage === 'replace') { fs.renameSync(f.lock, `${f.root}/old`); f.writeLock(); }
                return f.io.openSync(file, ...args);
            },
            readSync(fd, ...args) {
                if (stage === 'read') throw new Error(canary);
                const count = fs.readSync(fd, ...args);
                if (stage === 'mutate') {
                    const ownerBytes = fs.readFileSync(f.lock, 'utf8'); fs.writeFileSync(f.lock, ownerBytes.replace('123456', '654321'));
                }
                if (stage === 'parent' && fs.existsSync(f.lock)) { fs.renameSync(f.directory, `${f.root}/old-parent`); fs.mkdirSync(f.directory); }
                return count;
            },
            fstatSync(fd, ...args) { if (stage === 'stat') throw new Error(canary); return fs.fstatSync(fd, ...args); },
            lstatSync(file, ...args) {
                const value = fs.lstatSync(file, ...args);
                return file === f.lock && stage === 'uid' ? { ...value, uid: BigInt(process.geteuid() + 1), isFile: () => true } : value;
            },
            closeSync(fd) { f.io.closeSync(fd); if (stage === 'close') throw new Error(canary); },
        };
        assert.throws(() => f.read(io), /Invalid private/); assert.equal(f.descriptors.size, 0);
    });
});

test('normal close during private lock read is accepted only with its same bound transcript', async t => {
    for (const paired of [true, false]) await t.test(String(paired), t => {
        const f = fixture(t); if (paired) f.writeTranscript(); f.writeLock();
        const io = { ...f.io, readSync(fd, ...args) { const count = fs.readSync(fd, ...args); if (fs.existsSync(f.lock)) fs.unlinkSync(f.lock); return count; } };
        const read = f.read(io); assert.deepEqual(read.finish(), paired ? [] : [f.id]); assert.equal(f.descriptors.size, 0);
    });
});

test('normal unlink at each pathname/open gap requires the validated same-ID counterpart or stays pending', async t => {
    for (const stage of ['after-lstat', 'before-open', 'after-open']) for (const paired of [true, false]) await t.test(`${stage} paired=${paired}`, t => {
        const f = fixture(t); if (paired) f.writeTranscript(); f.writeLock(); let changed = false;
        const remove = () => { changed = true; fs.unlinkSync(f.lock); };
        const io = { ...f.io,
            realpathSync(file) { if (file === f.lock && stage === 'after-lstat' && !changed) remove(); return f.io.realpathSync(file); },
            openSync(file, ...args) {
                if (file === f.lock && stage === 'before-open' && !changed) remove();
                const fd = f.io.openSync(file, ...args);
                if (file === f.lock && stage === 'after-open' && !changed) remove();
                return fd;
            },
        };
        const read = f.read(io); assert.ok(changed);
        assert.deepEqual(read.finish(), paired ? [] : [f.id]); assert.equal(f.descriptors.size, 0);
        assert.equal(read.nativeSessions.has(f.id), paired);
    });
});

test('unlink-gap replacement, unsafe initial state and malformed opened owners still fail closed', async t => {
    for (const stage of ['after-lstat', 'before-open', 'after-open']) for (const replacement of ['regular', 'symlink', 'unsafe-mode']) {
        await t.test(`${stage} ${replacement}`, t => {
            const f = fixture(t); f.writeTranscript(); f.writeLock(); let changed = false;
            if (replacement === 'unsafe-mode') fs.chmodSync(f.lock, 0o644);
            const replace = () => {
                changed = true; fs.unlinkSync(f.lock);
                if (replacement === 'symlink') { fs.writeFileSync(`${f.root}/foreign`, JSON.stringify(owner()), { mode: 0o600 }); fs.symlinkSync(`${f.root}/foreign`, f.lock); }
                else f.writeLock();
            };
            const io = { ...f.io,
                realpathSync(file) { if (file === f.lock && stage === 'after-lstat' && !changed) replace(); return f.io.realpathSync(file); },
                openSync(file, ...args) {
                    if (file === f.lock && stage === 'before-open' && !changed) replace();
                    const fd = f.io.openSync(file, ...args);
                    if (file === f.lock && stage === 'after-open' && !changed) replace();
                    return fd;
                },
            };
            assert.throws(() => f.read(io), /Invalid private/); assert.equal(f.descriptors.size, 0);
            if (replacement === 'unsafe-mode') assert.equal(changed, false);
        });
    }
    await t.test('malformed owner remains invalid after open/unlink', t => {
        const f = fixture(t); f.writeTranscript(); f.writeLock('{');
        const io = { ...f.io, openSync(file, ...args) { const fd = f.io.openSync(file, ...args); if (file === f.lock) fs.unlinkSync(f.lock); return fd; } };
        assert.throws(() => f.read(io), /Invalid private/); assert.equal(f.descriptors.size, 0);
    });
});

test('concurrent lock growth reads at most one bounded overflow byte before rejection', t => {
    const f = fixture(t); f.writeTranscript(); f.writeLock();
    let total = 0, grew = false;
    const io = { ...f.io, readSync(fd, buffer, offset, length, position) {
        if (!grew) { grew = true; fs.appendFileSync(f.lock, 'x'.repeat(64 * 1024)); }
        assert.ok(length <= 4097);
        const count = fs.readSync(fd, buffer, offset, length, position); total += count; return count;
    } };
    assert.throws(() => f.read(io), /Invalid private/);
    assert.equal(total, 4097); assert.equal(f.descriptors.size, 0);
});

test('a disappeared listed lock cannot adopt a replacement and final counterpart/parent fences remain bound', async t => {
    for (const change of ['reappeared-lock', 'late-lock-mutation', 'counterpart', 'parent']) await t.test(change, t => {
        const f = fixture(t); f.writeTranscript(); f.writeLock(); let disappeared = false;
        const io = { ...f.io, lstatSync(file, ...args) {
            if (change === 'reappeared-lock' && file === f.lock && !disappeared) {
                disappeared = true; fs.unlinkSync(f.lock); throw Object.assign(new Error('gone'), { code: 'ENOENT' });
            }
            return fs.lstatSync(file, ...args);
        } };
        const read = f.read(io);
        if (change === 'reappeared-lock') f.writeLock();
        if (change === 'late-lock-mutation') fs.writeFileSync(f.lock, JSON.stringify({ ...owner(), start: '654321' }));
        if (change === 'counterpart') { fs.unlinkSync(f.lock); fs.renameSync(f.file, `${f.root}/old`); f.writeTranscript(); }
        if (change === 'parent') { fs.renameSync(f.directory, `${f.root}/old-parent`); fs.mkdirSync(f.directory); }
        assert.throws(() => read.finish(), /Invalid private/); assert.equal(f.descriptors.size, 0);
    });
});

test('incomplete decoder rejects authority fields, versions, failed subprocesses and malformed identities immediately', () => {
    const id = randomUUID();
    assert.deepEqual(decodeOrchestrationProcessResult({ stdout: JSON.stringify(pending([id])) }), pending([id]));
    for (const key of ['census', 'front', 'task', 'flow', 'phase', 'execution']) {
        assert.throws(() => decodeOrchestrationProcessResult({ stdout: JSON.stringify({ ...pending([id]), [key]: null }) }), /Invalid bounded/);
    }
    for (const payload of [{ ...pending([id]), version: 2 }, pending([]), pending([id, id]), pending(['../private']), { ...pending([id]), reason: 'unknown' }]) {
        assert.throws(() => decodeOrchestrationProcessResult({ stdout: JSON.stringify(payload) }), /Invalid bounded/);
    }
    assert.throws(() => decodeOrchestrationProcessResult({ stdout: JSON.stringify(pending([id])), code: 1 }), /failed/);
    assert.throws(() => decodeOrchestrationProcessResult({ stdout: '{' }), /JSON/);
});

test('polling resolves historical pending IDs using one absolute deadline and bounded summaries', async () => {
    const first = randomUUID(), second = randomUUID(); let time = 0, calls = 0; const budgets = [], waits = [];
    const result = await observeOrchestration(async ({ remaining }) => {
        budgets.push(remaining()); time += 20; calls += 1;
        return calls === 1 ? pending([first]) : calls === 2 ? pending([second]) : complete([first, second]);
    }, { now: () => time, wait: async ms => { waits.push(ms); time += ms; } });
    assert.deepEqual(budgets, [12000, 11880, 11760]); assert.deepEqual(waits, [100, 100]);
    assert.equal(result.observation.count, 3); assert.equal(result.observation.elapsedMs, 260);
    assert.deepEqual(result.observation.pendingSessionIds, [first, second].sort());
});

test('deadline, observation-count, pending-union and disappearing counterparts never return settlement evidence', async () => {
    const id = randomUUID(); let time = 0, calls = 0;
    await assert.rejects(observeOrchestration(async ({ remaining }) => {
        calls += 1; assert.equal(remaining(), 12000); time += 12001; return pending([id]);
    }, { now: () => time, wait: async ms => { time += ms; } }), /deadline/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(observeOrchestration(async () => { calls += 1; return pending([id]); }, { now: () => 0, wait: async () => {} }), /count exhausted/);
    assert.equal(calls, 128);
    calls = 0;
    await assert.rejects(observeOrchestration(async () => ++calls === 1 ? pending([id]) : complete([]), { now: () => 0, wait: async () => {} }), /incomplete/);
    assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(observeOrchestration(async () => { calls += 1; throw new Error('runtime binding changed'); }, { now: () => 0, wait: async () => {} }), /binding changed/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(observeOrchestration(async () => { calls += 1; return pending(Array.from({ length: 512 }, () => randomUUID())); },
        { now: () => 0, wait: async () => {} }), /inventory exceeded/);
    assert.equal(calls, 2);
});

test('actual canonical openSessionState held-lock and lock-free collectors yield identical chain evidence on Linux', async t => {
    assert.equal(process.platform, 'linux', 'Real canonical producer qualification requires Linux /proc; it must not be skipped or emulated.');
    assert.equal(fs.realpathSync(process.env.ACHILLES_ALA_COMMAND || ''), `${alaRoot}/bin/ala.mjs`);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-transcript-lock-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previousWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => { if (previousWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspace; });
    const cwd = `${root}/selected`, codeRoot = `${repository}/roboTeamAgent`, sessionId = randomUUID(), turnId = randomUUID();
    fs.mkdirSync(cwd);
    const { openSessionState } = await import(pathToFileURL(`${alaRoot}/src/session-state.mjs`));
    const { ConversationSessionStore } = await import(pathToFileURL(`${codeRoot}/copilot/src/lib/storage/conversationSessionStore.mjs`));
    const store = new ConversationSessionStore({ workingDir: cwd }), config = store.sessionPath(sessionId);
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ version: 2, sessionId, cwd,
        engine: { type: 'ala', version: 1, sessionId, cwd, backend: 'opencode', robotId: 'default-123456' },
        turns: [{ turnId, userMessageId: randomUUID(), assistantMessageId: randomUUID() }] }));
    const state = await openSessionState({ id: sessionId, sessionsRoot: `${cwd}/.roboteam/.ala` });
    let closed = false;
    t.after(async () => { if (!closed) await state.close(); });
    await state.save({ agent: 'opencode', continuation: { privateCanary: canary } });
    await state.append('user', { turnId, text: 'neutral canonical objective' });
    const contractFiles = delegationContractFiles(repository);
    const options = { cwd, workspaceRoot: root, expectedRepository: repository, contractFiles,
        contractHashes: Object.fromEntries(contractFiles.map(file => [file, hash(fs.readFileSync(`${codeRoot}/${file}`))])),
        expectedAla: { root: alaRoot, command: `${alaRoot}/bin/ala.mjs`, hashes: Object.fromEntries(['package.json', 'bin/ala.mjs', 'src/transcript.mjs']
            .map(file => [file, hash(fs.readFileSync(`${alaRoot}/${file}`))])) },
        robotId: 'default-123456', ownerPrincipal: 'user:fixture-owner', frontOnly: true,
        frontSessionId: sessionId, requestDigest: hash('neutral canonical objective') };
    const inventory = () => Object.fromEntries(fs.readdirSync(path.dirname(state.file)).map(name => [name, hash(fs.readFileSync(`${path.dirname(state.file)}/${name}`))]));
    const before = inventory(); let held, repeated, free;
    await readLiveSessionOrchestration(options, { codeRoot, emit(value) { held = value; } });
    await readLiveSessionOrchestration(options, { codeRoot, emit(value) { repeated = value; } });
    assert.deepEqual(inventory(), before); assert.deepEqual(held, repeated);
    assert.equal(held.front.turnId, turnId); assert.equal(held.front.nativeObserved, true);
    assert.ok(!JSON.stringify(held).includes(canary));
    await state.close(); closed = true;
    await readLiveSessionOrchestration(options, { codeRoot, emit(value) { free = value; } });
    assert.deepEqual(held, free);
    assert.ok(Buffer.byteLength(buildOrchestrationProgram(options)) < 128 * 1024);
});

test('reader budgets every lightweight command and preserves initialization/normal/frontOnly full guards', async t => {
    const outerId = 'a'.repeat(64), innerId = 'b'.repeat(64), workspaceRoot = '/neutral-workspace';
    const mount = { Type: 'bind', Source: workspaceRoot, Destination: workspaceRoot, RW: true };
    const nested = { Id: innerId, State: { Running: true, Pid: 5, StartedAt: 'neutral-generation' }, Mounts: [mount], Config: { Labels: {} } };
    const outer = { Id: outerId, State: { Running: true, StartedAt: 'neutral-generation' }, Image: 'neutral-image', Mounts: [mount] };
    const contractFiles = delegationContractFiles(repository);
    const actualHashes = Object.fromEntries(contractFiles.map(file => [file, hash(fs.readFileSync(`${repository}/roboTeamAgent/${file}`))]));
    const input = { release: { applicationBaseURL: 'http://localhost:19082', repositories: { achillesCLI: { repositoryPath: repository } } },
        evidence: { outerContainerId: outerId, workspaceRoot, workspaceHash: hash(workspaceRoot).slice(0, 12) }, runtime: { containerId: innerId },
        cwd: `${workspaceRoot}/selected`, robotId: 'default-123456', ownerPrincipal: 'user:fixture' };
    for (const mode of ['normal', 'frontOnly', 'slow-fence', 'binding-change', 'source-change']) await t.test(mode, async () => {
        let guards = 0, time = 0, observations = 0, light = 0, active = false;
        const id = randomUUID(), commands = [];
        const originalAlaBinding = { root: '/verified-ala', command: '/verified-ala/bin/ala.mjs', hashes: { 'bin/ala.mjs': 'a'.repeat(64) } };
        const reader = await createOrchestrationReader(input, {
            createRuntimeReader: async () => ({ finish: async () => { guards += 1; return { runtime: input.runtime, alaBinding: originalAlaBinding }; } }),
            execute: async (_command, args, limits) => {
                if (active) { commands.push(limits.timeout); assert.ok(limits.timeout <= 12000 - time); time += 10; }
                if (args[0] === 'container') {
                    if (active && mode === 'slow-fence') time = 12001;
                    return { stdout: JSON.stringify([{ ...outer, ...(active && mode === 'binding-change' ? { Image: 'changed' } : {}) }]) };
                }
                observations += 1;
                const payload = observations === 1 ? pending([id]) : complete([id]);
                return { stdout: JSON.stringify({ ...payload, codeHashes: mode === 'source-change' ? codeHashes : actualHashes }) };
            },
            nestedCommand: (_command, _args, limits) => {
                if (active) { light += 1; commands.push(limits.timeout); assert.ok(limits.timeout <= 12000 - time); time += 10; }
                return [nested];
            }, now: () => time, wait: async ms => { assert.ok(ms <= 100); time += ms; },
        });
        assert.equal(guards, 1);
        const descriptor = Object.getOwnPropertyDescriptor(reader, 'alaBinding');
        assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
        assert.ok(Object.isFrozen(reader.alaBinding)); assert.ok(Object.isFrozen(reader.alaBinding.hashes));
        assert.notEqual(reader.alaBinding, originalAlaBinding);
        originalAlaBinding.hashes['bin/ala.mjs'] = 'b'.repeat(64);
        assert.equal(reader.alaBinding.hashes['bin/ala.mjs'], 'a'.repeat(64));
        assert.throws(() => { reader.alaBinding.hashes['bin/ala.mjs'] = 'c'.repeat(64); }, TypeError);
        active = true;
        if (['slow-fence', 'binding-change', 'source-change'].includes(mode)) await assert.rejects(reader({}), /deadline|generation|deep-equal|equal/);
        else {
            const snapshot = await reader(mode === 'frontOnly' ? { frontOnly: true } : {});
            assert.equal(snapshot.observation.count, 2); assert.equal(light, 4);
        }
        assert.equal(guards, mode === 'frontOnly' ? 1 : 3);
        assert.ok(commands.length > 0);
        if (mode === 'slow-fence' || mode === 'binding-change') assert.equal(observations, 0);
        if (mode === 'source-change') assert.equal(observations, 1);
    });
});
