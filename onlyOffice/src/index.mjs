import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { drainOnlyOfficeSessions as defaultDrainOnlyOfficeSessions } from './drain.mjs';
import { disconnectOnlyOfficeEditors as defaultDisconnectOnlyOfficeEditors } from './editor-shutdown.mjs';
import { createEditorProxy as defaultCreateEditorProxy } from './proxy/editor-proxy.mjs';
import { createControlRouteHandler as defaultCreateControlRouteHandler } from './routes/control.mjs';
import { createStorageRouteHandler as defaultCreateStorageRouteHandler } from './routes/storage.mjs';
import { createSessionStore } from './session-store.mjs';
import { createDpuStore as defaultCreateDpuStore } from './storage/dpu-store.mjs';
import { createStorageRouter as defaultCreateStorageRouter } from './storage/router.mjs';
import { createWorkspaceStore as defaultCreateWorkspaceStore } from './storage/workspace-store.mjs';

function requireWorkspaceRoot(env) {
  const workspaceRoot = String(env?.PLOINKY_WORKSPACE_ROOT || '').trim();
  if (!workspaceRoot) {
    throw new Error('PLOINKY_WORKSPACE_ROOT is required.');
  }
  return workspaceRoot;
}

export function assertOnlyOfficeImageContract({
  contractPath = '/usr/local/share/ploinky/onlyoffice.contract',
  interposerPath = '/usr/local/lib/onlyoffice-docservice-loopback-bind.so',
  expectedUid = 0,
  expectedGid = 0,
} = {}) {
  let contractStat;
  let interposerStat;
  try {
    contractStat = lstatSync(contractPath);
    interposerStat = lstatSync(interposerPath);
  } catch (_) {
    throw new Error('OnlyOffice v5 image contract is missing. Publish and pin the verified v5 image before activation.');
  }
  if (!contractStat.isFile() || contractStat.isSymbolicLink()
      || contractStat.uid !== expectedUid || contractStat.gid !== expectedGid
      || (contractStat.mode & 0o777) !== 0o444) {
    throw new Error('OnlyOffice v5 image contract marker ownership, mode, or file type is invalid.');
  }
  if (!interposerStat.isFile() || interposerStat.isSymbolicLink()
      || interposerStat.uid !== expectedUid || interposerStat.gid !== expectedGid
      || (interposerStat.mode & 0o777) !== 0o555) {
    throw new Error('OnlyOffice v5 DocService loopback bind interposer ownership, mode, or file type is invalid.');
  }
  const lines = readFileSync(contractPath, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 5
      || lines[0] !== 'contract_version=5'
      || lines[1] !== 'documentserver_index_sha256=53a06109f1f4029a78f913a061e14f01bff023d109024073a13d4416b54d2195'
      || lines[2] !== 'ubuntu_snapshot=20260712T000000Z'
      || lines[3] !== 'docservice_bind_scope=docservice-port-8000'
      || !/^interposer_sha256=[0-9a-f]{64}$/.test(lines[4])) {
    throw new Error('OnlyOffice v5 image contract marker does not match the approved runtime contract.');
  }
  const expectedDigest = lines[4].slice('interposer_sha256='.length);
  const actualDigest = createHash('sha256').update(readFileSync(interposerPath)).digest('hex');
  if (actualDigest !== expectedDigest) {
    throw new Error('OnlyOffice v5 DocService loopback bind interposer digest does not match its image contract.');
  }
}

async function createAgentClient(...args) {
  const modulePath = String(process.env.ONLYOFFICE_AGENT_CLIENT_MODULE || '/Agent/client/AgentMcpClient.mjs').trim();
  const module = await import(modulePath);
  return module.createAgentClient(...args);
}

function sendNotFound(res) {
  res.statusCode = 404;
  res.end('Not found.');
}

function sendInternalError(res) {
  if (!res.headersSent) {
    res.statusCode = 500;
  }
  if (!res.writableEnded) {
    res.end('Internal server error.');
  }
}

function createRequestListener(handler, { parseUrl = false } = {}) {
  return async function onRequest(req, res) {
    try {
      const handled = parseUrl
        ? await handler(req, res, new URL(req.url, 'http://127.0.0.1'))
        : await handler(req, res);
      if (handled === false && !res.writableEnded) {
        sendNotFound(res);
      }
    } catch (error) {
      console.error('[onlyoffice] request handling failed', error);
      sendInternalError(res);
    }
  };
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off?.('error', onError);
      reject(error);
    };
    server.on?.('error', onError);
    server.listen(port, host, () => {
      server.off?.('error', onError);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server || typeof server.close !== 'function') {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeOutgoingHeaders(headers = {}, targetUrl) {
  const outgoing = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    outgoing[name] = value;
  }
  outgoing.host = targetUrl.host;
  return outgoing;
}

function applyResponseHeaders(res, headers = {}) {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      res.setHeader(name, value.map((item) => String(item)));
      continue;
    }
    res.setHeader(name, String(value));
  }
}

