import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { startDocumentServerProcess, startOnlyOfficeAgent } from '../src/index.mjs';

function createServerFactory() {
  const records = [];
  return {
    records,
    createHttpServer(handler) {
      const emitter = new EventEmitter();
      const record = {
        handler,
        listens: [],
        closed: false,
      };
      const server = Object.assign(emitter, {
        listen(port, host, callback) {
          record.listens.push({ port, host });
          callback?.();
          return server;
        },
        close(callback) {
          record.closed = true;
          callback?.();
        },
      });
      records.push(record);
      return server;
    },
  };
}

test('DocumentServer owns a process group that is signalled as one during shutdown', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
  });
  const calls = [];
  const runtime = startDocumentServerProcess({
    env: {},
    command: 'document-server-command',
    spawnProcess(file, args, options) {
      calls.push({ file, args, options });
      return child;
    },
    signalProcessGroup(pid, signal) {
      calls.push({ pid, signal });
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
    },
  });

  await runtime.stop();

  assert.equal(calls[0].file, '/bin/bash');
  assert.deepEqual(calls[0].args, ['-lc', 'document-server-command']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.PLUGINS_ENABLED, 'false');
  assert.deepEqual(calls[1], { pid: -4242, signal: 'SIGTERM' });
});

test('onlyoffice agent runtime starts control storage and editor listeners with separated ports', async () => {
  const env = {
    ONLYOFFICE_JWT_SECRET: 'jwt-secret',
    ONLYOFFICE_CONTROL_PORT: '17000',
    ONLYOFFICE_STORAGE_PORT: '19100',
    ONLYOFFICE_EDITOR_PORT: '18080',
    PLOINKY_WORKSPACE_ROOT: '/tmp/workspace',
  };
  const serverFactory = createServerFactory();
  const calls = {
    control: null,
    workspace: null,
    dpu: null,
    router: null,
    storage: null,
    editor: null,
    documentServerStarts: 0,
    documentServerStops: 0,
  };
  const controlHandler = () => true;
  const storageHandler = () => true;
  const editorHandler = () => {};
  const editorUpgradeHandler = () => {};

  const runtime = await startOnlyOfficeAgent({
    env,
    assertImageContract() {},
    createHttpServer: serverFactory.createHttpServer,
    createControlRouteHandler(args) {
      calls.control = args;
      return controlHandler;
    },
    createWorkspaceStore(args) {
      calls.workspace = args;
      return { kind: 'workspace-store' };
    },
    createDpuStore(args) {
      calls.dpu = args;
      return { kind: 'dpu-store' };
    },
    createStorageRouter(args) {
      calls.router = args;
      return { kind: 'storage-router' };
    },
    createStorageRouteHandler(args) {
      calls.storage = args;
      return storageHandler;
    },
    createEditorProxy(args) {
      calls.editor = args;
      return {
        handle: editorHandler,
        handleUpgrade: editorUpgradeHandler,
      };
    },
    startDocumentServer() {
      calls.documentServerStarts += 1;
      return {
        async stop() {
          calls.documentServerStops += 1;
        },
      };
    },
  });

  assert.equal(calls.documentServerStarts, 1);
  assert.equal(serverFactory.records.length, 3);
  assert.deepEqual(serverFactory.records.map((record) => record.listens[0]), [
    { port: 17000, host: '0.0.0.0' },
    { port: 19100, host: '127.0.0.1' },
    { port: 18080, host: '0.0.0.0' },
  ]);
  assert.equal(calls.workspace.workspaceRoot, '/tmp/workspace');
  assert.equal(calls.control.config.controlPort, 17000);
  assert.equal(calls.storage.storageRouter.kind, 'storage-router');
  assert.equal(calls.editor.targetBaseUrl, 'http://127.0.0.1:80');
  assert.equal(typeof calls.editor.forwardHttp, 'function');
  assert.equal(typeof calls.editor.forwardUpgrade, 'function');
  assert.deepEqual(calls.router, {
    workspaceStore: { kind: 'workspace-store' },
    dpuStore: { kind: 'dpu-store' },
  });
  assert.equal(calls.dpu.createAgentClient.name, 'createAgentClient');

  await runtime.stop();

  assert.equal(calls.documentServerStops, 1);
  assert.equal(serverFactory.records.every((record) => record.closed), true);
});

test('onlyoffice agent runtime requires an explicit workspace root', async () => {
  await assert.rejects(
    () => startOnlyOfficeAgent({
      env: {
        ONLYOFFICE_JWT_SECRET: 'jwt-secret',
      },
      assertImageContract() {},
      createWorkspaceStore() {
        throw new Error('workspace root fallback was used');
      },
      startDocumentServer() {
        throw new Error('document server should not start');
      },
    }),
    /PLOINKY_WORKSPACE_ROOT is required/
  );
});

