import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createEnvironmentImages, compareAbi, filterImageEnv } from '../../server/runtime/environmentImages.mjs';
import { makeTempDir } from '../helpers/synthetic.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const id = `sha256:${'b'.repeat(64)}`;
const ref = 'fixtures/nodeenv';
const exact = `docker.io/library/node@${digest}`;
const contract = { architecture: process.arch === 'x64' ? 'amd64' : process.arch, fingerprint: 'worker-v1', tools: { node: '/usr/local/bin/node' } };
const entry = (extra = {}) => ({ ref, about: 'Node', enableMode: 'global', runtime: 'podman', image: { reference: 'docker.io/library/node', digest, imageId: id }, reason: null, ...extra });
const turn = () => new Promise((resolve) => setImmediate(resolve));

function rig(t, options = {}) {
    const dataDir = makeTempDir(t);
    const calls = [];
    const state = { agents: [entry()], pulled: false, pulls: 0, removed: [], containers: 0, checkCount: 0, ...options.state };
    const podman = { available: true, async run(args, opts) {
        calls.push([...args]);
        if (options.run) { const value = await options.run(args, opts, state); if (value !== undefined) return value; }
        if (args[0] === 'image' && args[1] === 'inspect') {
            if (!state.pulled) return { status: 125, stdout: '' };
            return { status: 0, stdout: JSON.stringify([{ Id: id, Architecture: contract.architecture, RepoDigests: [exact], Size: 100, Containers: state.containers,
                Config: { Env: ['HOME=/root', 'PATH=/usr/bin:/bin', 'CLAUDE_CONFIG_DIR=/x', 'NODE_OPTIONS=--require=/x', 'LANG=C.UTF-8'] }, ...state.inspect }]) };
        }
        if (args[0] === 'pull') { state.pulls += 1; state.pulled = true; return { status: 0, stdout: id }; }
        if (args[0] === 'rmi') { state.removed.push(args[1]); state.pulled = false; return { status: 0, stdout: '' }; }
        if (args[0] === 'container' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(Array.from({ length: state.containers }, () => ({ ImageID: id }))) };
        throw new Error(`Unexpected operation ${args[0]}`);
    }, close() {} };
    const logs = [];
    const manager = createEnvironmentImages({ dataDir, podman, fetchAgentImages: async () => ({ schemaVersion: 1, agents: state.agents }),
        selfId: 'agent:fixtures/worker', coordinators: ['agent:fixtures/coordinator'], contract, limits: options.limits,
        clock: { now: () => state.now ?? 1000 }, log: (event, fields) => logs.push({ event, ...fields }),
        checkCompatibility: () => { state.checkCount += 1; if (state.badImage) throw Object.assign(new Error(), { reason: 'image_musl' }); return { glibc: '2.36' }; },
    });
    t.after(() => manager.close());
    return { manager, state, calls, dataDir, podman, logs };
}

test('listing never pulls, excludes worker/coordinators/non-global; preparation binds exact digest and strips authority env', async (t) => {
    const h = rig(t);
    h.state.agents.push(entry({ ref: 'fixtures/worker' }), entry({ ref: 'fixtures/coordinator' }), entry({ ref: 'fixtures/isolated', enableMode: 'isolated' }));
    assert.deepEqual((await h.manager.list()).map((item) => item.ref), [ref]);
    assert.equal(h.calls.length, 0);
    const first = await h.manager.prepare({ ref });
    assert.equal(first.imageId, id);
    assert.equal(first.digest, digest);
    assert.deepEqual(first.imageEnv, { LANG: 'C.UTF-8', PATH: '/rw-opt/bin:/usr/bin:/bin' });
    assert.equal(h.state.pulls, 1);
    const second = await h.manager.prepare({ ref });
    assert.equal(h.state.pulls, 1, 'a stored exact digest is reused');
    await first.checkRootfs('/first-ledger-root');
    await second.checkRootfs('/second-ledger-root');
    assert.equal(h.state.checkCount, 1, 'ABI verdict cached by image ID and worker fingerprint');
    assert.ok(h.calls.some((args) => args[0] === 'pull' && args.at(-1) === exact && args.includes('--tls-verify=true')));
    first.release(); second.release(); second.release();
    assert.ok(fs.existsSync(`${h.dataDir}/environment/images.json`));
});

