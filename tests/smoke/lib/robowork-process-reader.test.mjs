import test from 'node:test';
import assert from 'node:assert/strict';
import { residentNativeProcessIdentity } from './live-sessions.mjs';
import { processRuntimeFence } from './robowork-run-evidence.mjs';
import { workspaceHash } from './webtty-runtime-evidence.mjs';

function fixture() {
    const outer = 'a'.repeat(64), team = 'b'.repeat(64), work = 'c'.repeat(64), cwd = '/fixture/project';
    const id = (pid, ppid, namespace) => ({ pid, ppid, startToken: String(pid * 10), pidNamespace: `pid:[${namespace}]` });
    const inspection = (Id, Pid) => ({ Id, State: { Running: true, Pid, StartedAt: '2026-11-01T00:00:00Z' }, Image: 'd'.repeat(64),
        Mounts: [{ Type: 'bind', Source: `/source/${Id}`, Destination: '/code', RW: false }], Config: { Labels: { owner: Id } } });
    const inspections = new Map([[team, inspection(team, 30)], [work, inspection(work, 10)]]);
    const record = { runId: 'resident-one', robotId: 'robot-a', cwd, state: 'running', kind: 'copilot',
        sessionId: 'session', turnId: 'turn', pid: 20, servicePid: 12, pidStamp: '200', launchId: 'fixture',
        ownerPrincipal: 'user:owner', producer: { pid: 7, startStamp: '350' } };
    const codeHashes = { 'server/main.mjs': 'e'.repeat(64) }, controllerHash = 'f'.repeat(64);
    const native = { robotId: 'robot-a', realpath: '/native', sha256: '9'.repeat(64) };
    const service = id(12, 10, 111), ala = id(20, 12, 150), actual = id(22, 20, 200), controller = id(35, 30, 222);
    const identity = { runId: record.runId, launch: ala, containerInit: id(10, 1, 111),
        ala: { ...ala, cwd, sessionId: 'session', turnId: 'turn', entrypoint: '/ALA/bin/ala.mjs', sha256: '8'.repeat(64) },
        producer: { ...service, kind: 'copilot', script: '/code/server/main.mjs' }, producerAncestry: [service],
        serviceAncestry: [service, id(10, 1, 111)], native: { ...actual, executable: '/native', actualExecutable: '/native', scriptPath: null, sha256: native.sha256 },
        ancestry: [actual] };
    const producer = { runId: record.runId, containerInit: id(30, 1, 222),
        producer: { ...controller, kind: 'copilot', script: '/code/server/robot-cli.mjs', sha256: controllerHash }, producerAncestry: [controller] };
    const binding = { owner: { containerId: work }, repository: '/fixture/AchillesIDE', contractFiles: ['server/main.mjs'], codeHashes,
        controllerHashes: { 'server/robot-cli.mjs': controllerHash },
        controller: processRuntimeFence(inspections.get(team)), execution: processRuntimeFence(inspections.get(work)) };
    const context = { outer, team, work, record, identity, producer, inspections, calls: [], metadataReads: 0, beforeReturn: null };
    const selection = { kind: 'copilot', sessionId: 'session', turnId: 'turn', codeRoot: '/code',
        alaBinding: { root: '/ALA', command: '/ALA/bin/ala.mjs', hashes: { 'bin/ala.mjs': '8'.repeat(64) } }, residentBinding: binding };
    context.selection = selection;
    const executeImpl = async (command, args, limits) => {
        context.calls.push({ command, args, limits }); assert.equal(command, 'podman');
        assert.equal(limits.timeout, 30000); assert.equal(limits.maxBuffer, 65536);
        let value;
        if (args.includes('/usr/bin/podman')) {
            assert.equal(args[4], work, 'Private metadata may be read only inside the execution owner.');
            context.metadataReads += 1; value = { codeHashes, records: [context.record] };
        } else if (args.some(arg => arg.includes('collectControllerProducer'))) value = context.producer;
        else value = context.identity;
        context.beforeReturn?.(value, args);
        return { stdout: JSON.stringify(value) };
    };
    context.read = (overrides = {}) => residentNativeProcessIdentity({ outerContainerId: outer, workspaceRoot: '/fixture', workspaceHash: workspaceHash('/fixture') },
        { containerId: context.team }, native, 'project', { ...context.selection, ...overrides },
        { executeImpl, inspect: (_outer, inner) => context.inspections.get(inner) });
    context.task = () => {
        record.kind = 'task'; identity.producer.kind = 'workflow'; producer.producer.kind = 'workflow';
        producer.producer.script = '/code/server/robot-task.mjs'; selection.kind = 'workflow';
        binding.controllerHashes['server/robot-task.mjs'] = controllerHash;
    };
    context.replace = () => {
        const replacement = '7'.repeat(64), current = inspection(replacement, 50);
        context.team = replacement; context.inspections.set(replacement, current);
        context.selection = { ...selection, residentBinding: { ...binding, controller: processRuntimeFence(current) } };
        context.producer = { ...producer, attachRun: record.runId, containerInit: id(50, 1, 333),
            producer: { ...producer.producer, ...id(55, 50, 333) }, producerAncestry: [id(55, 50, 333)] };
    };
    return context;
}