test('failed drain keeps storage and DocumentServer alive and reports failure', async () => {
  const serverFactory = createServerFactory();
  let documentServerStops = 0;
  const runtime = await startOnlyOfficeAgent({
    env: {
      ONLYOFFICE_JWT_SECRET: 'jwt-secret',
      PLOINKY_WORKSPACE_ROOT: '/tmp/workspace',
    },
    assertImageContract() {},
    createHttpServer: serverFactory.createHttpServer,
    createControlRouteHandler: () => () => true,
    createStorageRouteHandler: () => () => true,
    createWorkspaceStore: () => ({}),
    createDpuStore: () => ({}),
    createStorageRouter: () => ({}),
    createEditorProxy: () => ({ handle() {}, handleUpgrade() {} }),
    startDocumentServer: () => ({
      async stop() {
        documentServerStops += 1;
      },
    }),
    drainOnlyOfficeSessions: async () => {
      throw new Error('callback acknowledgement missing');
    },
  });

  runtime.sessionStore.acknowledgeDrainedEditors = () => { throw new Error('failed drain must not retire editor sessions'); };
  await assert.rejects(() => runtime.stop(), /callback acknowledgement missing/);
  assert.equal(serverFactory.records[0].closed, true, 'control listener stops admitting new sessions');
  assert.equal(serverFactory.records[2].closed, true, 'editor listener stops admitting new sessions');
  assert.equal(serverFactory.records[1].closed, false, 'callback storage remains live');
  assert.equal(documentServerStops, 0, 'DocumentServer remains live for a retry');
});

test('active editor socket cannot block force-save drain before targeted restart', async () => {
  const records = [];
  const activeSocket = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() {
      throw new Error('raw socket destruction bypassed graceful shutdown');
    },
    closeGracefully() {
      this.destroyed = true;
      this.emit('close');
      records[2].finishClose?.();
    },
  });
  let drained = false;
  let disconnected = false;
  let nowMs = 1_000;
  let drainDeadline;
  const runtime = await startOnlyOfficeAgent({
    now: () => nowMs,
    env: {
      ONLYOFFICE_JWT_SECRET: 'jwt-secret',
      PLOINKY_WORKSPACE_ROOT: '/tmp/workspace',
    },
    assertImageContract() {},
    createHttpServer(handler) {
      const emitter = new EventEmitter();
      const index = records.length;
      const record = { handler, closeStarted: false, closeFinished: false };
      const server = Object.assign(emitter, {
        listen(_port, _host, callback) {
          callback?.();
          return server;
        },
        close(callback) {
          record.closeStarted = true;
          if (index !== 2) {
            record.closeFinished = true;
            callback?.();
            return;
          }
          record.finishClose = () => {
            record.closeFinished = true;
            callback?.();
          };
        },
      });
      records.push(record);
      return server;
    },
    createControlRouteHandler: () => () => true,
    createStorageRouteHandler: () => () => true,
    createWorkspaceStore: () => ({}),
    createDpuStore: () => ({}),
    createStorageRouter: () => ({}),
    createEditorProxy: () => ({ handle() {}, handleUpgrade() {} }),
    startDocumentServer: () => ({ async stop() {
      assert.equal(disconnected, true, 'DocumentServer stops only after the editor closes gracefully');
    } }),
    drainOnlyOfficeSessions: async ({ deadline }) => {
      drainDeadline = deadline;
      assert.equal(records[0].closeStarted, true, 'control no longer accepts new work');
      assert.equal(records[2].closeStarted, true, 'editor no longer accepts new work');
      assert.equal(records[2].closeFinished, false, 'active WebSocket still delays close callback');
      assert.equal(activeSocket.destroyed, false, 'editor stays connected through force-save acknowledgement');
      drained = true;
      nowMs += 1_200;
    },
    disconnectOnlyOfficeEditors: async ({ editorSockets, deadline, now }) => {
      assert.equal(drained, true, 'native disconnect follows durable callback acknowledgement');
      assert.equal(deadline, drainDeadline, 'disconnect shares the original application drain deadline');
      assert.equal(deadline - now(), 28_800);
      assert.equal(editorSockets.has(activeSocket), true);
      assert.equal(records[1].closeStarted, false, 'callback storage remains live through graceful disconnect');
      activeSocket.closeGracefully();
      disconnected = true;
    },
  });
  let acknowledged = false;
  runtime.sessionStore.acknowledgeDrainedEditors = () => {
    assert.equal(drained, true);
    assert.equal(disconnected, true);
    assert.equal(activeSocket.destroyed, true);
    acknowledged = true;
  };
  runtime.editorServer.emit('connection', activeSocket);
  runtime.editorServer.emit('upgrade', {}, activeSocket, Buffer.alloc(0));

  await runtime.stop();
  assert.equal(acknowledged, true);

  assert.equal(drained, true);
  assert.equal(activeSocket.destroyed, true);
  assert.equal(records[2].closeFinished, true);
});

