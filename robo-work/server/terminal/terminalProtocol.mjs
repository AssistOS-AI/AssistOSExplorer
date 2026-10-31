import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '../stateProtocol.mjs';

// The provider-terminal wire protocol, worker side (M-8 SPEC; plan section 10.1). It must match Ploinky's
// cli/server/webtty/providerTerminalProtocol.mjs (5918f322) byte for byte; that file is not mounted into agent containers, so the
// schema is copied here and the conformance test drives Ploinky's real ProviderTerminalClient against this worker.
//
//   control frames  WebSocket text, one JSON object `{v: 1, type, ...}` of at most 16 KiB, exact keys per type
//                   Router -> worker  hello{label?, helloToken} | reattach{ownershipSessionId, workerGeneration, proof, helloToken}
//                                     | heartbeat | launch{operationId, targetId, project, cols, rows, launchEvidence}
//                                     | attach{ptySessionId, afterOutputSequence} | resize{ptySessionId, cols, rows}
//                                     | close{ptySessionId, reason: user-close | router-shutdown}
//                   worker -> Router  challenge{nonce} | hello-ok{ownershipSessionId, workerGeneration, leaseExpiresAt, secret}
//                                     | reattach-ok{leaseExpiresAt, ptys[{ptySessionId, inputNext, outputLast}]} | heartbeat-ok{leaseExpiresAt}
//                                     | launched{operationId, ptySessionId} | launch-failed{operationId, code} | gap{ptySessionId, firstAvailable}
//                                     | ack{ptySessionId, sequence} | ended{ptySessionId, cause, exitCode?} | superseded-connection
//   data frames     WebSocket binary: byte 0 = 1 (version), byte 1 = direction (1 Router -> worker, 2 worker -> Router), bytes 2-17 the
//                   PTY session UUID, bytes 18-25 the sequence (u64 big-endian, >= 1), then at most 64 KiB of PTY bytes
// IDs (ownership session, worker generation, operation, PTY session) are UUID v4. Sequences on the wire are decimal strings.

export const LIMITS = Object.freeze({ json: 16 * 1024, payload: 64 * 1024, header: 26 });
export const U64_MAX = (1n << 64n) - 1n;
export const ENDED_CAUSES = Object.freeze(['supersession', 'shutdown', 'lease-expiry', 'generation-end', 'exit', 'unclaimed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTER = {
    hello: ['label?', 'helloToken'],
    reattach: ['ownershipSessionId', 'workerGeneration', 'proof', 'helloToken'],
    heartbeat: [],
    launch: ['operationId', 'targetId', 'project', 'cols', 'rows', 'launchEvidence'],
    attach: ['ptySessionId', 'afterOutputSequence'],
    resize: ['ptySessionId', 'cols', 'rows'],
    close: ['ptySessionId', 'reason']
};
const WORKER = {
    challenge: ['nonce'],
    'hello-ok': ['ownershipSessionId', 'workerGeneration', 'leaseExpiresAt', 'secret'],
    'reattach-ok': ['leaseExpiresAt', 'ptys'],
    'heartbeat-ok': ['leaseExpiresAt'],
    launched: ['operationId', 'ptySessionId'],
    'launch-failed': ['operationId', 'code'],
    gap: ['ptySessionId', 'firstAvailable'],
    ack: ['ptySessionId', 'sequence'],
    ended: ['ptySessionId', 'cause', 'exitCode?'],
    'superseded-connection': []
};

export class ProtocolError extends Error {
    constructor() {
        super('provider terminal: protocol');
        this.code = 'protocol';
    }
}

function requireValue(condition) {
    if (!condition) throw new ProtocolError();
}

function exact(value, fields) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
    const allowed = fields.map((field) => field.replace(/\?$/u, ''));
    requireValue(Object.keys(value).every((key) => allowed.includes(key)));
    requireValue(fields.filter((field) => !field.endsWith('?')).every((field) => Object.hasOwn(value, field)));
}

function text(value, max, min = 1) {
    requireValue(typeof value === 'string' && Buffer.byteLength(value) >= min && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value));
}

export const isTerminalId = (value) => typeof value === 'string' && UUID.test(value);

export function sequence(value, { zero = false } = {}) {
    requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/u.test(value));
    const number = BigInt(value);
    requireValue(number >= (zero ? 0n : 1n) && number <= U64_MAX);
    return number;
}

function secretText(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value));
    const bytes = Buffer.from(value, 'base64url');
    requireValue(bytes.length === 32 && bytes.toString('base64url') === value);
    return bytes;
}

function dimensions(value) {
    requireValue(Number.isInteger(value.cols) && value.cols >= 2 && value.cols <= 1024 && Number.isInteger(value.rows) && value.rows >= 2 && value.rows <= 512);
}

// The launch fields, validated as the Router validates them (the project is opaque input here; the worker's own launch rules are applied
// by the terminal path: `relativePath` must be '' in version 1 and the selection is resolved by the anchored grant resolver).
export function launchFields(frame) {
    const fields = { operationId: frame.operationId, targetId: frame.targetId, project: frame.project, cols: frame.cols, rows: frame.rows };
    exact(fields, ['operationId', 'targetId', 'project', 'cols', 'rows']);
    requireValue(isTerminalId(fields.operationId));
    requireValue(typeof fields.targetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(fields.targetId));
    dimensions(fields);
    if (fields.project !== null) {
        exact(fields.project, ['selection', 'relativePath']);
        text(fields.project.selection, 1024);
        text(fields.project.relativePath, 4096, 0);
        requireValue(!fields.project.relativePath.startsWith('/') && !fields.project.relativePath.includes('\\')
            && !fields.project.relativePath.split('/').some((part) => part === '.' || part === '..'));
    }
    return fields;
}

