import { createHmac, timingSafeEqual } from 'node:crypto';

import { buildDocumentKey } from '../onlyoffice-config.mjs';
import { resolveCanonicalEditorBrowserUrl } from '../public-editor-url.mjs';

const SAVE_STATUSES = new Set([2, 6]);
const CALLBACK_TEMPORAL_FIELDS = new Set(['iat', 'nbf', 'exp']);
const ALLOWED_DOWNLOAD_CONTENT_TYPES = [
  'application/msword',
  'application/octet-stream',
  'application/pdf',
  'application/rtf',
  'application/vnd.',
  'application/zip',
  'text/csv',
];

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim();
  return normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1';
}

function send(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), {
    'content-type': 'application/json'
  });
}

function getTokenFromPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) {
    return '';
  }
  const token = pathname.slice(prefix.length).split('/')[0];
  return decodeURIComponent(token || '');
}

async function readBody(req, { maxBytes, timeoutMs }) {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => req.destroy(new Error('OnlyOffice callback body timed out.')), timeoutMs);
  timer.unref?.();
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        throw new Error('OnlyOffice callback body exceeds the configured limit.');
      }
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeAndVerifyCallbackToken(token, secret, { now = () => Date.now(), maxLifetimeSeconds = 300 } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('OnlyOffice callback token is malformed.');
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
  if (header?.alg !== 'HS256' || (header?.typ && header.typ !== 'JWT')) {
    throw new Error('OnlyOffice callback token algorithm is not allowed.');
  }
  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('OnlyOffice callback token signature is invalid.');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (!isPlainJsonObject(payload)) {
    throw new Error('OnlyOffice callback token payload is invalid.');
  }
  const nowSeconds = Math.floor(Number(now()) / 1000);
  const { iat, nbf, exp } = payload;
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) {
    throw new Error('OnlyOffice callback token requires iat and exp.');
  }
  if (payload.nbf !== undefined && !Number.isInteger(nbf)) {
    throw new Error('OnlyOffice callback token nbf is invalid.');
  }
  if (iat > nowSeconds + 5 || (payload.nbf !== undefined && nbf > nowSeconds + 5)) {
    throw new Error('OnlyOffice callback token is not active yet.');
  }
  if (exp <= nowSeconds - 5 || exp <= iat || exp - iat > maxLifetimeSeconds) {
    throw new Error('OnlyOffice callback token is expired or exceeds its allowed lifetime.');
  }
  return payload;
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactJsonValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('OnlyOffice callback contains a non-finite number.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertExactJsonValue(item);
    }
    return;
  }
  if (!isPlainJsonObject(value)) {
    throw new Error('OnlyOffice callback contains a non-JSON value.');
  }
  for (const key of Object.keys(value)) {
    assertExactJsonValue(value[key]);
  }
}

function exactJsonEqual(left, right) {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return typeof left === typeof right && Object.is(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => exactJsonEqual(value, right[index]));
  }
  if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && exactJsonEqual(left[key], right[key]));
}

function parseCallbackEnvelope(payloadText) {
  const envelope = payloadText ? JSON.parse(payloadText) : null;
  if (!isPlainJsonObject(envelope)
      || !Object.hasOwn(envelope, 'token')
      || typeof envelope.token !== 'string') {
    throw new Error('OnlyOffice callback requires one own string token.');
  }
  return envelope;
}

function assertCallbackEnvelopeMatchesVerifiedPayload(envelope, payload) {
  assertExactJsonValue(envelope);
  assertExactJsonValue(payload);
  if (Object.hasOwn(payload, 'token')) {
    throw new Error('OnlyOffice callback signed payload cannot contain a token claim.');
  }
  for (const field of CALLBACK_TEMPORAL_FIELDS) {
    if (Object.hasOwn(envelope, field)) {
      throw new Error('OnlyOffice callback envelope cannot contain temporal fields.');
    }
  }

  const envelopeKeys = Object.keys(envelope).filter((key) => key !== 'token');
  const payloadKeys = Object.keys(payload).filter((key) => !CALLBACK_TEMPORAL_FIELDS.has(key));
  if (envelopeKeys.length !== payloadKeys.length
      || envelopeKeys.some((key) => !Object.hasOwn(payload, key))
      || payloadKeys.some((key) => !Object.hasOwn(envelope, key))) {
    throw new Error('OnlyOffice callback envelope fields do not match the verified payload.');
  }
  for (const key of payloadKeys) {
    if (!exactJsonEqual(envelope[key], payload[key])) {
      throw new Error('OnlyOffice callback envelope values do not match the verified payload.');
    }
  }
}

