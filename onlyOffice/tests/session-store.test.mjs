import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { buildDocumentKey } from '../src/onlyoffice-config.mjs';
import { createSessionStore as createSessionStoreRaw } from '../src/session-store.mjs';

const ACTIVE_BROWSER_URL = 'https://office.example.com/base-agent-additional-server/onlyOffice/8080';

function createSessionStore(options) {
  const store = createSessionStoreRaw(options);
  return {
    ...store,
    createSession(input = {}) {
      return store.createSession({
        activeBrowserUrl: ACTIVE_BROWSER_URL,
        ...input,
      });
    },
  };
}

function at(isoText) {
  return new Date(isoText);
}

test('config rejects missing onlyoffice jwt secret', () => {
  assert.throws(
    () => loadConfig({}),
    /ONLYOFFICE_JWT_SECRET/
  );
});

test('config fixes v5 session state under the persisted agent workdir with no override', () => {
  const config = loadConfig({
    ONLYOFFICE_JWT_SECRET: 'test-secret',
    ONLYOFFICE_SESSION_STATE_FILE: '/var/lib/onlyoffice/legacy.json',
  });
  assert.equal(config.sessionStateFile, '/root/state/onlyoffice-sessions-v5.json');
  assert.equal(config.sessionStateFile.includes('/.ploinky/'), false);
});

test('config keeps the OnlyOffice drain inside the generic targeted-recreate ceiling', () => {
  assert.equal(loadConfig({
    ONLYOFFICE_JWT_SECRET: 'test-secret',
    ONLYOFFICE_DRAIN_TIMEOUT_MS: '30000',
  }).drainTimeoutMs, 30_000);
  assert.throws(
    () => loadConfig({
      ONLYOFFICE_JWT_SECRET: 'test-secret',
      ONLYOFFICE_DRAIN_TIMEOUT_MS: '30001',
    }),
    /ONLYOFFICE_DRAIN_TIMEOUT_MS must be at most 30000/,
  );
});

test('config accepts only exact positive integer JWT TTLs within five minutes', () => {
  assert.equal(loadConfig({
    ONLYOFFICE_JWT_SECRET: 'test-secret',
    ONLYOFFICE_CONFIG_JWT_TTL_SECONDS: '300',
  }).configJwtTtlSeconds, 300);

  for (const value of ['0', '-1', '300junk', '300.0', '301', '31536000', '9007199254740992']) {
    assert.throws(
      () => loadConfig({
        ONLYOFFICE_JWT_SECRET: 'test-secret',
        ONLYOFFICE_CONFIG_JWT_TTL_SECONDS: value,
      }),
      /ONLYOFFICE_CONFIG_JWT_TTL_SECONDS/,
      value,
    );
  }
});

test('session store mints opaque tokens and never exposes delegation tokens in summaries', () => {
  const store = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    idleTtlMs: 30 * 60 * 1000
  });

  const created = store.createSession({
    path: '/Confidential/My Space/report.docx',
    storageKind: 'dpu',
    storageId: 'confidential:report-1',
    fileName: 'report.docx',
    canWrite: true,
    canComment: true,
    versionKey: 'v1',
    authUser: {
      id: 'local:alice',
      username: 'alice',
      roles: ['user']
    },
    delegations: {
      dpuConfidential: {
        token: 'delegation-token-value',
        expiresAt: '2026-06-09T12:30:00.000Z'
      }
    }
  });

  assert.equal(typeof created.token, 'string');
  assert.notEqual(created.token, 'delegation-token-value');

  const stored = store.getForStorageRequest(created.token, {
    now: at('2026-06-09T12:01:00.000Z')
  });
  assert.equal(typeof stored.tokenHash, 'string');
  assert.notEqual(stored.tokenHash, created.token);
  assert.equal(stored.activeBrowserUrl, ACTIVE_BROWSER_URL);

  const summary = created.publicSummary();
  assert.equal(summary.delegations, undefined);
  assert.equal(JSON.stringify(summary).includes('delegation-token-value'), false);
  assert.equal(summary.path, '/Confidential/My Space/report.docx');
});

