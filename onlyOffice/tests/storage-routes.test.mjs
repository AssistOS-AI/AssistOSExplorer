import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  _test as storageRouteTest,
  createStorageRouteHandler as createStorageRouteHandlerRaw
} from '../src/routes/storage.mjs';
import { buildDocumentKey } from '../src/onlyoffice-config.mjs';

const CALLBACK_SECRET = 'onlyoffice-callback-test-secret';
const DEFAULT_SESSION_IDENTITY = Object.freeze({
  storageKind: 'workspace',
  storageId: '/workspace/report.docx',
  versionKey: 'report-v1',
  fileName: 'report.docx',
  documentKey: 'a'.repeat(32),
  activeBrowserUrl: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080',
});
const DEFAULT_DOCUMENT_KEY = buildDocumentKey(DEFAULT_SESSION_IDENTITY);

test('editor activity is recorded only after callback signature, envelope and document-key validation', async () => {
  const events = [];
  const handler = createStorageRouteHandler({
    sessionStore: {
      getForStorageRequest() { return DEFAULT_SESSION_IDENTITY; },
      updateEditorStatus(...args) { events.push(args); },
    },
    storageRouter: { forSession: () => ({}) },
    fetchImpl: async () => { throw new Error('Activity callbacks must not download or write a document.'); },
  });
  for (const status of [1, 4]) {
    const res = createMockResponse();
    await handler(createMockRequest({
      method: 'POST', url: '/internal/callback/session-token',
      headers: { 'content-type': 'application/json' },
      body: signCallbackPayload({ status }),
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(events.at(-1), ['session-token', status]);
  }
  for (const body of [
    signCallbackPayload({ status: 4, key: 'b'.repeat(32) }),
    signCallbackPayload({ status: 1 }, undefined, { mutateEnvelope: envelope => { envelope.status = 4; } }),
    JSON.stringify({ key: DEFAULT_DOCUMENT_KEY, status: 4, token: 'invalid' }),
  ]) {
    const res = createMockResponse();
    await handler(createMockRequest({
      method: 'POST', url: '/internal/callback/session-token',
      headers: { 'content-type': 'application/json' }, body,
    }), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(events.length, 2);
});

function signCallbackPayload(
  payload,
  nowSeconds = Math.floor(Date.now() / 1000),
  {
    temporal = {
      iat: nowSeconds,
      nbf: nowSeconds - 1,
      exp: nowSeconds + 60,
    },
    signedClaims = {},
    mutateEnvelope = null,
    mutateToken = null,
  } = {},
) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadClaims = {
    key: DEFAULT_DOCUMENT_KEY,
    ...payload,
    ...temporal,
    ...signedClaims,
  };
  const claims = Buffer.from(JSON.stringify(payloadClaims)).toString('base64url');
  const signature = crypto.createHmac('sha256', CALLBACK_SECRET)
    .update(`${header}.${claims}`)
    .digest('base64url');
  let token = `${header}.${claims}.${signature}`;
  if (typeof mutateToken === 'function') {
    token = mutateToken(token);
  }
  const envelope = Object.fromEntries(Object.entries(payloadClaims).filter(([key]) => (
    key !== 'iat' && key !== 'nbf' && key !== 'exp' && key !== 'token'
  )));
  if (typeof mutateEnvelope === 'function') {
    mutateEnvelope(envelope);
  }
  envelope.token = token;
  return JSON.stringify(envelope);
}

function createStorageRouteHandler(options = {}) {
  return createStorageRouteHandlerRaw({
    ...options,
    config: {
      onlyofficeJwtSecret: CALLBACK_SECRET,
      ...options.config,
    },
  });
}

function createMockRequest({
  method = 'GET',
  url = '/',
  headers = {},
  body = '',
  remoteAddress = '127.0.0.1'
} = {}) {
  const request = Readable.from(body ? [body] : []);
  request.method = method;
  request.url = url;
  request.headers = headers;
  request.socket = { remoteAddress };
  return request;
}

function createMockResponse() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 200,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    writeHead(statusCode, nextHeaders = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(nextHeaders)) {
        this.setHeader(name, value);
      }
    },
    write(chunk) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk);
      }
      this.finished = true;
    },
    get bodyBuffer() {
      return Buffer.concat(chunks);
    },
    get bodyText() {
      return this.bodyBuffer.toString('utf8');
    }
  };
}

