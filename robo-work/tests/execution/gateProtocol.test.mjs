import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { COMMIT_BYTE, GATE_ABORT, GATE_COMMIT, awaitGate, createGate } from '../../server/execution/gateProtocol.mjs';
import { waitFor } from './helpers/duplexPair.mjs';
import { removeDirectory, shortTempDirectory } from './helpers/topology.mjs';

const helper = fileURLToPath(new URL('./fixtures/gateHelper.mjs', import.meta.url));
const supervisorFixture = fileURLToPath(new URL('./fixtures/gateSupervisor.mjs', import.meta.url));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

test('helper side: only the explicit commit byte commits; end-of-file, any other byte and any read error abort', () => {
    const reading = (outcome) => (_fd, buffer) => {
        if (outcome instanceof Error) throw outcome;
        if (outcome === null) return 0;
        buffer[0] = outcome;
        return 1;
    };
    assert.equal(awaitGate(3, { readSync: reading(COMMIT_BYTE) }), GATE_COMMIT);
    assert.equal(awaitGate(3, { readSync: reading(null) }), GATE_ABORT, 'end-of-file aborts');
    for (const other of [0x00, 0x01, 0x31, 0x63, 0xff]) assert.equal(awaitGate(3, { readSync: reading(other) }), GATE_ABORT, `byte ${other}`);
    assert.equal(awaitGate(3, { readSync: reading(Object.assign(new Error('x'), { code: 'EIO' })) }), GATE_ABORT);
    // A non-blocking descriptor that is not ready yet is retried, not treated as a decision.
    let calls = 0;
    const flaky = (_fd, buffer) => { calls += 1; if (calls < 3) throw Object.assign(new Error('again'), { code: 'EAGAIN' }); buffer[0] = COMMIT_BYTE; return 1; };
    assert.equal(awaitGate(3, { readSync: flaky }), GATE_COMMIT);
});

function startHelper(context) {
    const directory = shortTempDirectory('rw-gate');
    context.after(() => removeDirectory(directory));
    const result = path.join(directory, 'result');
    const marker = path.join(directory, 'exec');
    const child = spawn(process.execPath, [helper, '3', result, marker], { stdio: ['ignore', 'ignore', 'inherit', 'pipe'] });
    context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const gate = child.stdio[3];
    gate.on('error', () => {});
    return { child, gate, result, marker, read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null) };
}

test('the helper holds at the gate: before the decision it has neither decided nor reached the final exec', async (context) => {
    const run = startHelper(context);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(run.read(run.result), null);
    assert.equal(run.read(run.marker), null);
    assert.equal(run.child.exitCode, null);
    await createGate(run.gate).commit();
    const [code] = await once(run.child, 'exit');
    assert.equal(code, 0);
});

test('the commit byte releases the helper to the final exec', async (context) => {
    const run = startHelper(context);
    assert.equal(await createGate(run.gate).commit(), true);
    const [code] = await once(run.child, 'exit');
    assert.deepEqual([code, run.read(run.result), run.read(run.marker)], [0, GATE_COMMIT, 'final-exec']);
});

test('releasing the gate without a commit byte is end-of-file: the helper aborts and never reaches the final exec', async (context) => {
    const run = startHelper(context);
    await createGate(run.gate).abort();
    const [code] = await once(run.child, 'exit');
    assert.deepEqual([code, run.read(run.result), run.read(run.marker)], [99, GATE_ABORT, null]);
});

test('any input other than the commit byte aborts the helper', async (context) => {
    for (const byte of [0x00, 0x01, 0x42, 0x63]) {
        const run = startHelper(context);
        run.gate.write(Buffer.from([byte]));
        const [code] = await once(run.child, 'exit');
        assert.deepEqual([code, run.read(run.result), run.read(run.marker)], [99, GATE_ABORT, null], `byte ${byte}`);
    }
});

test('a gate cannot be decided twice', async (context) => {
    const run = startHelper(context);
    const gate = createGate(run.gate);
    assert.equal(await gate.commit(), true);
    assert.equal(await gate.commit(), false);
    assert.equal(await gate.abort(), false);
    await once(run.child, 'exit');
});

test('the death of the supervisor before commit (SIGKILL) closes the gate: the helper aborts and never executes', async (context) => {
    const directory = shortTempDirectory('rw-gate');
    context.after(() => removeDirectory(directory));
    const result = path.join(directory, 'result');
    const marker = path.join(directory, 'exec');
    const supervisor = spawn(process.execPath, [supervisorFixture, result, marker], { stdio: ['ignore', 'pipe', 'inherit'] });
    context.after(() => { if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL'); });
    let text = '';
    supervisor.stdout.on('data', (chunk) => { text += chunk; });
    assert.equal(await waitFor(() => /helper \d+/.test(text)), true);
    const helperPid = Number(/helper (\d+)/.exec(text)[1]);
    assert.equal(alive(helperPid), true, 'the helper is waiting at the gate');
    supervisor.kill('SIGKILL');
    await once(supervisor, 'exit');
    assert.equal(await waitFor(() => fs.existsSync(result)), true, 'the helper decided');
    assert.equal(fs.readFileSync(result, 'utf8').trim(), GATE_ABORT);
    assert.equal(fs.existsSync(marker), false, 'the final exec was never reached');
    assert.equal(await waitFor(() => !alive(helperPid)), true, 'the helper exited');
});
