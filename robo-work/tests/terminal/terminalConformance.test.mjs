import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { count, storeFile } from '../helpers/synthetic.mjs';
import { CLIENT_LIMITS, launchEvidence, ploinkyClient, terminalRig, until } from './helpers/terminalRig.mjs';

// M-8 conformance: Ploinky's REAL ProviderTerminalClient (5918f322, read from the sibling checkout) against the worker's terminal server,
// real Router-service tokens (Ploinky's minter and verifier), the real launch-evidence verifier, store and terminal execution path. Only
// the sandbox and the PTY are fakes (the fake PTY echoes input as output and counts spawns).

const lease = { synthetic: true };
const fieldsFor = (robotId, extra = {}) => ({ operationId: crypto.randomUUID(), targetId: robotId, project: null, cols: 80, rows: 24, ...extra });

test('hello, launch, attach, input with ack and echo, resize, heartbeat renewal, user close -> ended{shutdown}; no terminal byte in logs or the store', async (t) => {
    const rig = await terminalRig(t);
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    const outputs = [];
    const ended = [];
    client.on('output', (frame) => outputs.push(frame));
    client.on('ended', (frame) => ended.push(frame));
    await client.connect({ lease });
    const pty = await client.launch(fieldsFor(rig.robotId), { lease });
    assert.match(pty, /^[0-9a-f-]{36}$/u);
    assert.equal(rig.factory.spawns, 1);
    assert.equal(rig.ptyHost.opened[0].slaveDestroyed, true, 'the worker closed its slave copy before launched');
    await client.attach(pty, { lease, afterOutputSequence: 0n });
    const marker = `marker-${crypto.randomBytes(8).toString('hex')}`;
    assert.equal(await client.input(pty, Buffer.from(marker), { lease }), 1n);
    await until(() => outputs.length >= 1);
    assert.equal(outputs[0].payload.toString(), marker);
    assert.equal(outputs[0].sequence, 1n);
    await client.resize(pty, 100, 40, { lease });
    await until(() => rig.ptyHost.opened[0].sizes.length === 2);
    assert.deepEqual(rig.ptyHost.opened[0].sizes.at(-1), [100, 40]);
    // Heartbeats (every 300 ms here) renew the lease; the channel stays up across several.
    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(await client.input(pty, Buffer.from('x'), { lease }), 2n);
    await client.close(pty, { lease });
    await until(() => ended.length === 1);
    assert.deepEqual({ ptySessionId: ended[0].ptySessionId, cause: ended[0].cause }, { ptySessionId: pty, cause: 'shutdown' });
    assert.equal(rig.factory.ends[0].outcome.classification, 'cancelled');
    assert.deepEqual(rig.factory.ends[0].outcome.data, { cause: 'shutdown' });
    assert.equal(rig.ptyHost.opened[0].closed, true, 'the master is closed first');
    // M-51 add. 1: sizes and counts only. The marker went in as input and came back as output.
    assert.equal(rig.logs.some((line) => line.includes(marker)), false);
    for (const file of [storeFile(rig.dir), `${storeFile(rig.dir)}-wal`]) {
        if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from(marker)), false, file);
    }
    assert.ok(rig.logs.some((line) => line.includes('"terminal_ended"') && line.includes('"inputBytes"')));
});

test('shell exit -> ended{exit, exitCode}; a signal death omits exitCode; the admission ends completed and settled', async (t) => {
    const rig = await terminalRig(t);
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    const ended = [];
    client.on('ended', (frame) => ended.push(frame));
    await client.connect({ lease });
    const first = await client.launch(fieldsFor(rig.robotId), { lease });
    await client.attach(first, { lease, afterOutputSequence: 0n });
    rig.factory.opened[0].exit(3);
    await until(() => ended.length === 1);
    assert.deepEqual({ cause: ended[0].cause, exitCode: ended[0].exitCode }, { cause: 'exit', exitCode: 3 });
    const second = await client.launch(fieldsFor(rig.robotId), { lease });
    await client.attach(second, { lease, afterOutputSequence: 0n });
    rig.factory.opened[1].exit(null, 'SIGKILL');
    await until(() => ended.length === 2);
    assert.equal(Object.hasOwn(ended[1], 'exitCode'), false);
    assert.equal(rig.store.countOpenTerminals(), 0);
});

test('rotate (reattach with the possession proof) keeps the PTY and its input sequence; output produced while detached is replayed', async (t) => {
    const rig = await terminalRig(t);
    const opened = [];
    const client = await ploinkyClient(rig, { opened });
    t.after(() => client.shutdown());
    const outputs = [];
    client.on('output', (frame) => outputs.push(frame));
    await client.connect({ lease });
    const pty = await client.launch(fieldsFor(rig.robotId), { lease });
    await client.attach(pty, { lease, afterOutputSequence: 0n });
    await client.input(pty, Buffer.from('a'), { lease });
    await until(() => outputs.length === 1);
    await client.rotate({ lease });
    assert.equal(opened.length, 2);
    await until(() => opened[0].ws.readyState === 3, 3000);
    // Output while no connection is attached is kept for replay.
    rig.ptyHost.opened[0].emit(Buffer.from('while-detached'));
    await client.attach(pty, { lease, afterOutputSequence: 1n });
    await until(() => outputs.length === 2);
    assert.equal(outputs[1].payload.toString(), 'while-detached');
    assert.equal(outputs[1].sequence, 2n);
    assert.equal(await client.input(pty, Buffer.from('b'), { lease }), 2n);
    assert.equal(rig.factory.spawns, 1);
});

