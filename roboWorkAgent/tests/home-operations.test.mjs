import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHomeOperations } from '../server/home-op.mjs';
import { RobotPaths } from '../server/robot-paths.mjs';

const SENTINEL = 'sentinel-credential-value';
const CREDENTIALS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN', 'PLOINKY_AGENT_SECRET',
    'ROBOWORK_INTERNAL_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'XDG_DATA_HOME', 'HOME', 'NODE_OPTIONS'];

test('a credential variable of the server never reaches the helper that detects a robot login', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-home-op-')));
    const previous = Object.fromEntries(CREDENTIALS.map(name => [name, process.env[name]]));
    t.after(async () => {
        for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        await fs.rm(root, { recursive: true, force: true });
    });
    for (const name of CREDENTIALS) process.env[name] = SENTINEL;
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), workspaceRoot: path.join(root, 'workspace') });
    const alaEntry = path.join(root, 'ala', 'bin', 'ala.mjs');
    let launched;
    const operation = createHomeOperations({ paths, alaEntry, toolCache: { root: path.join(root, 'tool-cache') },
        execFileImpl: async (command, args, options) => { launched = { command, args, options }; return { stdout: '{}' }; } });
    await operation('robot-a', 'status', { includeLogins: true, codingAgents: ['codex'] });
    const { args, options } = launched;
    assert.equal(launched.command, 'bwrap');
    assert.ok(args.includes('--clearenv'));
    assert.ok(args.indexOf('--clearenv') < args.indexOf('--setenv'), 'the environment is cleared before anything is set');
    const set = Object.fromEntries(args.flatMap((value, index) => value === '--setenv' ? [[args[index + 1], args[index + 2]]] : []));
    // Only the robot's own home reaches the helper, never the server's.
    assert.equal(set.HOME, '/home/robot-a');
    assert.equal(set.CODEX_HOME, '/home/robot-a/.codex');
    assert.equal(set.XDG_DATA_HOME, '/home/robot-a/.local/share');
    for (const name of CREDENTIALS.filter(name => !['HOME', 'CODEX_HOME', 'XDG_DATA_HOME'].includes(name))) {
        assert.equal(name in set, false, `${name} is not passed into the helper`);
        assert.equal(name in options.env, false, `${name} is not in the helper launcher environment`);
    }
    assert.equal(JSON.stringify([args, options.env]).includes(SENTINEL), false);
});

test('the in-service status reads only the robot home: no server credential and no login reached through a link', async t => {
    const { robotStatus } = await import('../server/home-op.mjs');
    const { nativeEnvironment } = await import('../server/native-environment.mjs');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-status-')));
    const previous = process.env.OPENAI_API_KEY;
    t.after(async () => {
        if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    process.env.OPENAI_API_KEY = SENTINEL;
    const home = path.join(root, 'robot-a'), other = path.join(root, 'robot-b');
    const auth = JSON.stringify({ openai: { type: 'oauth' } });
    await fs.mkdir(path.join(other, '.local', 'share', 'opencode'), { recursive: true });
    await fs.writeFile(path.join(other, '.local', 'share', 'opencode', 'auth.json'), auth);
    await fs.mkdir(home);
    const status = () => robotStatus(home, { includeLogins: true, codingAgents: ['opencode'] }, { env: nativeEnvironment({ PATH: '/usr/bin:/bin' }, home) });
    // The server's own provider key is not a robot login.
    assert.deepEqual((await status()).logins, { codex: false, opencode: false, pi: false, claude: false });
    // Another home's login reached through a linked parent directory is not this robot's.
    await fs.symlink(path.join(other, '.local'), path.join(home, '.local'));
    assert.equal((await status()).logins.opencode, false);
    // The robot's own login is.
    await fs.rm(path.join(home, '.local'));
    await fs.mkdir(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
    await fs.writeFile(path.join(home, '.local', 'share', 'opencode', 'auth.json'), auth);
    assert.deepEqual(await status(), { activeAgent: 'opencode', logins: { codex: false, opencode: true, pi: false, claude: false } });
});
