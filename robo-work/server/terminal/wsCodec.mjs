import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// A bounded RFC 6455 server codec for the robot-terminal control channel (M-8 SPEC; plan-review F-6). The worker has no WebSocket
// library; this module is the whole of it. It follows the shape of ploinky/cli/server/utils/websocket.js and refuses more:
//
//   no extension, no subprotocol, no fragmentation (FIN must be set and a continuation frame is refused), every client frame masked,
//   no RSV bit, only the opcodes text (1), binary (2), close (8), ping (9) and pong (10), control frames of at most 125 bytes, and a
//   declared payload length above `maxPayload` refused from the header alone, BEFORE any payload byte is buffered. The reader never holds
//   more than one frame header plus `maxPayload` bytes. Server frames are unmasked.
//
//   validateUpgrade(req)                        -> the client key, or null when the request is not an acceptable version-13 upgrade
//   acceptValue(key)                            -> the Sec-WebSocket-Accept value
//   completeUpgrade(socket, key)                writes the 101 response (no extension or protocol header)
//   refuseUpgrade(socket, status)               writes a bodiless HTTP refusal and destroys the socket (before any 101)
//   createFrameReader({ maxPayload, onFrame, onError })   -> push(chunk): incremental parser; onFrame({ opcode, payload })
//   encodeFrame(opcode, payload)                -> Buffer (FIN set, unmasked)
//   createConnection(socket, { maxPayload, head })        -> WsConnection (EventEmitter)
//     events 'message' (payload Buffer, isBinary), 'close' (reason code string), 'drain' (the socket's write buffer emptied)
//     send(data, { binary }, callback)  callback(error|null) once the bytes were handed to the socket
//     bufferedAmount                    bytes queued in the socket (the backpressure measure)
//     close(code = 1000)                sends a close frame once and ends the socket; idempotent
//     destroy()                         drops the socket at once
// A codec refusal (`protocol`, `too_large`) closes with 1002 / 1009 and emits 'close' with that reason. Payload bytes are never logged.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY = /^[A-Za-z0-9+/]{22}==$/u;
const OPCODES = new Set([0x1, 0x2, 0x8, 0x9, 0xa]);
const REASONS = Object.freeze({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 503: 'Service Unavailable' });

const header = (value) => (Array.isArray(value) ? value.join(',') : String(value ?? ''));
const tokens = (value) => header(value).toLowerCase().split(',').map((token) => token.trim()).filter(Boolean);

export function validateUpgrade(req) {
    if (String(req?.method ?? '') !== 'GET') return null;
    if (!tokens(req.headers?.upgrade).includes('websocket')) return null;
    if (!tokens(req.headers?.connection).includes('upgrade')) return null;
    if (header(req.headers?.['sec-websocket-version']).trim() !== '13') return null;
    const key = header(req.headers?.['sec-websocket-key']).trim();
    if (!KEY.test(key) || Buffer.from(key, 'base64').length !== 16) return null;
    return key;
}

