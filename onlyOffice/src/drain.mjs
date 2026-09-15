import { buildDocumentKey, signJwt } from './onlyoffice-config.mjs';

const COMMAND_PATH = '/coauthoring/CommandService.ashx';
const MAX_COMMAND_RESPONSE_BYTES = 64 * 1024;

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function acknowledgementFingerprint(session) {
  const acknowledgement = session?.callbackAcknowledgement;
  return acknowledgement
    ? `${acknowledgement.acknowledgedAt || ''}\u0000${acknowledgement.version || ''}`
    : '';
}

async function readBoundedJson(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new Error('OnlyOffice drain command returned a non-JSON response.');
  }
  const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
  if (declaredLength > MAX_COMMAND_RESPONSE_BYTES) {
    throw new Error('OnlyOffice drain command response is too large.');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_COMMAND_RESPONSE_BYTES) {
    throw new Error('OnlyOffice drain command response is too large.');
  }
  return JSON.parse(buffer.toString('utf8'));
}

function buildForceSaveEnvelope(session, config, nowMs) {
  const issuedAt = Math.floor(nowMs / 1000);
  const command = {
    c: 'forcesave',
    key: buildDocumentKey(session),
  };
  return {
    ...command,
    token: signJwt({
      ...command,
      iat: issuedAt,
      nbf: issuedAt - 5,
      exp: issuedAt + Math.min(Number(config.configJwtTtlSeconds || 300), 300),
    }, config.onlyofficeJwtSecret),
  };
}

async function requestForceSave(session, {
  config,
  fetchImpl,
  now,
  deadline,
}) {
  const origin = new URL(config.internalDocumentServerBaseUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
    throw new Error('OnlyOffice drain requires the process-loopback DocumentServer origin.');
  }
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw new Error('OnlyOffice drain deadline expired before force-save.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(remainingMs, Number(config.ioTimeoutMs || 15_000)));
  timer.unref?.();
  try {
    const response = await fetchImpl(new URL(COMMAND_PATH, origin).toString(), {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildForceSaveEnvelope(session, config, now())),
    });
    if (!response?.ok || response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('OnlyOffice drain command failed.');
    }
    const result = await readBoundedJson(response);
    const errorCode = Number(result?.error);
    if (errorCode === 4) {
      return { callbackRequired: false };
    }
    if (errorCode !== 0) {
      throw new Error(`OnlyOffice drain command returned error ${Number.isFinite(errorCode) ? errorCode : 'unknown'}.`);
    }
    return { callbackRequired: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function drainOnlyOfficeSessions({
  config,
  sessionStore,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  wait = sleep,
  pollIntervalMs = 100,
  deadline = now() + Number(config?.drainTimeoutMs || 30_000),
} = {}) {
  if (!config || !sessionStore || typeof sessionStore.listActiveSessions !== 'function') {
    throw new Error('OnlyOffice drain requires config and a persistent session store.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('OnlyOffice drain requires fetch.');
  }
  if (!Number.isFinite(deadline) || deadline <= now()) {
    throw new Error('OnlyOffice drain deadline has expired.');
  }
  const activeSessions = sessionStore.listActiveSessions().filter((session) => (
    session.canWrite && session.documentAccessedAt && !session.drainAcknowledgedAt
    && ![2, 4].includes(session.callbackAcknowledgement?.status)
  ));
  const pending = new Map();

  for (const session of activeSessions) {
    const key = buildDocumentKey(session);
    const baseline = acknowledgementFingerprint(session);
    const result = await requestForceSave(session, { config, fetchImpl, now, deadline });
    if (result.callbackRequired) pending.set(key, baseline);
  }

  while (pending.size && now() < deadline) {
    for (const session of sessionStore.listActiveSessions()) {
      const key = buildDocumentKey(session);
      if (!pending.has(key)) continue;
      const current = acknowledgementFingerprint(session);
      if (current && current !== pending.get(key)) pending.delete(key);
    }
    if (pending.size) await wait(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }

  if (pending.size) {
    throw new Error(`OnlyOffice drain timed out waiting for ${pending.size} callback acknowledgement(s).`);
  }
  return { drainedSessions: activeSessions.length };
}

export const _test = Object.freeze({
  acknowledgementFingerprint,
  buildForceSaveEnvelope,
  readBoundedJson,
});