test('same-document sessions receive distinct store-minted document keys', () => {
  const store = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
  });
  const descriptor = {
    path: '/docs/shared.docx',
    storageKind: 'workspace',
    storageId: 'workspace:shared',
    fileName: 'shared.docx',
    versionKey: 'v1',
    canWrite: true,
    documentKey: 'f'.repeat(32),
  };

  const first = store.createSession(descriptor);
  const second = store.createSession(descriptor);

  assert.match(first.documentKey, /^[0-9a-f]{32}$/);
  assert.match(second.documentKey, /^[0-9a-f]{32}$/);
  assert.notEqual(first.documentKey, second.documentKey);
  assert.notEqual(first.documentKey, descriptor.documentKey, 'caller input cannot choose callback authorization material');
  assert.equal(buildDocumentKey(first), first.documentKey);
  assert.throws(
    () => buildDocumentKey({ ...descriptor, documentKey: '' }),
    /persisted v5 documentKey/i,
  );
});

test('session browser authority is canonical, immutable, and rejects conflicting updates', () => {
  const store = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
  });
  const created = store.createSession({
    path: '/docs/bound.docx',
    storageKind: 'workspace',
    fileName: 'bound.docx',
    canWrite: true,
  });

  created.activeBrowserUrl = 'https://evil.example/base-agent-additional-server/onlyOffice/8080';
  assert.equal(store.getForStorageRequest(created.token).activeBrowserUrl, ACTIVE_BROWSER_URL);
  assert.throws(
    () => store.touchSession(created.token, {
      activeBrowserUrl: 'https://evil.example/base-agent-additional-server/onlyOffice/8080',
    }),
    /activeBrowserUrl is immutable/,
  );
  assert.equal(
    store.touchSession(created.token, { activeBrowserUrl: ACTIVE_BROWSER_URL }).activeBrowserUrl,
    ACTIVE_BROWSER_URL,
  );

  for (const activeBrowserUrl of [
    undefined,
    `${ACTIVE_BROWSER_URL}/`,
    'https://office.example.com/base-agent-additional-server/onlyOffice/8081',
    'https://user@office.example.com/base-agent-additional-server/onlyOffice/8080',
  ]) {
    const isolated = createSessionStoreRaw();
    assert.throws(
      () => isolated.createSession({
        activeBrowserUrl,
        path: '/docs/rejected.docx',
        storageKind: 'workspace',
        fileName: 'rejected.docx',
        canWrite: true,
      }),
      /activeBrowserUrl.*recreate/i,
    );
  }
});

test('session store expires at the earlier of idle timeout and delegation expiry', () => {
  let now = at('2026-06-09T12:00:00.000Z');
  const store = createSessionStore({
    now: () => now,
    idleTtlMs: 30 * 60 * 1000
  });

  const created = store.createSession({
    path: '/Confidential/My Space/report.docx',
    storageKind: 'dpu',
    storageId: 'confidential:report-1',
    fileName: 'report.docx',
    canWrite: true,
    canComment: true,
    versionKey: 'v1',
    authUser: {
      id: 'local:alice',
      username: 'alice',
      roles: ['user']
    },
    delegations: {
      dpuConfidential: {
        token: 'delegation-token-value',
        expiresAt: '2026-06-09T12:10:00.000Z'
      }
    }
  });

  assert.equal(created.idleExpiresAt, '2026-06-09T12:10:00.000Z');
  assert.equal(created.absoluteExpiresAt, '2026-06-09T12:10:00.000Z');

  now = at('2026-06-09T12:05:00.000Z');
  const touched = store.touchSession(created.token);
  assert.equal(touched.idleExpiresAt, '2026-06-09T12:10:00.000Z');
  assert.equal(touched.absoluteExpiresAt, '2026-06-09T12:10:00.000Z');
});

