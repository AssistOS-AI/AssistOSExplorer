import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import { signHmacJwt } from '../../../ploinky/Agent/lib/jwtSign.mjs';
import { computeRchHttp } from '../../../ploinky/Agent/lib/requestHash.mjs';
import { createControlRouteHandler } from '../src/routes/control.mjs';
import { createDpuStore } from '../src/storage/dpu-store.mjs';

const AGENT_ID = 'agent:AssistOSExplorer/onlyOffice';
const AGENT_SECRET = crypto.randomBytes(32);
const AGENT_SECRET_HEX = AGENT_SECRET.toString('hex');
const EMPTY_BODY_HASH = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64url');
const INVOCATION_AUTH_MODULE = new URL('../../../ploinky/Agent/lib/invocationAuth.mjs', import.meta.url).href;

class MockWritableResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.body = '';
    this.done = new Promise((resolve) => this.on('finish', resolve));
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers || {})) {
      this.setHeader(name, value);
    }
  }

  _write(chunk, _encoding, callback) {
    this.body += chunk ? Buffer.from(chunk).toString('utf8') : '';
    callback();
  }
}

function makeEnv() {
  return {
    PLOINKY_AGENT_ID: AGENT_ID,
    PLOINKY_AGENT_SECRET: AGENT_SECRET_HEX,
    ONLYOFFICE_JWT_SECRET: 'onlyoffice-jwt-secret',
    ONLYOFFICE_STORAGE_PORT: '9100',
    ONLYOFFICE_CONTROL_PORT: '7000',
    ONLYOFFICE_EDITOR_PORT: '8080',
    ONLYOFFICE_INVOCATION_AUTH_MODULE: INVOCATION_AUTH_MODULE,
  };
}

function createTestControlRouteHandler(options = {}) {
  return createControlRouteHandler({
    resolveEditorService: async () => ({
      activeBrowserUrl: 'https://office.example.com/base-agent-additional-server/onlyOffice/8080',
    }),
    ...options,
  });
}

function mintAuthHeaders({
  method = 'GET',
  internalPath = '/control/office/session',
  externalPath = '/base-agent-additional-server/onlyOffice/7000/control/office/session',
  query = '?path=%2Fworkspace%2Freport.docx',
  delegations = {},
  user = {
    id: 'local:alice',
    username: 'alice',
    roles: ['user'],
  },
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = signHmacJwt({
    payload: {
      typ: 'router-request',
      iss: 'ploinky-router',
      aud: AGENT_ID,
      sub: `user:${user.id}`,
      actor: {
        kind: 'user',
        id: `user:${user.id}`,
        roles: user.roles,
      },
      method,
      path: internalPath,
      tool: '__http_route__',
      rch: computeRchHttp({
        method,
        path: internalPath,
        query,
        bodyHash: EMPTY_BODY_HASH,
      }),
      jti: crypto.randomBytes(12).toString('base64url'),
      iat: now,
      exp: now + 30,
    },
    secret: AGENT_SECRET,
  });

  return {
    'x-ploinky-auth-info': JSON.stringify({
      user,
      delegations,
      invocationToken: token,
      invocationBody: {
        method,
        externalPath,
        path: internalPath,
        search: query,
        routeKey: 'onlyOffice',
        bodyHash: EMPTY_BODY_HASH,
      },
    }),
  };
}

function makeRequest({ url, headers = {} }) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function verifySignedConfigToken(token, secret) {
  const [encodedHeader, encodedPayload, signature] = String(token || '').split('.');
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  assert.equal(signature, expected);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
    { alg: 'HS256', typ: 'JWT' },
  );
  return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
}

function countNamedFields(value, fieldName) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + countNamedFields(entry, fieldName), 0);
  }
  return Object.entries(value).reduce(
    (total, [name, entry]) => total + (name === fieldName ? 1 : 0) + countNamedFields(entry, fieldName),
    0,
  );
}

