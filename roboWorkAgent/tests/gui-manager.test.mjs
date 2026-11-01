import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GuiManager, buildRobotRunArgs, proxySessionHttp } from '../server/gui-manager.mjs';

const shellTools = { path: '/data/tool-cache/shell-generation', binPath: '/data/tool-cache/shell-generation/bin', agents: { codex: { path: '/data/tool-cache/codex-generation' } } };
const base = { robot: { id: 'robot-a', name: 'Robot' }, mode: 'browser', dataDir: '/data', workspaceRoot: '/workspace', images: { browser: 'browser', desktop: 'desktop' }, toolsPath: '/data/tool-cache/browser', shellTools };

for (const mode of ['browser', 'desktop']) for (const cwd of ['/home/robot-a', '/workspace', '/workspace/project']) {
    test(`${mode} launch limits home and retains bounded read-only hidden paths at ${cwd}`, () => {
        const { args } = buildRobotRunArgs({ ...base, mode, cwd, maskEnv: true });
        for (const grant of ['/data/robots/robot-a/home:/config', '/data/robots/robot-a/home:/home/robot-a', '/data/robots/robot-a/run/soul:/workspace/roboteam-soul']) assert.ok(args.includes(grant));
        for (const hidden of ['.data', '.ploinky']) {
            const masks = args.filter((value, index) => args[index - 1] === '--tmpfs' && value.startsWith(`/workspace/${hidden}:`));
            assert.deepEqual(masks, [`/workspace/${hidden}:ro,size=64k,mode=0555,nosuid,nodev,noexec`]);
            assert.ok(args.indexOf(masks[0]) > args.lastIndexOf(`${cwd}:${cwd}:rw`));
        }
        assert.ok(args.includes('/dev/null:/workspace/.env:ro'));
        assert.ok(args.includes('HOME=/home/robot-a'));
        assert.ok(args.includes('ROBOTEAM_SHELL_HOME=/home/robot-a'));
        assert.ok(args.includes('USER=robot-a'));
        assert.equal(args[args.indexOf('--network') + 1], 'pasta:--no-map-gw');
        const mounts = args.filter((value, index) => args[index - 1] === '-v');
        assert.equal(mounts.includes('/data:/data'), false);
        assert.equal(mounts.includes('/data/robots:/data/robots'), false);
        assert.ok(mounts.includes(cwd === '/workspace' ? '/workspace:/workspace:rw' : '/workspace:/workspace:ro'));
        if (cwd === '/home/robot-a') assert.equal(mounts.some(value => value.startsWith('/home/robot-a:')), false);
    });
}

test('proxy forwarding is only its relay and browser firewall precedes startup', () => {
    const plan = buildRobotRunArgs({ ...base, proxy: { relayPort: 4567, policyFile: '/data/proxy-pool/policy.json' } });
    assert.equal(plan.args[0], 'create');
    assert.equal(plan.firewalled, true);
    assert.equal(plan.args[plan.args.indexOf('--network') + 1], 'pasta:--no-map-gw,-T,3128:4567');
    assert.equal(plan.args.some(value => value.includes('password')), false);
});

async function fixture(t, overrides = {}) {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gui-manager-'));
    t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
    const calls = [];
    const homeCalls = [];
    const manager = new GuiManager({ workspaceRoot, dataDir: path.join(workspaceRoot, '.data/private'),
        getRobot: async id => ({ id, name: id }), prepareRobot: async () => {}, homeOps: async (...args) => homeCalls.push(args),
        toolCache: { root: '/data/tool-cache', prepareMode: async () => ({ path: '/data/tool-cache/browser' }), prepareShellTools: async () => shellTools },
        waitForSession: async () => {},
        execFileImpl: async (command, args) => {
            calls.push([command, args]);
            return { stdout: args[0] === 'port' ? '127.0.0.1:4567' : '', stderr: '' };
        }, ...overrides });
    return { manager, calls, homeCalls, workspaceRoot };
}

test('GUI preparation uses helper only and repeat ensure returns exact result', async t => {
    const { manager, calls, homeCalls } = await fixture(t);
    const request = { robotId: 'robot-a', mode: 'desktop', codingAgents: ['codex'] };
    const first = await manager.ensureReady(request);
    assert.deepEqual(first, { state: 'running', mode: 'desktop', sessionUrl: '/base-agent-additional-server/roboWorkAgent/3001/api/robots/robot-a/session/', mcpPort: 4567, cwd: '/home/robot-a' });
    assert.deepEqual(await manager.ensureReady(request), first);
    assert.deepEqual(homeCalls.map(call => call[1]), ['shell', 'desktop-launchers']);
    assert.equal(calls.filter(([, args]) => args[0] === 'run').length, 1);
    await assert.rejects(manager.ensureReady({ ...request, mode: 'browser' }), /occupied/u);
    assert.deepEqual(await manager.stop({ robotId: 'robot-a', mode: 'desktop' }), { state: 'stopped' });
});

