import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHumanInputChannel } from '../server/human-input-channel.mjs';
import { requireHumanInput } from '../copilot/src/skills/require-human-input/scripts/run.mjs';

const question = { question: 'Who is the target customer?', options: ['Retail', 'Business', 'Enterprise'] };

test('skill waits for persisted HTTP acknowledgement and runtime enforces termination', async () => {
    let saved = false;
    let stopped = false;
    const channel = await createHumanInputChannel({
        request: async input => { assert.deepEqual(input, question); saved = true; return { id: 'question-1' }; },
        stop: () => { stopped = true; }, graceMs: 15,
    });
    try {
        const result = await requireHumanInput(question, { directory: channel.directory });
        assert.equal(saved, true);
        assert.equal(result.ok, true);
        assert.equal(result.id, 'question-1');
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.equal(stopped, true);
    } finally { await channel.close(); }
    await assert.rejects(fs.stat(channel.directory), { code: 'ENOENT' });
});

test('failed callback does not stop the robot; channel rejects other paths and capabilities', async () => {
    let stopped = false;
    const channel = await createHumanInputChannel({ request: async () => { throw Object.assign(new Error('Not enabled'), { statusCode: 400 }); }, stop: () => { stopped = true; }, graceMs: 5 });
    try {
        await assert.rejects(requireHumanInput(question, { directory: channel.directory }), /Not enabled/);
        const status = await new Promise((resolve, reject) => {
            const req = http.request({ socketPath: path.join(channel.directory, 'request.sock'), path: '/require-human-input', method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject); req.end('{}');
        });
        assert.equal(status, 403);
        await new Promise(resolve => setTimeout(resolve, 15));
        assert.equal(stopped, false);
    } finally { await channel.close(); }
});

test('closing a finished execution cancels its forced stop', async () => {
    let stopped = false;
    const channel = await createHumanInputChannel({ request: async () => ({ id: 'q' }), stop: () => { stopped = true; }, graceMs: 50 });
    await requireHumanInput(question, { directory: channel.directory });
    await channel.close();
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(stopped, false);
});
