import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { RobotPaths } from '../server/robot-paths.mjs';
import { createTerminalProfiles, ensureTerminalStub, parseTerminalProfile, terminalProfileAccess } from '../server/terminal-profiles.mjs';
import { buildShellSandbox, buildTerminalLaunch, readTerminalDescriptor } from '../scripts/robot-shell.mjs';

const ADMIN = { ok: true, internal: false, canAdmin: true, principal: 'user:owner' };
const PROFILE = 'robot-a.default';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-terminal-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), workspaceRoot: path.join(root, 'workspace') });
    for (const directory of [path.join(paths.workspaceRoot, '.data'), path.join(paths.workspaceRoot, '.ploinky'),
        path.join(paths.dataDir, 'robots', 'robot-a', 'home'), paths.soul('robot-a'), path.join(paths.dataDir, 'tool-cache')]) {
        await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(path.join(paths.workspaceRoot, '.env'), 'test fixture only');
    await fs.writeFile(path.join(paths.dataDir, 'robots', 'robot-a', 'label'), '{}');
    const stub = await ensureTerminalStub(paths, 'robot-a');
    const calls = { tools: 0, runtime: 0, home: [], pulls: 0 };
    const robot = { id: 'robot-a', name: 'Robot A', codingAgents: ['opencode'] };
    const environment = { list: async () => [{ ref: 'repo/agent', key: 'YWdlbnQ', name: 'Agent', available: true, reason: '' }],
        require: async ref => ({ ref, image: 'image:fixture' }) };
    const toolCache = { root: path.join(paths.dataDir, 'tool-cache'), prepareShellTools: async () => {
        calls.tools++; return { binPath: path.join(paths.dataDir, 'tool-cache/shell-selections/shell/bin') };
    } };
    const runtimeBundle = { prepare: async () => { calls.runtime++; return { ala: { entry: '/opt/ala/bin/ala.mjs' }, bwrap: { bin: '/opt/bwrap' } }; } };
    const api = createTerminalProfiles({ paths, toolCache, runtimeBundle, environment,
        robots: { require: async id => { if (id !== robot.id) throw new Error('Unknown robot'); return robot; } },
        homeOperation: async (...args) => calls.home.push(args) });
    return { root, paths, stub, calls, api, environment };
}

test('catalog and resolve are readonly, even before first preparation; compound environment identity is required', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.api.catalog(), { ok: true, profiles: [{ id: 'robot-a', label: 'Robot A' }], environments: [
        { key: 'default', label: 'RoboWork (default)', available: true, reason: '' },
        { key: 'YWdlbnQ', label: 'Agent', available: true, reason: '' },
    ] });
    assert.deepEqual(await f.api.resolve(PROFILE), { allowed: true, profile: { id: PROFILE, label: 'Robot A', home: 'terminal/robot-a' } });
    assert.equal((await f.api.resolve('robot-a.YWdlbnQ')).allowed, true);
    for (const value of ['robot-a', 'robot-a.unknown', '../bad.default', 'robot-b.default', '', null, {}, 'robot-a.default.extra']) {
        assert.deepEqual(await f.api.resolve(value), { allowed: false });
    }
    assert.deepEqual(f.calls, { tools: 0, runtime: 0, home: [], pulls: 0 });
    assert.deepEqual(await fs.readdir(f.stub), []);
    await assert.rejects(fs.access(path.join(f.paths.dataDir, 'server-state')), { code: 'ENOENT' });
});

