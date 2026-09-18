import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
// Tests explicitly provision the workspace normally supplied by Ploinky.
process.env.PLOINKY_WORKSPACE_ROOT = os.tmpdir();
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { prepareWorkingHome } from '../server/working-home.mjs';

test('working home preserves native files and connects to the original gateway socket', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rth-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const original = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    await fs.mkdir(path.join(original, '.config/opencode'), { recursive: true });
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(original, 'native-session'), 'history');
    const socket = path.join(original, '.config/opencode/soul-gateway.sock');
    const server = net.createServer(client => client.end('connected'));
    server.listen(socket);
    await once(server, 'listening');
    t.after(() => server.close());
    const home = await prepareWorkingHome(cwd, original);
    assert.ok(home.startsWith(`${cwd}/`));
    assert.equal(await fs.readFile(path.join(home, 'native-session'), 'utf8'), 'history');
    assert.equal(await fs.readlink(path.join(home, '.config/opencode/soul-gateway.sock')), socket);
    const client = net.connect(path.join(home, '.config/opencode/soul-gateway.sock'));
    assert.equal(String((await once(client, 'data'))[0]), 'connected');
    client.destroy();
    await fs.writeFile(path.join(home, 'native-session'), 'continued');
    assert.equal(await prepareWorkingHome(cwd, original), home);
    assert.equal(await fs.readFile(path.join(home, 'native-session'), 'utf8'), 'continued');
    assert.equal(await fs.readFile(path.join(original, 'native-session'), 'utf8'), 'history');
});
