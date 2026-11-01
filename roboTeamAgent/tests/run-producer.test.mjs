import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { captureRunProducer } from '../copilot/src/lib/execution/runProducer.mjs';

const stat = (pid = process.pid, start = '12345678901234567890', name = 'wrapper (task) name') =>
    `${pid} (${name}) ${['R', ...Array(18).fill('0'), start].join(' ')}\n`;

test('producer capture reads its own proc stat and preserves the exact decimal start stamp', async () => {
    const reads = [];
    const producer = await captureRunProducer({ readFile: async (...args) => { reads.push(args); return stat(); } });
    assert.deepEqual(reads, [['/proc/self/stat', 'utf8']]);
    assert.deepEqual(producer, { pid: process.pid, startStamp: '12345678901234567890' });
});

test('producer capture refuses another PID, malformed stat and unavailable identity without a fallback', async () => {
    for (const value of [stat(process.pid + 1), stat(process.pid, ''), stat(process.pid, '-1'), stat(process.pid, '12x'),
        'missing process fields', `${process.pid} (unterminated R 0 0`]) {
        await assert.rejects(captureRunProducer({ readFile: async () => value }), { code: 'PRODUCER_IDENTITY_UNAVAILABLE' });
    }
    await assert.rejects(captureRunProducer({ readFile: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } }),
        { code: 'PRODUCER_IDENTITY_UNAVAILABLE' });
});

test('the production reader captures live Linux self identity or fails closed where procfs is absent', async () => {
    if (process.platform !== 'linux') {
        await assert.rejects(captureRunProducer(), { code: 'PRODUCER_IDENTITY_UNAVAILABLE' });
        return;
    }
    const producer = await captureRunProducer();
    const own = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
    assert.deepEqual(producer, { pid: process.pid, startStamp: own.slice(own.lastIndexOf(') ') + 2).trim().split(/\s+/u)[19] });
});
