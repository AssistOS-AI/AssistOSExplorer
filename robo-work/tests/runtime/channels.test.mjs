import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExecutionChannels, parseFailure, parseQuestion } from '../../server/runtime/channels.mjs';

// The worker-hosted channels over real Unix sockets. RoboTeam's own skill scripts (report-task-blocked, require-human-input) are run
// against the compatible layout, so the real client protocol is what is tested.
const ROBOTEAM = new URL('../../../roboTeamAgent/copilot/src/skills/', import.meta.url);

function tempDirectory(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-ch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function call(socketPath, route, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({ socketPath, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}
const QUESTION = { question: 'Ship it?', options: ['yes', 'no', 'later'] };

test('only the admitted channels exist; the plan sockets need no token and the handlers run before the reply', async (t) => {
    const dir = tempDirectory(t);
    const order = [];
    const channels = await createExecutionChannels({
        directory: dir,
        taskFailure: async (input) => { order.push(['recorded', input]); return {}; }
    });
    t.after(() => channels.close());
    assert.equal(fs.existsSync(path.join(dir, 'task-failure.sock')), true);
    assert.equal(fs.existsSync(path.join(dir, 'human-input.sock')), false, 'not admitted: no socket');
    assert.equal(fs.existsSync(path.join(dir, 'human-input')), false);
    const reply = await call(path.join(dir, 'task-failure.sock'), '/report-task-blocked', { message: ' blocked\u0007 here ' });
    order.push(['replied']);
    assert.deepEqual(reply, { status: 200, body: { ok: true } });
    assert.deepEqual(order, [['recorded', { message: 'blocked here' }], ['replied']]);
    assert.equal((await call(path.join(dir, 'task-failure.sock'), '/other', {})).status, 403);
});

test('RoboTeam\'s real skill scripts work against the compatible layout, and its capability token is required there', async (t) => {
    const dir = tempDirectory(t);
    const seen = [];
    const channels = await createExecutionChannels({
        directory: dir,
        taskFailure: async (input) => { seen.push(['failure', input]); return {}; },
        humanInput: async (input) => { seen.push(['question', input]); return { id: 'req-1' }; }
    });
    t.after(() => channels.close());
    const { reportTaskBlocked } = await import(new URL('report-task-blocked/scripts/run.mjs', ROBOTEAM).href);
    const { requireHumanInput } = await import(new URL('require-human-input/scripts/run.mjs', ROBOTEAM).href);
    assert.deepEqual(await reportTaskBlocked({ message: 'cannot continue' }, { directory: path.join(dir, 'task-failure') }), { ok: true });
    const answer = await requireHumanInput(QUESTION, { directory: path.join(dir, 'human-input') });
    assert.deepEqual(answer, { ok: true, id: 'req-1', instruction: 'End this execution now. Wait for the user answer.' });
    assert.deepEqual(seen, [['failure', { message: 'cannot continue' }], ['question', QUESTION]]);
    assert.equal((await call(path.join(dir, 'task-failure', 'request.sock'), '/report-task-blocked', { message: 'x' }, { 'x-task-capability': 'wrong' })).status, 403);
    assert.equal((await call(path.join(dir, 'task-failure', 'request.sock'), '/report-task-blocked', { message: 'x' })).status, 403);
});

test('bounds: sizes, option counts, malformed JSON and handler errors with a status', async (t) => {
    const dir = tempDirectory(t);
    const channels = await createExecutionChannels({
        directory: dir,
        taskFailure: async () => ({}),
        humanInput: async () => { throw Object.assign(new Error('A human-input question is already pending'), { statusCode: 409 }); }
    });
    t.after(() => channels.close());
    const failure = path.join(dir, 'task-failure.sock');
    const human = path.join(dir, 'human-input.sock');
    assert.equal((await call(failure, '/report-task-blocked', { message: 'x'.repeat(8001) })).status, 400);
    assert.equal((await call(failure, '/report-task-blocked', { message: '   ' })).status, 400);
    assert.equal((await call(failure, '/report-task-blocked', { message: 5 })).status, 400);
    assert.equal((await call(failure, '/report-task-blocked', '{not json')).status, 400);
    assert.equal((await call(failure, '/report-task-blocked', { message: 'x'.repeat(70 * 1024) })).status, 413);
    for (const options of [['a', 'b'], ['a', 'a', 'b'], ['a', 'b', ''], ['a', 'b', 'c'.repeat(2001)], 'abc']) {
        assert.equal((await call(human, '/require-human-input', { question: 'q', options })).status, 400, JSON.stringify(options).slice(0, 40));
    }
    assert.equal((await call(human, '/require-human-input', { question: 'q'.repeat(8001), options: ['a', 'b', 'c'] })).status, 400);
    assert.deepEqual(await call(human, '/require-human-input', QUESTION), { status: 409, body: { error: 'A human-input question is already pending' } });
    assert.deepEqual(parseQuestion({ question: ' q ', options: [' a', 'b ', 'c'] }), { question: 'q', options: ['a', 'b', 'c'] });
    assert.throws(() => parseFailure({}), /nonempty message/u);
});