test('a second hello (another Router incarnation) supersedes the session: the old PTY ends with cause supersession', async (t) => {
    const rig = await terminalRig(t);
    const first = await ploinkyClient(rig);
    await first.connect({ lease });
    const pty = await first.launch(fieldsFor(rig.robotId), { lease });
    await first.attach(pty, { lease, afterOutputSequence: 0n });
    const second = await ploinkyClient(rig);
    t.after(async () => { await first.shutdown(); await second.shutdown(); });
    await second.connect({ lease });
    await until(() => rig.factory.ends.length === 1);
    assert.deepEqual(rig.factory.ends[0].outcome.data, { cause: 'supersession' });
    assert.equal(rig.factory.ends[0].outcome.classification, 'interrupted');
    // The new session launches normally.
    await second.launch(fieldsFor(rig.robotId), { lease });
    assert.equal(rig.factory.spawns, 2);
});

test('forged, agent, guest, non-admin, delegated, wrong-hash and replayed launch evidence: launch fails, zero spawns, zero admissions', async (t) => {
    const rig = await terminalRig(t);
    const forged = crypto.randomBytes(32);
    let replay = null;
    const variants = [
        (launch) => launchEvidence(forged, launch),
        (launch) => launchEvidence(rig.secret, launch, { actor: { kind: 'agent', id: 'agent:AchillesIDE/roboTeamAgent' }, sub: 'agent:AchillesIDE/roboTeamAgent' }),
        (launch) => launchEvidence(rig.secret, launch, { actor: { kind: 'user', id: 'user:guest:x', roles: ['admin'] }, sub: 'user:guest:x' }),
        (launch) => launchEvidence(rig.secret, launch, { actor: { kind: 'user', id: 'user:bob', roles: ['user'] }, sub: 'user:bob' }),
        (launch) => launchEvidence(rig.secret, launch, { usr: { id: 'root', roles: ['admin'] }, delegation: { scope: ['execution:owner'] } }),
        (launch) => launchEvidence(rig.secret, { ...launch, cols: launch.cols + 1 }),
        (launch) => launchEvidence(rig.secret, launch, { tool: '__provider_terminal_targets__' }),
        (launch) => launchEvidence(rig.secret, launch, { path: '/v1/other' }),
        (launch) => { replay ??= launchEvidence(rig.secret, launch); return replay; }
    ];
    for (const [index, evidence] of variants.entries()) {
        const client = await ploinkyClient(rig, { evidence });
        await client.connect({ lease });
        const fields = fieldsFor(rig.robotId);
        if (index === variants.length - 1) {
            // The first use of the replayed evidence launches; the second (another operation, same jti) is refused.
            const ok = await client.launch(fields, { lease });
            assert.ok(ok);
            replay = launchEvidence(rig.secret, fieldsFor(rig.robotId));
            const replayed = fieldsFor(rig.robotId);
            const reuse = launchEvidence(rig.secret, replayed);
            const again = await ploinkyClient(rig, { evidence: () => reuse });
            await again.connect({ lease });
            await again.launch(replayed, { lease });
            const third = await ploinkyClient(rig, { evidence: () => reuse });
            await third.connect({ lease });
            await assert.rejects(third.launch(replayed, { lease }));
            await again.shutdown();
            await third.shutdown();
        } else {
            await assert.rejects(client.launch(fields, { lease }), `variant ${index}`);
            assert.equal(rig.factory.spawns, 0, `variant ${index}: zero spawns`);
            assert.equal(count(rig.dir, 'admission'), 0, `variant ${index}: zero admissions`);
        }
        await client.shutdown();
    }
    assert.equal(rig.logs.filter((line) => line.includes('"stage":"evidence"')).length >= 8, true);
});