export function acceptValue(key) {
    return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

export function completeUpgrade(socket, key) {
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptValue(key)}`, '', ''].join('\r\n'));
}

export function refuseUpgrade(socket, status = 400) {
    const reason = REASONS[status] ?? 'Error';
    try {
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    } catch { /* closed */ }
    setImmediate(() => { try { socket.destroy(); } catch { /* closed */ } });
}

export class CodecError extends Error {
    constructor(code) {
        super(`websocket: ${code}`);
        this.code = code;
    }
}

export function createFrameReader({ maxPayload, onFrame, onError }) {
    if (!Number.isSafeInteger(maxPayload) || maxPayload < 125) throw new TypeError('maxPayload must be an integer of at least 125');
    let buffered = Buffer.alloc(0);
    let failed = false;
    const fail = (code) => { failed = true; buffered = Buffer.alloc(0); onError(new CodecError(code)); };
    return {
        push(chunk) {
            if (failed) return;
            buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk]);
            while (!failed && buffered.length >= 2) {
                const first = buffered[0];
                const second = buffered[1];
                const fin = (first & 0x80) !== 0;
                const opcode = first & 0x0f;
                if ((first & 0x70) !== 0) return fail('protocol');
                if (!OPCODES.has(opcode)) return fail('protocol');
                if (!fin) return fail('protocol');
                if ((second & 0x80) === 0) return fail('protocol');
                let length = second & 0x7f;
                let offset = 2;
                if (length === 126) {
                    if (buffered.length < 4) return;
                    length = buffered.readUInt16BE(2);
                    if (length < 126) return fail('protocol');
                    offset = 4;
                } else if (length === 127) {
                    if (buffered.length < 10) return;
                    const high = buffered.readUInt32BE(2);
                    const low = buffered.readUInt32BE(6);
                    if (high !== 0 || low < 65536) return fail(high !== 0 ? 'too_large' : 'protocol');
                    length = low;
                    offset = 10;
                }
                if (opcode >= 0x8 && length > 125) return fail('protocol');
                if (length > maxPayload) return fail('too_large');
                if (buffered.length < offset + 4 + length) {
                    // Never more than a header plus maxPayload is held.
                    if (buffered.length > offset + 4 + maxPayload) return fail('too_large');
                    return;
                }
                const mask = buffered.subarray(offset, offset + 4);
                const payload = Buffer.allocUnsafe(length);
                for (let index = 0; index < length; index += 1) payload[index] = buffered[offset + 4 + index] ^ mask[index & 3];
                buffered = buffered.subarray(offset + 4 + length);
                if (buffered.length === 0) buffered = Buffer.alloc(0);
                onFrame({ opcode, payload });
            }
        }
    };
}

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    let head;
    if (body.length < 126) {
        head = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode;
        head[1] = 126;
        head.writeUInt16BE(body.length, 2);
    } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 127;
        head.writeUInt32BE(0, 2);
        head.writeUInt32BE(body.length, 6);
    }
    return Buffer.concat([head, body]);
}

class WsConnection extends EventEmitter {
    #socket;
    #closed = false;
    #closeSent = false;

    constructor(socket, { maxPayload, head }) {
        super();
        this.#socket = socket;
        socket.setNoDelay?.(true);
        const reader = createFrameReader({
            maxPayload,
            onFrame: (frame) => this.#onFrame(frame),
            onError: (error) => this.#fail(error.code)
        });
        socket.on('data', (chunk) => reader.push(chunk));
        socket.on('drain', () => this.emit('drain'));
        socket.on('error', () => this.#finish('transport'));
        socket.on('close', () => this.#finish('transport'));
        socket.on('end', () => this.#finish('transport'));
        if (head && head.length > 0) setImmediate(() => reader.push(head));
    }

    get closed() { return this.#closed; }
    get bufferedAmount() { return this.#socket.writableLength ?? 0; }

    #onFrame({ opcode, payload }) {
        if (this.#closed) return;
        if (opcode === 0x9) { this.#write(encodeFrame(0xa, payload)); return; }
        if (opcode === 0xa) return;
        if (opcode === 0x8) { this.close(1000); return; }
        this.emit('message', payload, opcode === 0x2);
    }

    #write(frame, callback) {
        try {
            this.#socket.write(frame, callback);
        } catch {
            callback?.(new CodecError('transport'));
        }
    }

    #fail(code) {
        if (this.#closed) return;
        this.#sendClose(code === 'too_large' ? 1009 : 1002);
        this.#finish(code);
    }

    #sendClose(code) {
        if (this.#closeSent) return;
        this.#closeSent = true;
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        try { this.#socket.end(encodeFrame(0x8, body)); } catch { /* closed */ }
    }

    #finish(reason) {
        if (this.#closed) return;
        this.#closed = true;
        setTimeout(() => { try { this.#socket.destroy(); } catch { /* closed */ } }, 1000).unref?.();
        this.emit('close', reason);
    }

    send(data, { binary = false } = {}, callback = () => {}) {
        if (this.#closed) { callback(new CodecError('closed')); return; }
        this.#write(encodeFrame(binary ? 0x2 : 0x1, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')), (error) => callback(error ? new CodecError('transport') : null));
    }

    close(code = 1000) {
        if (this.#closed) return;
        this.#sendClose(code);
        this.#finish('closed');
    }

    destroy() {
        try { this.#socket.destroy(); } catch { /* closed */ }
        this.#finish('closed');
    }
}

export function createConnection(socket, { maxPayload, head = null }) {
    return new WsConnection(socket, { maxPayload, head });
}