function createSessionStore(session, { onAcknowledge = null, onResolve = null } = {}) {
  const boundSession = {
    ...DEFAULT_SESSION_IDENTITY,
    ...session,
  };
  return {
    getForStorageRequest(token, options) {
      if (token !== 'token-1') {
        throw new Error('Unknown or expired OnlyOffice session token.');
      }
      onResolve?.(options);
      return boundSession;
    },
    acknowledgeCallback(token, acknowledgement) {
      onAcknowledge?.(token, acknowledgement);
    }
  };
}

function createDownloadResponse(body = 'saved from callback', contentType = 'application/octet-stream') {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async arrayBuffer() {
      return Buffer.from(body);
    },
  };
}

test('document route streams bytes for a valid unexpired token', async () => {
  const writes = [];
  const resolutions = [];
  const handler = createStorageRouteHandler({
    config: {},
    sessionStore: createSessionStore(
      {
        requestedPath: '/workspace/report.docx',
        mimeType: 'text/plain'
      },
      { onResolve: (options) => resolutions.push(options) },
    ),
    storageRouter: {
      forSession(session) {
        return {
          async metadata() {
            return session;
          },
          async read() {
            return {
              buffer: Buffer.from('document body'),
              mimeType: 'text/plain',
              fileName: 'report.docx'
            };
          },
          async write(buffer) {
            writes.push(buffer);
          }
        };
      }
    }
  });

  const req = createMockRequest({
    method: 'GET',
    url: '/internal/document/token-1'
  });
  const res = createMockResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('content-type'), 'text/plain');
  assert.equal(res.bodyText, 'document body');
  assert.equal(writes.length, 0);
  assert.deepEqual(resolutions, [{ markDocumentAccess: true }]);
});

test('document route rejects expired and unknown tokens', async () => {
  const handler = createStorageRouteHandler({
    config: {},
    sessionStore: {
      getForStorageRequest() {
        throw new Error('Unknown or expired OnlyOffice session token.');
      }
    },
    storageRouter: {
      forSession() {
        throw new Error('should not be called');
      }
    }
  });

  const expiredReq = createMockRequest({
    method: 'GET',
    url: '/internal/document/token-1'
  });
  const expiredRes = createMockResponse();
  await handler(expiredReq, expiredRes);

  const unknownReq = createMockRequest({
    method: 'GET',
    url: '/internal/document/token-2'
  });
  const unknownRes = createMockResponse();
  await handler(unknownReq, unknownRes);

  assert.equal(expiredRes.statusCode, 404);
  assert.equal(unknownRes.statusCode, 404);
});

test('callback route accepts status 1/4 and persists and acknowledges only status 2/6 save events', async () => {
  const fetchUrls = [];
  const savedBodies = [];
  const acknowledgements = [];
  const handler = createStorageRouteHandler({
    config: {
      publicEditorBaseUrl: 'http://public-onlyoffice:8080',
      internalDocumentServerBaseUrl: 'http://127.0.0.1:80'
    },
    sessionStore: createSessionStore(
      {
        requestedPath: '/workspace/report.docx',
        mimeType: 'text/plain',
        canWrite: true
      },
      {
        onAcknowledge(token, acknowledgement) {
          acknowledgements.push({ token, acknowledgement });
        }
      }
    ),
    storageRouter: {
      forSession() {
        return {
          async metadata() {
            return {};
          },
          async read() {
            return {
              buffer: Buffer.alloc(0)
            };
          },
          async write(buffer) {
            savedBodies.push(buffer.toString('utf8'));
          }
        };
      }
    },
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return createDownloadResponse();
    }
  });

  for (const status of [1, 4, 2, 6]) {
    const callbackPayload = status === 2 || status === 6
      ? {
          status,
          url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx'
        }
      : {
          actions: [{ type: 1, userid: `user-${status}` }],
          status
        };
    const signedAt = Math.floor(Date.now() / 1000);
    const bodyOptions = status === 1
      ? {
          mutateEnvelope(envelope) {
            const key = envelope.key;
            delete envelope.key;
            envelope.key = key;
          }
        }
      : status === 4
        ? {
            temporal: {
              iat: signedAt,
              exp: signedAt + 60
            }
          }
      : {};
    const req = createMockRequest({
      method: 'POST',
      url: '/internal/callback/token-1',
      headers: {
        'content-type': 'application/json'
      },
      body: signCallbackPayload(callbackPayload, signedAt, bodyOptions)
    });
    const res = createMockResponse();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyText, '{"error":0}');
  }

  assert.deepEqual(fetchUrls, [
    'http://127.0.0.1/cache/files/report.docx',
    'http://127.0.0.1/cache/files/report.docx'
  ]);
  assert.deepEqual(savedBodies, [
    'saved from callback',
    'saved from callback'
  ]);
  assert.deepEqual(
    acknowledgements.map(({ token, acknowledgement }) => ({
      token,
      status: acknowledgement.status,
      version: acknowledgement.version
    })),
    [
      { token: 'token-1', status: 2, version: DEFAULT_DOCUMENT_KEY },
      { token: 'token-1', status: 6, version: DEFAULT_DOCUMENT_KEY }
    ]
  );
});