const SAFE_EDITOR_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-range',
  'content-security-policy',
  'content-type',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'etag',
  'expires',
  'last-modified',
  'permissions-policy',
  'referrer-policy',
  'vary',
  'x-content-type-options',
]);

function sanitizeEditorResponseHeaders(headers = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = String(name).toLowerCase();
    if (!SAFE_EDITOR_RESPONSE_HEADERS.has(normalized) || value === undefined) continue;
    safe[normalized] = value;
  }
  return safe;
}

function isRedirectStatus(statusCode) {
  return [300, 301, 302, 303, 305, 306, 307, 308].includes(Number(statusCode));
}

export function createHttpForwarder({
  request = http.request,
  secureRequest = https.request,
} = {}) {
  return async function forwardHttp(plan, req, res) {
    const targetUrl = new URL(plan.targetUrl);
    const requestFn = targetUrl.protocol === 'https:' ? secureRequest : request;
    await new Promise((resolve, reject) => {
      const upstream = requestFn(targetUrl, {
        method: req.method || 'GET',
        headers: normalizeOutgoingHeaders(plan.headers, targetUrl),
      }, (upstreamRes) => {
        const statusCode = upstreamRes.statusCode || 502;
        if (isRedirectStatus(statusCode)) {
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', reject);
          upstreamRes.resume();
          res.statusCode = 502;
          res.setHeader('cache-control', 'no-store');
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('DocumentServer redirect rejected.');
          return;
        }
        res.statusCode = statusCode;
        applyResponseHeaders(res, sanitizeEditorResponseHeaders(upstreamRes.headers || {}));
        upstreamRes.on('error', reject);
        upstreamRes.on('end', resolve);
        upstreamRes.pipe(res);
      });

      upstream.on('error', reject);
      upstream.end();
    });
  };
}

