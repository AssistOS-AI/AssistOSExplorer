import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { GuiManager, buildRobotRunArgs, proxySessionHttp } from '../server/gui-manager.mjs';
import { createRoboWorkServer } from '../server/http-server.mjs';

const shellTools = { path: '/data/tool-cache/shell-generation', binPath: '/data/tool-cache/shell-generation/bin', agents: { codex: { path: '/data/tool-cache/codex-generation' } } };
const base = { robot: { id: 'robot-a', name: 'Robot' }, mode: 'browser', dataDir: '/data', workspaceRoot: '/workspace', images: { browser: 'browser', desktop: 'desktop' }, toolsPath: '/data/tool-cache/browser', shellTools };

for (const mode of ['browser', 'desktop']) for (const cwd of ['/home/robot-a', '/workspace/project']) {
    test(`${mode} launch mounts only home, the working folder and service paths at ${cwd}`, () => {
        const { args } = buildRobotRunArgs({ ...base, mode, cwd });
        for (const grant of ['/data/robots/robot-a/home:/config', '/data/robots/robot-a/home:/home/robot-a', '/data/robots/robot-a/run/soul:/workspace/roboteam-soul']) assert.ok(args.includes(grant));
        assert.equal(args.some(value => /^\/workspace\/\.(data|ploinky):/u.test(value)), false);
        assert.equal(args.some(value => value.includes('/workspace/.env')), false);
        assert.ok(args.includes('HOME=/home/robot-a'));
        assert.ok(args.includes('ROBOTEAM_SHELL_HOME=/home/robot-a'));
        assert.ok(args.includes('USER=robot-a'));
        assert.equal(args[args.indexOf('--network') + 1], 'pasta:--no-map-gw');
        const mounts = args.filter((value, index) => args[index - 1] === '-v');
        assert.equal(mounts.includes('/data:/data'), false);
        assert.equal(mounts.includes('/data/robots:/data/robots'), false);
        // Neither the workspace root nor a sibling project is mounted.
        assert.equal(mounts.some(value => value.startsWith('/workspace:')), false);
        assert.equal(mounts.some(value => value.startsWith('/workspace/sibling')), false);
        assert.equal(mounts.includes(`${cwd}:${cwd}:rw`), cwd !== '/home/robot-a');
        const writable = mounts.filter(value => value.endsWith(':rw'));
        assert.deepEqual(writable, cwd === '/home/robot-a' ? [] : [`${cwd}:${cwd}:rw`]);
        assert.equal(args[args.indexOf('-w') + 1], cwd);
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
    const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gui-manager-')));
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
    await assert.rejects(manager.resolveCwd('robot-a', path.join(workspaceRoot, '.data')), { code: 'CWD_REFUSED' });
    await assert.rejects(manager.resolveCwd('robot-a', workspaceRoot), { code: 'CWD_REFUSED' });
    await fs.mkdir(path.join(workspaceRoot, 'project'));
    assert.equal(await manager.resolveCwd('robot-a', path.join(workspaceRoot, 'project')), path.join(await fs.realpath(workspaceRoot), 'project'));
    await assert.rejects(manager.resolveCwd('robot-a', path.join(workspaceRoot, 'outside')), { code: 'CWD_REFUSED' });
});

test('gui_ensure reports CWD_REFUSED and its reason for every refused root form', async t => {
    const { manager, workspaceRoot } = await fixture(t);
    const root = await fs.realpath(workspaceRoot);
    const project = path.join(root, 'project');
    await fs.mkdir(path.join(project, '.roboteam', 'sessions'), { recursive: true });
    await fs.mkdir(path.join(root, '.data', '.private'), { recursive: true });
    await fs.mkdir(path.join(root, '.ploinky', 'repos', 'repo'), { recursive: true });
    await fs.mkdir(path.join(manager.dataDir, 'robots', 'robot-b', 'home'), { recursive: true });
    await fs.writeFile(path.join(root, 'file'), 'fixture');
    await fs.symlink(root, path.join(project, 'root-link'));
    await fs.symlink(path.join(manager.dataDir, 'robots', 'robot-b', 'home'), path.join(project, 'victim-link'));
    const server = createRoboWorkServer({ robots: {}, runs: {}, environment: {}, gui: manager, internalToken: 'private' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const ensure = cwd => fetch(`http://127.0.0.1:${server.address().port}/internal/gui_ensure`, { method: 'POST', headers: { 'x-robowork-internal-token': 'private' },
        body: JSON.stringify({ robotId: 'robot-a', mode: 'browser', cwd }) }).then(async response => ({ status: response.status, ...(await response.json()) }));
    const forms = [[manager.dataDir, /protected/u], [path.join(manager.dataDir, 'robots'), /protected/u], [path.join(manager.dataDir, 'robots', 'robot-b', 'home'), /protected/u],
        [path.join(root, '.data', '.private'), /protected/u], [root, /workspace root/u], ['/', /outside/u], [path.join(project, 'victim-link'), /protected/u],
        [`${root}/`, /workspace root/u], [`${root}/.`, /workspace root/u], [`${project}/..`, /workspace root/u], [path.join(project, 'root-link'), /workspace root/u],
        [path.join(root, '.ploinky', 'repos', 'repo'), /protected/u], [path.join(project, '.roboteam'), /private project data/u], [path.join(project, '.roboteam', 'sessions'), /private project data/u],
        ['relative', /absolute/u], [path.join(root, 'missing'), /unavailable/u], [path.join(root, 'file'), /directory is required/iu]];
    for (const [cwd, reason] of forms) {
        const answer = await ensure(cwd);
        assert.equal(answer.status, 400, cwd); assert.equal(answer.code, 'CWD_REFUSED', cwd);
        assert.match(answer.error, reason, cwd); assert.notEqual(answer.error, 'RoboWork request failed', cwd);
    }
    assert.equal(manager.sessions.size, 0);
    // A planted private directory reaches the caller with the same message a run gives.
    for (const plant of [target => fs.symlink(root, target), target => fs.writeFile(target, 'x')]) {
        const planted = path.join(root, 'planted');
        await fs.mkdir(planted); await plant(path.join(planted, '.roboteam'));
        const refused = await ensure(planted);
        assert.equal(refused.code, 'CWD_REFUSED'); assert.equal(refused.error, "The working folder's .roboteam is not a real directory");
        await fs.rm(planted, { recursive: true });
    }
    // A link inside the workspace is the path a swap leaves behind after RoboTeam canonicalised it.
    await fs.symlink(project, path.join(root, 'swapped'));
    assert.match((await ensure(path.join(root, 'swapped'))).error, /canonical/u);
});

test('Browser and Desktop mask private project data read-only in a working folder and need no mask in the home', () => {
    for (const mode of ['browser', 'desktop']) {
        const { args } = buildRobotRunArgs({ ...base, mode, cwd: '/workspace/project' });
        const mask = args[args.indexOf('--tmpfs', args.indexOf('/workspace/project:/workspace/project:rw')) + 1];
        assert.equal(mask, '/workspace/project/.roboteam:ro,size=4k,mode=0555,notmpcopyup');
        // Without this flag Podman copies what the mask covers, so history stays readable or fills the 4k tmpfs.
        // A real container is needed to prove the mask is empty, which only Linux can run.
        assert.ok(mask.split(':')[1].split(',').includes('notmpcopyup'));
        assert.equal(buildRobotRunArgs({ ...base, mode, cwd: '/home/robot-a' }).args.some(value => value.includes('.roboteam')), false);
    }
});

test('the container starts with the working folder check and only then becomes /init', async t => {
    const plan = buildRobotRunArgs({ ...base, cwd: '/workspace/project', cwdIdentity: '12:34' });
    const image = plan.args.indexOf('browser');
    assert.equal(plan.args[plan.args.indexOf('--entrypoint') + 1], '/bin/sh'); assert.ok(plan.args.indexOf('--entrypoint') < image);
    const [flag, script, name, cwd, identity] = plan.args.slice(image + 1);
    assert.deepEqual([flag, name, cwd, identity], ['-c', 'robowork-cwd-check', '/workspace/project', '12:34']);
    assert.equal(buildRobotRunArgs({ ...base, cwd: '/home/robot-a' }).args.at(-1), 'browser');
    // Runs the real script. macOS has another stat, so a stand-in answers; only Linux proves the format against coreutils.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gui-check-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const directory = path.join(root, 'folder'), link = path.join(root, 'link');
    await fs.mkdir(directory); await fs.symlink(directory, link);
    await fs.mkdir(path.join(root, 'bin'));
    await fs.writeFile(path.join(root, 'bin', 'stat'), `#!/bin/sh\n[ "$1" = -c ] && [ "$2" = '%d:%i' ] && [ "$3" = -- ] && [ "$4" = '${directory}' ] && echo 12:34\n`, { mode: 0o755 });
    const run = (target, expected) => spawnSync('/bin/sh', ['-c', script, name, target, expected], { encoding: 'utf8', env: { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin` } });
    for (const [target, expected] of [[directory, '99:99'], [link, '12:34'], [path.join(root, 'missing'), '12:34']]) {
        const refused = run(target, expected);
        assert.equal(refused.status, 78, target); assert.match(refused.stderr, /working folder changed/u);
    }
    // A link planted after the last check would put the mask on its target.
    await fs.symlink(root, path.join(directory, '.roboteam'));
    assert.equal(run(directory, '12:34').status, 78);
    await fs.rm(path.join(directory, '.roboteam'));
    // /init does not exist here, so a passing check ends as the shell's failure to run it.
    const passed = run(directory, '12:34');
    assert.notEqual(passed.status, 78, passed.stderr); assert.doesNotMatch(passed.stderr, /working folder changed/u);
});

test('a session mounts through a descriptor held until the container starts and reports a swap as CWD_REFUSED', async t => {
    const planned = [];
    let swap = async () => {}, holding = null, plantAtRun = null;
    const { manager, workspaceRoot } = await fixture(t, {
        prepareRobot: async () => { await swap(); },
        waitForSession: async () => { throw new Error('session did not become ready'); },
        execFileImpl: async (command, args) => {
            planned.push(args);
            if (args[0] === 'run' && plantAtRun) { await plantAtRun(); throw new Error('mounting a tmpfs over .roboteam failed'); }
            if (args[0] === 'run') holding = fstatSync(Number(/fd\/(\d+):/u.exec(args[args.findIndex(value => value.endsWith(`:${project}:rw`))])[1]), { bigint: true });
            return { stdout: args[0] === 'port' ? '127.0.0.1:4567' : args[0] === 'inspect' ? '78\n' : '', stderr: '' };
        },
    });
    const project = path.join(workspaceRoot, 'project'), other = path.join(workspaceRoot, 'other');
    await fs.mkdir(project); await fs.mkdir(other);
    const stat = await fs.lstat(project, { bigint: true }), identity = `${stat.dev}:${stat.ino}`;
    // The first-process check is the backstop: its exit status becomes the refusal.
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'desktop', cwd: project }), { code: 'CWD_REFUSED', message: /working folder changed/u });
    const run = planned.find(args => args[0] === 'run');
    assert.ok(run.includes(identity));
    assert.ok(run.some(value => new RegExp(`^/proc/${process.pid}/fd/\\d+:${project}:rw$`, 'u').test(value)));
    assert.equal(`${holding.dev}:${holding.ino}`, identity);
    const descriptor = Number(/fd\/(\d+):/u.exec(run.find(value => value.endsWith(`:${project}:rw`)))[1]);
    assert.throws(() => fstatSync(descriptor), { code: 'EBADF' }, 'The descriptor closes once the container has started.');
    const failed = manager.status('robot-a');
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.error, { code: 'CWD_REFUSED', message: 'The working folder changed before the session started', statusCode: 400 });
    // Planted during preparation: the reason reaches the status and Podman is never asked.
    planned.length = 0;
    await manager.stop({ robotId: 'robot-a' });
    swap = async () => { await fs.symlink(other, path.join(project, '.roboteam')); };
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'desktop', cwd: project }), { code: 'CWD_REFUSED', message: /\.roboteam is not a real directory/u });
    assert.equal(manager.status('robot-a').error.message, "The working folder's .roboteam is not a real directory");
    assert.equal(planned.filter(args => args[0] === 'run').length, 0);
    await fs.rm(path.join(project, '.roboteam'));
    // Planted right as Podman creates the container: the failed status carries the reason, not a raw Podman error.
    await manager.stop({ robotId: 'robot-a' });
    swap = async () => {};
    plantAtRun = async () => { await fs.symlink(other, path.join(project, '.roboteam')); };
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'desktop', cwd: project }), { code: 'CWD_REFUSED' });
    assert.deepEqual(manager.status('robot-a').error, { code: 'CWD_REFUSED', message: "The working folder's .roboteam is not a real directory", statusCode: 400 });
    plantAtRun = null;
    await fs.rm(path.join(project, '.roboteam'));
    // A swap during preparation is refused before Podman is asked for anything.
    planned.length = 0;
    await manager.stop({ robotId: 'robot-a' });
    swap = async () => { await fs.rename(project, `${project}-moved`); await fs.symlink(other, project); };
    await assert.rejects(manager.ensureReady({ robotId: 'robot-a', mode: 'desktop', cwd: project }), { code: 'CWD_REFUSED', message: /changed before it was mounted/u });
    assert.equal(planned.filter(args => args[0] === 'run').length, 0);
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