test('callback route rejects any unsigned/signed structural difference before fetch, write, or acknowledgement', async (t) => {
  const nowSeconds = 2_000_000_000;
  const basePayload = {
    actions: [
      {
        type: 1,
        userid: 'user-1',
        metadata: {
          active: true,
          labels: ['first', 'second'],
          optional: null
        }
      }
    ],
    status: 2,
    url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx'
  };
  const invalidBodies = [
    {
      name: 'tampered nested value',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          envelope.actions[0].metadata.labels[1] = 'tampered';
        }
      })
    },
    {
      name: 'extra outer field',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          envelope.extra = true;
        }
      })
    },
    {
      name: 'missing outer field',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          delete envelope.actions;
        }
      })
    },
    {
      name: 'signed-only non-temporal field',
      body: signCallbackPayload(basePayload, nowSeconds, {
        signedClaims: {
          signedOnly: {
            allowed: false
          }
        },
        mutateEnvelope(envelope) {
          delete envelope.signedOnly;
        }
      })
    },
    {
      name: 'type mismatch',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          envelope.status = '2';
        }
      })
    },
    {
      name: 'array order mismatch',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          envelope.actions[0].metadata.labels.reverse();
        }
      })
    },
    {
      name: 'envelope temporal field',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateEnvelope(envelope) {
          envelope.iat = nowSeconds;
        }
      })
    },
    {
      name: 'signed token claim',
      body: signCallbackPayload(basePayload, nowSeconds, {
        signedClaims: {
          token: 'signed-non-temporal-token-claim'
        }
      })
    },
    {
      name: 'malformed token',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateToken() {
          return 'not-a-jwt';
        }
      })
    },
    {
      name: 'invalid signature',
      body: signCallbackPayload(basePayload, nowSeconds, {
        mutateToken(token) {
          const [header, claims, signature] = token.split('.');
          const replacement = signature[0] === 'A' ? 'B' : 'A';
          return `${header}.${claims}.${replacement}${signature.slice(1)}`;
        }
      })
    },
    {
      name: 'expired temporal claims',
      body: signCallbackPayload(basePayload, nowSeconds, {
        temporal: {
          iat: nowSeconds - 120,
          nbf: nowSeconds - 120,
          exp: nowSeconds - 10
        }
      })
    },
    {
      name: 'future temporal claims',
      body: signCallbackPayload(basePayload, nowSeconds, {
        temporal: {
          iat: nowSeconds + 30,
          nbf: nowSeconds + 30,
          exp: nowSeconds + 60
        }
      })
    },
    {
      name: 'non-numeric temporal claims',
      body: signCallbackPayload(basePayload, nowSeconds, {
        temporal: {
          iat: String(nowSeconds),
          nbf: nowSeconds - 1,
          exp: nowSeconds + 60
        }
      })
    },
    {
      name: 'invalid JSON',
      body: '{"token":'
    },
    {
      name: 'missing own token',
      body: JSON.stringify({
        key: DEFAULT_DOCUMENT_KEY,
        status: 2
      })
    },
    {
      name: 'non-string token',
      body: JSON.stringify({
        key: DEFAULT_DOCUMENT_KEY,
        status: 2,
        token: 42
      })
    },
    {
      name: 'non-object envelope',
      body: JSON.stringify(['not', 'an', 'object'])
    }
  ];

  for (const invalid of invalidBodies) {
    await t.test(invalid.name, async () => {
      let fetchCalls = 0;
      let writes = 0;
      let acknowledgements = 0;
      const handler = createStorageRouteHandler({
        config: {
          internalDocumentServerBaseUrl: 'http://127.0.0.1:80'
        },
        now: () => nowSeconds * 1000,
        sessionStore: createSessionStore(
          {
            requestedPath: '/workspace/report.docx',
            mimeType: 'text/plain',
            canWrite: true
          },
          {
            onAcknowledge() {
              acknowledgements += 1;
            }
          }
        ),
        storageRouter: {
          forSession() {
            return {
              async write() {
                writes += 1;
              }
            };
          }
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return createDownloadResponse();
        }
      });
      const req = createMockRequest({
        method: 'POST',
        url: '/internal/callback/token-1',
        headers: {
          'content-type': 'application/json'
        },
        body: invalid.body
      });
      const res = createMockResponse();

      await handler(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.bodyText, '{"error":1}');
      assert.equal(fetchCalls, 0);
      assert.equal(writes, 0);
      assert.equal(acknowledgements, 0);
    });
  }
});

