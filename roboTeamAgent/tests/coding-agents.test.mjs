import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { ToolCache } from '../../roboWorkAgent/server/tool-cache.mjs';
import { CODING_AGENT_NAMES, codingAgentEnvironment, GUI_CODING_AGENTS, robotCodingAgents } from '../server/coding-agents.mjs';
import { prepareRobotShell } from '../../roboWorkAgent/server/robot-shell.mjs';
import { buildRobotRunArgs } from '../../roboWorkAgent/server/gui-manager.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';

test('new robots default to OpenCode and persisted API configuration supports every coding agent', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-agents-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: root, roboWork: { call: async () => ({}) } });
    const robot = await store.create({ name: 'worker' });
    assert.deepEqual(robot.codingAgents, ['opencode']);
    await store.setCodingAgents(robot.id, ['pi']);
    assert.deepEqual((await new RobotStore({ dataDir: root, roboWork: { call: async () => ({}) } }).get(robot.id)).codingAgents, ['pi']);
    await store.setCodingAgents(robot.id, ['claude']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['claude']);
    await store.setCodingAgents(robot.id, ['omp']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['omp']);
    await store.setCodingAgents(robot.id, ['codex', 'opencode', 'pi', 'omp', 'claude', 'vibe']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['codex', 'opencode', 'pi', 'omp', 'claude', 'vibe']);
    assert.deepEqual(robotCodingAgents({}), ['codex', 'opencode', 'pi', 'omp', 'claude', 'vibe']);
    for (const codingAgents of [[], ['unknown'], 'codex', null]) {
        await assert.rejects(store.setCodingAgents(robot.id, codingAgents), /codingAgents/);
    }
});

test('ALA sees only the selected agent while the shell and GUI mounts offer every agent', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-agent-exposure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const cacheRoot = path.join(root, 'cache');
    const agents = {};
    for (const name of CODING_AGENT_NAMES) {
        const prefix = path.join(cacheRoot, name, 'generation');
        await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
        await fs.writeFile(path.join(prefix, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        // OMP is a Bun program; its generation carries the Bun runtime beside it.
        if (name === 'omp') await fs.writeFile(path.join(prefix, 'bin', 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        agents[name] = { path: prefix, binPath: path.join(prefix, 'bin') };
    }
    const cache = new ToolCache({ root: cacheRoot });
    cache.prepareCodingAgents = async names => Object.fromEntries(names.map(name => [name, agents[name]]));
    const { discoverCodingAgents } = await resolveAlaInstallation();
    const shell = await cache.prepareShellTools();
    const inherited = { HOME: home, PATH: `${Object.values(agents).map(agent => agent.binPath).join(':')}:/usr/bin:/bin`,
        ...Object.fromEntries(CODING_AGENT_NAMES.map(name => [`${name.toUpperCase()}_BIN`, path.join(agents[name].binPath, name)])) };
    for (const name of CODING_AGENT_NAMES) {
        const environment = codingAgentEnvironment({ [name]: shell.agents[name] }, inherited, cacheRoot);
        const detected = await discoverCodingAgents({ env: environment });
        assert.deepEqual(detected.filter(agent => agent.available).map(agent => agent.name), [name]);
        await prepareRobotShell(home, { codingAgents: [name], binPath: shell.binPath, cacheRoot });
        const visible = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c',
            `. "$HOME/.roboteam-env.sh"; for tool in ${CODING_AGENT_NAMES.join(' ')}; do command -v "$tool" || :; done`],
        { env: inherited, encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(visible, CODING_AGENT_NAMES.map(tool => path.join(shell.binPath, tool)));
        for (const mode of ['desktop', 'browser']) {
            const plan = buildRobotRunArgs({ robot: { id: 'worker-abc123', name: 'worker', codingAgents: [name] },
                mode, dataDir: root, publicBasePath: '/rt/', images: { desktop: 'desktop', browser: 'browser' },
                timezone: 'UTC', cwd: '/workspace', toolsPath: '/tools', shellTools: shell, workspaceRoot: root,
                workspaceArgs: ['-v', `${root}:${root}:ro,rbind`] });
            for (const agent of Object.values(agents)) assert.ok(plan.args.includes(`${agent.path}:${agent.path}:ro`));
            assert.equal(plan.args.includes(`${cacheRoot}:/data/tool-cache:ro`), false);
            assert.ok(plan.args.includes(`${shell.path}:${path.dirname(shell.binPath)}:ro`));
        }
    }
    assert.deepEqual((await fs.readdir(shell.binPath)).sort(), [...CODING_AGENT_NAMES, 'bun'].sort());
    const codex = await cache.prepareShellTools(['codex']);
    assert.deepEqual(await fs.readdir(codex.binPath), ['codex']);
    const nextPrefix = path.join(cacheRoot, 'codex', 'next-generation');
    await fs.mkdir(path.join(nextPrefix, 'bin'), { recursive: true });
    await fs.writeFile(path.join(nextPrefix, 'bin', 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const updatedCache = new ToolCache({ root: cacheRoot });
    updatedCache.prepareCodingAgents = async () => ({ codex: { path: nextPrefix, binPath: path.join(nextPrefix, 'bin') } });
    const updated = await updatedCache.prepareShellTools(['codex']);
    assert.equal(updated.binPath, codex.binPath);
    assert.notEqual(updated.path, codex.path);
    assert.equal(await fs.realpath(path.join(codex.path, 'bin', 'codex')), path.join(agents.codex.binPath, 'codex'));
});

test('Claude Code can drive GUI tasks and keeps its login in the robot home', async t => {
    assert.ok(GUI_CODING_AGENTS.includes('claude'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-claude-home-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await prepareRobotShell(home, { codingAgents: ['claude'] });
    assert.equal((await fs.stat(path.join(home, '.claude'))).isDirectory(), true);
    const environment = await fs.readFile(path.join(home, '.roboteam-env.sh'), 'utf8');
    assert.match(environment, /^export CLAUDE_CONFIG_DIR="\$HOME\/\.claude"$/m);
    assert.match(environment, /^export CLAUDE_BIN='.*\/claude'$/m);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, '.ala', 'config.json'), 'utf8')).codingAgent, 'claude');
});

test('OMP is a terminal-only agent that keeps its login in the robot home and is installed with Bun', async t => {
    assert.equal(GUI_CODING_AGENTS.includes('omp'), false);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-omp-home-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await prepareRobotShell(home, { codingAgents: ['omp'] });
    assert.equal((await fs.stat(path.join(home, '.omp'))).isDirectory(), true);
    const environment = await fs.readFile(path.join(home, '.roboteam-env.sh'), 'utf8');
    assert.match(environment, /^export OMP_DIR="\$HOME\/\.omp"$/m);
    assert.match(environment, /^export OMP_BIN='.*\/omp'$/m);
    assert.match(environment, /^unset CODEX_BIN OPENCODE_BIN PI_BIN OMP_BIN CLAUDE_BIN VIBE_BIN$/m);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, '.ala', 'config.json'), 'utf8')).codingAgent, 'omp');

    // OMP and Bun are installed together into one prefix, and --version runs with that prefix first on PATH.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-omp-cache-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const cache = new ToolCache({ root, log: () => {}, execFileImpl: async (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === 'view') return { stdout: args[1].startsWith('bun@') ? '"1.5.0"' : '"19.0.1"' };
        if (args[0] === 'install') {
            const prefix = args[args.indexOf('--prefix') + 1];
            for (const name of ['omp', 'bun']) {
                await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
                await fs.writeFile(path.join(prefix, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            }
        }
        return { stdout: '', stderr: '' };
    } });
    const omp = await cache.prepareCodingAgent('omp');
    assert.deepEqual(omp.versions, { omp: '19.0.1', bun: '1.5.0' });
    const install = calls.find(call => call.args[0] === 'install');
    assert.deepEqual(install.args.slice(install.args.indexOf('--prefix') + 2), ['@oh-my-pi/pi-coding-agent@19.0.1', 'bun@1.5.0']);
    const probe = calls.find(call => call.args[0] === '--version');
    assert.equal(probe.options.env.PATH.split(':')[0], path.join(path.dirname(probe.command)));
});

