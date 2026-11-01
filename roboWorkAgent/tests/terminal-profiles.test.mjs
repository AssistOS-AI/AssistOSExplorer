import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { RobotPaths } from '../server/robot-paths.mjs';
import { createTerminalProfiles, ensureTerminalStub, parseTerminalProfile, terminalProfileAccess } from '../server/terminal-profiles.mjs';
import { buildShellSandbox, buildTerminalLaunch, readTerminalDescriptor } from '../scripts/robot-shell.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';

async function prepareReady(api, profile) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { return await api.prepare(profile); } catch (error) { if (error.code !== 'TERMINAL_PREPARING') throw error; }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Terminal preparation did not finish');
}

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
    const calls = { tools: 0, runtime: 0, ala: 0, home: [], pulls: 0 };
    const robot = { id: 'robot-a', name: 'Robot A', codingAgents: ['opencode'] };
    const environment = { list: async () => [{ ref: 'repo/agent', key: 'YWdlbnQ', name: 'Agent', available: true, reason: '' }],
        require: async ref => ({ ref, image: 'image:fixture' }), prepare: async () => ({}) };
    const toolCache = { root: path.join(paths.dataDir, 'tool-cache'), prepareShellTools: async () => {
        calls.tools++; return { binPath: path.join(paths.dataDir, 'tool-cache/shell-selections/shell/bin') };
    } };
    const runtimeBundle = { prepare: async () => { calls.runtime++; return { ala: { entry: '/opt/ala/bin/ala.mjs' }, bwrap: { bin: '/opt/bwrap' } }; },
        prepareAla: async () => { calls.ala++; return { entry: '/opt/ala/bin/ala.mjs' }; } };
    const api = createTerminalProfiles({ paths, toolCache, runtimeBundle, environment,
        robots: { require: async id => { if (id !== robot.id) throw new Error('Unknown robot'); return robot; } },
        homeOperation: async (...args) => calls.home.push(args) });
    return { root, paths, stub, calls, api, environment, runtimeBundle };
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
    assert.deepEqual(f.calls, { tools: 0, runtime: 0, ala: 0, home: [], pulls: 0 });
    assert.deepEqual(await fs.readdir(f.stub), []);
    await assert.rejects(fs.access(path.join(f.paths.dataDir, 'server-state')), { code: 'ENOENT' });
});

test('prepare confines home writes, records only protected metadata and deduplicates simultaneous requests', async t => {
    const f = await fixture(t);
    const answers = await Promise.all([f.api.prepare(PROFILE), f.api.prepare(PROFILE)]);
    assert.deepEqual(answers[0], { ok: true, id: PROFILE, label: 'Robot A', root: '.data/roboWorkAgent/terminal/robot-a' });
    assert.deepEqual(answers[0], answers[1]);
    assert.equal(f.calls.tools, 1); assert.equal(f.calls.runtime, 0); assert.equal(f.calls.ala, 1);
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

test('descriptor accepts only an exact owned stub identity through a canonical Router mount alias', async t => {
    const f = await fixture(t);
    await f.api.prepare(PROFILE);
    const alias = path.join(f.root, 'router-home');
    await fs.mkdir(alias);
    const selectedStat = await fs.lstat(f.stub);
    const originalLstat = fs.lstat.bind(fs);
    let aliasedStat = selectedStat;
    t.mock.method(fs, 'lstat', async (...args) => args[0] === alias ? aliasedStat : originalLstat(...args));
    // A bind mount preserves dev/ino while realpath retains its own canonical path.
    assert.notEqual(await fs.realpath(alias), f.stub);
    const loaded = await readTerminalDescriptor(f.paths, PROFILE, alias, alias);
    assert.equal(loaded.descriptor.cwd, null);
    const root = await readTerminalDescriptor(f.paths, PROFILE, alias, f.paths.workspaceRoot);
    assert.equal(root.descriptor.cwd, f.paths.workspaceRoot);
    const project = path.join(f.paths.workspaceRoot, 'project');
    await fs.mkdir(project);
    const clicked = await readTerminalDescriptor(f.paths, PROFILE, alias, project);
    assert.equal(clicked.descriptor.cwd, project);
    for (const mismatch of [{ dev: selectedStat.dev + 1 }, { ino: selectedStat.ino + 1 }, { uid: selectedStat.uid + 1 },
        { isDirectory: () => false }, { isSymbolicLink: () => true }]) {
        aliasedStat = Object.assign(Object.create(selectedStat), mismatch);
        await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, alias, alias));
    }
    aliasedStat = selectedStat;
    const link = path.join(f.root, 'linked-home');
    await fs.symlink(f.stub, link);
    await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, link, link));
    const otherDirectory = path.join(f.root, 'other-home');
    await fs.mkdir(otherDirectory);
    await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, otherDirectory, otherDirectory));
});