test('failed graceful editor shutdown retains storage and DocumentServer and can retry without reclosing listeners', async () => {
  const serverFactory = createServerFactory();
  const activeSocket = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy() { throw new Error('raw socket destruction is forbidden'); },
  });
  let attempts = 0;
  let documentServerStops = 0;
  const runtime = await startOnlyOfficeAgent({
    env: { ONLYOFFICE_JWT_SECRET: 'jwt-secret', PLOINKY_WORKSPACE_ROOT: '/tmp/workspace' },
    assertImageContract() {},
    createHttpServer: serverFactory.createHttpServer,
    createControlRouteHandler: () => () => true,
    createStorageRouteHandler: () => () => true,
    createWorkspaceStore: () => ({}),
    createDpuStore: () => ({}),
    createStorageRouter: () => ({}),
    createEditorProxy: () => ({ handle() {}, handleUpgrade() {} }),
    startDocumentServer: () => ({ async stop() { documentServerStops += 1; } }),
    drainOnlyOfficeSessions: async () => {},
    disconnectOnlyOfficeEditors: async ({ editorSockets }) => {
      attempts += 1;
      assert.equal(editorSockets.has(activeSocket), true);
      if (attempts === 1) throw new Error('native disconnect deadline expired');
      activeSocket.emit('close');
    },
  });
  runtime.editorServer.emit('connection', activeSocket);
  runtime.editorServer.emit('upgrade', {}, activeSocket, Buffer.alloc(0));
  let acknowledged = false;
  runtime.sessionStore.acknowledgeDrainedEditors = () => { acknowledged = true; };
  await assert.rejects(() => runtime.stop(), /native disconnect deadline expired/);
  assert.equal(acknowledged, false);
  assert.equal(documentServerStops, 0);
  assert.equal(serverFactory.records[1].closed, false);
  assert.equal(activeSocket.destroyed, false);
  runtime.controlServer.close = () => { throw new Error('control listener was closed twice'); };
  runtime.editorServer.close = () => { throw new Error('editor listener was closed twice'); };
  await runtime.stop();
  await runtime.stop();
  assert.equal(acknowledged, true);
  assert.equal(attempts, 2);
  assert.equal(documentServerStops, 1);
  assert.equal(serverFactory.records[1].closed, true);
});

test('partial editor HTTP requests close after graceful drain and before DocumentServer teardown', { timeout: 5_000 }, async () => {
  let acceptedSocket;
  let drained = false;
  let documentServerStopped = false;
  const runtime = await startOnlyOfficeAgent({
    env: { ONLYOFFICE_JWT_SECRET: 'jwt-secret', PLOINKY_WORKSPACE_ROOT: '/tmp/workspace' },
    assertImageContract() {},
    createHttpServer(handler) {
      const server = http.createServer(handler);
      const bind = server.listen.bind(server);
      server.listen = (_port, _host, callback) => bind(0, '127.0.0.1', callback);
      return server;
    },
    createControlRouteHandler: () => () => true,
    createStorageRouteHandler: () => () => true,
    createWorkspaceStore: () => ({}),
    createDpuStore: () => ({}),
    createStorageRouter: () => ({}),
    createEditorProxy: () => ({ handle() {}, handleUpgrade() {} }),
    drainOnlyOfficeSessions: async () => {
      assert.equal(acceptedSocket.destroyed, false, 'HTTP sockets survive until durable drain completes');
      drained = true;
    },
    startDocumentServer: () => ({ async stop() {
      assert.equal(drained, true);
      assert.equal(acceptedSocket.destroyed, true, 'partial HTTP cannot block close after process termination');
      documentServerStopped = true;
    } }),
  });
  const accepted = once(runtime.editorServer, 'connection');
  const client = net.connect(runtime.editorServer.address().port, '127.0.0.1');
  let timer;
  try {
    [[acceptedSocket]] = await Promise.all([accepted, once(client, 'connect')]);
    const receivedPartialRequest = once(acceptedSocket, 'data');
    client.write('GET /unfinished HTTP/1.1\r\nHost: localhost\r\n');
    await receivedPartialRequest;
    await Promise.race([
      runtime.stop(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('partial HTTP blocked runtime shutdown')), 1_000); }),
    ]);
    assert.equal(documentServerStopped, true);
    assert.equal(runtime.editorServer.listening, false);
    assert.equal(runtime.storageServer.listening, false);
  } finally {
    clearTimeout(timer);
    client.destroy();
    for (const server of [runtime.editorServer, runtime.controlServer, runtime.storageServer]) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
});