test('getForStorageRequest renews idle expiry within the absolute bound', () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const store = createSessionStore({ now: () => clock, idleTtlMs: 30 * 60 * 1000 });
  const created = store.createSession({ path: '/docs/a.docx', storageKind: 'workspace', fileName: 'a.docx', canWrite: true });

  clock = new Date('2026-01-01T00:25:00.000Z'); // 25 min in, still active → touch-on-read
  store.getForStorageRequest(created.token);

  clock = new Date('2026-01-01T00:50:00.000Z'); // 50 min after open, but only 25 min since last activity
  const after = store.getForStorageRequest(created.token);
  assert.equal(after.path, '/docs/a.docx');
});

test('session store records only explicit DocumentServer document access', () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const store = createSessionStore({ now: () => clock });
  const created = store.createSession({
    path: '/docs/loaded.docx',
    storageKind: 'workspace',
    fileName: 'loaded.docx',
    canWrite: true,
  });

  assert.equal(created.documentAccessedAt, null);
  assert.equal(store.getForStorageRequest(created.token).documentAccessedAt, null);

  clock = new Date('2026-01-01T00:01:00.000Z');
  const loaded = store.getForStorageRequest(created.token, { markDocumentAccess: true });
  assert.equal(loaded.documentAccessedAt, '2026-01-01T00:01:00.000Z');
  assert.equal(store.listActiveSessions()[0].documentAccessedAt, loaded.documentAccessedAt);

  clock = new Date('2026-01-01T00:02:00.000Z');
  assert.equal(
    store.getForStorageRequest(created.token, { markDocumentAccess: true }).documentAccessedAt,
    loaded.documentAccessedAt,
  );
});

test('session store rejects document access after absolute delegation expiry', () => {
  const store = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    idleTtlMs: 30 * 60 * 1000
  });

  const created = store.createSession({
    path: '/Confidential/My Space/report.docx',
    storageKind: 'dpu',
    storageId: 'confidential:report-1',
    fileName: 'report.docx',
    canWrite: true,
    canComment: true,
    versionKey: 'v1',
    authUser: {
      id: 'local:alice',
      username: 'alice',
      roles: ['user']
    },
    delegations: {
      dpuConfidential: {
        token: 'delegation-token-value',
        expiresAt: '2026-06-09T12:10:00.000Z'
      }
    }
  });

  assert.throws(
    () => store.getForStorageRequest(created.token, {
      now: at('2026-06-09T12:10:01.000Z')
    }),
    /expired|unknown/i
  );
});

test('session metadata survives a targeted recreate through an atomic private v5 file', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-persist-')));
  const stateFile = path.join(directory, 'sessions-v5.json');
  const now = () => at('2026-06-09T12:00:00.000Z');
  const first = createSessionStore({ now, stateFile });
  const created = first.createSession({
    path: '/docs/recreate.docx',
    storageKind: 'workspace',
    storageId: 'workspace:recreate',
    objectId: 'recreate',
    fileName: 'recreate.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    canWrite: true,
    canComment: false,
    versionKey: 'v1',
    authUser: { id: 'alice', username: 'alice', roles: ['user'] },
  });
  first.getForStorageRequest(created.token, {
    now: at('2026-06-09T12:01:00.000Z'),
    markDocumentAccess: true,
  });

  const second = createSessionStore({ now, stateFile });
  const reopened = second.getForStorageRequest(created.token);
  assert.equal(reopened.path, '/docs/recreate.docx');
  assert.equal(reopened.documentKey, created.documentKey);
  assert.equal(reopened.documentAccessedAt, '2026-06-09T12:01:00.000Z');
  assert.equal(reopened.activeBrowserUrl, ACTIVE_BROWSER_URL);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sessions[0].activeBrowserUrl, ACTIVE_BROWSER_URL);
  assert.equal((await readFile(stateFile, 'utf8')).endsWith('\n'), true);
  assert.equal((await readdir(directory)).some((name) => name.includes('.tmp-')), false);
});

