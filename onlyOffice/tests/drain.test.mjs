import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { drainOnlyOfficeSessions } from '../src/drain.mjs';

const config = Object.freeze({
  onlyofficeJwtSecret: 'drain-test-secret',
  internalDocumentServerBaseUrl: 'http://127.0.0.1:80',
  configJwtTtlSeconds: 300,
  ioTimeoutMs: 1_000,
  drainTimeoutMs: 500,
});

function response(payload, contentType = 'application/json') {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-type') return contentType;
        if (String(name).toLowerCase() === 'content-length') return String(body.length);
        return null;
      },
    },
    async arrayBuffer() {
      return body;
    },
  };
}

function activeSession(callbackAcknowledgement = null, documentKey = 'c'.repeat(32)) {
  return {
    storageKind: 'workspace',
    storageId: '/docs/report.docx',
    versionKey: 'version-1',
    fileName: 'report.docx',
    documentKey,
    canWrite: true,
    documentAccessedAt: '2026-07-15T11:59:00.000Z',
    callbackAcknowledgement,
  };
}

function verifyJwt(token, secret) {
  const [header, payload, signature] = String(token).split('.');
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  assert.equal(signature, expected);
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
  return JSON.parse(Buffer.from(payload, 'base64url'));
}

test('drain force-saves writable sessions and waits for a new callback acknowledgement', async () => {
  let nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  let acknowledgement = null;
  const requests = [];
  const result = await drainOnlyOfficeSessions({
    config,
    now: () => nowMs,
    wait: async (delayMs) => {
      nowMs += delayMs;
      acknowledgement = {
        acknowledgedAt: new Date(nowMs).toISOString(),
        version: 'version-2',
      };
    },
    sessionStore: {
      listActiveSessions() {
        return [activeSession(acknowledgement)];
      },
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ error: 0 });
    },
  });

  assert.deepEqual(result, { drainedSessions: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1/coauthoring/CommandService.ashx');
  assert.equal(requests[0].options.redirect, 'manual');
  const envelope = JSON.parse(requests[0].options.body);
  assert.equal(envelope.c, 'forcesave');
  assert.match(envelope.key, /^[0-9a-f]{32}$/);
  const signed = verifyJwt(envelope.token, config.onlyofficeJwtSecret);
  assert.equal(signed.c, envelope.c);
  assert.equal(signed.key, envelope.key);
  assert.ok(signed.exp > signed.iat);
  assert.ok(signed.exp - signed.iat <= 300);
});

test('drain independently waits for same-document sessions with distinct persisted keys', async () => {
  let nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  let waits = 0;
  const acknowledgements = [null, null];
  const requestedKeys = [];
  const result = await drainOnlyOfficeSessions({
    config,
    now: () => nowMs,
    wait: async (delayMs) => {
      nowMs += delayMs;
      acknowledgements[waits] = {
        acknowledgedAt: new Date(nowMs).toISOString(),
        version: `callback-${waits + 1}`,
      };
      waits += 1;
    },
    sessionStore: {
      listActiveSessions() {
        return [
          activeSession(acknowledgements[0], 'c'.repeat(32)),
          activeSession(acknowledgements[1], 'd'.repeat(32)),
        ];
      },
    },
    fetchImpl: async (_url, options) => {
      requestedKeys.push(JSON.parse(options.body).key);
      return response({ error: 0 });
    },
  });

  assert.deepEqual(result, { drainedSessions: 2 });
  assert.deepEqual(requestedKeys, ['c'.repeat(32), 'd'.repeat(32)]);
  assert.equal(waits, 2);
  assert.ok(acknowledgements.every(Boolean));
});

test('drain ignores an issued control session that DocumentServer never accessed', async () => {
  const loaded = activeSession(null, 'c'.repeat(32));
  const unused = {
    ...activeSession(null, 'd'.repeat(32)),
    documentAccessedAt: null,
  };
  const requestedKeys = [];
  const result = await drainOnlyOfficeSessions({
    config,
    sessionStore: {
      listActiveSessions() {
        return [loaded, unused];
      },
    },
    fetchImpl: async (_url, options) => {
      requestedKeys.push(JSON.parse(options.body).key);
      return response({ error: 4 });
    },
  });

  assert.deepEqual(result, { drainedSessions: 1 });
  assert.deepEqual(requestedKeys, ['c'.repeat(32)]);
});

