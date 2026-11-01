import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentEnvironments } from '../server/agent-environments.mjs';
import { EnvironmentManager } from '../../roboWorkAgent/server/environment.mjs';

function fixture(options = {}) {
    const agents = ['gitAgent', 'templated', 'unpullable', 'privateAgent', 'dpuAgent', 'roboWorkAgent', 'roboTeamAgent', 'isolated', 'inactive']
        .map(name => ({ repo: 'AchillesIDE', name, active: name !== 'inactive', enableMode: name === 'isolated' ? 'isolated' : 'global',
            running: false, manifestPath: `/manifests/${name}.json` }));
    const pulled = [];
    const manager = new EnvironmentManager({ loadMarketplace: async () => ({ agents }),
        readManifest: async file => {
            if (file.includes('templated')) return { container: 'image:{{VERSION}}' };
            if (file.includes('privateAgent')) return { container: 'image:private', volumes: { '.data/.private/owner': '/data' } };
            if (file.includes('dpuAgent')) return { container: 'image:dpu-node', runtime: { resources: { persistentStorage: { key: 'dpu-data', containerPath: '/dpu-data' } } } };
            return { container: file.includes('unpullable') ? 'image:missing' : 'image:node' };
        },
        imageExists: async () => false,
        ensureImage: async image => {
            pulled.push(image);
            if (image === 'image:missing') throw new Error('registry credentials must not escape');
            return { path: '/image/bin:/usr/bin' };
        }, ...options });
    return { manager, agents, pulled };
}

test('discovery resolves image manifests, excludes private owners and reports unavailable images safely', async () => {
    const { manager, pulled } = fixture();
    const list = await manager.list();
    assert.deepEqual(list.map(({ ref, available, reason }) => [ref, available, reason]), [
        ['AchillesIDE/dpuAgent', true, ''],
        ['AchillesIDE/gitAgent', true, ''],
        ['AchillesIDE/unpullable', true, ''],
        ['AchillesIDE/templated', false, 'templated or invalid image'],
    ]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['about', 'available', 'key', 'name', 'reason', 'ref', 'repo']);
    assert.equal(Buffer.from(list[0].key, 'base64url').toString(), list[0].ref);
    assert.deepEqual(pulled, []);
    assert.equal((await manager.require('AchillesIDE/gitAgent')).image, 'image:node');
    assert.deepEqual(pulled, []);
    assert.equal((await manager.prepare('AchillesIDE/gitAgent')).image, 'image:node');
    assert.deepEqual(pulled, ['image:node']);
    for (const ref of ['AchillesIDE/templated', 'AchillesIDE/privateAgent', 'AchillesIDE/absent']) {
        await assert.rejects(manager.require(ref), { code: 'ENVIRONMENT_UNAVAILABLE' });
    }
    for (const ref of ['', '../agent', 'gitAgent', 'a/b/c', null]) {
        await assert.rejects(manager.require(ref), { code: 'ENVIRONMENT_INVALID' });
    }
});

test('choosing an environment refreshes state and a manifest failure stays a safe unavailable record', async () => {
    const { manager, agents } = fixture();
    await manager.list();
    agents[0].active = false;
    await assert.rejects(manager.require('AchillesIDE/gitAgent'), { code: 'ENVIRONMENT_UNAVAILABLE' });
    const failed = fixture({ readManifest: async () => { throw new Error('/private/path secret'); } }).manager;
    const list = await failed.list();
    assert.ok(list.every(entry => entry.reason === 'manifest unavailable' && entry.available === false));
    assert.equal(JSON.stringify(list).includes('secret'), false);
    assert.ok((await fixture({ readManifest: async () => null }).manager.list()).every(entry => entry.reason === 'manifest unavailable'));
});

test('only selected image preparation pulls without a time cap and inspects PATH', async () => {
    const calls = [];
    const { manager } = fixture({ ensureImage: undefined, imageExists: undefined, execFileImpl: async (...args) => {
        calls.push(args);
        if (args[1][1] === 'exists') throw Object.assign(new Error('not downloaded'), { code: 1 });
        return { stdout: '["PATH=/custom/node/bin:/usr/bin","PLOINKY_AGENT_SECRET=never-forward"]' };
    } });
    await manager.list();
    await manager.require('AchillesIDE/gitAgent');
    assert.ok(calls.every(([, args]) => args[0] === 'image' && args[1] === 'exists'));
    calls.length = 0;
    const entry = await manager.prepare('AchillesIDE/gitAgent');
    assert.equal(entry.imagePath, '/custom/node/bin:/usr/bin');
    const pulls = calls.filter(([, args]) => args[0] === 'pull');
    assert.equal(pulls.length, 1);
    assert.deepEqual(pulls[0].slice(0, 2), ['podman', ['pull', 'image:node']]);
    assert.equal('timeout' in pulls[0][2], false);
    assert.deepEqual(calls.at(-1).slice(0, 2), ['podman', ['image', 'inspect', '--format', '{{json .Config.Env}}', 'image:node']]);
    assert.equal(JSON.stringify(entry).includes('never-forward'), false);
});

