import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshImages, isTaggedReference } from '../server/image-refresh.mjs';
import { EnvironmentManager } from '../server/environment.mjs';

function fakePodman({ ids = {}, afterPull = {}, failPull = new Set() } = {}) {
    const state = { ...ids };
    const calls = [];
    const execFileImpl = async (command, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'image' && args[1] === 'inspect') {
            const image = args.at(-1);
            if (!state[image]) throw Object.assign(new Error('no such image'), { code: 125 });
            return { stdout: `${state[image]}\n` };
        }
        if (args[0] === 'pull') {
            const image = args.at(-1);
            if (failPull.has(image)) throw Object.assign(new Error('pull failed'), { code: 125 });
            state[image] = afterPull[image] || state[image] || `new-${image}`;
            return { stdout: '' };
        }
        if (args[0] === 'image' && args[1] === 'exists') {
            if (!state[args[2]]) throw new Error('missing');
            return { stdout: '' };
        }
        throw new Error(`unexpected podman call: ${args.join(' ')}`);
    };
    return { execFileImpl, calls };
}

test('only tagged references are refreshed', () => {
    assert.equal(isTaggedReference('docker.io/assistos/roboteam-browser:runtime'), true);
    assert.equal(isTaggedReference('localhost:5000/image'), true);
    assert.equal(isTaggedReference('docker.io/library/node@sha256:abc'), false);
    assert.equal(isTaggedReference(''), false);
});

test('refresh reports updated, current and failed images and keeps going', async () => {
    const { execFileImpl, calls } = fakePodman({
        ids: { 'a:runtime': 'id-a', 'b:runtime': 'id-b', 'c:runtime': 'id-c' },
        afterPull: { 'a:runtime': 'id-a2' },
        failPull: new Set(['c:runtime']),
    });
    const log = [];
    const results = await refreshImages(['a:runtime', 'b:runtime', 'a:runtime', 'c:runtime', 'd@sha256:1'],
        { execFileImpl, log: message => log.push(message) });
    assert.deepEqual(results, [
        { image: 'a:runtime', outcome: 'updated' },
        { image: 'b:runtime', outcome: 'current' },
        { image: 'c:runtime', outcome: 'failed' },
    ]);
    assert.equal(calls.filter(call => call.startsWith('pull')).length, 3);
    assert.ok(!calls.some(call => call.includes('d@sha256')));
    assert.ok(log.some(line => line.includes('c:runtime') && line.includes('keeping the local image')));
});

test('a missing image is pulled unless only present images are refreshed', async () => {
    const first = fakePodman();
    assert.deepEqual(await refreshImages(['x:runtime'], { execFileImpl: first.execFileImpl, log: () => {} }), [{ image: 'x:runtime', outcome: 'updated' }]);
    const second = fakePodman();
    assert.deepEqual(await refreshImages(['x:runtime'], { execFileImpl: second.execFileImpl, onlyPresent: true, log: () => {} }), []);
    assert.ok(!second.calls.some(call => call.startsWith('pull')));
});

test('an exhausted time budget skips the remaining pulls', async () => {
    const { execFileImpl, calls } = fakePodman({ ids: { 'a:runtime': 'id-a', 'b:runtime': 'id-b' } });
    let clock = 0;
    const timed = async (command, args, options) => {
        if (args[0] === 'pull') clock += 10;
        return execFileImpl(command, args, options);
    };
    const results = await refreshImages(['a:runtime', 'b:runtime'], { execFileImpl: timed, budgetMs: 10, now: () => clock, log: () => {} });
    assert.deepEqual(results, [{ image: 'a:runtime', outcome: 'current' }, { image: 'b:runtime', outcome: 'skipped' }]);
    assert.equal(calls.filter(call => call.startsWith('pull')).length, 1);
});

test('environment refresh pulls only present tagged agent images', async () => {
    const { execFileImpl, calls } = fakePodman({ ids: { 'present:latest': 'id-p', 'pinned@sha256:1': 'id-d' } });
    const manifests = { '/m/present.json': { container: 'present:latest' }, '/m/absent.json': { container: 'absent:latest' },
        '/m/pinned.json': { container: 'pinned@sha256:1' } };
    const agent = (name, manifestPath) => ({ repo: 'repo', name, active: true, enableMode: 'global', manifestPath });
    const environment = new EnvironmentManager({
        loadMarketplace: async () => ({ agents: [agent('present', '/m/present.json'), agent('absent', '/m/absent.json'), agent('pinned', '/m/pinned.json')] }),
        readManifest: async file => manifests[file], execFileImpl, podmanCommand: 'podman',
    });
    const results = await environment.refreshImages({ log: () => {} });
    assert.deepEqual(results, [{ image: 'present:latest', outcome: 'current' }]);
    assert.deepEqual(calls.filter(call => call.startsWith('pull')), ['pull --quiet present:latest']);
});

test('environment refresh tolerates an unavailable marketplace', async () => {
    const environment = new EnvironmentManager({ loadMarketplace: async () => { throw new Error('router down'); } });
    assert.deepEqual(await environment.refreshImages({ log: () => {} }), []);
});
