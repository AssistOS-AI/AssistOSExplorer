import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTROL_STREAM_LIMIT_DEFAULTS, resolveControlStreamLimits } from '../../server/execution/executionLimits.mjs';
import { ByteRing, createControlStreamReader } from '../../server/execution/controlStreamReader.mjs';
import { descriptorCount, waitFor } from './helpers/duplexPair.mjs';
import { findPython, removeDirectory, shortTempDirectory } from './helpers/topology.mjs';

const fakeChild = fileURLToPath(new URL('./fixtures/fakeControlChild.mjs', import.meta.url));
const scmChild = fileURLToPath(new URL('./fixtures/scmChild.py', import.meta.url));

// PROVISIONAL test values; they are not the G5 limits.
const limitsFor = (overrides = {}) => resolveControlStreamLimits({
    maxRecordBytes: 4096, maxBufferedBytes: 64 * 1024, maxRecordsPerWindow: 1_000_000, rateWindowMs: 100, stallDeadlineMs: 1500,
    stderrRingBytes: 4096, stdinStallDeadlineMs: 300, maxPendingStdinBytes: 256 * 1024, ...overrides
});

// Starts a fake domain whose three pipes are read by the real reader. The child is ended by its recorded PID only.
function rig(context, { mode, options = {}, limits = limitsFor(), validate, onRecord, command, args }) {
    const directory = shortTempDirectory('rw-ctl');
    const doneFile = path.join(directory, 'done');
    context.after(() => removeDirectory(directory));
    const child = command
        ? spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(process.execPath, [fakeChild, mode, JSON.stringify({ ...options, doneFile })], { stdio: ['pipe', 'pipe', 'pipe'] });
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const records = [];
    const ends = [];
    const reader = createControlStreamReader({
        stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, limits,
        validateRecord: validate || ((record) => (typeof record.type === 'string' ? null : 'type')),
        onRecord: onRecord || ((record) => { records.push(record); }),
        onEnd: (reason, detail) => ends.push([reason, detail])
    });
    return { child, reader, records, ends, doneFile, done: () => fs.existsSync(doneFile) && fs.readFileSync(doneFile, 'utf8') };
}

test('valid records are parsed in order, each within the record limit, and the stream ends cleanly', async (context) => {
    const run = rig(context, { mode: 'records', options: { count: 50, size: 300 } });
    assert.equal(await waitFor(() => run.ends.length === 1), true);
    assert.deepEqual(run.ends, [['stdout_ended', 'clean']]);
    assert.deepEqual(run.records.map((record) => record.n), [...Array(50).keys()]);
});

test('a record of exactly the maximum size is accepted, and one byte more without a newline ends the execution', async (context) => {
    const limit = limitsFor().maxRecordBytes;
    const exact = Buffer.from(`${JSON.stringify({ type: 'event', pad: 'x'.repeat(limit - JSON.stringify({ type: 'event', pad: '' }).length) })}\n`);
    assert.equal(exact.length - 1, limit);
    const accepted = rig(context, { mode: 'raw', options: { base64: exact.toString('base64') } });
    assert.equal(await waitFor(() => accepted.records.length === 1), true);
    assert.deepEqual(accepted.ends, []);

    const over = Buffer.from(exact.subarray(0, limit)); // exactly `limit` bytes, no newline yet
    const tooLong = rig(context, { mode: 'raw', options: { base64: Buffer.concat([over, Buffer.from('x')]).toString('base64') } });
    assert.equal(await waitFor(() => tooLong.ends.length === 1), true);
    assert.deepEqual(tooLong.ends, [['control_stream_violation', 'record_too_large']]);
    assert.ok(tooLong.reader.stats().peakRetained <= limit, 'never more than the limit was retained');
});

test('an unterminated line far above the limit ends the execution having retained no more than the limit', async (context) => {
    const before = descriptorCount();
    const run = rig(context, { mode: 'unterminated', options: { total: 256 * 1024 * 1024, chunk: 65536 } });
    assert.equal(await waitFor(() => run.ends.length === 1), true);
    assert.deepEqual(run.ends, [['control_stream_violation', 'record_too_large']]);
    const stats = run.reader.stats();
    assert.ok(stats.peakRetained <= limitsFor().maxRecordBytes);
    assert.equal(stats.queuedChunks, 0);
    // The reader destroyed all three pipes; the supervisor's descriptor count is back to what it was.
    assert.equal(await waitFor(() => descriptorCount() <= before), true);
    // The child is blocked or dead, not producing 256 MiB into the supervisor.
    const sent = Number(run.done() || 0);
    assert.ok(sent < 256 * 1024 * 1024, `the child wrote ${sent} bytes before it was cut off`);
});

