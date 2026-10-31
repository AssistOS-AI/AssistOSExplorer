import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import test from 'node:test';

import { createFrameReader, encodeFrame } from '../../server/terminal/wsCodec.mjs';
import { encodeWorkerData, possessionProof } from '../../server/terminal/terminalProtocol.mjs';
import { count } from '../helpers/synthetic.mjs';
import { AUDIENCE, PATH, launchEvidence, ploinky, terminalRig, until } from './helpers/terminalRig.mjs';

// M-8 wire-level probes (plan-review F-6 codec refusals; SPEC adversarial probes): a raw client speaks the frames by hand.

function masked(opcode, payload, { fin = true, rsv = 0, mask = true, length } = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const len = length ?? body.length;
    let head;
    if (len < 126) head = Buffer.from([(fin ? 0x80 : 0) | rsv | opcode, (mask ? 0x80 : 0) | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = (fin ? 0x80 : 0) | rsv | opcode; head[1] = (mask ? 0x80 : 0) | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = (fin ? 0x80 : 0) | rsv | opcode; head[1] = (mask ? 0x80 : 0) | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
    if (!mask) return Buffer.concat([head, body]);
    const key = crypto.randomBytes(4);
    const out = Buffer.from(body);
    for (let i = 0; i < out.length; i += 1) out[i] ^= key[i & 3];
    return Buffer.concat([head, key, out]);
}

test('codec: unmasked, fragmented, continuation, RSV, unknown opcode, oversize control and oversize data are refused; oversize before any payload byte', () => {
    const cases = [
        ['unmasked', masked(1, '{}', { mask: false }), 'protocol'],
        ['fragmented', masked(1, '{}', { fin: false }), 'protocol'],
        ['continuation', masked(0, '{}'), 'protocol'],
        ['rsv', masked(1, '{}', { rsv: 0x40 }), 'protocol'],
        ['opcode', masked(3, '{}'), 'protocol'],
        ['control', masked(9, Buffer.alloc(126)), 'protocol']
    ];
    for (const [name, bytes, code] of cases) {
        const errors = [];
        const frames = [];
        createFrameReader({ maxPayload: 1000, onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error.code) }).push(bytes);
        assert.deepEqual({ errors, frames: frames.length }, { errors: [code], frames: 0 }, name);
    }
    // A declared length above the bound is refused from the header alone (only 14 bytes arrive).
    const errors = [];
    createFrameReader({ maxPayload: 1000, onFrame: () => assert.fail('no frame'), onError: (error) => errors.push(error.code) })
        .push(masked(2, Buffer.alloc(0), { length: 70000 }).subarray(0, 14));
    assert.deepEqual(errors, ['too_large']);
    // A valid frame split across chunks is reassembled.
    const frames = [];
    const reader = createFrameReader({ maxPayload: 1000, onFrame: (frame) => frames.push(frame), onError: () => assert.fail('no error') });
    const whole = masked(2, Buffer.from('abcdef'));
    reader.push(whole.subarray(0, 3));
    reader.push(whole.subarray(3));
    assert.equal(frames[0].payload.toString(), 'abcdef');
    assert.equal(encodeFrame(1, 'x')[0], 0x81);
});

// The client side of the codec (server frames are unmasked): a minimal parser for the test only.
function serverFrames(onFrame) {
    let buffered = Buffer.alloc(0);
    return {
        push(chunk) {
            buffered = Buffer.concat([buffered, chunk]);
            for (;;) {
                if (buffered.length < 2) return;
                let length = buffered[1] & 0x7f;
                let offset = 2;
                if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
                else if (length === 127) { if (buffered.length < 10) return; length = buffered.readUInt32BE(6); offset = 10; }
                if (buffered.length < offset + length) return;
                onFrame({ opcode: buffered[0] & 0x0f, payload: buffered.subarray(offset, offset + length) });
                buffered = buffered.subarray(offset + length);
            }
        }
    };
}

// A raw connection: upgrade with the given auth header, then text/binary frames by hand.
function rawConnect(port, authInfo) {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        const key = crypto.randomBytes(16).toString('base64');
        let buffer = Buffer.alloc(0);
        const state = { socket, status: null, frames: [], closed: false };
        let upgraded = false;
        const reader = serverFrames((frame) => state.frames.push(frame));
        socket.on('data', (chunk) => {
            if (upgraded) { reader.push(chunk); return; }
            buffer = Buffer.concat([buffer, chunk]);
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            state.status = Number(buffer.subarray(0, end).toString().split(' ')[1]);
            upgraded = state.status === 101;
            const rest = buffer.subarray(end + 4);
            if (upgraded && rest.length) reader.push(rest);
            resolve(state);
        });
        socket.on('close', () => { state.closed = true; resolve(state); });
        socket.on('error', () => {});
        socket.write([`GET ${PATH} HTTP/1.1`, 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`,
            ...(authInfo === null ? [] : [`x-ploinky-auth-info: ${authInfo}`]), '', ''].join('\r\n'));
    });
}

const json = (frame) => JSON.parse(frame.payload.toString());
const controls = (state) => state.frames.filter((frame) => frame.opcode === 1).map(json);
const sendJson = (state, value) => state.socket.write(masked(1, JSON.stringify(value)));

async function tokens(rig) {
    const { RouterServiceTokenService } = await ploinky('cli/server/security/tokens/RouterServiceTokenService.js');
    const minter = new RouterServiceTokenService({ resolveAgentSecret: () => rig.secret });
    return {
        upgrade: async () => JSON.stringify({ routerServiceToken: await minter.mint({ targetAgentId: AUDIENCE, path: PATH }) }),
        hello: (nonce) => minter.mint({ targetAgentId: AUDIENCE, path: PATH, purpose: 'execution-provider-terminal-hello', nonce })
    };
}

async function helloed(rig, mint) {
    const state = await rawConnect(rig.port, await mint.upgrade());
    await until(() => controls(state).length === 1);
    const { nonce } = controls(state)[0];
    sendJson(state, { v: 1, type: 'hello', helloToken: await mint.hello(nonce) });
    await until(() => controls(state).length === 2);
    return { state, nonce, ok: controls(state)[1] };
}

test('upgrade: no token, a Router Request token and a wrong-path token are refused before 101; a valid token gets a challenge', async (t) => {
    const rig = await terminalRig(t);
    const mint = await tokens(rig);
    assert.equal((await rawConnect(rig.port, null)).status, 401);
    const routerRequest = launchEvidence(rig.secret, { operationId: crypto.randomUUID(), targetId: rig.robotId, project: null, cols: 80, rows: 24 });
    assert.equal((await rawConnect(rig.port, JSON.stringify({ routerServiceToken: routerRequest }))).status, 401);
    assert.equal((await rawConnect(rig.port, JSON.stringify({ invocationToken: routerRequest }))).status, 401);
    const { RouterServiceTokenService } = await ploinky('cli/server/security/tokens/RouterServiceTokenService.js');
    const other = await new RouterServiceTokenService({ resolveAgentSecret: () => rig.secret }).mint({ targetAgentId: AUDIENCE, path: '/v1/other' });
    assert.equal((await rawConnect(rig.port, JSON.stringify({ routerServiceToken: other }))).status, 401);
    const state = await rawConnect(rig.port, await mint.upgrade());
    assert.equal(state.status, 101);
    await until(() => controls(state).length === 1);
    assert.equal(controls(state)[0].type, 'challenge');
    state.socket.destroy();
});

test('hello with a token for another nonce, and reattach with a bad proof, are refused and change nothing; a valid reattach supersedes the connection', async (t) => {
    const rig = await terminalRig(t);
    const mint = await tokens(rig);
    const { state: first, ok } = await helloed(rig, mint);
    assert.equal(ok.type, 'hello-ok');
    const secret = Buffer.from(ok.secret, 'base64url');
    // Wrong nonce: refused, the session stays (a valid reattach still works afterwards).
    const wrong = await rawConnect(rig.port, await mint.upgrade());
    await until(() => controls(wrong).length === 1);
    sendJson(wrong, { v: 1, type: 'hello', helloToken: await mint.hello(crypto.randomBytes(32).toString('base64url')) });
    await until(() => wrong.closed);
    // Bad proof: refused.
    const bad = await rawConnect(rig.port, await mint.upgrade());
    await until(() => controls(bad).length === 1);
    const badNonce = controls(bad)[0].nonce;
    sendJson(bad, { v: 1, type: 'reattach', ownershipSessionId: ok.ownershipSessionId, workerGeneration: ok.workerGeneration, proof: crypto.randomBytes(32).toString('base64url'), helloToken: await mint.hello(badNonce) });
    await until(() => bad.closed);
    assert.equal(rig.server.stats().session, true);
    // Valid proof over the new nonce: reattach-ok, and the first connection is told superseded-connection.
    const good = await rawConnect(rig.port, await mint.upgrade());
    await until(() => controls(good).length === 1);
    const nonce = controls(good)[0].nonce;
    const proof = possessionProof(secret, { nonce, ownershipSessionId: ok.ownershipSessionId, workerGeneration: ok.workerGeneration }).toString('base64url');
    sendJson(good, { v: 1, type: 'reattach', ownershipSessionId: ok.ownershipSessionId, workerGeneration: ok.workerGeneration, proof, helloToken: await mint.hello(nonce) });
    await until(() => controls(good).length === 2);
    assert.deepEqual(controls(good)[1].ptys, []);
    await until(() => controls(first).some((frame) => frame.type === 'superseded-connection'));
    good.socket.destroy();
});

test('launch idempotency (same operationId twice: one admission, one PTY), malformed frames close the connection with the PTY unchanged, input jumps close it', async (t) => {
    const rig = await terminalRig(t);
    const mint = await tokens(rig);
    const { state } = await helloed(rig, mint);
    const fields = { operationId: crypto.randomUUID(), targetId: rig.robotId, project: null, cols: 80, rows: 24 };
    sendJson(state, { v: 1, type: 'launch', ...fields, launchEvidence: launchEvidence(rig.secret, fields) });
    sendJson(state, { v: 1, type: 'launch', ...fields, launchEvidence: launchEvidence(rig.secret, fields) });
    await until(() => controls(state).filter((frame) => frame.type === 'launched').length === 2);
    const launched = controls(state).filter((frame) => frame.type === 'launched');
    assert.equal(launched[0].ptySessionId, launched[1].ptySessionId);
    assert.equal(count(rig.dir, 'admission'), 1);
    assert.equal(rig.factory.spawns, 1);
    // Another hash under the same operationId is refused.
    sendJson(state, { v: 1, type: 'launch', ...fields, cols: 81, launchEvidence: launchEvidence(rig.secret, { ...fields, cols: 81 }) });
    await until(() => controls(state).some((frame) => frame.type === 'launch-failed'));
    assert.equal(controls(state).find((frame) => frame.type === 'launch-failed').code, 'operation_conflict');
    const pty = launched[0].ptySessionId;
    sendJson(state, { v: 1, type: 'attach', ptySessionId: pty, afterOutputSequence: '0' });
    // Input sequence 2 before 1: a jump closes the connection; the PTY keeps running.
    const frame = Buffer.concat([Buffer.from([1, 1]), Buffer.from(pty.replaceAll('-', ''), 'hex'), Buffer.alloc(8), Buffer.from('x')]);
    frame.writeBigUInt64BE(2n, 18);
    state.socket.write(masked(2, frame));
    await until(() => state.closed);
    assert.equal(rig.factory.ends.length, 0);
    assert.equal(rig.server.stats().ptys, 1);
    // A malformed control frame (cols out of range) on a new connection: closed, PTY unchanged.
    const { state: second } = await (async () => {
        const raw = await rawConnect(rig.port, await mint.upgrade());
        await until(() => controls(raw).length === 1);
        return { state: raw };
    })();
    sendJson(second, { v: 1, type: 'launch', ...fields, cols: 1, launchEvidence: 'x' });
    await until(() => second.closed);
    assert.equal(rig.server.stats().ptys, 1);
    assert.equal(rig.factory.spawns, 1);
    void encodeWorkerData;
});
