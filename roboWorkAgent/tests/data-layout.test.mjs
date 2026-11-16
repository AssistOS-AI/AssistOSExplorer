import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RobotPaths } from '../server/robot-paths.mjs';
import { RobotManager } from '../server/robot-manager.mjs';
import { RunManager } from '../server/run-manager.mjs';
import { createTerminalProfiles } from '../server/terminal-profiles.mjs';
import { buildPrivateLaunch } from '../server/launch.mjs';
import { preparePodmanStorage } from '../scripts/prepare-podman-storage.mjs';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/rw-layout-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paths = new RobotPaths({ dataDir: path.join(root, 'service'), robotsDir: path.join(root, 'robots'), workspaceRoot: path.join(root, 'workspace') });
    await fs.mkdir(paths.workspaceRoot);
    const robots = new RobotManager({ paths, toolCache: {}, soulGateway: { prepare: async () => {}, remove: async () => {} },
        homeOperation: async (id, operation) => {
            if (operation === 'delete') for (const name of await fs.readdir(paths.home(id))) await fs.rm(path.join(paths.home(id), name), { recursive: true });
            return {};
        }, readStatus: async () => ({}) });
    await robots.initialize();
    return { root, paths, robots };
}

test('robot deletion keeps history readable after restart, excludes the robot from catalogs, and permits recreation', async t => {
    const { paths, robots } = await fixture(t);
    const input = { robotId: 'robot-a', name: 'Robot A', codingAgents: ['codex'], seed: false };
    await robots.ensure(input);
    const directory = paths.run(input.robotId, 'history-1');
    await fs.mkdir(directory, { recursive: true });
    const meta = { runId: 'history-1', robotId: input.robotId, state: 'exited', startedAt: new Date().toISOString(), exit: { code: 0 }, tag: {} };
    const record = { seq: 1, stream: 'stdout', data: Buffer.from('retained output').toString('base64') };
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta));
    await fs.writeFile(path.join(directory, 'log.ndjson'), JSON.stringify(record) + '\n');
    const runs = new RunManager({ paths, robots });
    await runs.initialize(); robots.runs = runs;
    await robots.delete({ robotId: input.robotId });
    assert.deepEqual(await fs.readdir(paths.robot(input.robotId)), ['runs']);
    await fs.mkdir(path.join(paths.robotsDir, '.credentials'));
    assert.deepEqual(await robots.status(), { robots: [] });
    const terminal = createTerminalProfiles({ paths, robots, environment: { list: async () => [] } });
    assert.deepEqual((await terminal.catalog()).profiles, []);
    assert.deepEqual(await terminal.resolveLive('robot-a.default'), { allowed: false });
    await runs.close();
    const restarted = new RunManager({ paths, robots });
    await restarted.initialize(); t.after(() => restarted.close());
    assert.deepEqual((await restarted.read({ runId: 'history-1' })).records, [record]);
    assert.equal(restarted.list()[0].robotId, input.robotId);
    await robots.ensure(input);
    assert.equal((await robots.status()).robots[0].id, input.robotId);
    assert.deepEqual((await restarted.read({ runId: 'history-1' })).records, [record]);
});

test('native launches mask service and robots roots before rebinding the selected robot', async t => {
    const { paths } = await fixture(t);
    const directory = paths.run('robot-a', 'launch-1');
    await fs.mkdir(directory, { recursive: true });
    await buildPrivateLaunch({ paths, id: 'robot-a', directory, command: '/bin/true', args: [] });
    const script = await fs.readFile(path.join(directory, 'launch.sh'), 'utf8');
    for (const root of [paths.dataDir, paths.robotsDir]) assert.ok(script.includes(`mount -t tmpfs tmpfs '${root}'`));
    assert.ok(script.indexOf(`tmpfs '${paths.robotsDir}'`) < script.indexOf(`mount --bind "$stage/0" '${paths.robot('robot-a')}'`));
    assert.ok(!script.includes('.credentials'));
    assert.ok(!script.includes('robot-b'));
});

test('old image storage config adapts without altering graphroot, runroot or persistent cache bytes', async t => {
    const { root, paths } = await fixture(t);
    const source = path.join(root, 'image-storage.conf');
    const template = '[storage]\ndriver = "overlay"\nrunroot = "/var/lib/roboteam-podman/run"\ngraphroot = "/var/lib/roboteam-podman/storage"\nimagestore = "/data/podman/images"\ntransient_store = true\n[storage.options.overlay]\nforce_mask = "0700"\n';
    await fs.writeFile(source, template);
    await fs.mkdir(path.join(paths.dataDir, 'podman/images'), { recursive: true });
    const marker = path.join(paths.dataDir, 'podman/images/existing-cache');
    await fs.writeFile(marker, 'preserved');
    const options = { dataDir: paths.dataDir, source };
    const destination = await preparePodmanStorage(options);
    assert.equal(await preparePodmanStorage(options), destination);
    assert.equal(await fs.readFile(destination, 'utf8'), template.replace('/data/podman/images', path.join(paths.dataDir, 'podman/images')));
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserved');
    assert.equal(await fs.readFile(source, 'utf8'), template);
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    await fs.writeFile(source, template.replace('/var/lib/roboteam-podman/storage', '/data/podman/storage'));
    await assert.rejects(preparePodmanStorage(options), /Unsupported/u);
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserved');
});