test('an already cached chosen image is inspected without a pull', async () => {
    const calls = [];
    const { manager } = fixture({ ensureImage: undefined, imageExists: undefined, execFileImpl: async (...args) => {
        calls.push(args);
        return { stdout: '[]' };
    } });
    await manager.prepare('AchillesIDE/dpuAgent');
    assert.equal(calls.some(([, args]) => args[0] === 'pull'), false);
    assert.deepEqual(calls.at(-1)[1], ['image', 'inspect', '--format', '{{json .Config.Env}}', 'image:dpu-node']);
});

test('a failed selected pull is cached as its reason and only an explicit step retries it', async () => {
    let fail = true;
    const pulls = [];
    const { manager } = fixture({ ensureImage: async image => {
        pulls.push(image);
        if (fail) throw new Error('credentials must stay private');
        return { path: '/image/bin' };
    } });
    await assert.rejects(manager.prepare('AchillesIDE/unpullable'), { code: 'ENVIRONMENT_UNAVAILABLE' });
    const list = await manager.list();
    assert.equal(list.find(entry => entry.ref === 'AchillesIDE/unpullable').reason, 'image cannot be pulled');
    assert.equal(list.find(entry => entry.ref === 'AchillesIDE/gitAgent').available, true);
    await assert.rejects(manager.require('AchillesIDE/unpullable'), /image cannot be pulled/u);
    assert.deepEqual(pulls, ['image:missing']);
    assert.equal(JSON.stringify(list).includes('credentials'), false);
    fail = false;
    assert.equal((await manager.prepare('AchillesIDE/unpullable')).available, true);
    assert.deepEqual(pulls, ['image:missing', 'image:missing']);
    assert.equal((await manager.list()).find(entry => entry.ref === 'AchillesIDE/unpullable').available, true);
});

async function launchFixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robowork-environment-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(path.join(workspaceRoot, '.data'));
    await fs.writeFile(path.join(workspaceRoot, '.env'), 'secret');
    return { environment: 'AchillesIDE/gitAgent', runId: 'run-1', robotId: 'robot-one',
        workspaceRoot, cwd: workspaceRoot, home: path.join(root, 'private/robot-one/home'),
        toolCache: { source: '/data/tool-cache', target: '/data/tool-cache' },
        ala: { source: '/Agent/linked/AdvancedLanguageAgent', target: '/opt/ala', entry: '/opt/ala/bin/ala.mjs' },
        bwrap: { source: '/data/tool-cache/bwrap/bin/bwrap', target: '/opt/bwrap' },
        channels: [{ source: '/data/runs/run-1/channels/human-input', target: '/workspace/human-input' }],
        soul: { source: '/data/robots/robot-one/run/soul', target: '/workspace/roboteam-soul' },
        folders: [{ source: '/skills/one', target: '/workspace/roboteam-skill-0' }],
        args: ['--home', '/home/robot-one', '--cwd', workspaceRoot, '--ignore', '.data', '--ignore', '.ploinky', '--ignore', '.env'],
        env: { PLOINKY_AGENT_SECRET: 'secret', TOKEN: 'secret', HOME: '/wrong', PATH: '/wrong', ALA_SESSIONS: `${workspaceRoot}/.roboteam/.ala`, LANG: 'C.UTF-8' } };
}

test('each step builds a fresh disposable image container with only its mapped resources and cleared env', async t => {
    const options = await launchFixture(t);
    const { manager } = fixture();
    const launch = await manager.buildLaunch(options);
    const args = launch.args;
    assert.deepEqual(args.slice(0, 3), ['run', '--rm', '-i']);
    assert.equal(args[args.indexOf('--user') + 1], '0:0');
    assert.equal(args[args.indexOf('--network') + 1], 'pasta:--no-map-gw');
    assert.equal(args[args.indexOf('--security-opt') + 1], 'unmask=/proc/*');
    assert.equal(args[args.indexOf('--entrypoint') + 1], '/usr/bin/env');
    assert.ok(args.includes(`${options.home}:/home/robot-one:rw`));
    assert.ok(args.includes(`${options.workspaceRoot}:${options.workspaceRoot}:ro`));
    assert.ok(args.includes(`${options.workspaceRoot}:${options.workspaceRoot}:rw`));
    assert.ok(args.includes('/data/tool-cache:/data/tool-cache:ro'));
    assert.ok(args.includes('/Agent/linked/AdvancedLanguageAgent:/opt/ala:ro'));
    assert.ok(args.includes('/data/tool-cache/bwrap/bin/bwrap:/opt/bwrap:ro'));
    assert.ok(args.includes('/data/runs/run-1/channels/human-input:/workspace/human-input:rw'));
    assert.ok(args.includes('/data/robots/robot-one/run/soul:/workspace/roboteam-soul:ro'));
    assert.ok(args.includes('/skills/one:/workspace/roboteam-skill-0:ro'));
    for (const hidden of ['.data', '.ploinky']) {
        assert.ok(args.indexOf(`${options.workspaceRoot}/${hidden}:rw,nosuid,nodev,noexec`) > args.indexOf(`${options.workspaceRoot}:${options.workspaceRoot}:rw`));
    }
    assert.ok(args.includes(`/dev/null:${options.workspaceRoot}/.env:ro`));
    const imageIndex = args.indexOf('image:node');
    assert.equal(args[imageIndex + 1], '-i');
    assert.ok(args.includes('PATH=/image/bin:/usr/bin'));
    assert.ok(args.includes('HOME=/home/robot-one'));
    assert.ok(args.includes('USER=robot-one'));
    assert.ok(args.includes('ALA_BWRAP=/opt/bwrap'));
    assert.deepEqual(args.slice(args.indexOf('node'), args.indexOf('node') + 2), ['node', '/opt/ala/bin/ala.mjs']);
    assert.equal(args.join(' ').includes('secret'), false);
    assert.equal(args.includes('exec'), false);
    assert.equal(args.some(arg => arg.includes('host') || arg.includes('map-gw:') || arg.startsWith('PLOINKY_')), false);
    const other = await manager.buildLaunch({ ...options, runId: 'run-2', tty: true });
    assert.notEqual(other.containerName, launch.containerName);
    assert.equal(other.args[2], '-it');
});