export function sanitizeUpgradeHandshake(bytes) {
  const boundary = bytes.indexOf('\r\n\r\n');
  if (boundary < 0) return null;
  const headerBytes = bytes.subarray(0, boundary + 4);
  if (headerBytes.length > 16 * 1024) throw new Error('OnlyOffice WebSocket response headers are too large.');
  const lines = headerBytes.toString('latin1').slice(0, -4).split('\r\n');
  if (!/^HTTP\/1\.[01] 101(?: |$)/.test(lines.shift() || '')) {
    throw new Error('OnlyOffice WebSocket upstream did not return 101.');
  }
  const allowed = new Map();
  for (const line of lines) {
    if (!line || /^[ \t]/.test(line)) throw new Error('OnlyOffice WebSocket response header is malformed.');
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('OnlyOffice WebSocket response header is malformed.');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (!/^[a-z0-9-]+$/.test(name) || /[\0\r\n]/.test(value)) {
      throw new Error('OnlyOffice WebSocket response header is malformed.');
    }
    if (['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(name)) {
      if (allowed.has(name)) throw new Error(`OnlyOffice WebSocket response repeats ${name}.`);
      allowed.set(name, value);
    }
  }
  if (!allowed.get('sec-websocket-accept')) {
    throw new Error('OnlyOffice WebSocket response is missing Sec-WebSocket-Accept.');
  }
  const output = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${allowed.get('sec-websocket-accept')}`,
  ];
  if (allowed.has('sec-websocket-protocol')) {
    output.push(`Sec-WebSocket-Protocol: ${allowed.get('sec-websocket-protocol')}`);
  }
  if (allowed.has('sec-websocket-extensions')) {
    output.push(`Sec-WebSocket-Extensions: ${allowed.get('sec-websocket-extensions')}`);
  }
  return {
    handshake: Buffer.from(`${output.join('\r\n')}\r\n\r\n`, 'latin1'),
    remainder: bytes.subarray(boundary + 4),
  };
}

function socketConnectorFor(targetUrl, { connect = net.connect, secureConnect = tls.connect } = {}) {
  const port = Number(targetUrl.port || (targetUrl.protocol === 'wss:' ? 443 : 80));
  return targetUrl.protocol === 'wss:'
    ? secureConnect({ host: targetUrl.hostname, port, servername: targetUrl.hostname })
    : connect({ host: targetUrl.hostname, port });
}

function appendHeaderLine(lines, name, value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      appendHeaderLine(lines, name, item);
    }
    return;
  }
  if (value === undefined || value === null) {
    return;
  }
  lines.push(`${name}: ${String(value)}`);
}

function buildUpgradeRequest(targetUrl, headers = {}) {
  const lines = [
    `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    appendHeaderLine(lines, name, value);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function createUpgradeForwarder({
  connect = net.connect,
  secureConnect = tls.connect,
} = {}) {
  return async function forwardUpgrade(plan, req, socket, head) {
    const targetUrl = new URL(plan.targetUrl);
    const upstream = socketConnectorFor(targetUrl, { connect, secureConnect });
    await new Promise((resolve, reject) => {
      let handshakeBytes = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => fail(new Error('OnlyOffice WebSocket upstream handshake timed out.')), 5_000);
      timer.unref?.();
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        upstream.destroy();
        socket.destroy();
        reject(error);
      }
      function onHandshakeData(chunk) {
        if (settled) return;
        handshakeBytes = Buffer.concat([handshakeBytes, Buffer.from(chunk)]);
        if (handshakeBytes.length > 16 * 1024) {
          fail(new Error('OnlyOffice WebSocket response headers are too large.'));
          return;
        }
        let sanitized;
        try {
          sanitized = sanitizeUpgradeHandshake(handshakeBytes);
        } catch (error) {
          fail(error);
          return;
        }
        if (!sanitized) return;
        settled = true;
        clearTimeout(timer);
        upstream.off('data', onHandshakeData);
        upstream.off('error', fail);
        socket.off?.('error', fail);
        upstream.on('error', () => socket.destroy());
        socket.on?.('error', () => upstream.destroy());
        socket.write(sanitized.handshake);
        if (sanitized.remainder.length) socket.write(sanitized.remainder);
        socket.pipe(upstream).pipe(socket);
        socket.resume?.();
        resolve();
      }
      upstream.once('error', fail);
      socket.once('error', fail);
      upstream.once('connect', () => {
        socket.pause?.();
        upstream.on('data', onHandshakeData);
        const requestText = buildUpgradeRequest(targetUrl, {
          ...normalizeOutgoingHeaders(plan.headers, targetUrl),
          connection: 'Upgrade',
          upgrade: 'websocket',
        });
        upstream.write(requestText);
        if (head?.length) {
          upstream.write(head);
        }
      });
    });
  };
}

function defaultDocumentServerCommand(env) {
  return env?.ONLYOFFICE_DOCUMENT_SERVER_COMMAND
    ? String(env.ONLYOFFICE_DOCUMENT_SERVER_COMMAND).trim()
    : undefined;
}

export function startDocumentServerProcess({
  env = process.env,
  spawnProcess = spawn,
  signalProcessGroup = process.kill,
  command = defaultDocumentServerCommand(env),
} = {}) {
  if (command !== undefined && !command) {
    throw new Error('OnlyOffice document server command is required.');
  }

  const args = command === undefined
    ? [fileURLToPath(new URL('../scripts/run-document-server-with-autoassembly.sh', import.meta.url))]
    : ['-lc', command];
  const child = spawnProcess('/bin/bash', args, {
    detached: true,
    env: { ...env, PLUGINS_ENABLED: 'false' },
    stdio: 'inherit',
  });

  let stopped = false;
  return {
    child,
    async stop() {
      if (stopped) {
        return;
      }
      if (child.exitCode !== null || child.signalCode) {
        stopped = true;
        return;
      }
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        throw new Error('OnlyOffice DocumentServer process group is unavailable.');
      }
      const childExit = once(child, 'exit');
      signalProcessGroup(-child.pid, 'SIGTERM');
      try {
        await childExit;
      } catch (_) {}
      stopped = true;
    },
  };
}