test('session loading ignores an uncommitted crash temp and retains the last renamed generation', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-crash-')));
  const stateFile = path.join(directory, 'sessions-v5.json');
  const now = () => at('2026-06-09T12:00:00.000Z');
  const first = createSessionStore({ now, stateFile });
  const created = first.createSession({
    path: '/docs/stable.docx', storageKind: 'workspace', storageId: '', objectId: '',
    fileName: 'stable.docx', mimeType: '', canWrite: true, canComment: false,
    versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: [] },
  });
  await writeFile(path.join(directory, '.sessions-v5.json.tmp-crashed'), '{"partial":', { mode: 0o600 });

  const recreated = createSessionStore({ now, stateFile });
  assert.equal(recreated.getForStorageRequest(created.token).fileName, 'stable.docx');
});

test('persisted state contains no delegation bearer and requires fresh DPU control material after recreate', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-delegation-')));
  const stateFile = path.join(directory, 'sessions-v5.json');
  const now = () => at('2026-06-09T12:00:00.000Z');
  const first = createSessionStore({ now, stateFile });
  const created = first.createSession({
    path: '/Confidential/restricted.docx', storageKind: 'dpu', storageId: 'dpu:1', objectId: '1',
    fileName: 'restricted.docx', mimeType: '', canWrite: true, canComment: false,
    versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: ['user'] },
    delegations: {
      dpuConfidential: {
        token: 'raw-delegation-bearer-must-not-reach-disk',
        expiresAt: '2026-06-09T12:30:00.000Z',
      },
    },
  });
  assert.equal(first.getForStorageRequest(created.token).delegations.dpuConfidential.token, 'raw-delegation-bearer-must-not-reach-disk');
  const bytes = await readFile(stateFile, 'utf8');
  assert.equal(bytes.includes('raw-delegation-bearer-must-not-reach-disk'), false);
  assert.equal(JSON.parse(bytes).sessions[0].requiresReauthorization, true);
  assert.deepEqual(JSON.parse(bytes).sessions[0].delegations, {});

  const recreated = createSessionStore({ now, stateFile });
  assert.throws(() => recreated.getForStorageRequest(created.token), /fresh authenticated control material/i);
  assert.deepEqual(recreated.listActiveSessions(), []);
});

test('fresh authenticated DPU control reauthorizes only the matching loaded persisted session', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-reauthorize-')));
  const stateFile = path.join(directory, 'sessions-v5.json');
  let clock = at('2026-06-09T12:00:00.000Z');
  const first = createSessionStore({ now: () => clock, stateFile });
  const descriptor = {
    requestedPath: '/Confidential/report.docx',
    path: '/Confidential/report.docx',
    storageKind: 'dpu',
    storageId: '/Confidential/report.docx',
    objectId: 'object-1',
    fileName: 'report.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    canWrite: true,
    canComment: false,
    versionKey: 'v1',
    preview: {
      storageKind: 'dpu',
      requestedPath: '/Confidential/report.docx',
      objectId: 'object-1',
      canWrite: true,
      canComment: false,
    },
    authUser: { id: 'local:alice', username: 'alice', roles: ['user'] },
    delegations: {
      dpuConfidential: {
        token: 'first-generation-delegation',
        expiresAt: '2026-06-09T13:00:00.000Z',
      },
    },
  };
  const loaded = first.createSession(descriptor);
  const unused = first.createSession(descriptor);
  clock = at('2026-06-09T12:01:00.000Z');
  first.getForStorageRequest(loaded.token, { markDocumentAccess: true });

  clock = at('2026-06-09T12:02:00.000Z');
  const recreated = createSessionStore({ now: () => clock, stateFile });
  assert.throws(() => recreated.getForStorageRequest(loaded.token), /fresh authenticated control material/i);
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    authUser: { id: 'local:bob', username: 'bob', roles: ['user'] },
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 0);
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    requestedPath: '/Confidential/other.docx',
    path: '/Confidential/other.docx',
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 0);
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    objectId: 'object-2',
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 0);
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    canWrite: false,
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 0);
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    activeBrowserUrl: 'https://other.example.com/base-agent-additional-server/onlyOffice/8080',
  }), 0);

  const freshDelegation = {
    dpuConfidential: {
      token: 'fresh-generation-delegation',
      expiresAt: '2026-06-09T14:00:00.000Z',
    },
  };
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    versionKey: 'v2',
    delegations: freshDelegation,
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 1);

  const restored = recreated.getForStorageRequest(loaded.token);
  assert.equal(restored.versionKey, 'v2');
  assert.equal(restored.delegations.dpuConfidential.token, 'fresh-generation-delegation');
  assert.equal(restored.idleExpiresAt, '2026-06-09T12:32:00.000Z');
  assert.equal(restored.absoluteExpiresAt, '2026-06-09T13:00:00.000Z');
  assert.equal(recreated.listActiveSessions().length, 1);
  assert.throws(() => recreated.getForStorageRequest(unused.token), /fresh authenticated control material/i);

  const bytes = await readFile(stateFile, 'utf8');
  assert.equal(bytes.includes('first-generation-delegation'), false);
  assert.equal(bytes.includes('fresh-generation-delegation'), false);
  assert.deepEqual(JSON.parse(bytes).sessions.map((record) => record.requiresReauthorization), [true, true]);
});