test('builder rejects private cwd, symlink escapes and invalid mount vectors before spawn', async t => {
    const options = await launchFixture(t);
    const { manager } = fixture();
    await fs.symlink(path.dirname(options.workspaceRoot), path.join(options.workspaceRoot, 'escape'));
    for (const cwd of [path.join(options.workspaceRoot, '.data'), path.join(options.workspaceRoot, 'escape')]) {
        await assert.rejects(manager.buildLaunch({ ...options, cwd }), { code: 'ENVIRONMENT_PATH_INVALID' });
    }
    await assert.rejects(manager.buildLaunch({ ...options, home: '/bad:mount' }), { code: 'ENVIRONMENT_PATH_INVALID' });
    await assert.rejects(manager.buildLaunch({ ...options, robotId: '../robot' }), { code: 'ENVIRONMENT_INVALID' });
});

test('cached executables and PATH are translated while executable symlink escapes are refused', async t => {
    const options = await launchFixture(t);
    const source = path.join(path.dirname(options.workspaceRoot), 'cache');
    await fs.mkdir(path.join(source, 'generation/bin'), { recursive: true });
    await fs.writeFile(path.join(source, 'generation/bin/codex'), '');
    await fs.symlink('generation', path.join(source, 'selected'));
    await fs.symlink('/usr/bin/env', path.join(source, 'escape'));
    const { manager } = fixture();
    const configured = { ...options, toolCache: { source, target: '/data/tool-cache' },
        env: { CODEX_BIN: path.join(source, 'selected/bin/codex'), PATH: `/usr/bin:${source}/selected/bin`, ALA_EVENT_STREAM: '1' } };
    const launch = await manager.buildLaunch(configured);
    assert.ok(launch.args.includes('CODEX_BIN=/data/tool-cache/generation/bin/codex'));
    assert.ok(launch.args.includes('PATH=/image/bin:/usr/bin:/data/tool-cache/generation/bin'));
    assert.ok(launch.args.includes('ALA_SANDBOX_HOME=/home/robot-one'));
    assert.ok(launch.args.includes('ALA_EVENT_STREAM=1'));
    assert.ok(launch.args.includes('XDG_CONFIG_HOME=/home/robot-one/.config'));
    await assert.rejects(manager.buildLaunch({ ...configured, env: { CODEX_BIN: path.join(source, 'escape') } }), { code: 'ENVIRONMENT_PATH_INVALID' });
});

test('spawn delegates the exact vector and exposes the managed container identity for stop', async t => {
    const options = await launchFixture(t), calls = [], child = {};
    const { manager } = fixture({ spawnImpl: (...args) => { calls.push(args); return child; } });
    assert.equal(await manager.spawn(options), child);
    assert.equal(calls[0][0], 'podman');
    assert.equal(calls[0][1][calls[0][1].indexOf('--name') + 1], child.containerName);
    assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
});

test('RoboTeam is a thin environment_list MCP client and propagates unavailable selection errors', async () => {
    const entries = [{ ref: 'AchillesIDE/gitAgent', key: 'git', available: true, reason: '' },
        { ref: 'AchillesIDE/broken', key: 'bad', available: false, reason: 'image cannot be pulled' }];
    const calls = [];
    const client = new AgentEnvironments({ call: async (...args) => { calls.push(args); return entries; } });
    assert.deepEqual(await client.list(), entries);
    assert.equal((await client.require('AchillesIDE/gitAgent')).key, 'git');
    assert.deepEqual(calls[0], ['environment_list', {}, { timeoutMs: 120000 }]);
    await assert.rejects(client.require('AchillesIDE/broken'), /image cannot be pulled/u);
    await assert.rejects(client.require('AchillesIDE/missing'), { statusCode: 409 });
    await assert.rejects(client.require('bad'), { statusCode: 400 });
    await assert.rejects(new AgentEnvironments({ call: async () => ({}) }).list(), /unreadable/u);
});