test('prepare confines home writes, records only protected metadata and deduplicates simultaneous requests', async t => {
    const f = await fixture(t);
    const answers = await Promise.all([f.api.prepare(PROFILE), f.api.prepare(PROFILE)]);
    assert.deepEqual(answers[0], { ok: true, id: PROFILE, label: 'Robot A', root: '.data/roboWorkAgent/terminal/robot-a' });
    assert.deepEqual(answers[0], answers[1]);
    assert.equal(f.calls.tools, 1); assert.equal(f.calls.runtime, 1);
    assert.equal(f.calls.home.length, 1); assert.deepEqual(f.calls.home[0].slice(0, 2), ['robot-a', 'shell']);
    assert.deepEqual(await fs.readdir(f.stub), []);
    const file = path.join(f.paths.dataDir, 'server-state/terminal', PROFILE + '.json');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.doesNotMatch(JSON.stringify(descriptor), /PLOINKY_|TOKEN|SECRET/u);
    const loaded = await readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub);
    assert.equal(loaded.descriptor.cwd, null);
    const root = await readTerminalDescriptor(f.paths, PROFILE, f.stub, f.paths.workspaceRoot);
    assert.equal(root.descriptor.cwd, f.paths.workspaceRoot);
    await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, f.root, f.root));
    const saved = f.stub + '-saved';
    await fs.rename(f.stub, saved); await fs.mkdir(f.stub);
    await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub), { code: 'PROFILE_REFUSED' });
});

test('resolve and prepare refuse substituted stub paths and unexpected files', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.stub, 'not-empty'), 'fixture');
    assert.deepEqual(await f.api.resolve(PROFILE), { allowed: false });
    await assert.rejects(f.api.prepare(PROFILE), { code: 'UNSAFE_STORAGE' });
    await fs.rm(path.join(f.stub, 'not-empty'));
    await fs.rename(f.stub, f.stub + '-saved');
    await fs.symlink(f.stub + '-saved', f.stub);
    assert.deepEqual(await f.api.resolve(PROFILE), { allowed: false });
    await assert.rejects(f.api.prepare(PROFILE), { code: 'UNSAFE_STORAGE' });
});

test('terminal routes refuse every non-administrator context before any effect', async t => {
    const f = await fixture(t);
    for (const access of [undefined, {}, { ...ADMIN, internal: true }, { ...ADMIN, canAdmin: false },
        { ...ADMIN, principal: 'agent:controller' }, { ...ADMIN, principal: 'user:' }, { ...ADMIN, canAdmin: 'true' }]) {
        assert.equal(terminalProfileAccess(access).ok, false);
        for (const [method, pathname] of [['GET', '/api/terminal-profiles'], ['POST', '/api/terminal-profiles/resolve'], ['POST', `/api/terminal-profiles/${PROFILE}/prepare`]]) {
            const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
            await f.api.handle({ method }, res, new URL(pathname, 'http://fixture'), access);
            assert.equal(res.status, 403); assert.equal(res.body.ok, false);
        }
    }
    assert.equal(f.calls.tools, 0);
    const res = { writeHead(status) { this.status = status; }, end(text) { this.body = JSON.parse(text); } };
    await f.api.handle({ method: 'POST' }, res, new URL('/api/terminal-profiles/resolve', 'http://fixture'),
        { ...ADMIN, body: Buffer.from(JSON.stringify({ version: 1, id: PROFILE })) });
    assert.equal(res.status, 200); assert.equal(res.body.allowed, true);
    await f.api.handle({ method: 'POST' }, res, new URL(`/api/terminal-profiles/${PROFILE}/prepare`, 'http://fixture'),
        { ...ADMIN, body: Buffer.from('{"unexpected":true}') });
    assert.equal(res.status, 400); assert.equal(f.calls.tools, 0);
});

test('default launch uses private pasta with no forwarding, inherited TTY and no service credentials', async t => {
    const f = await fixture(t);
    await f.api.prepare(PROFILE);
    const { descriptor } = await readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub);
    const launch = await buildTerminalLaunch(descriptor, f.paths);
    assert.equal(launch.command, 'pasta'); assert.equal(launch.options.detached, false); assert.equal(launch.options.stdio, 'inherit');
    assert.deepEqual(launch.args.slice(0, 12), ['--netns-only', '--runas', '0:0', '--config-net', '--no-map-gw', '-t', 'none', '-u', 'none', '-U', 'none', '--']);
    assert.ok(!Object.keys(launch.options.env).some(key => /PLOINKY_|TOKEN|SECRET|NODE_OPTIONS/u.test(key)));
    const wrapper = await fs.readFile(path.join(launch.directory, 'launch.sh'), 'utf8');
    assert.match(wrapper, /exec unshare|exec .*robot-shell.mjs/u);
    assert.doesNotMatch(wrapper, /PROMPT_COMMAND/u);
    await fs.rm(launch.directory, { recursive: true, force: true });
});