test('callback exact-value verification rejects non-finite and non-JSON values', () => {
  const verifiedPayload = {
    key: DEFAULT_DOCUMENT_KEY,
    status: 2,
    iat: 2_000_000_000,
    exp: 2_000_000_060
  };
  assert.throws(
    () => storageRouteTest.assertCallbackEnvelopeMatchesVerifiedPayload(
      {
        key: DEFAULT_DOCUMENT_KEY,
        status: Number.POSITIVE_INFINITY,
        token: 'verified-separately'
      },
      verifiedPayload
    ),
    /non-finite/
  );
  assert.throws(
    () => storageRouteTest.assertCallbackEnvelopeMatchesVerifiedPayload(
      {
        key: DEFAULT_DOCUMENT_KEY,
        status: 2,
        nested: new Date(0),
        token: 'verified-separately'
      },
      {
        ...verifiedPayload,
        nested: {}
      }
    ),
    /non-JSON/
  );
});

test('callback route uses only session-bound authority, strips one prefix, and preserves direct internal cache urls', async () => {
  const fetchUrls = [];
  const handler = createStorageRouteHandler({
    config: {
      internalDocumentServerBaseUrl: 'http://127.0.0.1:80'
    },
    sessionStore: createSessionStore({
      requestedPath: '/workspace/report.docx',
      mimeType: 'text/plain',
      canWrite: true
    }),
    storageRouter: {
      forSession() {
        return {
          async metadata() {
            return {};
          },
          async read() {
            return {
              buffer: Buffer.alloc(0)
            };
          },
          async write() {}
        };
      }
    },
    fetchImpl: async (url) => {
      fetchUrls.push(url);
      return createDownloadResponse();
    },
    resolveEditorService: async () => {
      throw new Error('callback authority must not be re-resolved');
    },
  });

  for (const downloadUrl of [
    'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx?download=1',
    'http://127.0.0.1/cache/files/direct.docx?download=2',
  ]) {
    const req = createMockRequest({
      method: 'POST',
      url: '/internal/callback/token-1',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      },
      body: signCallbackPayload({
        status: 2,
        url: downloadUrl,
      })
    });
    const res = createMockResponse();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  }

  assert.deepEqual(fetchUrls, [
    'http://127.0.0.1/cache/files/report.docx?download=1',
    'http://127.0.0.1/cache/files/direct.docx?download=2',
  ]);
});

