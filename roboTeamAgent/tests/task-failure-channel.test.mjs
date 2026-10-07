import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createTaskFailureChannel } from '../server/task-failure-channel.mjs';
import { reportTaskBlocked } from '../copilot/src/skills/report-task-blocked/scripts/run.mjs';

function send(directory, token, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: path.join(directory, 'request.sock'), path: '/report-task-blocked', method: 'POST',
            headers: { 'x-task-capability': token } }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject); req.end(body);
    });
}

test('failure script sends only a message through its execution capability and cleanup revokes it', async () => {
    const reports = [];
    const channel = await createTaskFailureChannel({ request: input => { reports.push(input); return {}; } });
    const other = await createTaskFailureChannel({ request: () => { throw new Error('Wrong execution'); } });
    try {
        const { token } = JSON.parse(await fs.readFile(path.join(channel.directory, 'context.json'), 'utf8'));
        assert.equal(await send(other.directory, token, JSON.stringify({ message: 'Cross-execution failure' })), 403);
        assert.equal(await send(channel.directory, 'wrong', '{}'), 403);
        for (const body of ['null', '{}', '{', '{"message":" "}']) assert.equal(await send(channel.directory, token, body), 400);
        await assert.rejects(reportTaskBlocked({ message: '' }, { directory: channel.directory }), /nonempty/);
        assert.deepEqual(reports, []);
        assert.equal((await reportTaskBlocked({ message: 'Stopped at validation: required tool unavailable.' }, { directory: channel.directory })).ok, true);
        assert.deepEqual(reports, [{ message: 'Stopped at validation: required tool unavailable.' }]);
    } finally { await channel.close(); await other.close(); }
    await assert.rejects(fs.stat(channel.directory), { code: 'ENOENT' });
    await assert.rejects(reportTaskBlocked({ message: 'Late callback' }, { directory: channel.directory }), /not available/);
});
