import net from 'node:net';

import { resolveOnlyOfficeEditorService } from '../edge-topology.mjs';
import { resolveCanonicalEditorBrowserUrl } from '../public-editor-url.mjs';

const BLOCKED_EXACT_PATHS = new Set([
  '/coauthoring/CommandService.ashx',
  '/ConvertService.ashx',
  '/converter',
  '/healthcheck'
]);

const BLOCKED_PREFIXES = [
  '/example/',
  '/welcome/',
  '/info/',
  '/internal/'
];

const ALLOWED_HTTP_PREFIXES = [
  '/web-apps/',
  '/sdkjs/',
  '/sdkjs-plugins/',
  '/fonts/',
  '/themes/',
  '/cache/files/'
];

const ALLOWED_HTTP_EXACT_PATHS = new Set([
  '/document_editor_service_worker.js',
  '/plugins.json',
  '/themes.json'
]);

const ROUTER_INTERNAL_EDITOR_HOST = '127.0.0.1:8080';
const ROUTER_FORWARDED_HEADER_NAMES = new Set([
  'x-forwarded-host',
  'x-forwarded-prefix',
  'x-forwarded-proto',
]);

function stripOnlyOfficeVersionPrefix(pathname) {
  const match = String(pathname || '').match(/^\/\d+(?:\.\d+){1,3}-[A-Za-z0-9._-]+(?=\/)/);
  if (!match) {
    return pathname;
  }
  return pathname.slice(match[0].length) || '/';
}

function sanitizeHeaders(headers = {}) {
  const blocked = new Set([
    'authorization',
    'cookie',
    'forwarded',
    'host',
    'ploinky-agent-assertion',
    'proxy-authorization',
    'x-forwarded',
  ]);
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = String(name).toLowerCase();
    if (
      normalizedName.startsWith('x-ploinky-')
      || normalizedName.startsWith('x-forwarded-')
      || blocked.has(normalizedName)
    ) {
      continue;
    }
    sanitized[name] = value;
  }
  return sanitized;
}

function withCanonicalForwardingHeaders(headers, publicBrowserUrl) {
  const { browserUrl, prefix } = resolveCanonicalEditorBrowserUrl(publicBrowserUrl);
  return {
    ...headers,
    'x-forwarded-host': browserUrl.host,
    'x-forwarded-proto': browserUrl.protocol.replace(/:$/, ''),
    'x-forwarded-prefix': prefix,
  };
}

function exactScalarHeader(headers, expectedName) {
  const matches = Object.entries(headers || {}).filter(
    ([name]) => String(name).toLowerCase() === expectedName,
  );
  if (matches.length !== 1 || typeof matches[0][1] !== 'string') {
    return null;
  }
  return matches[0][1];
}

function collectHeaderOccurrences(req) {
  if (req?.rawHeaders !== undefined) {
    if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 !== 0) {
      return null;
    }
    const occurrences = new Map();
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index];
      const value = req.rawHeaders[index + 1];
      if (typeof name !== 'string' || typeof value !== 'string') {
        return null;
      }
      const normalizedName = name.toLowerCase();
      const values = occurrences.get(normalizedName) || [];
      values.push(value);
      occurrences.set(normalizedName, values);
    }
    return occurrences;
  }

  if (req?.headersDistinct !== undefined) {
    if (!req.headersDistinct || typeof req.headersDistinct !== 'object') {
      return null;
    }
    const occurrences = new Map();
    for (const [name, values] of Object.entries(req.headersDistinct)) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        return null;
      }
      const normalizedName = String(name).toLowerCase();
      const existingValues = occurrences.get(normalizedName) || [];
      occurrences.set(normalizedName, [...existingValues, ...values]);
    }
    return occurrences;
  }

  const occurrences = new Map();
  for (const [name, value] of Object.entries(req?.headers || {})) {
    const normalizedName = String(name).toLowerCase();
    const values = occurrences.get(normalizedName) || [];
    values.push(value);
    occurrences.set(normalizedName, values);
  }
  return occurrences;
}

function exactRequestHeader(req, occurrences, expectedName) {
  const values = occurrences.get(expectedName) || [];
  if (
    values.length !== 1
    || typeof values[0] !== 'string'
    || exactScalarHeader(req?.headers, expectedName) !== values[0]
  ) {
    return null;
  }
  return values[0];
}

function hasOnlyRouterForwardingHeaders(headers, occurrences) {
  const names = new Set([
    ...Object.keys(headers || {}).map((name) => String(name).toLowerCase()),
    ...occurrences.keys(),
  ]);
  for (const normalizedName of names) {
    if (normalizedName === 'forwarded' || normalizedName === 'x-forwarded') {
      return false;
    }
    if (
      normalizedName.startsWith('x-forwarded-')
      && !ROUTER_FORWARDED_HEADER_NAMES.has(normalizedName)
    ) {
      return false;
    }
  }
  return true;
}

