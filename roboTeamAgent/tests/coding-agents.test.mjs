import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { ToolCache } from '../server/tool-cache.mjs';
import { codingAgentEnvironment, robotCodingAgents } from '../server/coding-agents.mjs';
import { prepareRobotShell } from '../server/robot-shell.mjs';
import { buildRobotRunArgs } from '../server/runtime-manager.mjs';
import { resolveAlaInstallation } from '../copilot/src/lib/alaInstallation.mjs';

test('new robots default to OpenCode and persisted API configuration supports all three', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-agents-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir: root });
    const robot = await store.create({ name: 'worker' });
    assert.deepEqual(robot.codingAgents, ['opencode']);
    await store.setCodingAgents(robot.id, ['pi']);
    assert.deepEqual((await new RobotStore({ dataDir: root }).get(robot.id)).codingAgents, ['pi']);
    await store.setCodingAgents(robot.id, ['codex', 'opencode', 'pi']);
    assert.deepEqual(robotCodingAgents(await store.get(robot.id)), ['codex', 'opencode', 'pi']);
    assert.deepEqual(robotCodingAgents({}), ['codex', 'opencode', 'pi']);
    for (const codingAgents of [[], ['unknown'], 'codex', null]) {
        await assert.rejects(store.setCodingAgents(robot.id, codingAgents), /codingAgents/);
    }
});

test('each selection is the only managed tool exposed to ALA, the shell and GUI mounts', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-agent-exposure-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    const cacheRoot = path.join(root, 'cache');
    const agents = {};
    for (const name of ['codex', 'opencode', 'pi']) {
        const prefix = path.join(cacheRoot, name, 'generation');
        await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
        await fs.writeFile(path.join(prefix, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        agents[name] = { path: prefix, binPath: path.join(prefix, 'bin') };
    }
    const cache = new ToolCache({ root: cacheRoot });
    cache.prepareCodingAgents = async names => Object.fromEntries(names.map(name => [name, agents[name]]));
    const { discoverCodingAgents } = await resolveAlaInstallation();
    for (const name of ['codex', 'opencode', 'pi']) {
        const tools = await cache.prepareShellTools([name]);
        assert.deepEqual(await fs.readdir(tools.binPath), [name]);
        const relativeTarget = await fs.readlink(path.join(tools.path, 'bin', name));
        assert.equal(path.resolve(tools.binPath, relativeTarget), path.join(agents[name].binPath, name));
        const inherited = { HOME: home, PATH: `${Object.values(agents).map(agent => agent.binPath).join(':')}:/usr/bin:/bin`,
            CODEX_BIN: path.join(agents.codex.binPath, 'codex'), OPENCODE_BIN: path.join(agents.opencode.binPath, 'opencode'),
            PI_BIN: path.join(agents.pi.binPath, 'pi') };
        const environment = codingAgentEnvironment(tools.agents, inherited, cacheRoot);
        const detected = await discoverCodingAgents({ env: environment });
        assert.deepEqual(detected.filter(agent => agent.available).map(agent => agent.name), [name]);
        await prepareRobotShell(home, { codingAgents: [name], binPath: tools.binPath, cacheRoot });
        const visible = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c',
            '. "$HOME/.roboteam-env.sh"; for tool in codex opencode pi; do command -v "$tool" || :; done'],
        { env: inherited, encoding: 'utf8' }).trim().split('\n');
        assert.deepEqual(visible, [path.join(tools.binPath, name)]);
        for (const mode of ['desktop', 'browser']) {
            const plan = buildRobotRunArgs({ robot: { id: 'worker-abc123', name: 'worker', codingAgents: [name] },
                mode, dataDir: root, publicBasePath: '/rt/', images: { desktop: 'desktop', browser: 'browser' },
                timezone: 'UTC', cwd: '/workspace', toolsPath: '/tools', shellTools: tools });
            for (const [candidate, agent] of Object.entries(agents)) {
                assert.equal(plan.args.includes(`${agent.path}:${agent.path}:ro`), candidate === name);
            }
            assert.equal(plan.args.includes(`${cacheRoot}:/data/tool-cache:ro`), false);
            assert.ok(plan.args.includes(`${tools.path}:${path.dirname(tools.binPath)}:ro`));
        }
    }
    const all = await cache.prepareShellTools(['codex', 'opencode', 'pi']);
    assert.deepEqual((await fs.readdir(all.binPath)).sort(), ['codex', 'opencode', 'pi']);
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