test('default terminal preparation never builds static Bubblewrap while selected Environments still require it', async t => {
    const f = await fixture(t);
    let staticCalls = 0;
    f.runtimeBundle.prepare = async () => { staticCalls++; throw new Error('Static preparation unavailable'); };
    await f.api.prepare(PROFILE);
    const { descriptor } = await readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub);
    assert.equal(descriptor.bwrap, '/usr/bin/bwrap');
    assert.equal(descriptor.alaEntry, '/opt/ala/bin/ala.mjs');
    assert.equal(f.calls.ala, 1); assert.equal(staticCalls, 0);
    await assert.rejects(prepareReady(f.api, 'robot-a.YWdlbnQ'), /Static preparation unavailable/u);
    assert.equal(staticCalls, 1);
    await assert.rejects(fs.access(path.join(f.paths.dataDir, 'server-state', 'terminal', 'robot-a.YWdlbnQ.json')), { code: 'ENOENT' });
});

test('resolve and prepare refuse substituted stub paths and unexpected files', async t => {
    const f = await fixture(t);
    await f.api.prepare(PROFILE);
    await fs.writeFile(path.join(f.stub, 'not-empty'), 'fixture');
    assert.deepEqual(await f.api.resolve(PROFILE), { allowed: false });
    await assert.rejects(f.api.prepare(PROFILE), { code: 'UNSAFE_STORAGE' });
    await assert.rejects(readTerminalDescriptor(f.paths, PROFILE, f.stub, f.stub), { code: 'UNSAFE_STORAGE' });
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
    await prepareReady(f.api, 'robot-a.YWdlbnQ');
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

test('robot login profiles restore identity after the image system profile resets USER and LOGNAME', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-terminal-identity-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'robot-a');
    const project = path.join(root, 'project');
    const binPath = path.join(root, 'tools', 'bin');
    for (const directory of [home, project, binPath]) await fs.mkdir(directory, { recursive: true });
    for (const name of ['codex', 'opencode', 'pi', 'claude']) {
        await fs.writeFile(path.join(binPath, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    await prepareRobotShell(home, { binPath, cacheRoot: path.join(root, 'tools') });
    // The runtime image's /etc/profile derives these from id -un, which is root.
    const systemProfile = path.join(root, 'system-profile');
    await fs.writeFile(systemProfile, 'USER=root\nLOGNAME=$USER\nexport USER LOGNAME\n');
    const previousHome = path.join(root, 'previous-home');
    await fs.mkdir(previousHome);
    for (const { directory, selectedHome, shellHome, expectedDirectory } of [
        { directory: home, selectedHome: home, expectedDirectory: home },
        { directory: project, selectedHome: home, expectedDirectory: project },
        { directory: previousHome, selectedHome: previousHome, shellHome: home, expectedDirectory: home },
    ]) {
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c',
            '. "$1"; printf "%s:%s\\n" "$USER" "$LOGNAME"; . "$2"; '
            + 'printf "%s\\n" "$USER" "$LOGNAME" "$HOME" "$PWD"; '
            + 'for cli in codex opencode pi claude; do command -v "$cli" || exit 1; done',
            'login-fixture', systemProfile, path.join(home, shellHome ? '.roboteam-env.sh' : '.bash_profile')], {
            cwd: directory, env: { PATH: '/usr/bin:/bin', HOME: selectedHome, USER: 'robot-a', LOGNAME: 'robot-a',
                ...(shellHome ? { ROBOTEAM_SHELL_HOME: shellHome } : {}) }, encoding: 'utf8',
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split('\n'), ['root:root', 'robot-a', 'robot-a', home, expectedDirectory,
            ...['codex', 'opencode', 'pi', 'claude'].map(name => path.join(binPath, name))]);
    }
});

test('outer profile Bash leaves its empty stub unchanged on exit and failed gate while plain shells retain history', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-terminal-history-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const hook = new URL('../scripts/webtty-env.sh', import.meta.url).pathname;
    const cases = [
        { provider: 'roboWorkAgent', id: PROFILE, command: 'exit 0', status: 0, history: false },
        { provider: 'roboWorkAgent', id: PROFILE, command: "exec /bin/sh -c 'exit 124'", status: 124, history: false },
        { provider: '', id: '', command: 'exit 0', status: 0, history: true },
        { provider: 'otherAgent', id: PROFILE, command: 'exit 0', status: 0, history: true },
        { provider: 'roboWorkAgent', id: '', command: 'exit 0', status: 0, history: true },
    ];
    for (const [index, entry] of cases.entries()) {
        const home = path.join(root, String(index));
        await fs.mkdir(home);
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-p', '-c',
            '. "$1"; /bin/bash --noprofile --norc -i', 'wrapper', hook], {
            env: { PATH: '/usr/bin:/bin', HOME: home, PLOINKY_WEBTTY_PROFILE_PROVIDER: entry.provider,
                PLOINKY_WEBTTY_PROFILE_ID: entry.id },
            input: `printf history-probe\\n\n${entry.command}\n`, encoding: 'utf8',
        });
        assert.ifError(result.error);
        assert.equal(result.status, entry.status, result.stderr);
        const files = await fs.readdir(home);
        assert.deepEqual(files, entry.history ? ['.bash_history'] : []);
        if (entry.history) assert.match(await fs.readFile(path.join(home, '.bash_history'), 'utf8'), /history-probe/u);
    }
});

test('cached download failures can resolve and launch a selected terminal while other reasons stay refused', async t => {
    const f = await fixture(t);
    const { EnvironmentManager } = await import('../server/environment.mjs');
    let failing = true, pulls = 0;
    let manifest = { container: 'image:terminal' };
    const environment = new EnvironmentManager({
        loadMarketplace: async () => ({ agents: [{ repo: 'repo', name: 'agent', active: true, enableMode: 'global', manifestPath: '/manifest.json' }] }),
        readManifest: async () => manifest, imageExists: async () => false,
        ensureImage: async () => { pulls++; if (failing) throw new Error('download failed'); return {}; },
    });
    for (const name of ['list', 'require', 'prepare', 'buildLaunch']) f.environment[name] = environment[name].bind(environment);
    await assert.rejects(environment.prepare('repo/agent'));
    const entry = (await environment.list())[0];
    const profile = `robot-a.${entry.key}`;
    assert.equal((await f.api.catalog()).environments.find(item => item.key === entry.key).available, false);
    assert.equal((await f.api.resolve(profile)).allowed, true);
    failing = false;
    await prepareReady(f.api, profile);
    assert.equal(pulls, 2, 'only selected terminal preparation retries the download');
    const { descriptor } = await readTerminalDescriptor(f.paths, profile, f.stub, f.stub);
    failing = false;
    assert.equal((await buildTerminalLaunch(descriptor, f.paths, { environment })).command, 'podman');
    assert.equal(pulls, 3, 'the selected terminal launch revalidates its image');
    for (const value of [{ container: 'image:{{VERSION}}' }, {}, null]) {
        manifest = value;
        environment.cached = null;
        assert.equal((await f.api.resolve(profile)).allowed, false);
        await assert.rejects(f.api.prepare(profile));
    }
    assert.equal(pulls, 3, 'nonretryable choices never download');
});

test('chosen terminal preparation returns retry immediately and default preparation remains usable', async t => {
    const f = await fixture(t); let release;
    f.runtimeBundle.prepare = () => new Promise(resolve => { release = resolve; });
    const started = performance.now();
    await assert.rejects(f.api.prepare('robot-a.YWdlbnQ'), { code: 'TERMINAL_PREPARING', statusCode: 409 });
    assert.ok(performance.now() - started < 500);
    await f.api.prepare(PROFILE);
    await assert.rejects(fs.access(path.join(f.paths.dataDir, 'server-state', 'terminal', 'robot-a.YWdlbnQ.json')), { code: 'ENOENT' });
    release({ ala: { entry: '/opt/ala/bin/ala.mjs' }, bwrap: { bin: '/opt/bwrap' } });
    const ready = await prepareReady(f.api, 'robot-a.YWdlbnQ');
    assert.equal(ready.ok, true); assert.equal(ready.id, 'robot-a.YWdlbnQ');
});
