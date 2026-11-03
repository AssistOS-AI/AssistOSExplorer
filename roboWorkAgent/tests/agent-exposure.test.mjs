import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RobotManager } from '../server/robot-manager.mjs';
import { RunManager } from '../server/run-manager.mjs';

const NAMES = ['codex', 'opencode', 'pi', 'claude'];
const prepared = names => Object.fromEntries(names.map(name => [name, { path: `/tools/${name}`, binPath: `/tools/${name}/bin` }]));

async function workspace(t) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    const cwd = path.join(workspaceRoot, 'project');
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(dataDir, 'runs'), { recursive: true });
    return { paths: new RobotPaths({ dataDir, workspaceRoot }), cwd, dataDir };
}

test('model listing prepares only the chosen coding agent and starts the listing with its environment', async t => {
    const { paths, dataDir } = await workspace(t);
    const prepareCalls = [];
    let launched;
    const robots = new RobotManager({ paths, alaEntry: '/unused',
        toolCache: { root: path.join(dataDir, 'tool-cache'), prepareCodingAgents: async names => { prepareCalls.push(names); return prepared(names); } },
        soulGateway: { prepare: async () => {} }, homeOperation: async () => {},
        captureLaunch: async launch => { launched = launch; return { stdout: '[]' }; } });
    robots.require = async id => ({ id, codingAgents: NAMES });
    await robots.models({ robotId: 'robot-abc', agent: 'opencode' });
    assert.deepEqual(prepareCalls, [['opencode']]);
    const env = launched.options.env;
    assert.equal(env.OPENCODE_BIN, '/tools/opencode/bin/opencode');
    for (const other of ['CODEX_BIN', 'PI_BIN', 'CLAUDE_BIN']) assert.equal(env[other], undefined, other);
    assert.ok(env.PATH.split(path.delimiter).includes('/tools/opencode/bin'));
    assert.ok(!env.PATH.split(path.delimiter).some(entry => ['codex', 'pi', 'claude'].some(name => entry === `/tools/${name}/bin`)));
});

test('a run gives ALA only the coding agents selected for the robot', async t => {
    const { paths, cwd } = await workspace(t);
    const prepareCalls = [];
    let launch;
    const manager = new RunManager({ paths, alaEntry: '/unused',
        robots: { require: async id => ({ id, codingAgents: ['codex', 'pi'] }) },
        toolCache: { root: path.join(paths.dataDir, 'tool-cache'), prepareCodingAgents: async names => { prepareCalls.push(names); return prepared(names); } },
        buildLaunch: async options => { launch = options; return { command: process.execPath, args: ['-e', ''], options: { detached: true, stdio: ['pipe', 'pipe', 'pipe'] } }; } });
    await manager.initialize();
    await manager.start({ runId: 'run-1', robotId: 'robot-abc', cwd, ala: { sessionId: 'session-1' }, folders: [], ignore: [], channels: [] });
    await manager.get('run-1').preparing;
    await manager.close();
    assert.deepEqual(prepareCalls, [['codex', 'pi']]);
    assert.equal(launch.env.CODEX_BIN, '/tools/codex/bin/codex');
    assert.equal(launch.env.PI_BIN, '/tools/pi/bin/pi');
    for (const other of ['OPENCODE_BIN', 'CLAUDE_BIN']) assert.equal(launch.env[other], undefined, other);
    assert.ok(!launch.env.PATH.split(path.delimiter).some(entry => ['opencode', 'claude'].some(name => entry === `/tools/${name}/bin`)));
});
