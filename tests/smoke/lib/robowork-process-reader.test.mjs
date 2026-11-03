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
    const service = id(12, 1, 111), ala = id(20, 12, 150), actual = id(22, 20, 200), controller = { ...id(7, 1, 222), startToken: '350' };
    const ownerInit = { ...id(1, 0, 111), startToken: '100' };
    const identity = { runId: record.runId, launch: ala, containerInit: ownerInit,
        ala: { ...ala, cwd, sessionId: 'session', turnId: 'turn', entrypoint: '/ALA/bin/ala.mjs', sha256: '8'.repeat(64) },
        producer: { ...service, kind: 'copilot', script: '/code/server/main.mjs' }, producerAncestry: [service],
        serviceAncestry: [service, ownerInit], native: { ...actual, executable: '/native', actualExecutable: '/native', scriptPath: null, sha256: native.sha256 },
        ancestry: [actual] };
    const producer = { runId: record.runId, containerInit: id(1, 0, 222),
        producer: { ...controller, kind: 'copilot', script: '/code/server/robot-cli.mjs', sha256: controllerHash }, producerAncestry: [controller] };
    const binding = { owner: { containerId: work }, repository: '/fixture/AchillesIDE', contractFiles: ['server/main.mjs'], codeHashes,
        controllerHashes: { 'server/robot-cli.mjs': controllerHash, 'server/robot-task.mjs': controllerHash },
        controller: processRuntimeFence(inspections.get(team)), execution: processRuntimeFence(inspections.get(work)) };
    const context = { outer, team, work, record, identity, producer, inspections, calls: [], metadataReads: 0, beforeReturn: null, controllerCensus: [] };
    context.procProof = { init: { boxPid: 10, boxPpid: 1, startToken: '100', namespacePids: [10, 1], pidNamespace: 'pid:[111]' },
        processes: [{ boxPid: 200, boxPpid: 120, pid: 20, ppid: 12, startToken: '200', pidNamespace: 'pid:[150]' }] };
    const selection = { kind: 'copilot', sessionId: 'session', turnId: 'turn', codeRoot: '/code',
        alaBinding: { root: '/ALA', command: '/ALA/bin/ala.mjs', hashes: { 'bin/ala.mjs': '8'.repeat(64) } }, residentBinding: binding };
    context.selection = selection;
    const executeImpl = async (command, args, limits) => {
        context.calls.push({ command, args, limits }); assert.equal(command, 'podman');
        assert.equal(limits.timeout, 30000); assert.equal(limits.maxBuffer, 65536);
        let value;
        if (args.some(arg => arg.includes('readResidentRunRecords'))) {
            assert.equal(args[4], work, 'Private metadata may be read only inside the execution owner.');
            context.metadataReads += 1; value = { codeHashes, records: context.records || [context.record] };
        } else if (args.some(arg => arg.includes('collectControllerProducerCensus'))) {
            assert.equal(args[4], context.team, 'Independent pending-wrapper census belongs to the exact controller.');
            value = context.controllerCensus;
        } else if (args.some(arg => arg.includes('collectControllerProducer'))) {
            assert.equal(args[4], context.team, 'Controller source must be read inside its exact owner.');
            value = context.producer;
        } else if (args.some(arg => arg.includes('collectBoxProcReadProofs'))) value = context.procProof;
        else if (context.census) {
            assert.equal(args[4], work, 'Native process roots must be read inside their execution owner.');
            const { ala, launch, runId } = context.identity;
            value = context.emptyNative ? [] : [{ kind: 'ala-turn', ...ala, producerKind: context.record.kind === 'task' ? 'workflow' : 'copilot', launch, runId }];
        } else {
            assert.equal(args[4], work, 'Native process roots must be read inside their execution owner.');
            value = context.identity;
        }
        if (args.some(arg => arg.includes('collectNativeProcessSnapshot'))) value = { identity: value, ownerInit, procReads: context.procReads || [] };
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
        context.producer = { ...producer, attachRun: record.runId, containerInit: id(1, 0, 333),
            producer: { ...producer.producer, ...id(55, 1, 333) }, producerAncestry: [id(55, 1, 333)] };
    };
    return context;
}

test('wrong native container, wrong controller, different run and stale controller incarnation fail', async () => {
    for (const mutate of [
        f => { f.identity.containerInit.pid = 30; }, f => { f.producer.containerInit.pid = 10; },
        f => { f.producer.runId = 'another-run'; }, f => { f.producer.producer.startToken = 'stale'; },
        f => { f.producer.producer.sha256 = '7'.repeat(64); }, f => { f.identity.native.sha256 = '7'.repeat(64); },
        f => { f.identity.runId = 'another-run'; }, f => { f.record.turnId = 'another-turn'; },
    ]) { const f = fixture(); mutate(f); await assert.rejects(f.read()); }
});

test('a copilot producer with ppid 0 is accepted; a task, a two-row chain and a wrong parent are not', async () => {
    const ok = fixture(); ok.producer.producerAncestry[0].ppid = 0; await ok.read();
    const task = fixture(); task.task(); task.producer.producerAncestry[0].ppid = 0; await assert.rejects(task.read());
    const chain = fixture(); chain.producer.producerAncestry = [{ ...chain.producer.producerAncestry[0], ppid: 9 },
        { pid: 9, ppid: 0, startToken: '90', pidNamespace: 'pid:[222]' }];
    await assert.rejects(chain.read());
    const wrong = fixture(); wrong.producer.producerAncestry[0].ppid = 5; await assert.rejects(wrong.read());
});