test('callback route rejects missing, malformed, or conflicting stored authority before side effects', async (t) => {
  for (const [name, activeBrowserUrl] of [
    ['missing', undefined],
    ['malformed', 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/'],
    ['conflicting origin', 'https://other.example/base-agent-additional-server/onlyOffice/8080'],
    ['conflicting prefix', 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8081'],
  ]) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      let writes = 0;
      let acknowledgements = 0;
      const handler = createStorageRouteHandler({
        config: {
          internalDocumentServerBaseUrl: 'http://127.0.0.1:80',
        },
        sessionStore: createSessionStore(
          {
            requestedPath: '/workspace/report.docx',
            mimeType: 'text/plain',
            canWrite: true,
            activeBrowserUrl,
          },
          {
            onAcknowledge() {
              acknowledgements += 1;
            },
          },
        ),
        storageRouter: {
          forSession() {
            return {
              async write() {
                writes += 1;
              },
            };
          },
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return createDownloadResponse();
        },
      });
      const req = createMockRequest({
        method: 'POST',
        url: '/internal/callback/token-1',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-host': 'public-onlyoffice:8080',
          'x-forwarded-proto': 'http',
        },
        body: signCallbackPayload({
          status: 6,
          url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx',
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      assert.equal(res.statusCode, 400, name);
      assert.equal(fetchCalls, 0, name);
      assert.equal(writes, 0, name);
      assert.equal(acknowledgements, 0, name);
    });
  }
});

test('callback route rejects ambiguous or unconfined cache paths before fetch, write, or acknowledgement', async (t) => {
  const routePrefix = '/base-agent-additional-server/onlyOffice/8080';
  const publicOrigin = 'http://public-onlyoffice:8080';
  const invalidUrls = [
    ['missing public prefix', `${publicOrigin}/cache/files/report.docx`],
    ['duplicate public prefix', `${publicOrigin}${routePrefix}${routePrefix}/cache/files/report.docx`],
    ['partial public prefix', `${publicOrigin}/base-agent-additional-server/onlyOffice/808/cache/files/report.docx`],
    ['lookalike public prefix', `${publicOrigin}${routePrefix}.evil/cache/files/report.docx`],
    ['unexpected agent', `${publicOrigin}/base-agent-additional-server/notOnlyOffice/8080/cache/files/report.docx`],
    ['unexpected port', `${publicOrigin}/base-agent-additional-server/onlyOffice/8081/cache/files/report.docx`],
    ['extra path prefix', `${publicOrigin}/extra${routePrefix}/cache/files/report.docx`],
    ['missing suffix', `${publicOrigin}${routePrefix}/cache/files/`],
    ['empty suffix segment', `${publicOrigin}${routePrefix}/cache/files/data//report.docx`],
    ['raw parent segment', `${publicOrigin}${routePrefix}/cache/files/data/../report.docx`],
    ['raw current segment', `${publicOrigin}${routePrefix}/cache/files/data/./report.docx`],
    ['encoded parent segment', `${publicOrigin}${routePrefix}/cache/files/data/%2e%2e/report.docx`],
    ['double-encoded parent segment', `${publicOrigin}${routePrefix}/cache/files/data/%252e%252e/report.docx`],
    ['encoded slash', `${publicOrigin}${routePrefix}/cache/files/data%2freport.docx`],
    ['double-encoded slash', `${publicOrigin}${routePrefix}/cache/files/data%252freport.docx`],
    ['encoded backslash', `${publicOrigin}${routePrefix}/cache/files/data%5creport.docx`],
    ['encoded query separator', `${publicOrigin}${routePrefix}/cache/files/report%3fdownload.docx`],
    ['encoded fragment separator', `${publicOrigin}${routePrefix}/cache/files/report%23fragment.docx`],
    ['malformed encoding', `${publicOrigin}${routePrefix}/cache/files/report%2.docx`],
    ['literal backslash', `${publicOrigin}${routePrefix}/cache/files/data\\report.docx`],
    ['surrounding whitespace', ` ${publicOrigin}${routePrefix}/cache/files/report.docx`],
  ];

  for (const [name, downloadUrl] of invalidUrls) {
    await t.test(name, async () => {
      let fetchCalls = 0;
      let writes = 0;
      let acknowledgements = 0;
      const handler = createStorageRouteHandler({
        config: {
          internalDocumentServerBaseUrl: 'http://127.0.0.1:80',
        },
        sessionStore: createSessionStore(
          {
            requestedPath: '/workspace/report.docx',
            mimeType: 'text/plain',
            canWrite: true,
          },
          {
            onAcknowledge() {
              acknowledgements += 1;
            },
          }
        ),
        storageRouter: {
          forSession() {
            return {
              async write() {
                writes += 1;
              },
            };
          },
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return createDownloadResponse();
        },
      });
      const req = createMockRequest({
        method: 'POST',
        url: '/internal/callback/token-1',
        headers: { 'content-type': 'application/json' },
        body: signCallbackPayload({
          status: 6,
          url: downloadUrl,
        }),
      });
      const res = createMockResponse();

      await handler(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.bodyText, '{"error":1}');
      assert.equal(fetchCalls, 0);
      assert.equal(writes, 0);
      assert.equal(acknowledgements, 0);
    });
  }
});

test('callback route rejects an outbox JWT from another session for the same document before fetch or write', async () => {
  let fetchCalled = false;
  let writeCalled = false;
  const targetSession = {
    ...DEFAULT_SESSION_IDENTITY,
    documentKey: 'b'.repeat(32),
    canWrite: true,
  };
  const handler = createStorageRouteHandler({
    config: { internalDocumentServerBaseUrl: 'http://127.0.0.1:80' },
    sessionStore: createSessionStore(targetSession),
    storageRouter: {
      forSession() {
        return {
          async write() {
            writeCalled = true;
          },
        };
      },
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return createDownloadResponse();
    },
  });
  const req = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    headers: { 'content-type': 'application/json' },
    body: signCallbackPayload({
      key: DEFAULT_DOCUMENT_KEY,
      status: 2,
      url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx',
    }),
  });
  const res = createMockResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.bodyText, '{"error":1}');
  assert.equal(fetchCalled, false);
  assert.equal(writeCalled, false);
  assert.notEqual(DEFAULT_DOCUMENT_KEY, buildDocumentKey(targetSession));
  assert.equal(targetSession.storageId, DEFAULT_SESSION_IDENTITY.storageId);
  assert.equal(targetSession.versionKey, DEFAULT_SESSION_IDENTITY.versionKey);
  assert.equal(targetSession.fileName, DEFAULT_SESSION_IDENTITY.fileName);
});