test('read-only editors do not force-save and an exhausted shared deadline cannot issue a command', async () => {
  let calls = 0;
  const options = {
    config,
    now: () => 1_000,
    sessionStore: { listActiveSessions: () => [{ ...activeSession(), canWrite: false }] },
    fetchImpl: async () => { calls += 1; return response({ error: 0 }); },
  };
  assert.deepEqual(await drainOnlyOfficeSessions({ ...options, deadline: 1_100 }), { drainedSessions: 0 });
  await assert.rejects(() => drainOnlyOfficeSessions({ ...options, deadline: 1_000 }), /deadline has expired/);
  assert.equal(calls, 0);
});

test('drain cannot renew the shared deadline between force-save commands', async () => {
  let nowMs = 1_000;
  let calls = 0;
  await assert.rejects(() => drainOnlyOfficeSessions({
    config,
    now: () => nowMs,
    deadline: 1_005,
    sessionStore: { listActiveSessions: () => [activeSession(), activeSession(null, 'd'.repeat(32))] },
    fetchImpl: async () => {
      calls += 1;
      nowMs += 5;
      return response({ error: 4 });
    },
  }), /deadline expired before force-save/);
  assert.equal(calls, 1);
});

test('drain treats DocumentServer no-changes as acknowledged without waiting', async () => {
  let waits = 0;
  const result = await drainOnlyOfficeSessions({
    config,
    sessionStore: { listActiveSessions: () => [activeSession()] },
    wait: async () => { waits += 1; },
    fetchImpl: async () => response({ error: 4 }),
  });
  assert.deepEqual(result, { drainedSessions: 1 });
  assert.equal(waits, 0);
});

test('drain excludes sessions with a durable final-save or signed no-change close acknowledgement', async () => {
  const sessions = [2, 4].map((status, index) => activeSession({
    status,
    acknowledgedAt: '2026-07-15T12:00:00.000Z',
    version: status === 2 ? 'saved-version' : '',
  }, String(index + 1).repeat(32)));
  sessions.push({ ...activeSession({ status: 6, version: 'partial', acknowledgedAt: '2026-07-15T12:00:00.000Z' }, '3'.repeat(32)), drainAcknowledgedAt: '2026-07-15T12:00:01.000Z' });
  let calls = 0;
  const result = await drainOnlyOfficeSessions({
    config,
    sessionStore: { listActiveSessions: () => sessions },
    fetchImpl: async () => { calls += 1; return response({ error: 1 }); },
  });
  assert.deepEqual(result, { drainedSessions: 0 });
  assert.equal(calls, 0);
});

test('a force-save acknowledgement alone cannot excuse a missing DocumentServer session', async () => {
  await assert.rejects(() => drainOnlyOfficeSessions({
    config,
    sessionStore: { listActiveSessions: () => [activeSession({
      status: 6,
      acknowledgedAt: '2026-07-15T12:00:00.000Z',
      version: 'partial-save',
    })] },
    fetchImpl: async () => response({ error: 1 }),
  }), /command returned error 1/);
});

test('drain fails closed when the save callback is not acknowledged before the deadline', async () => {
  let nowMs = 1_000;
  await assert.rejects(
    () => drainOnlyOfficeSessions({
      config: { ...config, drainTimeoutMs: 5 },
      now: () => nowMs,
      wait: async (delayMs) => { nowMs += delayMs; },
      sessionStore: { listActiveSessions: () => [activeSession()] },
      fetchImpl: async () => response({ error: 0 }),
    }),
    /timed out waiting for 1 callback acknowledgement/i,
  );
});

test('drain rejects redirects and non-JSON command responses', async () => {
  await assert.rejects(
    () => drainOnlyOfficeSessions({
      config,
      sessionStore: { listActiveSessions: () => [activeSession()] },
      fetchImpl: async () => response({ error: 0 }, 'text/html'),
    }),
    /non-JSON response/i,
  );
});