test('Mistral Vibe drives GUI tasks and keeps its login and sessions in the robot home', async t => {
    assert.ok(GUI_CODING_AGENTS.includes('vibe'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-vibe-home-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    await prepareRobotShell(home, { codingAgents: ['vibe'] });
    assert.equal((await fs.stat(path.join(home, '.vibe'))).isDirectory(), true);
    const environment = await fs.readFile(path.join(home, '.roboteam-env.sh'), 'utf8');
    assert.match(environment, /^export VIBE_HOME="\$HOME\/\.vibe"$/m);
    // Without a keyring Vibe's sign-in stores the key in $VIBE_HOME/.env, where the login is detected.
    assert.match(environment, /^export PYTHON_KEYRING_BACKEND=keyring\.backends\.fail\.Keyring$/m);
    assert.match(environment, /^export VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG=true$/m);
    assert.match(environment, /^export VIBE_BIN='.*\/vibe'$/m);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, '.ala', 'config.json'), 'utf8')).codingAgent, 'vibe');
    const plan = buildRobotRunArgs({ robot: { id: 'worker-abc123', name: 'worker', codingAgents: ['vibe'] },
        mode: 'desktop', dataDir: home, publicBasePath: '/rt/', images: { desktop: 'desktop', browser: 'browser' },
        timezone: 'UTC', cwd: '/workspace', toolsPath: '/tools', workspaceRoot: home, workspaceArgs: [],
        shellTools: { path: '/cache/shell-generations/g', binPath: '/cache/shell-selections/shell/bin', agents: {} } });
    assert.ok(plan.args.includes('VIBE_HOME=/home/worker-abc123/.vibe'));
    assert.ok(plan.args.includes('PYTHON_KEYRING_BACKEND=keyring.backends.fail.Keyring'));
    assert.ok(plan.args.includes('VIBE_EXPERIMENTAL_ENABLE_MODEL_CATALOG=true'));
});