test('two-container reader reads metadata only in RoboWork and links both process proofs through the same run', async () => {
    const f = fixture(), result = await f.read();
    assert.equal(result.runId, result.controller.runId); assert.equal(f.metadataReads, 2);
    assert.equal(result.containerInit.pid, 10); assert.equal(result.controller.containerInit.pid, 30);
    assert.equal(f.calls.length, 5); assert.equal(f.calls[0].args[4], f.work); assert.equal(f.calls[3].args[4], f.work);
});

test('wrong native container, wrong controller, different run and stale controller incarnation fail', async () => {
    for (const mutate of [
        f => { f.identity.containerInit.pid = 30; }, f => { f.producer.containerInit.pid = 10; },
        f => { f.producer.runId = 'another-run'; }, f => { f.producer.producer.startToken = 'stale'; },
        f => { f.producer.producer.sha256 = '7'.repeat(64); }, f => { f.identity.native.sha256 = '7'.repeat(64); },
        f => { f.identity.runId = 'another-run'; }, f => { f.record.turnId = 'another-turn'; },
    ]) { const f = fixture(); mutate(f); await assert.rejects(f.read()); }
});

test('container identity and source or mount replacements cannot count as native evidence', async () => {
    for (const mutate of [
        f => { f.inspections.get(f.work).State.Pid += 1; },
        f => { f.inspections.get(f.team).State.StartedAt = 'restarted'; },
        f => { f.inspections.get(f.work).Mounts = []; },
        f => { f.inspections.get(f.team).Config.Labels.owner = 'foreign'; },
        f => { f.inspections.get(f.work).Id = f.team; },
    ]) { const f = fixture(); mutate(f); await assert.rejects(f.read()); }
});

test('service metadata drift between the independent proofs fails settlement', async () => {
    const f = fixture();
    f.beforeReturn = (_value, args) => { if (args.some(arg => arg.includes('collectNativeProcessSnapshot'))) f.record.pidStamp = 'changed'; };
    await assert.rejects(f.read(), /Authoritative run identity changed/u);
});

test('a controller incarnation that dies or changes after its first proof cannot pass settlement', async () => {
    const f = fixture();
    f.beforeReturn = (_value, args) => { if (args.some(arg => arg.includes('collectNativeProcessSnapshot'))) f.producer.producer.startToken = 'reused'; };
    await assert.rejects(f.read(), /controller producer changed/u);
});

test('continuity retains initial authority and verifies a new attach producer with the same resident/native identity', async () => {
    const f = fixture(); f.task(); const initial = await f.read();
    assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.residentRecord));
    f.replace();
    const current = await f.read({ retainedProofs: [initial] });
    assert.deepEqual(current.residentRecord, initial.residentRecord); assert.deepEqual(current.native, initial.native);
    assert.equal(current.runId, initial.runId); assert.equal(current.controller.attachRun, initial.runId);
    assert.equal(initial.controller.containerInit.pid, 30); assert.equal(current.controller.containerInit.pid, 50);
    assert.deepEqual(current.residentRecord.producer, { pid: 7, startStamp: '350' });
});

test('continuity rejects a JSON prior proof, wrong attachment/current generation and changed native or trusted owner', async () => {
    for (const mutate of [
        (f, _prior, request) => { request.retainedProofs = [JSON.parse(JSON.stringify(request.retainedProofs[0]))]; },
        f => { f.producer.attachRun = 'another-run'; },
        (f, prior) => { f.selection.residentBinding.controller = prior.controllerRuntime; f.team = prior.controllerRuntime.id; },
        (f, prior) => { f.producer.containerInit = prior.controller.containerInit; },
        f => { f.identity.native.pid += 1; f.identity.ancestry[0].pid += 1; },
        f => { f.record.ownerPrincipal = 'user:foreign'; },
    ]) {
        const f = fixture(); f.task(); const initial = await f.read(); f.replace();
        const request = { retainedProofs: [initial] }; mutate(f, initial, request);
        await assert.rejects(f.read(request));
    }
});
