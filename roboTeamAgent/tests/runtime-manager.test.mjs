import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { buildRobotRunArgs, RuntimeManager } from '../server/runtime-manager.mjs';

test('builds browser and desktop containers around the persistent robot directories', () => {
    const plan = buildRobotRunArgs({
        robot: { id: 'research-a1b2c3', name: 'Research' },
        mode: 'browser',
        dataDir: '/data',
        publicBasePath: '/base-agent-additional-server/roboTeamAgent/3001/',
        images: { browser: 'browser:image', desktop: 'desktop:image' },
        timezone: 'Europe/Bucharest',
    });
    assert.equal(plan.image, 'browser:image');
    assert.ok(plan.args.includes('SUBFOLDER=/base-agent-additional-server/roboTeamAgent/3001/api/robots/research-a1b2c3/session/'));
    assert.ok(plan.args.includes('/data/robots/research-a1b2c3/home:/config'));
    assert.ok(plan.args.includes('127.0.0.1::3000'));
    assert.equal(plan.args.includes('--privileged'), false);
    assert.deepEqual(plan.args.slice(2, 6), ['--ipc', 'private', '--shm-size', '1g']);
});

test('allows exactly one active mode per robot and removes only its exact container', async (t) => {
    const listener = net.createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => listener.close());
    const port = listener.address().port;
    const calls = [];
    const execFileImpl = async (_command, args) => {
        calls.push(args);
        if (args[0] === 'ps') return { stdout: '[]', stderr: '' };
        if (args[0] === 'port') return { stdout: `127.0.0.1:${port}\n`, stderr: '' };
        if (args[0] === 'inspect') return { stdout: 'true\n', stderr: '' };
        return { stdout: '', stderr: '' };
    };
    const manager = new RuntimeManager({ dataDir: '/data', publicBasePath: '/rt/', execFileImpl });
    await manager.initialize();
    const robot = { id: 'research-a1b2c3', name: 'Research' };
    const running = await manager.start(robot, 'desktop');
    assert.equal(running.mode, 'desktop');
    await assert.rejects(() => manager.start(robot, 'browser'), /already running in desktop mode/);
    await manager.stop(robot.id);
    assert.deepEqual(manager.status(robot.id), { state: 'stopped' });
    assert.ok(calls.some((args) => args[0] === 'rm' && args[2] === 'roboteam-robot-research-a1b2c3'));
});
