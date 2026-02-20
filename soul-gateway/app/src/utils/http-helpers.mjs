/**
 * Read the full request body as a string.
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Read and parse JSON body.
 */
export async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * Send a JSON response.
 */
export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

/**
 * Send an error response.
 */
export function sendError(res, status, message, type = 'error') {
  sendJson(res, {
    error: { type, message, status },
  }, status);
}

/**
 * CORS headers.
 */
export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Soul-Id, X-Soul-Agent, X-Soul-Session, x-api-key, anthropic-version, anthropic-beta',
  };
}

/**
 * Handle OPTIONS preflight.
 */
export function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return true;
  }
  return false;
}

/**
 * Parse URL path and query params.
 */
export function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return {
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams),
    url,
  };
}

/**
 * Simple path pattern matcher. Returns params or null.
 * Pattern: /api/v1/soul-families/:id → matches /api/v1/soul-families/abc → { id: 'abc' }
 */
export function matchPath(pattern, pathname) {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
