import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPloinkyTaskContext } from '../src/lib/ploinkyTaskContext.mjs';
import { sendTaskEvent } from '../src/skills/launch-robot/scripts/taskEventClient.mjs';

test('acknowledges after observation, deduplicates retries and accepts separate metadata updates', async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tasks = [];
    const context = await createPloinkyTaskContext({ context: { workingDir: '/workspace' }, env: {},
        onTask: async task => { tasks.push(task); await gate; } });
    t.after(() => context.close());
    const { eventToken } = JSON.parse(await fs.readFile(path.join(context.directory, 'context.json'), 'utf8'));
    const socket = path.join(context.directory, 'tasks.sock');
    const id = randomUUID();
    const event = { type: 'task-started', task: { taskId: 'remote' } };
    let acknowledged = false;
    const first = sendTaskEvent(socket, eventToken, event, { id }).then(() => { acknowledged = true; });
    const second = sendTaskEvent(socket, eventToken, event, { id });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(acknowledged, false);
    assert.equal(tasks.length, 1);
    release();
    await Promise.all([first, second]);
    await assert.rejects(sendTaskEvent(socket, 'wrong', event), /not accepted/);
    await assert.rejects(sendTaskEvent(socket, eventToken, { type: 'task-started', task: { taskId: 'other' } }, { id }), /not accepted/);
    await sendTaskEvent(socket, eventToken, { type: 'task-started', task: { taskId: 'remote', metadata: { liveSession: { url: '/live' } } } });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[1].metadata.liveSession.url, '/live');
    await context.close();
    await assert.rejects(fs.stat(context.directory), { code: 'ENOENT' });
});

test('a lost acknowledgement retries the same notification ID', async t => {
    const directory = await fs.mkdtemp('/tmp/socket-retry-');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const ids = [];
    const server = net.createServer(socket => socket.once('data', bytes => {
        const message = JSON.parse(bytes.toString());
        ids.push(message.id);
        if (ids.length === 1) socket.destroy();
        else socket.end(JSON.stringify({ id: message.id, ok: true }) + '\n');
    }));
    await new Promise(resolve => server.listen(path.join(directory, 'tasks.sock'), resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    await sendTaskEvent(path.join(directory, 'tasks.sock'), 'token', { type: 'task-started', task: { taskId: 'remote' } });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
});
