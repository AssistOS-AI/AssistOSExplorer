/**
 * Minimal RFC 6455 WebSocket frame codec.
 * No dependencies — works directly with node:http upgrade sockets.
 */
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/**
 * Compute the Sec-WebSocket-Accept value for the handshake.
 */
export function computeWebSocketAccept(key) {
    return createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');
}

/**
 * Complete the HTTP -> WebSocket upgrade handshake.
 */
export function completeUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) return false;

    const accept = computeWebSocketAccept(key);
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            '\r\n'
    );
    return true;
}

/**
 * Encode a payload into a WebSocket frame buffer (server -> client, unmasked).
 */
export function encodeFrame(opcode, payload) {
    const data = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const len = data.length;

    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, data]);
}

/**
 * Decode a WebSocket frame from a buffer.
 * Returns { opcode, payload, bytesConsumed } or null if incomplete.
 */
export function decodeFrame(buf) {
    if (buf.length < 2) return null;

    const firstByte = buf[0];
    const opcode = firstByte & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
        if (buf.length < 4) return null;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buf.length < 10) return null;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }

    const maskSize = masked ? 4 : 0;
    const totalLen = offset + maskSize + payloadLen;
    if (buf.length < totalLen) return null;

    let payload;
    if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        offset += 4;
        payload = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
            payload[i] = buf[offset + i] ^ mask[i & 3];
        }
    } else {
        payload = buf.subarray(offset, offset + payloadLen);
    }

    return { opcode, payload, bytesConsumed: totalLen };
}

/** Send a text frame. */
export function sendTextFrame(socket, text) {
    socket.write(encodeFrame(OPCODE_TEXT, text));
}

/** Send a ping frame. */
export function sendPing(socket) {
    socket.write(encodeFrame(OPCODE_PING, Buffer.alloc(0)));
}

/** Send a close frame. */
export function sendCloseFrame(socket, code = 1000, reason = '') {
    const codeBuf = Buffer.alloc(2);
    codeBuf.writeUInt16BE(code);
    const reasonBuf = Buffer.from(reason);
    socket.write(
        encodeFrame(OPCODE_CLOSE, Buffer.concat([codeBuf, reasonBuf]))
    );
}

export { OPCODE_TEXT, OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG };
