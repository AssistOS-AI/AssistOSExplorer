import { createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.mjs';
import { handleLogStream } from './log-stream.mjs';
import { handleSoulStream } from './soul-stream.mjs';
import { isAuthenticated } from '../dashboard/auth.mjs';

const log = createLogger('ws');
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5BAB0DC85B11';

/**
 * Handle WebSocket upgrade (RFC 6455).
 */
export function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams);

  // Check dashboard auth for WebSocket connections
  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Validate WebSocket handshake
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) {
    socket.destroy();
    return;
  }

  const acceptKey = createHash('sha1')
    .update(wsKey + WS_MAGIC)
    .digest('base64');

  // Disable any Node.js timeouts on this socket
  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 30000);

  // Complete the handshake
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n'
  );

  const ws = createWsHelper(socket);

  // Process any leftover data from the HTTP upgrade
  if (head && head.length > 0) {
    socket.emit('data', head);
  }

  if (pathname === '/ws/v1/logs') {
    handleLogStream(ws, query);
  } else if (pathname.startsWith('/ws/v1/soul/')) {
    const soulId = pathname.split('/').pop();
    handleSoulStream(ws, soulId, query);
  } else {
    ws.send(JSON.stringify({ error: 'Unknown WebSocket path' }));
    ws.close();
  }
}

/**
 * Create a simple WebSocket helper that wraps a raw TCP socket.
 */
function createWsHelper(socket) {
  const ws = {
    socket,
    alive: true,

    send(data) {
      if (!ws.alive) return;
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      const buf = Buffer.from(payload, 'utf8');
      const frame = encodeFrame(buf, 0x01); // text frame
      try {
        socket.write(frame);
      } catch { ws.alive = false; }
    },

    close() {
      ws.alive = false;
      try {
        socket.write(encodeFrame(Buffer.alloc(0), 0x08)); // close frame
        socket.end();
      } catch { /* ignore */ }
    },

    onMessage: null,
    onClose: null,
  };

  let msgBuffer = Buffer.alloc(0);

  socket.on('data', (data) => {
    msgBuffer = Buffer.concat([msgBuffer, data]);
    while (msgBuffer.length >= 2) {
      const decoded = decodeFrame(msgBuffer);
      if (!decoded) break;
      msgBuffer = msgBuffer.subarray(decoded.totalLength);

      if (decoded.opcode === 0x08) { // close
        ws.alive = false;
        if (ws.onClose) ws.onClose();
        socket.end();
        return;
      }
      if (decoded.opcode === 0x09) { // ping
        socket.write(encodeFrame(decoded.payload, 0x0A)); // pong
        continue;
      }
      if (decoded.opcode === 0x0A) { // pong — ignore
        continue;
      }
      if (decoded.opcode === 0x01 || decoded.opcode === 0x02) { // text or binary
        if (ws.onMessage) {
          ws.onMessage(decoded.payload.toString('utf8'));
        }
      }
    }
  });

  socket.on('close', () => {
    if (!ws.alive) {
      // Error already marked dead — still need to run cleanup
      if (ws.onClose) { const cb = ws.onClose; ws.onClose = null; cb(); }
      return;
    }
    ws.alive = false;
    if (ws.onClose) { const cb = ws.onClose; ws.onClose = null; cb(); }
  });

  socket.on('error', (err) => {
    log.warn('WebSocket socket error', { error: err.message });
    ws.alive = false;
  });

  // Heartbeat
  const pingInterval = setInterval(() => {
    if (!ws.alive) {
      clearInterval(pingInterval);
      return;
    }
    try {
      socket.write(encodeFrame(Buffer.alloc(0), 0x09)); // ping
    } catch {
      ws.alive = false;
      clearInterval(pingInterval);
    }
  }, 15_000);

  socket.on('close', () => clearInterval(pingInterval));

  return ws;
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
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
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0F;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7F;
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

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { opcode, payload, totalLength: offset + payloadLen };
  }

  if (buf.length < offset + payloadLen) return null;
  const payload = buf.subarray(offset, offset + payloadLen);
  return { opcode, payload: Buffer.from(payload), totalLength: offset + payloadLen };
}