test('fresh authenticated DPU control cannot resurrect an expired loaded session', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-expired-reauthorize-')));
  const stateFile = path.join(directory, 'sessions-v5.json');
  let clock = at('2026-06-09T12:00:00.000Z');
  const first = createSessionStore({ now: () => clock, stateFile });
  const descriptor = {
    requestedPath: '/Confidential/expired.docx',
    path: '/Confidential/expired.docx',
    storageKind: 'dpu',
    storageId: '/Confidential/expired.docx',
    objectId: 'expired-object',
    fileName: 'expired.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    canWrite: true,
    canComment: false,
    versionKey: 'v1',
    authUser: { id: 'local:alice', username: 'alice', roles: ['user'] },
    delegations: {
      dpuConfidential: {
        token: 'expired-generation-delegation',
        expiresAt: '2026-06-09T12:05:00.000Z',
      },
    },
  };
  const loaded = first.createSession(descriptor);
  clock = at('2026-06-09T12:01:00.000Z');
  first.getForStorageRequest(loaded.token, { markDocumentAccess: true });

  clock = at('2026-06-09T12:06:00.000Z');
  const recreated = createSessionStore({ now: () => clock, stateFile });
  assert.equal(recreated.reauthorizeLoadedSessions({
    ...descriptor,
    delegations: {
      dpuConfidential: {
        token: 'later-generation-delegation',
        expiresAt: '2026-06-09T13:00:00.000Z',
      },
    },
    activeBrowserUrl: ACTIVE_BROWSER_URL,
  }), 0);
  assert.deepEqual(recreated.listActiveSessions(), []);
  assert.throws(() => recreated.getForStorageRequest(loaded.token), /unknown|expired/i);
  assert.equal((await readFile(stateFile, 'utf8')).includes('later-generation-delegation'), false);
});

test('session state fails closed on symlink targets, symlink parents, weak modes, and corrupt bytes', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-guards-')));
  const target = path.join(directory, 'target.json');
  const stateLink = path.join(directory, 'state-link.json');
  await writeFile(target, '{"schemaVersion":5,"sessions":[]}\n', { mode: 0o600 });
  await symlink(target, stateLink);
  assert.throws(() => createSessionStore({ stateFile: stateLink }), /regular file|link/i);

  const realParent = path.join(directory, 'real-parent');
  const linkedParent = path.join(directory, 'linked-parent');
  await mkdir(realParent, { mode: 0o700 });
  await symlink(realParent, linkedParent);
  const linkedStore = createSessionStore({ stateFile: path.join(linkedParent, 'state.json') });
  assert.throws(() => linkedStore.createSession({}), /directory is unsafe/i);

  const weak = path.join(directory, 'weak.json');
  await writeFile(weak, '{"schemaVersion":5,"sessions":[]}\n', { mode: 0o600 });
  await chmod(weak, 0o644);
  assert.throws(() => createSessionStore({ stateFile: weak }), /permissions.*0600/i);

  const corrupt = path.join(directory, 'corrupt.json');
  await writeFile(corrupt, '{"schemaVersion":5,"sessions":[{"tokenHash":"bad"}]}\n', { mode: 0o600 });
  assert.throws(() => createSessionStore({ stateFile: corrupt }), /corrupt/i);

  const v4 = path.join(directory, 'v4.json');
  await writeFile(v4, '{"schemaVersion":4,"sessions":[]}\n', { mode: 0o600 });
  assert.throws(() => createSessionStore({ stateFile: v4 }), /runtime contract v5.*recreate/i);
});