test('callback route rejects read-only sessions before fetching save payload', async () => {
  let fetchCalled = false;
  const handler = createStorageRouteHandler({
    config: {
      publicEditorBaseUrl: 'http://public-onlyoffice:8080',
      internalDocumentServerBaseUrl: 'http://127.0.0.1:80'
    },
    sessionStore: createSessionStore({
      requestedPath: '/workspace/report.docx',
      mimeType: 'text/plain',
      canWrite: false
    }),
    storageRouter: {
      forSession() {
        return {
          async read() {
            return { buffer: Buffer.alloc(0) };
          },
          async write() {
            throw new Error('write should not be reached');
          }
        };
      }
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        async arrayBuffer() {
          return Buffer.from('saved from callback');
        }
      };
    }
  });

  const req = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    headers: {
      'content-type': 'application/json'
    },
    body: signCallbackPayload({
      status: 2,
      url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx'
    })
  });
  const res = createMockResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(fetchCalled, false);
});

test('callback route rejects save download urls from untrusted origins', async () => {
  let fetchCalled = false;
  const handler = createStorageRouteHandler({
    config: {
      publicEditorBaseUrl: 'http://public-onlyoffice:8080',
      internalDocumentServerBaseUrl: 'http://127.0.0.1:80'
    },
    sessionStore: createSessionStore({
      requestedPath: '/workspace/report.docx',
      mimeType: 'text/plain',
      canWrite: true
    }),
    storageRouter: {
      forSession() {
        return {
          async read() {
            return { buffer: Buffer.alloc(0) };
          },
          async write() {
            throw new Error('write should not be reached');
          }
        };
      }
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        async arrayBuffer() {
          return Buffer.from('saved from callback');
        }
      };
    }
  });

  const req = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    headers: {
      'content-type': 'application/json'
    },
    body: signCallbackPayload({
      status: 2,
      url: 'http://evil.example/cache/files/report.docx'
    })
  });
  const res = createMockResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(fetchCalled, false);
});