function hasCanonicalRouterHostname(browserUrl) {
  const hostname = String(browserUrl?.hostname || '');
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (net.isIP(literal)) {
    return true;
  }
  return hostname.length <= 253 && hostname.split('.').every(
    (label) => label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function requestMatchesCommittedOrigin(req, publicBrowserUrl, { requireOrigin = false } = {}) {
  const {
    browserUrl: expected,
    prefix,
  } = resolveCanonicalEditorBrowserUrl(publicBrowserUrl);
  const headers = req?.headers;
  const occurrences = collectHeaderOccurrences(req);
  if (
    !headers
    || !occurrences
    || !hasCanonicalRouterHostname(expected)
    || !hasOnlyRouterForwardingHeaders(headers, occurrences)
    || exactRequestHeader(req, occurrences, 'host') !== ROUTER_INTERNAL_EDITOR_HOST
    || exactRequestHeader(req, occurrences, 'x-forwarded-host') !== expected.host
    || exactRequestHeader(req, occurrences, 'x-forwarded-proto') !== expected.protocol.replace(/:$/, '')
    || exactRequestHeader(req, occurrences, 'x-forwarded-prefix') !== prefix
  ) {
    return false;
  }
  const origin = exactRequestHeader(req, occurrences, 'origin');
  if (origin === null) {
    const hasOrigin = occurrences.has('origin') || Object.keys(headers).some(
      (name) => String(name).toLowerCase() === 'origin',
    );
    if (hasOrigin) {
      return false;
    }
    return !requireOrigin;
  }
  try {
    // Origin is a serialized origin, not an arbitrary URL whose computed
    // origin happens to match. Reject credentials, paths, trailing slashes,
    // and surrounding whitespace before any upstream connection is opened.
    return origin === expected.origin && new URL(origin).origin === expected.origin;
  } catch (_) {
    return false;
  }
}

function isBlockedPath(pathname) {
  const normalizedPathname = stripOnlyOfficeVersionPrefix(pathname);
  return BLOCKED_EXACT_PATHS.has(normalizedPathname) || BLOCKED_PREFIXES.some((prefix) => normalizedPathname.startsWith(prefix));
}

function isDocumentCollaborationPath(pathname) {
  const normalizedPathname = stripOnlyOfficeVersionPrefix(pathname);
  return /^\/doc\/[A-Za-z0-9][A-Za-z0-9._-]{0,255}\/c\/?$/.test(normalizedPathname);
}

function isAllowedHttpPath(pathname) {
  const normalizedPathname = stripOnlyOfficeVersionPrefix(pathname);
  if (/^\/dictionaries\/[A-Za-z][A-Za-z0-9_-]{0,63}\/[A-Za-z][A-Za-z0-9_-]{0,63}\.(?:dic|aff)$/.test(normalizedPathname)) {
    return true;
  }
  if (normalizedPathname === '/web-apps/apps/api/documents/api.js'
      || ALLOWED_HTTP_EXACT_PATHS.has(normalizedPathname)
      || isDocumentCollaborationPath(normalizedPathname)) {
    return true;
  }
  if (/^\/cache\/files\/.+/.test(normalizedPathname)) {
    return true;
  }
  const nonCachePrefixes = ALLOWED_HTTP_PREFIXES.filter((prefix) => prefix !== '/cache/files/');
  return nonCachePrefixes.some((prefix) => normalizedPathname.startsWith(prefix));
}

function isAllowedUpgradeRequest(req, pathname) {
  return req?.method === 'GET' &&
    isDocumentCollaborationPath(pathname) &&
    String(req?.headers?.upgrade || '').toLowerCase() === 'websocket';
}

function rewriteRequestUrlForDocumentServer(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1');
  const normalizedPathname = stripOnlyOfficeVersionPrefix(url.pathname);
  if (normalizedPathname === '/document_editor_service_worker.js') {
    url.pathname = normalizedPathname;
  }
  return `${url.pathname}${url.search}`;
}

function buildTargetUrl(targetBaseUrl, requestUrl, kind) {
  const targetUrl = new URL(requestUrl, targetBaseUrl);
  if (kind !== 'ws') {
    return targetUrl.toString();
  }
  if (targetUrl.protocol === 'https:') {
    targetUrl.protocol = 'wss:';
  } else if (targetUrl.protocol === 'http:') {
    targetUrl.protocol = 'ws:';
  }
  return targetUrl.toString();
}

function sendNotFound(res) {
  res.statusCode = 404;
  res.end('Not found.');
}

export function createEditorProxy({
  targetBaseUrl,
  forwardHttp,
  forwardUpgrade,
  resolveEditorService = resolveOnlyOfficeEditorService,
} = {}) {
  if (!targetBaseUrl) {
    throw new Error('Editor proxy requires targetBaseUrl.');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || isBlockedPath(url.pathname) || !isAllowedHttpPath(url.pathname)) {
      sendNotFound(res);
      return;
    }
    const editorService = await resolveEditorService({ req });
    if (!requestMatchesCommittedOrigin(req, editorService.activeBrowserUrl)) {
      sendNotFound(res);
      return;
    }

    const plan = {
      kind: 'http',
      targetUrl: buildTargetUrl(targetBaseUrl, rewriteRequestUrlForDocumentServer(req.url), 'http'),
      headers: withCanonicalForwardingHeaders(sanitizeHeaders(req.headers), editorService.activeBrowserUrl)
    };

    if (typeof forwardHttp !== 'function') {
      res.statusCode = 502;
      res.end('Proxy forwarder is not configured.');
      return;
    }

    const result = await forwardHttp(plan, req, res);
    if (!res.finished && result) {
      res.statusCode = result.statusCode || 200;
      if (result.headers) {
        for (const [name, value] of Object.entries(result.headers)) {
          res.setHeader(name, value);
        }
      }
      res.end(result.body || '');
    }
  }

  async function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (isBlockedPath(url.pathname) || !isAllowedUpgradeRequest(req, url.pathname) || typeof forwardUpgrade !== 'function') {
      socket.destroy();
      return;
    }
    const editorService = await resolveEditorService({ req });
    if (!requestMatchesCommittedOrigin(req, editorService.activeBrowserUrl, { requireOrigin: true })) {
      socket.destroy();
      return;
    }

    const plan = {
      kind: 'ws',
      targetUrl: buildTargetUrl(targetBaseUrl, req.url, 'ws'),
      headers: withCanonicalForwardingHeaders(sanitizeHeaders(req.headers), editorService.activeBrowserUrl)
    };
    await forwardUpgrade(plan, req, socket, head);
  }

  return {
    handle,
    handleUpgrade
  };
}
