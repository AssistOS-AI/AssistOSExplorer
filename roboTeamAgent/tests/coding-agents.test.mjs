import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { CODING_AGENT_NAMES, codingAgentEnvironment, GUI_CODING_AGENTS, robotCodingAgents } from '../server/coding-agents.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';
import { buildRobotRunArgs } from '../server/runtime-manager.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/execution/alaInstallation.mjs';

test('new robots default to OpenCode and persisted API configuration supports every coding agent', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-agents-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: root });
    const robot = await store.create({ name: 'worker' });
    assert.deepEqual(robot.codingAgents, ['opencode']);
    await store.setCodingAgents(robot.id, ['pi']);
    assert.deepEqual((await new RobotStore({ dataDir: root }).get(robot.id)).codingAgents, ['pi']);
    await store.setCodingAgents(robot.id, ['claude']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['claude']);
    await store.setCodingAgents(robot.id, ['codex', 'opencode', 'pi', 'claude']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['codex', 'opencode', 'pi', 'claude']);
    assert.deepEqual(robotCodingAgents({}), ['codex', 'opencode', 'pi', 'claude']);
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
                timezone: 'UTC', cwd: '/workspace', toolsPath: '/tools', shellTools: shell, workspaceRoot: root });
            for (const agent of Object.values(agents)) assert.ok(plan.args.includes(`${agent.path}:${agent.path}:ro`));
            assert.equal(plan.args.includes(`${cacheRoot}:/data/tool-cache:ro`), false);
            assert.ok(plan.args.includes(`${shell.path}:${path.dirname(shell.binPath)}:ro`));
        }
    }
    assert.deepEqual((await fs.readdir(shell.binPath)).sort(), [...CODING_AGENT_NAMES].sort());
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