test('caps: a fifth terminal on one robot is terminal_limit with no spawn; two parallel launches for the last slot give exactly one PTY', async (t) => {
    const rig = await terminalRig(t, { executionLimits: { maxPerRobot: 2, maxTotal: 16 } });
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    await client.connect({ lease });
    await client.launch(fieldsFor(rig.robotId), { lease });
    const results = await Promise.allSettled([client.launch(fieldsFor(rig.robotId), { lease }), client.launch(fieldsFor(rig.robotId), { lease })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(rig.factory.spawns, 2);
    assert.ok(rig.logs.some((line) => line.includes('"code":"terminal_limit"')));
});

test('unknown target not_found and a non-empty relativePath grant_refused, with zero spawns; an unattached PTY ends unclaimed', async (t) => {
    const rig = await terminalRig(t, { serverLimits: { unclaimedMs: 300 } });
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    await client.connect({ lease });
    await assert.rejects(client.launch(fieldsFor('AAAAAAAAAAAAAAAAAAAAAA'), { lease }));
    await assert.rejects(client.launch(fieldsFor(rig.robotId, { project: { selection: 'proj', relativePath: 'sub' } }), { lease }));
    assert.equal(rig.factory.spawns, 0);
    assert.ok(rig.logs.some((line) => line.includes('"code":"not_found"')));
    assert.ok(rig.logs.some((line) => line.includes('"stage":"project"')));
    await client.launch(fieldsFor(rig.robotId), { lease });
    await until(() => rig.factory.ends.length === 1, 3000);
    assert.deepEqual(rig.factory.ends[0].outcome.data, { cause: 'unclaimed' });
});

test('termination that cannot be verified sends no ended; worker shutdown ends terminals with generation-end', async (t) => {
    const rig = await terminalRig(t, { factoryOptions: { quarantine: true } });
    const client = await ploinkyClient(rig);
    const ended = [];
    client.on('ended', (frame) => ended.push(frame));
    await client.connect({ lease });
    const pty = await client.launch(fieldsFor(rig.robotId), { lease });
    await client.attach(pty, { lease, afterOutputSequence: 0n });
    await client.close(pty, { lease });
    await until(() => rig.factory.ends.length === 1);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(ended.length, 0, 'no ended without verified termination');
    assert.ok(rig.logs.some((line) => line.includes('terminal_termination_unverified')));
    const other = await client.launch(fieldsFor(rig.robotId), { lease });
    void other;
    await rig.server.close();
    assert.deepEqual(rig.factory.ends.at(-1).outcome.data, { cause: 'generation-end' });
    await client.shutdown();
});

test('Close terminals (closeRobot) ends every terminal of the robot through the normal end path with cause shutdown', async (t) => {
    const rig = await terminalRig(t);
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    const ended = [];
    client.on('ended', (frame) => ended.push(frame));
    await client.connect({ lease });
    for (const _ of [1, 2]) {
        const pty = await client.launch(fieldsFor(rig.robotId), { lease });
        await client.attach(pty, { lease, afterOutputSequence: 0n });
    }
    assert.deepEqual(await rig.server.closeRobot(rig.robotId), { closed: 2, unverified: 0 });
    await until(() => ended.length === 2);
    assert.deepEqual(ended.map((frame) => frame.cause), ['shutdown', 'shutdown']);
    assert.equal(rig.store.countOpenTerminals({ robotId: rig.robotId }), 0);
});

test('channel limits the worker expects of the Router are consistent with the client contract', () => {
    assert.ok(CLIENT_LIMITS.heartbeatMs < CLIENT_LIMITS.leaseMs);
});

test('review #1: operations are forgotten once their PTY ends or their refusal is sent, so maxOperations bounds open work only', async (t) => {
    const rig = await terminalRig(t, { serverLimits: { maxOperations: 2 } });
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    const ended = [];
    client.on('ended', (frame) => ended.push(frame));
    await client.connect({ lease });
    for (let index = 0; index < 3; index += 1) {
        const pty = await client.launch(fieldsFor(rig.robotId), { lease });
        await client.attach(pty, { lease, afterOutputSequence: 0n });
        await client.close(pty, { lease });
        await until(() => ended.length === index + 1);
    }
    // Refusals are forgotten too: three refused launches (unknown robot) leave room for a fourth successful one.
    for (let index = 0; index < 3; index += 1) await assert.rejects(client.launch(fieldsFor('AAAAAAAAAAAAAAAAAAAAAA'), { lease }));
    assert.ok(await client.launch(fieldsFor(rig.robotId), { lease }));
    assert.equal(rig.factory.spawns, 4);
    assert.equal(rig.logs.some((line) => line.includes('terminal_limit')), false);
});

test('review #4: output the shell writes before the server subscribes (its first prompt) reaches the client', async (t) => {
    const rig = await terminalRig(t);
    const realOpen = rig.ptyHost.open;
    rig.ptyHost.open = (size) => {
        const pty = realOpen(size);
        const listeners = [];
        const held = [];
        pty.onData = (fn) => { listeners.push(fn); for (const chunk of held.splice(0)) fn(chunk); };
        pty.emit = (buffer) => { if (listeners.length === 0) held.push(buffer); else for (const fn of listeners) fn(buffer); };
        pty.emit(Buffer.from('prompt$ '));
        return pty;
    };
    const client = await ploinkyClient(rig);
    t.after(() => client.shutdown());
    const outputs = [];
    client.on('output', (frame) => outputs.push(frame.payload.toString()));
    await client.connect({ lease });
    const pty = await client.launch(fieldsFor(rig.robotId), { lease });
    await client.attach(pty, { lease, afterOutputSequence: 0n });
    await until(() => outputs.length === 1);
    assert.equal(outputs[0], 'prompt$ ');
});
