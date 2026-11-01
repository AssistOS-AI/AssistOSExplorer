import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentCgroup, effectiveCgroupSubtree } from '../../server/sandbox/environmentCgroup.mjs';
import { createPodmanRunner, validatePodmanArgs, PODMAN_LIFETIME_SCRIPT } from '../../server/sandbox/podmanRunner.mjs';

test('explicit cgroup overrides never fall back; generic provider path is consumed only without override', () => {
    assert.equal(effectiveCgroupSubtree({ PLOINKY_CGROUP_SUBTREE: '/run/ploinky/cgroup/workloads' }), '/run/ploinky/cgroup/workloads');
    for (const value of ['', '/', 'relative', '/x/../y', '/x//y', '/x/']) assert.equal(effectiveCgroupSubtree({ ROBO_WORK_CGROUP_SUBTREE: value, PLOINKY_CGROUP_SUBTREE: '/generic' }), null);
    assert.equal(effectiveCgroupSubtree({ ROBO_WORK_CGROUP_SUBTREE: '/explicit', PLOINKY_CGROUP_SUBTREE: '/generic' }), '/explicit');
});

test('cgroup2 exact child limits, init attach and idempotent absence; missing delegation fails closed', async () => {
    const subtree = '/delegated'; const target = `${subtree}/x-${'a'.repeat(32)}`;
    const files = new Map([[`${subtree}/cgroup.controllers`, 'memory cpu pids']]);
    let exists = false;
    const stat = { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n };
    const api = { lstatSync: (file) => { if (file === target && !exists) throw Object.assign(new Error(), { code: 'ENOENT' }); return stat; },
        statfsSync: () => ({ type: 0x63677270 }), readFileSync: (file) => files.get(file), writeFileSync: (file, value) => files.set(file, value),
        mkdirSync: () => { exists = true; }, rmdirSync: () => { if (!exists) throw Object.assign(new Error(), { code: 'ENOENT' }); exists = false; } };
    const group = createEnvironmentCgroup({ path: target, subtree, limits: { memoryBytes: 67108864, cpus: 0.5, pids: 16 }, fsImpl: api });
    assert.equal(files.get(`${target}/memory.max`), '67108864'); assert.equal(files.get(`${target}/memory.swap.max`), '0');
    assert.equal(files.get(`${target}/memory.oom.group`), '1'); assert.equal(files.get(`${target}/cpu.max`), '50000 100000'); assert.equal(files.get(`${target}/pids.max`), '16');
    group.attach(123); assert.equal(files.get(`${target}/cgroup.procs`), '123');
    assert.equal((await group.release()).absent, true); assert.equal((await group.release()).absent, true);
    assert.throws(() => createEnvironmentCgroup({ path: '/other/x-abc', subtree, fsImpl: api }), { reason: 'limits_unavailable' });
    files.set(`${subtree}/cgroup.controllers`, 'cpu');
    assert.throws(() => createEnvironmentCgroup({ path: target, subtree, fsImpl: api }), { reason: 'limits_unavailable' });
});

test('runner rejects broad deletion and non-argv input; fixed lifetime wrapper never evaluates image text', () => {
    for (const args of [['system', 'reset'], ['image', 'prune'], ['rmi', '-a'], ['rm', '--all'], ['rmi', '--all=true'], 'pull bad', ['pull', 'a\0b']]) {
        assert.throws(() => validatePodmanArgs(args));
    }
    assert.deepEqual(validatePodmanArgs(['pull', '--tls-verify=true', 'docker.io/library/node@sha256:abc']), ['pull', '--tls-verify=true', 'docker.io/library/node@sha256:abc']);
    assert.ok(PODMAN_LIFETIME_SCRIPT.includes('/usr/bin/podman "$@"'));
    assert.ok(!PODMAN_LIFETIME_SCRIPT.includes('eval'));
});

test('missing Podman refuses only the Environment runner before any directory or command is created', async () => {
    let spawned = 0;
    const runner = createPodmanRunner({ dataDir: '/not-created-test', spawnImpl: () => { spawned += 1; },
        accessExecutable: (file) => { if (file === '/usr/bin/podman') throw Object.assign(new Error(), { code: 'ENOENT' }); } });
    assert.throws(() => runner.initialize(), { code: 'ENOENT' });
    assert.equal(runner.available, false);
    await assert.rejects(runner.run(['pull', 'docker.io/library/node@sha256:abc']), { code: 'runtime_unavailable' });
    assert.equal(spawned, 0);
});
