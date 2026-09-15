import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { editorUrl, probeUpgrade } from './helpers/public-editor-probe.mjs';

async function withServer(t, connection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    connection(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/editor`;
}

test('editor probe preserves transport query parameters under its service prefix', () => {
  assert.equal(
    editorUrl('http://localhost:8080/editor/?old=value', '/doc/key/c/?shardkey=key&EIO=4&transport=websocket'),
    'http://localhost:8080/editor/doc/key/c/?shardkey=key&EIO=4&transport=websocket',
  );
});

test('editor probe sends the real upgrade path and receives HTTP 101', async (t) => {
  let request;
  const base = await withServer(t, (socket) => socket.once('data', (data) => {
    request = data.toString();
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  }));
  assert.equal(await probeUpgrade(base, '/doc/key/c/?EIO=4&transport=websocket'), 101);
  assert.match(request, /^GET \/editor\/doc\/key\/c\/\?EIO=4&transport=websocket HTTP\/1\.1\r\n/);
});

test('editor probe rejects a connection closed without an HTTP response', { timeout: 1000 }, async (t) => {
  const base = await withServer(t, (socket) => socket.destroy());
  await assert.rejects(probeUpgrade(base, '/doc/key/c/'), /closed before an HTTP upgrade response/);
});

test('editor probe bounds a connected server that never responds', { timeout: 1000 }, async (t) => {
  const base = await withServer(t, () => {});
  await assert.rejects(probeUpgrade(base, '/doc/key/c/', { timeoutMs: 25 }), /Timed out/);
});