test('eight simultaneous reservations prevent a ninth launch', async t => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const { manager } = await fixture(t, { prepareRobot: async () => blocked });
    const starting = Array.from({ length: 8 }, (_, index) => manager.ensureReady({ robotId: `robot-${index}`, mode: 'browser' }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(manager.ensureReady({ robotId: 'robot-9', mode: 'browser' }), /active robot limit/u);
    release();
    await Promise.all(starting);
    await manager.shutdown();
});

test('GUI cwd rejects protected folders and escaping symlinks', async t => {
    const { manager, workspaceRoot } = await fixture(t);
    await fs.mkdir(path.join(workspaceRoot, '.data'));
    await fs.symlink(os.tmpdir(), path.join(workspaceRoot, 'outside'));
    await assert.rejects(manager.resolveCwd('robot-a', path.join(workspaceRoot, '.data')), /CWD_REFUSED/u);
    await assert.rejects(manager.resolveCwd('robot-a', path.join(workspaceRoot, 'outside')), /CWD_REFUSED/u);
});

test('failed start cleans only its own container and closes its relay', async t => {
    let closed = 0;
    const { manager, calls } = await fixture(t, { proxyPool: { lease: async () => ({ upstream: { id: 'proxy', host: 'proxy.invalid', port: 80 }, locale: null }) },
        createRelay: () => ({ listen: async () => 4567, close: async () => { closed++; } }),
        waitForSession: async () => { throw new Error('not ready'); } });
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'desktop' }), /not ready/u);
    assert.equal(closed, 1);
    assert.equal(manager.sessions.size, 1);
    assert.equal(manager.status('robot-a').state, 'failed');
    assert.deepEqual(calls.find(([, args]) => args[0] === 'rm')[1], ['rm', '-f', '--ignore', 'robowork-desktop-robot-a']);
});

test('proxy off skips lease; exhausted pool prevents container launch', async t => {
    let leases = 0;
    const { manager, calls } = await fixture(t, { proxyPool: { lease: async () => { leases++; throw new Error('pool exhausted'); } },
        proxySettings: { useProxy: async () => false } });
    await manager.ensureReady({ robotId: 'robot-a', mode: 'browser' });
    assert.equal(leases, 0);
    await manager.stop({ robotId: 'robot-a' });
    calls.length = 0;
    manager.proxySettings = { useProxy: async () => true };
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'browser' }), /pool exhausted/u);
    assert.equal(calls.length, 0);
});

test('proxied Browser loads firewall before start, failure never starts container', async t => {
    const events = [];
    const { manager } = await fixture(t, {
        proxyPool: { lease: async () => ({ upstream: { id: 'proxy', host: 'proxy.invalid', port: 80 }, locale: { timezone: 'Europe/Bucharest', locale: 'ro_RO.UTF-8', lang: 'ro-RO' } }) },
        createRelay: () => ({ listen: async () => 4567, close: async () => events.push('relay-close') }),
        execFileImpl: async (command, args) => {
            events.push(args[0]);
            if (args[0] === 'create') {
                assert.ok(args.includes('TZ=Europe/Bucharest'));
                assert.ok(args.includes('LANG=ro_RO.UTF-8'));
                return { stdout: '' };
            }
            if (args[0] === 'inspect') return { stdout: '/run/netns/owned' };
            if (command === '/usr/bin/nsenter') throw new Error('firewall failed');
            return { stdout: '' };
        },
    });
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'browser' }), /firewall failed/u);
    assert.deepEqual(events, ['create', 'init', 'inspect', '--net=/run/netns/owned', 'rm', 'relay-close']);
    assert.equal(manager.status('robot-a').state, 'failed');
});

test('proxy listing prunes orphan leases and release refuses running GUI', async t => {
    const released = [];
    const assignments = [{ subject: 'robot-a', proxyId: 'proxy-a' }, { subject: 'robot-gone', proxyId: 'proxy-b' }];
    const { manager } = await fixture(t, { proxyPool: {
        assignments: async () => ({ available: true, active: true, assignments }),
        release: async id => { released.push(id); return true; }, lease: async () => null,
    }, getRobot: async id => {
        if (id === 'robot-gone') throw Object.assign(new Error('missing'), { code: 'UNKNOWN_ROBOT' });
        return { id, name: id };
    } });
    assert.deepEqual(await manager.proxyAssignments(), { available: true, active: true, useProxy: true, assignments: [assignments[0]] });
    assert.deepEqual(released, ['robot-gone']);
    await manager.ensureReady({ robotId: 'robot-a', mode: 'browser' });
    await assert.rejects(manager.releaseProxy({ robotId: 'robot-a' }), error => error.code === 'ROBOT_BUSY');
    await manager.stop({ robotId: 'robot-a' });
    assert.deepEqual(await manager.releaseProxy({ robotId: 'robot-a' }), { released: true });
    assert.deepEqual(released, ['robot-gone', 'robot-a']);
});

test('session HTTP forwards verified bytes and projects baseline browser headers', async t => {
    let received;
    const upstream = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        received = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('session');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const proxy = http.createServer((req, res) => {
        req.resume();
        proxySessionHttp(req, res, upstream.address().port, '/base/', Buffer.from('verified'));
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); });
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api/robots/robot-a/session/`, {
        headers: { authorization: 'must-not-forward', cookie: 'session=browser', 'content-length': '8' }, method: 'POST', body: 'verified',
    });
    assert.equal(await response.text(), 'session');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(received.path, '/base/api/robots/robot-a/session/');
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers.cookie, 'session=browser');
    assert.equal(received.body, 'verified');
});