test('session state hard cut rejects missing, malformed, and duplicate per-session document keys', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-key-')));
  const missingKeyFile = path.join(directory, 'missing-key.json');
  const first = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    stateFile: missingKeyFile,
  });
  first.createSession({
    path: '/docs/a.docx', storageKind: 'workspace', storageId: 'a', objectId: '',
    fileName: 'a.docx', mimeType: '', canWrite: true, canComment: false,
    versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: [] },
  });
  const missingKeyState = JSON.parse(await readFile(missingKeyFile, 'utf8'));
  delete missingKeyState.sessions[0].documentKey;
  await writeFile(missingKeyFile, `${JSON.stringify(missingKeyState)}\n`, { mode: 0o600 });
  assert.throws(
    () => createSessionStore({ stateFile: missingKeyFile }),
    /documentKey.*recreate/i,
  );

  const malformedKeyFile = path.join(directory, 'malformed-key.json');
  const malformed = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    stateFile: malformedKeyFile,
  });
  malformed.createSession({
    path: '/docs/malformed.docx', storageKind: 'workspace', storageId: 'malformed', objectId: '',
    fileName: 'malformed.docx', mimeType: '', canWrite: true, canComment: false,
    versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: [] },
  });
  const malformedKeyState = JSON.parse(await readFile(malformedKeyFile, 'utf8'));
  malformedKeyState.sessions[0].documentKey = 'A'.repeat(32);
  await writeFile(malformedKeyFile, `${JSON.stringify(malformedKeyState)}\n`, { mode: 0o600 });
  assert.throws(
    () => createSessionStore({ stateFile: malformedKeyFile }),
    /documentKey.*recreate/i,
  );

  const duplicateKeyFile = path.join(directory, 'duplicate-key.json');
  const second = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    stateFile: duplicateKeyFile,
  });
  for (const name of ['b.docx', 'c.docx']) {
    second.createSession({
      path: `/docs/${name}`, storageKind: 'workspace', storageId: name, objectId: '',
      fileName: name, mimeType: '', canWrite: true, canComment: false,
      versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: [] },
    });
  }
  const duplicateKeyState = JSON.parse(await readFile(duplicateKeyFile, 'utf8'));
  duplicateKeyState.sessions[1].documentKey = duplicateKeyState.sessions[0].documentKey;
  await writeFile(duplicateKeyFile, `${JSON.stringify(duplicateKeyState)}\n`, { mode: 0o600 });
  assert.throws(
    () => createSessionStore({ stateFile: duplicateKeyFile }),
    /duplicate documentKey/i,
  );
});

test('session state hard cut rejects missing or malformed document access state', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-access-')));

  for (const [name, mutate] of [
    ['missing', (record) => { delete record.documentAccessedAt; }],
    ['malformed', (record) => { record.documentAccessedAt = 'not-an-iso-timestamp'; }],
    ['before-creation', (record) => { record.documentAccessedAt = '2026-06-09T11:59:59.000Z'; }],
  ]) {
    const stateFile = path.join(directory, `${name}.json`);
    const store = createSessionStore({
      now: () => at('2026-06-09T12:00:00.000Z'),
      stateFile,
    });
    store.createSession({
      path: `/docs/${name}.docx`, storageKind: 'workspace', storageId: name, objectId: '',
      fileName: `${name}.docx`, mimeType: '', canWrite: true, canComment: false,
      versionKey: 'v1', authUser: { id: 'alice', username: 'alice', roles: [] },
    });
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
    mutate(persisted.sessions[0]);
    await writeFile(stateFile, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
    assert.throws(
      () => createSessionStore({ stateFile }),
      /document access timestamp.*corrupt/i,
      name,
    );
  }
});