test('numeric ABI versions and hostile image environment', () => {
    assert.equal(compareAbi('2.9', '2.28'), -1);
    assert.equal(compareAbi('3.4.30', '3.4.9'), 1);
    assert.equal(compareAbi('2.28', '2.28.0'), 0);
    assert.throws(() => compareAbi('GLIBC_PRIVATE', '2.28'));
    const env = filterImageEnv(['LD_PRELOAD=/x', 'ENV=/x', 'BASH_ENV=/x', 'XDG_CONFIG_HOME=/x', 'NODE_PATH=/x', 'NODE_EXTRA_CA_CERTS=/x',
        'SSL_CERT_FILE=/x', 'SSL_CERT_DIR=/x', 'HTTP_PROXY=/x', 'https_proxy=/x', 'ALL_PROXY=/x', 'NO_PROXY=*', 'HOME=/root', 'PATH=/image/bin', 'CUSTOM=safe']);
    assert.deepEqual(env, { CUSTOM: 'safe', PATH: '/rw-opt/bin:/image/bin' });
    assert.throws(() => filterImageEnv(Array(65).fill('X=a')));
});

test('GC cannot remove an image pinned by an idle attempt; releases permit exact-ID eviction', async (t) => {
    const h = rig(t);
    const prepared = await h.manager.prepare({ ref });
    h.state.agents = [];
    await h.manager.gc();
    assert.deepEqual(h.state.removed, []);
    prepared.release();
    h.state.containers = 1;
    await h.manager.gc();
    assert.deepEqual(h.state.removed, [], 'created container references protect the image');
    h.state.containers = 0;
    await h.manager.gc(); await h.manager.gc();
    assert.deepEqual(h.state.removed, [id]);
    for (const args of h.calls) {
        assert.ok(!args.some((arg) => ['prune', 'reset', '-a', '--all'].includes(arg)));
        if (args[0] === 'rmi') assert.deepEqual(args, ['rmi', id]);
    }
});

test('GC rechecks a pending resolution after inspect and before rmi', async (t) => {
    let resolveInspect;
    let block = false;
    const h = rig(t, { run: async (args) => {
        if (block && args[0] === 'image' && args[2] === id) {
            await new Promise((resolve) => { resolveInspect = resolve; });
            return { status: 0, stdout: JSON.stringify([{ Id: id, Containers: 0 }]) };
        }
    } });
    (await h.manager.prepare({ ref })).release();
    h.state.now = 10 * 86400000;
    block = true;
    const gc = h.manager.gc();
    while (!resolveInspect) await turn();
    const preparing = h.manager.prepare({ ref });
    await turn();
    resolveInspect();
    await gc;
    const prepared = await preparing;
    assert.deepEqual(h.state.removed, []);
    prepared.release();
});

test('single-flight pull: cancelling one waiter preserves the other and waits for owned command cleanup when all cancel', async (t) => {
    let complete;
    let pullSignal;
    let observedAbort = false;
    const h = rig(t, { run: async (args, options, state) => {
        if (args[0] !== 'pull') return;
        state.pulls += 1; pullSignal = options.signal;
        return new Promise((resolve, reject) => {
            complete = () => { state.pulled = true; resolve({ status: 0, stdout: id }); };
            options.signal.addEventListener('abort', () => { observedAbort = true; reject(Object.assign(new Error(), { code: 'ABORT_ERR' })); });
        });
    } });
    const first = new AbortController(); const second = new AbortController();
    const a = h.manager.prepare({ ref, signal: first.signal });
    const b = h.manager.prepare({ ref, signal: second.signal });
    while (!complete) await turn();
    const rejectedA = assert.rejects(a, { code: 'environment_unavailable' });
    first.abort(); await rejectedA;
    assert.equal(pullSignal.aborted, false, 'another waiter owns the pull');
    complete();
    const prepared = await b;
    assert.equal(h.state.pulls, 1); assert.equal(observedAbort, false); prepared.release();
    h.state.pulled = false;
    const third = new AbortController();
    complete = null;
    const c = h.manager.prepare({ ref, signal: third.signal });
    while (!complete) await turn();
    const rejectedC = assert.rejects(c, { code: 'environment_unavailable' });
    third.abort(); await rejectedC;
    assert.equal(observedAbort, true);
});