test('shell sandbox requires private proc, one layer, own home, masks and newSession false before profile evaluation', async t => {
    const f = await fixture(t);
    await f.api.prepare(PROFILE);
    const { descriptor } = await readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub);
    let options;
    const previous = process.env.ALA_SANDBOX_HOME;
    t.after(() => { if (previous === undefined) delete process.env.ALA_SANDBOX_HOME; else process.env.ALA_SANDBOX_HOME = previous; });
    const launch = await buildShellSandbox(descriptor, { loadSandbox: async () => {
        assert.equal(process.env.ALA_SANDBOX_HOME, '/home/robot-a');
        return { canMountPrivateProc: () => true, buildSandboxArgs: input => { options = input; return ['--clearenv', '--', '/bin/bash', '--login', '-i']; } };
    } });
    assert.equal(options.newSession, false); assert.equal(options.privateProc, true);
    assert.equal(options.home, f.paths.home('robot-a')); assert.equal(options.chdir, '/home/robot-a');
    assert.deepEqual(options.ignoredPaths, ['.data', '.ploinky', '.env'].map(name => path.join(f.paths.workspaceRoot, name)));
    assert.ok(options.folders.some(folder => folder.source === f.paths.workspaceRoot && !folder.writable));
    assert.ok(launch.args.indexOf('--setenv') < launch.args.indexOf('--'));
    await assert.rejects(buildShellSandbox(descriptor, { loadSandbox: async () => ({ canMountPrivateProc: () => false }) }), { code: 'SANDBOX_UNAVAILABLE' });
});

test('environment terminal creates an interactive new image launch and never executes in a live agent', async t => {
    const f = await fixture(t);
    await f.api.prepare('robot-a.YWdlbnQ');
    const { descriptor } = await readTerminalDescriptor(f.paths, 'robot-a.YWdlbnQ', f.stub, f.stub);
    let options;
    const environment = { require: f.environment.require, buildLaunch: async input => { options = input; return { command: 'podman', args: ['run', '-it'], options: {} }; } };
    const launch = await buildTerminalLaunch(descriptor, f.paths, { environment });
    assert.equal(options.environment, 'repo/agent'); assert.equal(options.tty, true); assert.equal(options.home, f.paths.home('robot-a'));
    assert.equal(options.cwd, f.paths.workspaceRoot); assert.deepEqual(options.env, {});
    assert.equal(options.args[0], '--inner'); assert.equal(JSON.parse(options.args[1]).cwd, null);
    assert.equal(launch.options.stdio, 'inherit'); assert.equal(launch.options.detached, false);
    assert.ok(!launch.args.includes('exec'));
});

test('hook no-ops in plain shells and gate cannot leave an outer prompt', async () => {
    const hook = new URL('../scripts/webtty-env.sh', import.meta.url).pathname;
    const gate = await fs.readFile(new URL('../scripts/robot-shell-gate.sh', import.meta.url), 'utf8');
    for (const provider of ['', 'roboWorkAgent', 'otherAgent']) {
        assert.equal(execFileSync('/bin/sh', ['-c', '. "$1"; printf plain', 'test', hook], {
            env: { PATH: '/usr/bin:/bin', PLOINKY_WEBTTY_PROFILE_PROVIDER: provider }, encoding: 'utf8',
        }), 'plain');
    }
    assert.match(gate, /exec \/usr\/bin\/env node/u); assert.doesNotMatch(gate, /PROMPT_COMMAND/u);
    for (const value of ['abc.default', 'abc.YWdlbnQ']) assert.doesNotThrow(() => parseTerminalProfile(value));
    for (const value of ['ab.default', 'abc', 'abc.default.extra', 'abc.$(bad)', '../abc.default']) assert.throws(() => parseTerminalProfile(value));
});