async function readBoundedDownload(response, maxBytes) {
  const declaredLength = Number(response?.headers?.get?.('content-length') || 0);
  if (declaredLength > maxBytes) {
    throw new Error('OnlyOffice download exceeds the configured limit.');
  }
  if (response?.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        throw new Error('OnlyOffice download exceeds the configured limit.');
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    throw new Error('OnlyOffice download exceeds the configured limit.');
  }
  return buffer;
}

function assertAllowedDownloadContentType(response) {
  const contentType = String(response?.headers?.get?.('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!contentType || !ALLOWED_DOWNLOAD_CONTENT_TYPES.some((allowed) => (
    allowed.endsWith('.') ? contentType.startsWith(allowed) : contentType === allowed
  ))) {
    throw new Error('OnlyOffice download content type is not allowed.');
  }
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function extractRawPathname(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl !== rawUrl.trim()) {
    throw new Error('OnlyOffice callback download URL is malformed.');
  }
  const match = rawUrl.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?(?:\?[^#]*)?$/);
  if (!match) {
    throw new Error('OnlyOffice callback download URL is malformed.');
  }
  return match[1] || '/';
}

function assertConfinedCachePath(rawPathname, expectedPrefix = '') {
  const cachePrefix = `${expectedPrefix}/cache/files/`;
  if (!rawPathname.startsWith(cachePrefix)) {
    throw new Error('OnlyOffice callback download path is not allowed.');
  }
  const suffix = rawPathname.slice(cachePrefix.length);
  if (!suffix || suffix.endsWith('/') || suffix.includes('\\')) {
    throw new Error('OnlyOffice callback download path is not allowed.');
  }
  const rawSegments = suffix.split('/');
  if (rawSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('OnlyOffice callback download path is not allowed.');
  }
  for (const segment of rawSegments) {
    if (/%(?![0-9A-Fa-f]{2})/.test(segment)) {
      throw new Error('OnlyOffice callback download path is not allowed.');
    }
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch (_) {
      throw new Error('OnlyOffice callback download path is not allowed.');
    }
    if (
      !decoded
      || decoded === '.'
      || decoded === '..'
      || /[\/\\\0?#]/.test(decoded)
      || /%(?:25|2e|2f|5c|3f|23)/i.test(decoded)
    ) {
      throw new Error('OnlyOffice callback download path is not allowed.');
    }
  }
  return `/cache/files/${suffix}`;
}

function resolveTrustedDownloadUrl(rawUrl, {
  publicEditorBaseUrl,
  internalDocumentServerBaseUrl
} = {}) {
  if (!rawUrl) {
    throw new Error('OnlyOffice callback did not include a download URL.');
  }
  if (!publicEditorBaseUrl || !internalDocumentServerBaseUrl) {
    throw new Error('OnlyOffice callback URL configuration is required.');
  }

  const rawPathname = extractRawPathname(rawUrl);
  const downloadUrl = new URL(rawUrl);
  const { browserUrl: publicBase, prefix: publicPrefix } = resolveCanonicalEditorBrowserUrl(publicEditorBaseUrl);
  const internalBase = new URL(internalDocumentServerBaseUrl);
  if (internalBase.protocol !== 'http:' || !isLoopbackHostname(internalBase.hostname)) {
    throw new Error('OnlyOffice internal DocumentServer origin must be process-loopback HTTP.');
  }
  if (
    downloadUrl.username
    || downloadUrl.password
    || downloadUrl.hash
    || !['http:', 'https:'].includes(downloadUrl.protocol)
  ) {
    throw new Error('OnlyOffice callback download URL is malformed.');
  }
  if (downloadUrl.origin !== publicBase.origin && downloadUrl.origin !== internalBase.origin) {
    throw new Error('OnlyOffice callback download URL origin is not trusted.');
  }
  if (publicBase.origin === internalBase.origin) {
    throw new Error('OnlyOffice callback public and internal origins must be distinct.');
  }
  if (downloadUrl.origin === internalBase.origin) {
    assertConfinedCachePath(rawPathname);
    return downloadUrl.toString();
  }
  const internalPathname = assertConfinedCachePath(rawPathname, publicPrefix);

  downloadUrl.protocol = internalBase.protocol;
  downloadUrl.username = internalBase.username;
  downloadUrl.password = internalBase.password;
  downloadUrl.hostname = internalBase.hostname;
  downloadUrl.port = internalBase.port;
  downloadUrl.pathname = internalPathname;
  return downloadUrl.toString();
}

function resolveSessionFromToken(sessionStore, token, { markDocumentAccess = false } = {}) {
  return sessionStore.getForStorageRequest(token, { markDocumentAccess });
}

export function createStorageRouteHandler({
  config = {},
  sessionStore,
  storageRouter,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!sessionStore || !storageRouter) {
    throw new Error('Storage routes require sessionStore and storageRouter.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Storage routes require fetchImpl.');
  }

  return async function handleStorageRoute(req, res) {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      send(res, 403, 'Loopback access only.');
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const documentToken = getTokenFromPath(url.pathname, '/internal/document/');
    const callbackToken = getTokenFromPath(url.pathname, '/internal/callback/');
    const isDocumentRoute = req.method === 'GET' && Boolean(documentToken);
    const isCallbackRoute = req.method === 'POST' && Boolean(callbackToken);

    if (!isDocumentRoute && !isCallbackRoute) {
      send(res, 404, 'Not found.');
      return;
    }

    let session;
    try {
      session = resolveSessionFromToken(sessionStore, documentToken || callbackToken, {
        markDocumentAccess: isDocumentRoute,
      });
    } catch (error) {
      if (String(error?.message || '').includes('Unknown or expired OnlyOffice session token.')) {
        send(res, 404, 'OnlyOffice session not found.');
        return;
      }
      throw error;
    }

    const backend = storageRouter.forSession(session);

    if (isDocumentRoute) {
      const controller = new AbortController();
      let rejectTimeout;
      const timeoutPromise = new Promise((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timeout = setTimeout(() => {
        controller.abort();
        rejectTimeout(new Error('OnlyOffice source document read timed out.'));
      }, Number(config.ioTimeoutMs || 15_000));
      timeout.unref?.();
      let document;
      try {
        document = await Promise.race([
          backend.read({ signal: controller.signal }),
          timeoutPromise,
        ]);
      } catch (_) {
        send(res, controller.signal.aborted ? 504 : 502, 'OnlyOffice source document is unavailable.');
        return;
      } finally {
        clearTimeout(timeout);
      }
      const buffer = Buffer.isBuffer(document?.buffer) ? document.buffer : Buffer.from(document?.buffer || '');
      if (buffer.length > Number(config.downloadMaxBytes || 64 * 1024 * 1024)) {
        send(res, 413, 'OnlyOffice document exceeds the configured limit.');
        return;
      }
      send(res, 200, buffer, {
        'content-type': document.mimeType || 'application/octet-stream'
      });
      return;
    }

    const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(res, 415, { error: 1 });
      return;
    }

    let payload;
    try {
      const payloadText = await readBody(req, {
        maxBytes: Number(config.callbackMaxBytes || 256 * 1024),
        timeoutMs: Number(config.ioTimeoutMs || 15_000),
      });
      const envelope = parseCallbackEnvelope(payloadText);
      payload = decodeAndVerifyCallbackToken(envelope.token, config.onlyofficeJwtSecret, {
        now,
        maxLifetimeSeconds: Number(config.configJwtTtlSeconds || 300),
      });
      assertCallbackEnvelopeMatchesVerifiedPayload(envelope, payload);
    } catch (_) {
      sendJson(res, 400, { error: 1 });
      return;
    }
    if (typeof payload?.key !== 'string' || payload.key !== buildDocumentKey(session)) {
      sendJson(res, 400, { error: 1 });
      return;
    }
    if ([1, 4].includes(Number(payload.status))) {
      sessionStore.updateEditorStatus?.(callbackToken, Number(payload.status));
    }
    if (!SAVE_STATUSES.has(Number(payload?.status))) {
      sendJson(res, 200, { error: 0 });
      return;
    }

    if (!session.canWrite) {
      sendJson(res, 403, { error: 1 });
      return;
    }

    let downloadUrl;
    try {
      downloadUrl = resolveTrustedDownloadUrl(payload?.url, {
        publicEditorBaseUrl: session.activeBrowserUrl,
        internalDocumentServerBaseUrl: config.internalDocumentServerBaseUrl,
      });
    } catch (_) {
      sendJson(res, 400, { error: 1 });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(config.ioTimeoutMs || 15_000));
    timeout.unref?.();
    try {
      const downloadResponse = await fetchImpl(downloadUrl, {
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!downloadResponse?.ok || (downloadResponse.status >= 300 && downloadResponse.status < 400) || downloadResponse.redirected) {
        throw new Error('OnlyOffice callback download failed.');
      }
      assertAllowedDownloadContentType(downloadResponse);
      const bytes = await readBoundedDownload(downloadResponse, Number(config.downloadMaxBytes || 64 * 1024 * 1024));
      await backend.write(bytes);
      sessionStore.acknowledgeCallback?.(callbackToken, {
        status: Number(payload.status),
        version: String(payload.key || payload.history?.serverVersion || ''),
        acknowledgedAt: new Date(Number(now())).toISOString(),
      });
      sendJson(res, 200, { error: 0 });
    } catch (_) {
      sendJson(res, 502, { error: 1 });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export const _test = Object.freeze({
  decodeAndVerifyCallbackToken,
  assertCallbackEnvelopeMatchesVerifiedPayload,
  assertAllowedDownloadContentType,
  readBoundedDownload,
  resolveTrustedDownloadUrl,
});