// computeRch(fields) of Ploinky Agent/lib/requestHash.mjs: base64url(SHA-256(canonical JSON)). The worker's canonical JSON is identical
// for this input (strings, integers, null and plain objects).
export function launchHash(fields) {
    return crypto.createHash('sha256').update(canonicalJson(launchFields(fields)), 'utf8').digest('base64url');
}

function validate(value, types) {
    requireValue(value && typeof value === 'object' && Object.hasOwn(types, value.type));
    exact(value, ['v', 'type', ...types[value.type]]);
    requireValue(value.v === 1);
    for (const field of ['ownershipSessionId', 'workerGeneration', 'operationId', 'ptySessionId']) {
        if (Object.hasOwn(value, field)) requireValue(isTerminalId(value[field]));
    }
    for (const field of ['secret', 'nonce', 'proof']) if (Object.hasOwn(value, field)) secretText(value[field]);
    if (Object.hasOwn(value, 'leaseExpiresAt')) requireValue(Number.isSafeInteger(value.leaseExpiresAt) && value.leaseExpiresAt > 0);
    if (Object.hasOwn(value, 'cols')) dimensions(value);
    if (Object.hasOwn(value, 'label')) text(value.label, 128);
    if (Object.hasOwn(value, 'helloToken')) text(value.helloToken, 12 * 1024);
    if (value.type === 'launch') {
        launchFields(value);
        text(value.launchEvidence, 12 * 1024);
    }
    if (value.type === 'attach') sequence(value.afterOutputSequence, { zero: true });
    if (value.type === 'close') requireValue(['user-close', 'router-shutdown'].includes(value.reason));
    if (value.type === 'reattach-ok') {
        requireValue(Array.isArray(value.ptys) && value.ptys.length <= 128);
        for (const entry of value.ptys) {
            exact(entry, ['ptySessionId', 'inputNext', 'outputLast']);
            requireValue(isTerminalId(entry.ptySessionId));
        }
    }
    if (value.type === 'gap') sequence(value.firstAvailable);
    if (value.type === 'ack') sequence(value.sequence);
    if (value.type === 'launch-failed') requireValue(typeof value.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value.code));
    if (value.type === 'ended') {
        requireValue(ENDED_CAUSES.includes(value.cause));
        if (Object.hasOwn(value, 'exitCode')) requireValue(Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255);
    }
    return value;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

// A Router control frame (text). Throws ProtocolError on anything else.
export function decodeRouterControl(bytes) {
    try {
        requireValue(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.json);
        return validate(JSON.parse(decoder.decode(bytes)), ROUTER);
    } catch {
        throw new ProtocolError();
    }
}

export function encodeWorkerControl(type, fields = {}) {
    const value = validate({ v: 1, type, ...fields }, WORKER);
    const wire = JSON.stringify(value);
    requireValue(Buffer.byteLength(wire) <= LIMITS.json);
    return wire;
}

const uuidBytes = (id) => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidText = (bytes) => {
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

// A Router data frame (binary, direction 1): {ptySessionId, sequence (BigInt), payload}.
export function decodeRouterData(frame) {
    requireValue(Buffer.isBuffer(frame) && frame.length >= LIMITS.header && frame.length <= LIMITS.header + LIMITS.payload);
    requireValue(frame[0] === 1 && frame[1] === 1);
    const ptySessionId = uuidText(frame.subarray(2, 18));
    requireValue(isTerminalId(ptySessionId));
    const value = frame.readBigUInt64BE(18);
    requireValue(value > 0n);
    return { ptySessionId, sequence: value, payload: frame.subarray(LIMITS.header) };
}

// A worker data frame (binary, direction 2).
export function encodeWorkerData(ptySessionId, value, payload) {
    requireValue(isTerminalId(ptySessionId) && typeof value === 'bigint' && value >= 1n && value <= U64_MAX);
    requireValue(Buffer.isBuffer(payload) && payload.length <= LIMITS.payload);
    const frame = Buffer.alloc(LIMITS.header + payload.length);
    frame[0] = 1;
    frame[1] = 2;
    uuidBytes(ptySessionId).copy(frame, 2);
    frame.writeBigUInt64BE(value, 18);
    payload.copy(frame, LIMITS.header);
    return frame;
}

export const newSecret = () => crypto.randomBytes(32);
export const newNonce = () => crypto.randomBytes(32).toString('base64url');

// HMAC-SHA256(secret, len32(nonce) nonce len32(ownershipSessionId) ownershipSessionId len32(workerGeneration) workerGeneration), base64url:
// Ploinky's terminalPossessionProof. The secret is the raw 32 bytes the worker issued in hello-ok and holds in memory only.
export function possessionProof(secret, { nonce, ownershipSessionId, workerGeneration }) {
    const parts = [nonce, ownershipSessionId, workerGeneration].flatMap((value) => {
        const bytes = Buffer.from(value, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return [length, bytes];
    });
    return crypto.createHmac('sha256', secret).update(Buffer.concat(parts)).digest();
}

export function proofMatches(secret, proofText, binding) {
    let presented;
    try { presented = secretText(proofText); } catch { return false; }
    const expected = possessionProof(secret, binding);
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}