export async function startOnlyOfficeAgent({
  env = process.env,
  createAgentClient: createAgentClientFn = createAgentClient,
  createHttpServer = http.createServer,
  createControlRouteHandler = defaultCreateControlRouteHandler,
  createStorageRouteHandler = defaultCreateStorageRouteHandler,
  createWorkspaceStore = defaultCreateWorkspaceStore,
  createDpuStore = defaultCreateDpuStore,
  createStorageRouter = defaultCreateStorageRouter,
  createEditorProxy = defaultCreateEditorProxy,
  startDocumentServer = startDocumentServerProcess,
  drainOnlyOfficeSessions = defaultDrainOnlyOfficeSessions,
  disconnectOnlyOfficeEditors = defaultDisconnectOnlyOfficeEditors,
  now = () => Date.now(),
  assertImageContract = assertOnlyOfficeImageContract,
} = {}) {
  assertImageContract();
  const config = loadConfig(env);
  const sessionStore = createSessionStore({
    idleTtlMs: config.sessionIdleTtlMs,
    stateFile: config.sessionStateFile,
  });
  const workspaceStore = createWorkspaceStore({
    workspaceRoot: requireWorkspaceRoot(env),
  });
  const dpuStore = createDpuStore({
    createAgentClient: createAgentClientFn,
  });
  const storageRouter = createStorageRouter({
    workspaceStore,
    dpuStore,
  });
  const controlHandler = createControlRouteHandler({
    env,
    config,
    sessionStore,
    storageRouter,
  });
  const storageHandler = createStorageRouteHandler({
    config,
    sessionStore,
    storageRouter,
  });
  const editorProxy = createEditorProxy({
    targetBaseUrl: config.internalDocumentServerBaseUrl,
    forwardHttp: createHttpForwarder(),
    forwardUpgrade: createUpgradeForwarder(),
  });
  const controlServer = createHttpServer(createRequestListener(controlHandler, { parseUrl: true }));
  const storageServer = createHttpServer(createRequestListener(storageHandler));
  const editorServer = createHttpServer(createRequestListener(editorProxy.handle));
  const editorConnections = new Set();
  const editorSockets = new Set();
  editorServer.on?.('connection', (socket) => {
    editorConnections.add(socket);
    socket.once?.('close', () => editorConnections.delete(socket));
  });
  editorServer.on?.('upgrade', (req, socket, head) => {
    editorSockets.add(socket);
    socket.once?.('close', () => editorSockets.delete(socket));
    Promise.resolve(editorProxy.handleUpgrade(req, socket, head))
      .catch(() => socket.destroy());
  });

  const documentServerProcess = startDocumentServer({
    env,
  });

  try {
    await listen(controlServer, config.controlPort, '0.0.0.0');
    await listen(storageServer, config.storagePort, '127.0.0.1');
    await listen(editorServer, config.editorPort, '0.0.0.0');
  } catch (error) {
    await Promise.allSettled([
      closeServer(editorServer),
      closeServer(storageServer),
      closeServer(controlServer),
      documentServerProcess?.stop?.(),
    ]);
    throw error;
  }

  let stopped = false;
  let stopping = false;
  let editorClose;
  let controlClose;
  return {
    config,
    sessionStore,
    workspaceStore,
    dpuStore,
    storageRouter,
    controlServer,
    storageServer,
    editorServer,
    documentServerProcess,
    async stop() {
      if (stopped) {
        return;
      }
      if (stopping) {
        throw new Error('OnlyOffice drain is already in progress.');
      }
      stopping = true;
      const deadline = now() + config.drainTimeoutMs;
      // Begin closing the routed listeners immediately so no new editor or
      // control request is admitted. Do not await Node's close callbacks yet:
      // upgraded editor sockets can keep them pending, while the force-save
      // and callback acknowledgement must run with those sessions alive.
      editorClose ||= closeServer(editorServer);
      controlClose ||= closeServer(controlServer);
      // A failed drain deliberately leaves the process alive; retain handlers
      // so a later close error cannot become an unhandled rejection.
      editorClose.catch(() => {});
      controlClose.catch(() => {});
      try {
        await drainOnlyOfficeSessions({ config, sessionStore, deadline, now });
        await disconnectOnlyOfficeEditors({ editorSockets, deadline, now });
        sessionStore.acknowledgeDrainedEditors();
        // Graceful delivery has closed every upgraded editor. Retire residual
        // HTTP connections so incomplete requests cannot block listener close.
        for (const socket of editorConnections) {
          if (!socket.destroyed) socket.destroy();
        }
        await Promise.all([
          editorClose,
          controlClose,
          closeServer(storageServer),
          documentServerProcess?.stop?.(),
        ]);
        stopped = true;
      } finally {
        stopping = false;
      }
    },
  };
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch (_) {
    return false;
  }
})();

if (isDirectRun) {
  const runtime = await startOnlyOfficeAgent();
  const stopAndExit = async () => {
    try {
      await runtime.stop();
      process.exit(0);
    } catch (error) {
      console.error('[onlyoffice] drain failed; storage and DocumentServer remain active', error);
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', stopAndExit);
  process.on('SIGTERM', stopAndExit);
  await new Promise(() => {});
}

export default {
  startOnlyOfficeAgent,
};
