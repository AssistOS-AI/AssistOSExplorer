import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createExecutionSupervisor } from '../../server/sandbox/executionSupervisor.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';
import { makeTempDir } from '../helpers/synthetic.mjs';
import { planAlaExecution } from '../../server/runtime/alaPlan.mjs';

function rig(t, { incompatible = false } = {}) {
    const dir = makeTempDir(t);
    const homeFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    t.after(() => fs.closeSync(homeFd));
    const events = []; const launched = []; const roots = []; const groups = []; const sandboxes = []; const logs = [];
    const log = (event, fields) => logs.push({ event, ...fields });
    const launcher = { async launch(spec) {
        launched.push(spec); events.push('launch');
        const identity = { pid: 500, startTime: '1', init: { pid: 501, startTime: '2' } };
        await spec.onIdentity?.(identity);
        let onExit;
        const sandbox = { identity, gate: { async commit() { events.push('gate'); return true; }, async abort() {} },
            onExit(fn) { onExit = fn; }, wait: async () => ({ exitCode: 0 }),
            release: async () => { events.push('sandbox-release'); return { absent: true }; },
            stop: async () => ({ absent: true }), emitExit() { onExit(); } };
        sandboxes.push(sandbox); return sandbox;
    } };
    const prepared = { imageId: `sha256:${'a'.repeat(64)}`, imageEnv: { PATH: '/rw-opt/bin:/image/bin', LANG: 'C' },
        async checkRootfs() { events.push('compatibility'); if (incompatible) throw Object.assign(new Error(), { reason: 'image_musl' }); } };
    const supervisor = createExecutionSupervisor({ launcher, view: { process: () => null, listProcesses: () => [] },
        admission: { inventory: [{ name: 'codex' }], streamDirectory: '/stream' },
        roles: { orchestration: {}, endpoint: {}, workload: { environment: prepared, roBinds: [{ source: '/worker/tools', dest: '/rw-opt/tools' }], symlinks: [] } },
        home: { path: dir, fd: homeFd }, cgroupSubtree: '/cg',
        environmentResources: {
            log,
            rootfs: async ({ locator, log: rootfsLog }) => {
                assert.equal(rootfsLog, log, 'the real supervisor forwards the factory logger to rootfs preparation');
                rootfsLog('environment_image_entry_skipped', { kind: 'fifo', name: 'fixture', count: 1 });
                const root = { identity: { name: locator.name, mergedPath: `/store/${locator.name}`, imageId: prepared.imageId }, entries: [{ name: 'usr', kind: 'directory' }],
                    async release() { events.push('root-release'); return { absent: true }; } };
                roots.push(root); events.push('root-create'); return root;
            },
            cgroup: ({ path }) => { const group = { identity: { path }, attach(pid) { assert.equal(pid, 501); events.push('attach-init'); }, async release() { events.push('cg-release'); return { absent: true }; } };
                groups.push(group); events.push('cg-create'); return group; },
        },
    });
    let n = 0;
    const ledger = { async publish({ kind, spec }) {
        const locator = deriveLocator(kind, (++n).toString(16).padStart(32, '0'), { runtimeDir: dir, cgroupSubtree: '/cg' });
        events.push(`reserve:${kind}`);
        const created = await supervisor.create({ kind, resourceId: String(n), marker: `rw-${'a'.repeat(32)}`, locator, spec });
        events.push(`commit:${kind}`);
        await created.gate?.commit(); return { ...created };
    } };
    const request = { home: '/home/robot', cwd: '/home/robot', executable: 'codex', args: [], network: 'none', env: {}, folders: [], exclusions: [] };
    return { supervisor, ledger, events, roots, groups, launched, sandboxes, request, logs };
}

test('first ledger-owned rootfs is checked before any launch; each workload receives a fresh root and limited init before the gate', async (t) => {
    const h = rig(t);
    await h.ledger.publish({ kind: 'runtime-dir' });
    await h.supervisor.prepareEnvironment(h.ledger);
    assert.equal(h.launched.length, 0);
    assert.ok(h.events.indexOf('commit:env-rootfs') < h.events.indexOf('compatibility'));
    const provider = h.supervisor.providerSandbox(h.ledger);
    await provider.start({ process: 1, request: h.request, streams: {} });
    await provider.start({ process: 2, request: h.request, streams: {} });
    assert.equal(h.roots.length, 2); assert.equal(h.groups.length, 2);
    assert.equal(h.logs.filter((entry) => entry.event === 'environment_image_entry_skipped').length, 2);
    assert.notEqual(h.launched[0].imageRoot.path, h.launched[1].imageRoot.path);
    assert.equal(h.launched[0].autoCommit, false);
    assert.equal(h.launched[0].env.PATH, '/rw-opt/bin:/image/bin');
    assert.equal(h.launched[0].env.HOME, '/home/robot');
    assert.ok(h.events.indexOf('attach-init') < h.events.indexOf('commit:process-tree'));
    assert.ok(h.events.indexOf('commit:process-tree') < h.events.indexOf('gate'));
    h.sandboxes[0].emitExit();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.events.indexOf('sandbox-release') < h.events.indexOf('root-release'));
    assert.ok(h.events.indexOf('root-release') < h.events.indexOf('cg-release'));
    await h.supervisor.releaseViews();
});

test('compatibility refusal leaves a recorded rootfs and zero launches for normal ledger cleanup', async (t) => {
    const h = rig(t, { incompatible: true });
    await h.ledger.publish({ kind: 'runtime-dir' });
    await assert.rejects(h.supervisor.prepareEnvironment(h.ledger), { reason: 'image_musl' });
    assert.equal(h.launched.length, 0); assert.equal(h.roots.length, 1);
    await h.supervisor.releaseViews();
    assert.ok(h.events.includes('root-release'));
});

test('flow admission uses its recorded logical kind, never the workflowExecution boolean', () => {
    const specification = { version: 2, prompt: 'x', displayText: 'x', sessionId: 'test-session', turnId: 'test-turn', permissions: 'full-access', environment: 'a/b', workflowExecution: true };
    assert.throws(() => planAlaExecution({ specification, workspaceRoot: '/ws', logicalKind: 'task' }), { reason: 'environment_requires_flow' });
    assert.equal(planAlaExecution({ specification, workspaceRoot: '/ws', logicalKind: 'flow' }).environment, 'a/b');
});
