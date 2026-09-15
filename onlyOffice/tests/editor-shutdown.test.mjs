import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { disconnectOnlyOfficeEditors } from '../src/editor-shutdown.mjs';

function editorSocket() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    closeGracefully() { this.destroyed = true; this.emit('close'); },
    destroy() { throw new Error('shutdown must not destroy a live editor socket'); },
  });
}

function nativeRequest(onEnd) {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    end() { onEnd(this); },
    destroy() {
      this.destroyed = true;
      queueMicrotask(() => this.emit('error', new Error('intentional native HTTP cancellation')));
    },
  });
}

test('native response is not delivery proof; every editor socket must close before cancellation', async () => {
  const first = editorSocket();
  const second = editorSocket();
  const response = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} });
  let request;
  let resolved = false;
  const pending = disconnectOnlyOfficeEditors({
    editorSockets: new Set([first, second]),
    deadline: Date.now() + 1_000,
    requestImpl(url, options) {
      assert.equal(url, 'http://[::1]:8000/internal/cluster/inactive');
      assert.deepEqual(options, { method: 'PUT' });
      request = nativeRequest((outgoing) => {
        outgoing.emit('response', response);
        first.closeGracefully();
      });
      return request;
    },
  }).then((value) => { resolved = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  assert.equal(request.destroyed, false);
  second.closeGracefully();
  assert.deepEqual(await pending, { disconnectedEditors: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.destroyed, true);
  assert.equal(first.listenerCount('close'), 0);
  assert.equal(second.listenerCount('close'), 0);
});

test('native failures and exhausted budgets retain live sockets and remove observers', async (t) => {
  for (const mode of ['request error', 'HTTP 500', 'HTTP redirect', 'response aborted', 'shared deadline']) {
    await t.test(mode, async () => {
      const socket = editorSocket();
      let request;
      await assert.rejects(() => disconnectOnlyOfficeEditors({
        editorSockets: new Set([socket]),
        deadline: Date.now() + (mode === 'shared deadline' ? 20 : 1_000),
        requestImpl() {
          request = nativeRequest((outgoing) => {
            if (mode === 'request error') outgoing.emit('error', new Error('connection refused'));
            if (mode.startsWith('HTTP') || mode === 'response aborted') {
              const response = Object.assign(new EventEmitter(), {
                statusCode: mode === 'HTTP 500' ? 500 : mode === 'HTTP redirect' ? 302 : 200,
                resume() {},
              });
              outgoing.emit('response', response);
              if (mode === 'response aborted') response.emit('aborted');
            }
          });
          return request;
        },
      }), mode === 'shared deadline' ? /timed out waiting for 1 socket/ : /shutdown (?:request failed|response failed|returned HTTP)/);
      assert.equal(socket.destroyed, false);
      assert.equal(socket.listenerCount('close'), 0);
      assert.equal(request.destroyed, true);
    });
  }
});

test('zero editors need no native request, and an expired overall budget cannot be renewed', async () => {
  let requests = 0;
  const options = { now: () => 1_000, requestImpl() { requests += 1; } };
  assert.deepEqual(await disconnectOnlyOfficeEditors({ ...options, deadline: 1_100, editorSockets: new Set() }), { disconnectedEditors: 0 });
  await assert.rejects(() => disconnectOnlyOfficeEditors({ ...options, deadline: 1_000, editorSockets: new Set([editorSocket()]) }), /no remaining drain budget/);
  assert.equal(requests, 0);
});

test('native graceful delivery has a two-second ceiling inside a longer application deadline', { timeout: 5_000 }, async () => {
  const socket = editorSocket();
  const startedAt = Date.now();
  await assert.rejects(() => disconnectOnlyOfficeEditors({
    editorSockets: new Set([socket]),
    deadline: startedAt + 30_000,
    requestImpl: () => nativeRequest(() => {}),
  }), /timed out waiting for 1 socket/);
  assert(Date.now() - startedAt < 4_000, 'native shutdown must not consume the full thirty-second HTTP wait');
  assert.equal(socket.destroyed, false);
});

test('real native HTTP cancellation follows terminal bytes and actual client socket closure', { timeout: 5_000 }, async () => {
  let upstreamSocket;
  const editor = net.createServer((socket) => { upstreamSocket = socket; });
  await new Promise((resolve) => editor.listen(0, '127.0.0.1', resolve));
  const client = net.connect(editor.address().port, '127.0.0.1');
  await once(client, 'connect');
  const chunks = [];
  client.on('data', (chunk) => chunks.push(chunk));
  let nativeResponseClosed;
  const nativeClosed = new Promise((resolve) => { nativeResponseClosed = resolve; });
  const native = http.createServer((request, response) => {
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, '/internal/cluster/inactive');
    response.once('close', nativeResponseClosed);
    upstreamSocket.end('SHUTDOWN: server namespace disconnect\n');
    // Deliberately keep the native HTTP response outstanding after delivery.
  });
  await new Promise((resolve) => native.listen(0, '::1', resolve));
  try {
    const result = await disconnectOnlyOfficeEditors({
      editorSockets: new Set([client]),
      deadline: Date.now() + 1_000,
      requestImpl(url, options) {
        assert.equal(url, 'http://[::1]:8000/internal/cluster/inactive');
        return http.request(`http://[::1]:${native.address().port}/internal/cluster/inactive`, options);
      },
    });
    await nativeClosed;
    assert.deepEqual(result, { disconnectedEditors: 1 });
    assert.equal(client.destroyed, true);
    assert.equal(Buffer.concat(chunks).toString(), 'SHUTDOWN: server namespace disconnect\n');
  } finally {
    client.destroy();
    upstreamSocket?.destroy();
    native.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => native.close(resolve)),
      new Promise((resolve) => editor.close(resolve)),
    ]);
  }
});