test('GC protects same-config aliases with another ref/digest, including an unknown config ID, during deferred acquisition', async (t) => {
    for (const imageId of [id, null]) {
        let resumeInspect; let block = false;
        const nextDigest = `sha256:${'c'.repeat(64)}`;
        const nextExact = `docker.io/library/other@${nextDigest}`;
        const h = rig(t, { run: async (args) => {
            if (block && args[0] === 'image' && args[2] === id) {
                await new Promise((resolve) => { resumeInspect = resolve; });
                return { status: 0, stdout: JSON.stringify([{ Id: id }]) };
            }
        } });
        (await h.manager.prepare({ ref })).release();
        h.state.now = 10 * 86400000;
        h.state.agents = [entry({ ref: 'fixtures/alias', image: { reference: 'docker.io/library/other', digest: nextDigest, imageId } })];
        h.state.inspect = { RepoDigests: [exact, nextExact] };
        block = true;
        const gc = h.manager.gc();
        while (!resumeInspect) await turn();
        const acquisition = h.manager.prepare({ ref: 'fixtures/alias' });
        await turn();
        resumeInspect();
        await gc;
        const prepared = await acquisition;
        const removed = [...h.state.removed];
        prepared.release();
        assert.deepEqual(removed, [], 'pending aliases protect the config ID even before their final pin exists');
        assert.equal(h.state.pulls, 1, 'GC did not force a second acquisition of a pending image');
        assert.equal(prepared.imageId, id);
    }
});

test('unknown-ID acquisition waits for an already-issued deletion and then acquires a present image', async (t) => {
    let completeDelete;
    const nextDigest = `sha256:${'d'.repeat(64)}`;
    const nextExact = `docker.io/library/alias@${nextDigest}`;
    const h = rig(t, { run: async (args, _options, state) => {
        if (args[0] === 'rmi') return new Promise((resolve) => { completeDelete = () => {
            state.removed.push(args[1]); state.pulled = false; resolve({ status: 0, stdout: '' });
        }; });
    } });
    (await h.manager.prepare({ ref })).release();
    h.state.now = 10 * 86400000;
    const gc = h.manager.gc();
    while (!completeDelete) await turn();
    h.state.agents = [entry({ ref: 'fixtures/alias', image: { reference: 'docker.io/library/alias', digest: nextDigest, imageId: null } })];
    h.state.inspect = { RepoDigests: [exact, nextExact] };
    const acquiring = h.manager.prepare({ ref: 'fixtures/alias' });
    await turn();
    assert.equal(h.calls.some((args) => args[0] === 'image' && args[2] === nextExact), false, 'no store read or returned pin can race an issued rmi');
    completeDelete(); await gc;
    const prepared = await acquiring;
    assert.equal(prepared.imageId, id); assert.equal(h.state.pulled, true); assert.equal(h.state.pulls, 2);
    prepared.release();
});

test('refuses malformed identity, wrong architecture, size and missing runtime; caches compatibility failures', async (t) => {
    for (const [inspect, reason] of [[{ Id: `sha256:${'c'.repeat(64)}` }, 'image_mismatch'], [{ RepoDigests: [] }, 'image_mismatch'],
        [{ Architecture: 'other' }, 'image_arch'], [{ Size: 101 }, 'image_too_large']]) {
        const h = rig(t, { state: { inspect }, limits: { imageMaxBytes: 100 } });
        await assert.rejects(h.manager.prepare({ ref }), { reason });
    }
    const h = rig(t, { state: { badImage: true } });
    const first = await h.manager.prepare({ ref });
    await assert.rejects(first.checkRootfs('/ledger-owned'), { reason: 'image_musl' });
    await assert.rejects(first.checkRootfs('/next-owned'), { reason: 'image_musl' });
    first.release();
    assert.equal(h.state.checkCount, 1);
    assert.equal((await h.manager.list())[0].reason, 'image_musl');
    h.podman.available = false;
    await assert.rejects(h.manager.prepare({ ref }), { reason: 'runtime_unavailable' });
});