test('malformed JSON, a non-object record and a schema failure each end the execution with a violation', async (context) => {
    const cases = [
        ['not json', '{broken\n', 'malformed_record'],
        ['an array', '[1,2,3]\n', 'malformed_record'],
        ['a string', '"text"\n', 'malformed_record'],
        ['an empty record', '\n', 'malformed_record'],
        ['a schema failure', '{"type":42}\n', 'invalid_record'],
        ['a missing type', '{"n":1}\n', 'invalid_record']
    ];
    for (const [name, text, code] of cases) {
        const run = rig(context, { mode: 'raw', options: { base64: Buffer.from(text).toString('base64') } });
        assert.equal(await waitFor(() => run.ends.length === 1), true, name);
        assert.deepEqual(run.ends, [['control_stream_violation', code]], name);
        assert.equal(run.records.length, 0, name);
    }
    // A valid record before the bad one is still delivered: the violation ends the stream, it does not erase history.
    const mixed = rig(context, { mode: 'raw', options: { base64: Buffer.from('{"type":"ok"}\n{broken\n').toString('base64') } });
    assert.equal(await waitFor(() => mixed.ends.length === 1), true);
    assert.equal(mixed.records.length, 1);
});

test('the buffering budget pauses the stream while records are unpersisted, the writer blocks, and releasing resumes it', async (context) => {
    const held = [];
    const run = rig(context, {
        mode: 'records', options: { count: 400, size: 4000 }, limits: limitsFor({ stallDeadlineMs: 20_000 }),
        onRecord: () => new Promise((resolve) => held.push(resolve))
    });
    assert.equal(await waitFor(() => run.reader.stats().paused.includes('buffer')), true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const stats = run.reader.stats();
    const { maxBufferedBytes, maxRecordBytes } = limitsFor();
    assert.ok(stats.pendingBytes >= maxBufferedBytes, 'paused at the budget');
    assert.ok(stats.pendingBytes < maxBufferedBytes + maxRecordBytes, `pending ${stats.pendingBytes} stayed within one record of the budget`);
    assert.equal(run.done(), false, 'the writer is blocked on a full pipe, not finished');
    assert.equal(run.reader.stats().ended, false);
    // Persisting the records releases the budget; every record then arrives.
    for (let delivered = 0; delivered < 400;) {
        while (held.length) { held.shift()(); delivered += 1; }
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (run.done() === 'records' && held.length === 0) break;
    }
    assert.equal(await waitFor(() => run.done() === 'records', 5000), true);
    assert.equal(await waitFor(() => run.ends.length === 1, 5000), true);
    assert.deepEqual(run.ends, [['stdout_ended', 'clean']]);
});

test('a pause that outlasts the stall deadline ends only that execution', async (context) => {
    const run = rig(context, {
        mode: 'records', options: { count: 400, size: 4000 }, limits: limitsFor({ stallDeadlineMs: 250 }),
        onRecord: () => new Promise(() => {})
    });
    assert.equal(await waitFor(() => run.ends.length === 1, 3000), true);
    assert.deepEqual(run.ends, [['control_stall', 'buffer']]);
});

test('the record-rate bound pauses the stream, spreads the records over time and loses none', async (context) => {
    const started = Date.now();
    const run = rig(context, {
        mode: 'records', options: { count: 150, size: 0 }, limits: limitsFor({ maxRecordsPerWindow: 30, rateWindowMs: 100 })
    });
    assert.equal(await waitFor(() => run.ends.length === 1, 5000), true);
    assert.equal(run.records.length, 150);
    assert.ok(Date.now() - started >= 300, `150 records at 30 per 100 ms take at least 300 ms, took ${Date.now() - started}`);
    assert.ok(run.reader.stats().pauseCount >= 3, 'the stream was paused for the rate bound');
});

test('stderr is drained without parsing into a ring of the most recent bytes, and never pauses the stream', async (context) => {
    const total = 6 * 1024 * 1024;
    const limits = limitsFor({ stderrRingBytes: 4096 });
    const run = rig(context, { mode: 'stderr', options: { total }, limits });
    assert.equal(await waitFor(() => run.done() === 'stderr', 15_000), true);
    assert.equal(await waitFor(() => run.records.length === 1), true);
    const expected = Buffer.alloc(limits.stderrRingBytes);
    for (let index = 0; index < expected.length; index += 1) expected[index] = (((total - expected.length + index) * 7 + 3) & 0xff);
    assert.deepEqual(run.reader.stderrTail(), expected);
    assert.deepEqual(run.reader.stats().paused, []);
    assert.equal(run.reader.stats().pauseCount, 0);
    assert.deepEqual(run.ends, []);
});

// The plan row says stderr is "drained without parsing": a flood neither ends nor stalls the execution, so the bound
// that matters is memory. The supervisor's resident memory is sampled throughout a 384 MiB flood.
test('a stderr flood neither ends nor stalls the execution and the supervisor RSS stays within a provisional bound', async (context) => {
    const TOTAL = 384 * 1024 * 1024;
    const RSS_GROWTH_BOUND = 160 * 1024 * 1024; // PROVISIONAL test bound (well under the flood size), not a recorded G5 value
    const limits = limitsFor({ stderrRingBytes: 4096 });
    globalThis.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    context.after(() => clearInterval(sampler));
    const run = rig(context, { mode: 'stderr-flood', options: { total: TOTAL }, limits });
    assert.equal(await waitFor(() => run.done() === 'stderr-flood', 60_000), true, 'the whole flood was drained');
    assert.equal(await waitFor(() => run.reader.stats().stderrBytes === TOTAL, 60_000), true, 'every byte of the flood was drained');
    assert.equal(await waitFor(() => run.records.length === 1), true, 'a stdout record after the flood still arrives');
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    assert.ok(peak - baseline < RSS_GROWTH_BOUND, `RSS grew by ${((peak - baseline) / 1048576).toFixed(1)} MiB during a ${TOTAL / 1048576} MiB flood`);
    const block = Buffer.alloc(65536);
    for (let index = 0; index < block.length; index += 1) block[index] = (index * 7 + 3) & 0xff;
    assert.deepEqual(run.reader.stderrTail(), block.subarray(block.length - 4096));
    assert.deepEqual(run.reader.stats().paused, []);
    assert.deepEqual(run.ends, [], 'the flood neither ended nor stalled the execution');
    context.diagnostic(`stderr flood of ${TOTAL / 1048576} MiB: peak RSS growth ${((peak - baseline) / 1048576).toFixed(1)} MiB`);
});

test('the stderr ring keeps the last bytes across wrap-around and short writes', () => {
    const ring = new ByteRing(8);
    ring.write(Buffer.from('abc'));
    assert.equal(ring.contents().toString(), 'abc');
    ring.write(Buffer.from('defgh'));
    ring.write(Buffer.from('ij'));
    assert.equal(ring.contents().toString(), 'cdefghij');
    ring.write(Buffer.from('0123456789abcdef'));
    assert.equal(ring.contents().toString(), '89abcdef');
    assert.equal(ring.length, 8);
});

test('stdin writes respect backpressure: a child that never reads ends only its execution, by stall or by queue bound', async (context) => {
    const stalled = rig(context, { mode: 'hold', limits: limitsFor({ stdinStallDeadlineMs: 250, maxPendingStdinBytes: 64 * 1024 * 1024 }) });
    const record = { type: 'control', pad: 'z'.repeat(3000) };
    for (let index = 0; index < 400 && stalled.ends.length === 0; index += 1) void stalled.reader.writeControl(record);
    assert.equal(await waitFor(() => stalled.ends.length === 1, 3000), true);
    assert.deepEqual(stalled.ends, [['stdin_stall', undefined]]);

    const overflow = rig(context, { mode: 'hold', limits: limitsFor({ stdinStallDeadlineMs: 20_000, maxPendingStdinBytes: 40 * 1024 }) });
    for (let index = 0; index < 400 && overflow.ends.length === 0; index += 1) void overflow.reader.writeControl(record);
    assert.equal(await waitFor(() => overflow.ends.length === 1, 3000), true);
    assert.deepEqual(overflow.ends, [['stdin_overflow', undefined]]);
});

test('stdin writes to a child that does read are delivered and resolve', async (context) => {
    const run = rig(context, { mode: 'echo' });
    for (let index = 0; index < 20; index += 1) assert.equal(await run.reader.writeControl({ type: 'control', index }), true);
    assert.equal(await waitFor(() => run.records.length === 20), true);
    assert.deepEqual(run.records.map((record) => record.line.index), [...Array(20).keys()]);
    await assert.rejects(run.reader.writeControl({ type: 'control', pad: 'x'.repeat(limitsFor().maxRecordBytes + 1) }), RangeError);
    assert.deepEqual(run.ends, []);
});

test('the control-stream limits are explicit named positive integers', () => {
    assert.throws(() => resolveControlStreamLimits({ maxRecordBytes: 0 }), TypeError);
    assert.throws(() => resolveControlStreamLimits({ maxRecordBytes: 1.5 }), TypeError);
    assert.throws(() => resolveControlStreamLimits({ unknownLimit: 1 }), TypeError);
    assert.equal(CONTROL_STREAM_LIMIT_DEFAULTS.maxRecordBytes, 256 * 1024);
    assert.equal(CONTROL_STREAM_LIMIT_DEFAULTS.maxBufferedBytes, 4 * 1024 * 1024);
    assert.equal(CONTROL_STREAM_LIMIT_DEFAULTS.stderrRingBytes, 64 * 1024);
});

const kernelProbe = fileURLToPath(new URL('./fixtures/scmKernelProbe.py', import.meta.url));

// R3-7 asks that descriptors a domain attaches to its writes are never read and are discarded. Whether that holds is a
// property of the kernel's read() on a Unix socket, not of this reader: the probe measures it first. Where the kernel
// discards (Linux), the reader must leave the supervisor's descriptor table unchanged. Where it installs them (this
// Darwin host), the test records that the property does NOT hold, so that the divergence is a failing-to-qualify fact
// in the evidence and not a silent pass.
test('R3-7 descriptor discard on the control stream: holds only where the kernel discards; FALSIFIED on this Darwin host (descriptors are installed and leaked)', async (context) => {
    const probe = JSON.parse(await new Promise((resolve, reject) => {
        const child = spawn(findPython(), ['-I', kernelProbe], { stdio: ['ignore', 'pipe', 'inherit'] });
        let text = '';
        child.stdout.on('data', (chunk) => { text += chunk; });
        child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`probe exited ${code}`))));
    }));
    const limits = limitsFor();
    // The baseline precedes rig(), so it excludes the child's three stdio sockets and the check below proves they are
    // counted while the child runs. A net 0 at the end shows that no descriptor outlives the run; it does not show that
    // the reader alone closed those sockets (Node also closes them when the child exits).
    const baseline = descriptorCount();
    const run = rig(context, { command: findPython(), args: ['-I', scmChild, '20', '3'], limits });
    const grewAfterSpawn = descriptorCount() - baseline;
    assert.ok(grewAfterSpawn >= 3, `the three stdio sockets are held while the child runs (grew by ${grewAfterSpawn})`);
    assert.equal(await waitFor(() => run.ends.length === 1, 10_000), true);
    // The child reported that its standard descriptors are Unix sockets, so SCM_RIGHTS was really possible.
    const report = run.records.find((record) => record.type === 'report');
    assert.deepEqual(report.sockets, [true, true, true]);
    assert.equal(report.sent, 20 * 3 * 3, 'descriptors were really attached on all three streams');
    assert.deepEqual(run.records.filter((record) => record.type === 'event').map((record) => record.n), [0, 1, 2]);
    assert.deepEqual(run.ends, [['stdout_ended', 'clean']]);
    const delta = descriptorCount() - baseline;
    if (probe.behavior === 'discards') {
        context.diagnostic(`probe.behavior = ${probe.behavior}; growth after spawn = ${grewAfterSpawn}; final delta = ${delta}`);
        assert.equal(delta, 0, 'the kernel discards ancillary descriptors, and the supervisor holds none');
    } else {
        // FINDING (non-qualifying here): this kernel installs the descriptors of a plain read() into the reader.
        assert.equal(probe.behavior, 'installs');
        // The baseline excludes the three stdio sockets, which are released by the end, so a bare leak of a few
        // descriptors must not confirm "installs": more than 3 are required.
        assert.ok(delta > 3, `the probe says the kernel installs descriptors, and the table grew by ${delta}`);
        context.diagnostic(`kernel installs SCM_RIGHTS descriptors on read(): supervisor table grew by ${delta} (R3-7 not satisfied on this host)`);
    }
});