test('callback route rejects non-cache DocumentServer paths and unsafe response types', async () => {
  let fetchCalls = 0;
  let writes = 0;
  const handler = createStorageRouteHandler({
    config: {
      internalDocumentServerBaseUrl: 'http://127.0.0.1:80',
    },
    sessionStore: createSessionStore({
      requestedPath: '/workspace/report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      canWrite: true,
    }),
    storageRouter: {
      forSession() {
        return {
          async write() {
            writes += 1;
          },
        };
      },
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return createDownloadResponse('<html>not a document</html>', 'text/html');
    },
  });

  const disallowedPath = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    headers: { 'content-type': 'application/json' },
    body: signCallbackPayload({
      status: 2,
      url: 'http://public-onlyoffice:8080/coauthoring/CommandService.ashx',
    }),
  });
  const disallowedPathResponse = createMockResponse();
  await handler(disallowedPath, disallowedPathResponse);
  assert.equal(disallowedPathResponse.statusCode, 400);
  assert.equal(fetchCalls, 0);

  const unsafeContent = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    headers: { 'content-type': 'application/json' },
    body: signCallbackPayload({
      status: 2,
      url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx',
    }),
  });
  const unsafeContentResponse = createMockResponse();
  await handler(unsafeContent, unsafeContentResponse);
  assert.equal(unsafeContentResponse.statusCode, 502);
  assert.equal(fetchCalls, 1);
  assert.equal(writes, 0);
});

test('document route bounds source bytes and source-read duration', async () => {
  const oversizedHandler = createStorageRouteHandler({
    config: { downloadMaxBytes: 4 },
    sessionStore: createSessionStore({ requestedPath: '/workspace/report.docx' }),
    storageRouter: {
      forSession() {
        return { async read() { return { buffer: Buffer.from('12345') }; } };
      },
    },
  });
  const oversizedResponse = createMockResponse();
  await oversizedHandler(createMockRequest({ url: '/internal/document/token-1' }), oversizedResponse);
  assert.equal(oversizedResponse.statusCode, 413);

  const slowHandler = createStorageRouteHandler({
    config: { ioTimeoutMs: 10 },
    sessionStore: createSessionStore({ requestedPath: '/workspace/report.docx' }),
    storageRouter: {
      forSession() {
        return { async read() { return new Promise(() => {}); } };
      },
    },
  });
  const slowResponse = createMockResponse();
  await slowHandler(createMockRequest({ url: '/internal/document/token-1' }), slowResponse);
  assert.equal(slowResponse.statusCode, 504);
});

test('callback route rejects non-loopback peers', async () => {
  const handler = createStorageRouteHandler({
    config: {},
    sessionStore: createSessionStore({
      requestedPath: '/workspace/report.docx',
      mimeType: 'text/plain'
    }),
    storageRouter: {
      forSession() {
        return {
          async metadata() {
            return {};
          },
          async read() {
            return {
              buffer: Buffer.from('document body')
            };
          },
          async write() {}
        };
      }
    }
  });

  const req = createMockRequest({
    method: 'GET',
    url: '/internal/document/token-1',
    remoteAddress: '10.20.30.40'
  });
  const res = createMockResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
});

test('callback route never accepts x-ploinky-auth-info as storage authorization', async () => {
  let fetchCalled = false;
  let writeCalled = false;
  const handler = createStorageRouteHandler({
    config: {},
    sessionStore: {
      getForStorageRequest() {
        throw new Error('Unknown or expired OnlyOffice session token.');
      }
    },
    storageRouter: {
      forSession() {
        writeCalled = true;
        return {
          async metadata() {
            return {};
          },
          async read() {
            return {
              buffer: Buffer.alloc(0)
            };
          },
          async write() {
            writeCalled = true;
          }
        };
      }
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return {
        ok: true,
        async arrayBuffer() {
          return Buffer.alloc(0);
        }
      };
    }
  });

  const req = createMockRequest({
    method: 'POST',
    url: '/internal/callback/token-1',
    remoteAddress: '127.0.0.1',
    headers: {
      'content-type': 'application/json',
      'x-ploinky-auth-info': 'forged'
    },
    body: JSON.stringify({
      status: 2,
      url: 'http://public-onlyoffice:8080/base-agent-additional-server/onlyOffice/8080/cache/files/report.docx'
    })
  });
  const res = createMockResponse();
  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(fetchCalled, false);
  assert.equal(writeCalled, false);
});