test('office session route rejects forged auth-info without invocation token', async () => {
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2Fworkspace%2Freport.docx',
    headers: {
      'x-ploinky-auth-info': JSON.stringify({
        user: { id: 'local:alice', username: 'alice', roles: ['user'] },
      }),
    },
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 401);
});

test('office session route rejects auth-info when invocation path does not match', async () => {
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2Fworkspace%2Freport.docx',
    headers: mintAuthHeaders({
      internalPath: '/control/other/session',
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 401);
});

test('office session route requires dpuConfidential delegation for Confidential paths', async () => {
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2FConfidential%2FMy%20Space%2Freport.docx',
    headers: mintAuthHeaders({
      query: '?path=%2FConfidential%2FMy%20Space%2Freport.docx',
      delegations: {},
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 403);
});

test('office session route builds signed config with loopback document and callback urls', async () => {
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2FConfidential%2FMy%20Space%2Freport.docx',
    headers: mintAuthHeaders({
      query: '?path=%2FConfidential%2FMy%20Space%2Freport.docx',
      delegations: {
        dpuConfidential: {
          token: 'delegation-token-value',
          expiresAt: '2026-06-09T12:30:00.000Z',
        },
      },
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.sessionId, 'string');
  assert.match(payload.config.document.key, /^[0-9a-f]{32}$/);
  assert.match(payload.config.document.url, /^http:\/\/127\.0\.0\.1:9100\/internal\/document\//);
  assert.match(payload.config.editorConfig.callbackUrl, /^http:\/\/127\.0\.0\.1:9100\/internal\/callback\//);
  assert.equal(payload.config.documentServerUrl, 'https://office.example.com/base-agent-additional-server/onlyOffice/8080');
  assert.deepEqual(payload.config.editorConfig.customization, {
    autosave: true,
    forcesave: true,
    plugins: false,
  });
  assert.equal(countNamedFields(payload.config, 'token'), 1);
  assert.equal(typeof payload.config.token, 'string');
  assert.equal(payload.config.token.split('.').length, 3);

  const signedPayload = verifySignedConfigToken(payload.config.token, 'onlyoffice-jwt-secret');
  assert.equal(signedPayload.document.key, payload.config.document.key);
  assert.equal(signedPayload.document.url, payload.config.document.url);
  assert.equal(signedPayload.editorConfig.callbackUrl, payload.config.editorConfig.callbackUrl);
  assert.deepEqual(signedPayload.editorConfig.customization, payload.config.editorConfig.customization);
});

test('office session route resolves storage metadata before signing config', async () => {
  let capturedSession = null;
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
    storageRouter: {
      forSession(session) {
        capturedSession = session;
        return {
          async metadata() {
            return {
              storageKind: 'dpu',
              requestedPath: session.requestedPath,
              path: session.path,
              storageId: 'confidential:file-1',
              objectId: 'file-1',
              fileName: 'report.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              canWrite: false,
              canComment: true,
              versionKey: 'dpu-v1',
            };
          },
        };
      },
    },
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2FConfidential%2FMy%20Space%2Freport.docx',
    headers: mintAuthHeaders({
      query: '?path=%2FConfidential%2FMy%20Space%2Freport.docx',
      delegations: {
        dpuConfidential: {
          token: 'delegation-token-value',
          expiresAt: '2026-06-09T12:30:00.000Z',
        },
      },
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(capturedSession.requestedPath, '/Confidential/My Space/report.docx');
  assert.equal(capturedSession.storageKind, 'dpu');
  assert.equal(capturedSession.delegations.dpuConfidential.token, 'delegation-token-value');

  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.preview, {
    storageKind: 'dpu',
    requestedPath: '/Confidential/My Space/report.docx',
    objectId: 'file-1',
    canWrite: false,
    canComment: true,
  });
	  assert.equal(payload.config.document.permissions.edit, false);
	  assert.equal(payload.config.document.permissions.comment, true);
	  assert.deepEqual(payload.config.editorConfig.customization, {
	    autosave: true,
	    forcesave: false,
	    plugins: false,
	  });

	  const signedPayload = verifySignedConfigToken(payload.config.token, 'onlyoffice-jwt-secret');
	  assert.equal(signedPayload.document.permissions.edit, false);
	  assert.equal(signedPayload.document.permissions.comment, true);
});

test('confidential control reauthorizes matching loaded sessions before minting a fresh session', async () => {
  const events = [];
  let reauthorizationInput = null;
  let creationInput = null;
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
    sessionStore: {
      reauthorizeLoadedSessions(input) {
        events.push('reauthorize');
        reauthorizationInput = input;
        return 1;
      },
      createSession(input) {
        events.push('create');
        creationInput = input;
        return {
          ...input,
          token: 'fresh-session-token',
          documentKey: 'd'.repeat(32),
          publicSummary: () => ({}),
        };
      },
    },
    resolveSessionDescriptor: async () => ({
      requestedPath: '/Confidential/report.docx',
      path: '/Confidential/report.docx',
      storageKind: 'dpu',
      storageId: '/Confidential/report.docx',
      objectId: 'object-1',
      fileName: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      canWrite: true,
      canComment: false,
      versionKey: 'v2',
    }),
  });
  const query = '?path=%2FConfidential%2Freport.docx';
  const req = makeRequest({
    url: `/control/office/session${query}`,
    headers: mintAuthHeaders({
      query,
      delegations: {
        dpuConfidential: {
          token: 'fresh-generation-delegation',
          expiresAt: '2026-09-01T12:30:00.000Z',
        },
      },
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(events, ['reauthorize', 'create']);
  assert.equal(reauthorizationInput, creationInput);
  assert.equal(reauthorizationInput.objectId, 'object-1');
  assert.equal(reauthorizationInput.authUser.id, 'local:alice');
  assert.equal(reauthorizationInput.delegations.dpuConfidential.token, 'fresh-generation-delegation');
  assert.equal(
    reauthorizationInput.activeBrowserUrl,
    'https://office.example.com/base-agent-additional-server/onlyOffice/8080',
  );
});

test('workspace session is created WITHOUT a DPU delegation token', async () => {
  const captured = {};
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
    sessionStore: {
      createSession(input) {
        captured.input = input;
        return {
          ...input,
          token: 'sess-token',
          documentKey: 'd'.repeat(32),
          publicSummary: () => ({}),
        };
      },
    },
    resolveSessionDescriptor: async () => ({
      requestedPath: '/workspace/report.docx', path: '/workspace/report.docx', storageKind: 'workspace',
      storageId: 'workspace/report.docx', fileName: 'report.docx', canWrite: true, canComment: true, versionKey: 'v',
      preview: { storageKind: 'workspace', requestedPath: '/workspace/report.docx', canWrite: true, canComment: true },
    }),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2Fworkspace%2Freport.docx',
    headers: mintAuthHeaders({
      delegations: { dpuConfidential: { token: 'grant', expiresAt: '2026-01-01T00:30:00.000Z' } },
    }),
  });
  const res = new MockWritableResponse();
  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;
  assert.equal(res.statusCode, 200);
  assert.deepEqual(captured.input.delegations, {});
  assert.equal(
    captured.input.activeBrowserUrl,
    'https://office.example.com/base-agent-additional-server/onlyOffice/8080',
  );
});

test('office session route validates and binds editor authority before creating a session', async () => {
  for (const activeBrowserUrl of [
    'https://office.example.com/base-agent-additional-server/onlyOffice/8080/',
    'https://evil.example/other',
    'https://user@office.example.com/base-agent-additional-server/onlyOffice/8080',
  ]) {
    let createCalls = 0;
    const handler = createTestControlRouteHandler({
      env: makeEnv(),
      resolveEditorService: async () => ({ activeBrowserUrl }),
      sessionStore: {
        createSession() {
          createCalls += 1;
          throw new Error('must not create a session');
        },
      },
      resolveSessionDescriptor: async () => ({
        requestedPath: '/workspace/report.docx',
        path: '/workspace/report.docx',
        storageKind: 'workspace',
        storageId: 'workspace/report.docx',
        fileName: 'report.docx',
        canWrite: true,
        canComment: true,
        versionKey: 'v1',
      }),
    });
    const req = makeRequest({
      url: '/control/office/session?path=%2Fworkspace%2Freport.docx',
      headers: mintAuthHeaders(),
    });
    const res = new MockWritableResponse();

    await assert.rejects(
      () => handler(req, res, new URL(req.url, 'http://localhost')),
      /browser URL|committed Router route/i,
      activeBrowserUrl,
    );
    assert.equal(createCalls, 0, activeBrowserUrl);
  }
});

test('office session route does not return delegation tokens to the browser', async () => {
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
  });
  const req = makeRequest({
    url: '/control/office/session?path=%2FConfidential%2FMy%20Space%2Freport.docx',
    headers: mintAuthHeaders({
      query: '?path=%2FConfidential%2FMy%20Space%2Freport.docx',
      delegations: {
        dpuConfidential: {
          token: 'delegation-token-value',
          expiresAt: '2026-06-09T12:30:00.000Z',
        },
      },
    }),
  });
  const res = new MockWritableResponse();

  assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
  await res.done;

  assert.equal(res.statusCode, 200, res.body);
  const payload = JSON.parse(res.body);
  const signedPayload = verifySignedConfigToken(payload.config.token, 'onlyoffice-jwt-secret');

  assert.equal(JSON.stringify(payload).includes('delegation-token-value'), false);
  assert.equal(payload.delegations, undefined);
  assert.equal(payload.config.delegations, undefined);
  assert.equal(JSON.stringify(signedPayload).includes('delegation-token-value'), false);
});

for (const scenario of [
  { name: 'missing Confidential path', expectedStatus: 404, expectedError: 'document_not_found', objectId: null },
  { name: 'Confidential object without read access', expectedStatus: 403, expectedError: 'document_forbidden', objectId: 'private-id' },
]) {
  test(`office session route rejects ${scenario.name} without creating an editor`, async () => {
    let closed = false;
    const store = createDpuStore({
      createAgentClient: async () => ({
        async callTool(name) {
          if (name === 'dpu_workspace_roots') return { roots: { mySpace: { id: 'my-root' } } };
          if (name === 'dpu_confidential_list') return { items: scenario.objectId ? [{ id: scenario.objectId, name: 'secret.docx' }] : [] };
          if (name === 'dpu_confidential_get') return { object: { id: scenario.objectId, contentVisible: false } };
          assert.fail(`Unexpected tool: ${name}`);
        },
        async close() { closed = true; },
      }),
    });
    const handler = createTestControlRouteHandler({
      env: makeEnv(),
      storageRouter: { forSession: (session) => ({ metadata: () => store.metadata(session) }) },
      sessionStore: { createSession() { assert.fail('Denied document must not create a session.'); } },
      resolveEditorService() { assert.fail('Denied document must not resolve an editor.'); },
    });
    const query = '?path=%2FConfidential%2FMy%20Space%2Fsecret.docx';
    const req = makeRequest({
      url: '/control/office/session' + query,
      headers: mintAuthHeaders({ query, delegations: { dpuConfidential: { token: 'private-delegation', expiresAt: '2999-01-01T00:00:00.000Z' } } }),
    });
    const res = new MockWritableResponse();
    assert.equal(await handler(req, res, new URL(req.url, 'http://localhost')), true);
    await res.done;
    assert.equal(res.statusCode, scenario.expectedStatus);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: scenario.expectedError });
    assert.equal(closed, true);
  });
}

test('office session route preserves unexpected storage failures', async () => {
  const failure = new Error('storage transport unavailable');
  const handler = createTestControlRouteHandler({
    env: makeEnv(),
    resolveSessionDescriptor: async () => { throw failure; },
  });
  const req = makeRequest({ url: '/control/office/session?path=%2Fworkspace%2Freport.docx', headers: mintAuthHeaders() });
  const res = new MockWritableResponse();
  await assert.rejects(() => handler(req, res, new URL(req.url, 'http://localhost')), (error) => error === failure);
  assert.equal(res.body, '');
});
