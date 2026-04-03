import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  decodeFrame,
  computeWebSocketAccept,
  OPCODE_TEXT,
  OPCODE_CLOSE,
  OPCODE_PING,
} from '../../core/websocket-frame-codec.mjs';

describe('WebSocket frame codec', () => {
  it('encodes and decodes small text frame', () => {
    const text = 'hello world';
    const frame = encodeFrame(OPCODE_TEXT, text);
    const decoded = decodeFrame(frame);

    assert.equal(decoded.opcode, OPCODE_TEXT);
    assert.equal(decoded.payload.toString(), text);
    assert.equal(decoded.bytesConsumed, frame.length);
  });

  it('encodes and decodes medium payload (126-65535 bytes)', () => {
    const text = 'x'.repeat(500);
    const frame = encodeFrame(OPCODE_TEXT, text);
    const decoded = decodeFrame(frame);

    assert.equal(decoded.opcode, OPCODE_TEXT);
    assert.equal(decoded.payload.length, 500);
  });

  it('encodes and decodes large payload (>65535 bytes)', () => {
    const text = 'x'.repeat(70000);
    const frame = encodeFrame(OPCODE_TEXT, text);
    const decoded = decodeFrame(frame);

    assert.equal(decoded.opcode, OPCODE_TEXT);
    assert.equal(decoded.payload.length, 70000);
  });

  it('returns null for incomplete frame', () => {
    assert.equal(decodeFrame(Buffer.alloc(1)), null);
  });

  it('handles close frame', () => {
    const frame = encodeFrame(OPCODE_CLOSE, Buffer.alloc(0));
    const decoded = decodeFrame(frame);
    assert.equal(decoded.opcode, OPCODE_CLOSE);
  });

  it('handles ping frame', () => {
    const frame = encodeFrame(OPCODE_PING, Buffer.alloc(0));
    const decoded = decodeFrame(frame);
    assert.equal(decoded.opcode, OPCODE_PING);
  });

  it('decodes masked client frame', () => {
    // Simulate a masked client frame: "Hi"
    const payload = Buffer.from('Hi');
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    const header = Buffer.alloc(2 + 4 + payload.length);
    header[0] = 0x80 | OPCODE_TEXT;
    header[1] = 0x80 | payload.length; // masked flag
    mask.copy(header, 2);
    masked.copy(header, 6);

    const decoded = decodeFrame(header);
    assert.equal(decoded.opcode, OPCODE_TEXT);
    assert.equal(decoded.payload.toString(), 'Hi');
  });
});

describe('computeWebSocketAccept', () => {
  it('computes correct accept key per RFC 6455', () => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    // SHA-1(key + "258EAFA5-E914-47DA-95CA-5AB5DC11D65B") base64-encoded
    assert.equal(computeWebSocketAccept(key), 'oTYf8w8uN9dmWLQsgPa0ssJjDCY=');
  });
});
