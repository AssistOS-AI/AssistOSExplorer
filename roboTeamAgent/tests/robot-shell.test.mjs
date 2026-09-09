import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';
import { ToolCache } from '../server/tool-cache.mjs';

test('new robots have shell configuration, repeated preparation preserves user configuration', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-shell-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: root });
    const robot = await store.create({ name: 'analyst' });
    const home = path.join(store.robotPath(robot.id), 'home');
    await fs.appendFile(path.join(home, '.bashrc'), '# user configuration\n');
    await prepareRobotShell(home);
    const profile = await fs.readFile(path.join(home, '.bashrc'), 'utf8');
    assert.equal(profile.split('. "$HOME/.roboteam-env.sh"').length, 2);
    assert.match(profile, /user configuration/);
    const environment = JSON.parse(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c',
        '. "$HOME/.bashrc"; node -e \'console.log(JSON.stringify({home:process.env.HOME,codex:process.env.CODEX_HOME,pi:process.env.PI_CODING_AGENT_DIR,path:process.env.PATH,config:process.env.XDG_CONFIG_HOME}))\''],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
    assert.equal(environment.codex, path.join(home, '.codex'));
    assert.equal(environment.pi, path.join(home, '.pi/agent'));
    assert.equal(environment.config, path.join(home, '.config'));
    assert(environment.path.startsWith('/data/tool-cache/shell/bin:'));
    await fs.unlink(path.join(home, '.bashrc'));
    await fs.symlink(path.join(home, '.profile'), path.join(home, '.bashrc'));
    await assert.rejects(prepareRobotShell(home), /ELOOP/);
});

test('WebTTY agent hook sets robot HOME even when profiles are disabled', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-webtty-env-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: root });
    const robot = await store.create({ name: 'analyst' });
    const home = path.join(store.robotPath(robot.id), 'home');
    const source = await fs.readFile(new URL('../scripts/webtty-env.sh', import.meta.url), 'utf8');
    const hook = path.join(root, 'hook.sh');
    await fs.writeFile(hook, source.replaceAll('/data/robots/', root + '/robots/'));
    const output = execFileSync('/bin/bash', ['--noprofile', '--norc', '-p', '-c',
        '. "$1"; printf "%s\\n%s" "$HOME" "$CODEX_HOME"', 'test', hook],
    { cwd: home, env: { ...process.env, HOME: '/wrong' }, encoding: 'utf8' });
    assert.equal(output, home + '\n' + home + '/.codex');
});

test('shared shell bin resolves all three installations without copying packages and survives relocation', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-shared-tools-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const cacheRoot = path.join(root, 'cache');
    const agents = {};
    for (const name of ['codex', 'pi', 'opencode']) {
        const prefix = path.join(cacheRoot, name, 'generation');
        await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
        await fs.mkdir(path.join(prefix, 'lib'));
        await fs.writeFile(path.join(prefix, 'lib', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        await fs.symlink('../lib/' + name, path.join(prefix, 'bin', name));
        agents[name] = { path: prefix, binPath: path.join(prefix, 'bin') };
    }
    const cache = new ToolCache({ root: cacheRoot });
    cache.prepareCodingAgents = async () => agents;
    const [one, two] = await Promise.all([cache.prepareShellTools(), cache.prepareShellTools()]);
    assert.deepEqual(one, two);
    const moved = path.join(root, 'mounted-cache');
    await fs.rename(cacheRoot, moved);
    for (const name of Object.keys(agents)) {
        assert.equal(await fs.realpath(path.join(moved, 'shell/bin', name)), path.join(moved, name, 'generation/lib', name));
    }
});