test('session state hard cut rejects missing or mutated browser authority without fallback', async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-session-browser-url-')));
  const sourceFile = path.join(directory, 'source.json');
  const store = createSessionStore({
    now: () => at('2026-06-09T12:00:00.000Z'),
    stateFile: sourceFile,
  });
  store.createSession({
    path: '/docs/authority.docx',
    storageKind: 'workspace',
    storageId: 'authority',
    objectId: '',
    fileName: 'authority.docx',
    mimeType: '',
    canWrite: true,
    canComment: false,
    versionKey: 'v1',
    authUser: { id: 'alice', username: 'alice', roles: [] },
  });
  const pristine = JSON.parse(await readFile(sourceFile, 'utf8'));

  const mutations = [
    ['missing', (record) => delete record.activeBrowserUrl],
    ['missing-binding', (record) => delete record.activeBrowserBindingHash],
    ['mutated-binding', (record) => {
      record.activeBrowserBindingHash = 'A'.repeat(43);
    }],
    ['trailing-slash', (record) => {
      record.activeBrowserUrl = `${ACTIVE_BROWSER_URL}/`;
    }],
    ['different-origin', (record) => {
      record.activeBrowserUrl = 'https://evil.example/base-agent-additional-server/onlyOffice/8080';
    }],
    ['different-prefix', (record) => {
      record.activeBrowserUrl = 'https://office.example.com/base-agent-additional-server/onlyOffice/8081';
    }],
  ];

  for (const [name, mutate] of mutations) {
    const state = structuredClone(pristine);
    mutate(state.sessions[0]);
    const stateFile = path.join(directory, `${name}.json`);
    await writeFile(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    assert.throws(
      () => createSessionStoreRaw({ stateFile }),
      /activeBrowserUrl.*recreate/i,
      name,
    );
  }
});


test('verified close and native drain receipts survive reload and a new signed editing cycle clears them', async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'onlyoffice-close-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'sessions-v5.json');
  let clock = at('2026-06-09T12:00:00.000Z');
  const options = { now: () => clock, stateFile };
  let store = createSessionStore(options);
  const created = store.createSession({ path: '/docs/close.docx', storageKind: 'workspace', canWrite: true });
  const unused = store.createSession({ path: '/docs/unused.docx', storageKind: 'workspace', canWrite: true });
  store.getForStorageRequest(created.token, { markDocumentAccess: true });
  store.acknowledgeCallback(created.token, { status: 6, version: 'partial' });
  store.updateEditorStatus(created.token, 1);
  assert.equal(store.getForStorageRequest(created.token).callbackAcknowledgement.status, 6);
  store.acknowledgeDrainedEditors();
  store = createSessionStore(options);
  assert.equal(store.getForStorageRequest(created.token).drainAcknowledgedAt, clock.toISOString());
  assert.equal(store.getForStorageRequest(unused.token).drainAcknowledgedAt, null);
  store.updateEditorStatus(created.token, 1);
  store = createSessionStore(options);
  assert.equal(store.getForStorageRequest(created.token).drainAcknowledgedAt, null);
  assert.equal(store.getForStorageRequest(created.token).callbackAcknowledgement, null);
  for (const status of [2, 4]) {
    if (status === 2) store.acknowledgeCallback(created.token, { status, version: 'final' });
    else store.updateEditorStatus(created.token, status);
    store = createSessionStore(options);
    assert.equal(store.getForStorageRequest(created.token).callbackAcknowledgement.status, status);
    store.updateEditorStatus(created.token, 1);
    store = createSessionStore(options);
    assert.equal(store.getForStorageRequest(created.token).callbackAcknowledgement, null);
  }
  assert.throws(() => store.updateEditorStatus('unknown', 4), /Unknown or expired/);
  assert.throws(() => store.updateEditorStatus(created.token, 6), /Unsupported/);
  clock = at('2026-06-10T12:00:00.000Z');
  assert.throws(() => store.updateEditorStatus(created.token, 4), /Unknown or expired/);
});
