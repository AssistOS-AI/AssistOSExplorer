import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { createLogger } from '../utils/logger.mjs';

const log = createLogger('pkce-flow');

/**
 * Generate PKCE code verifier and challenge.
 * @returns {{ verifier: string, challenge: string }}
 */
export function generatePKCE() {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the authorization URL with PKCE parameters.
 */
export function buildAuthUrl(config, challenge, state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    response_type: 'code',
    ...(config.scopes ? { scope: config.scopes } : {}),
    ...(config.extraAuthParams || {}),
  });
  return `${config.authUrl}?${params.toString()}`;
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 * Returns a promise that resolves when the callback is received.
 * @param {number} port
 * @param {number} [timeoutMs=600000] - timeout in ms (default 10 minutes)
 * @returns {{ server, waitForCallback: () => Promise<{ code, state, error }>, close: () => void }}
 */
export function startCallbackServer(port, timeoutMs = 600_000) {
  let resolveCallback, rejectCallback;
  const callbackPromise = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/oauth/callback' || url.pathname === '/auth/callback' || url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>OAuth Error: ${error}</h2><p>You can close this window.</p></body></html>`);
        resolveCallback({ code: null, state, error });
      } else if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window and return to Soul Gateway.</p></body></html>');
        resolveCallback({ code, state, error: null });
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Missing authorization code</h2></body></html>');
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const timeout = setTimeout(() => {
    rejectCallback(new Error('OAuth callback timed out'));
    server.close();
  }, timeoutMs);

  server.listen(port, '127.0.0.1', () => {
    log.info(`PKCE callback server listening on port ${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.warn(`Port ${port} already in use for OAuth callback`);
      rejectCallback(new Error(`Port ${port} in use — another auth flow may be active`));
    } else {
      rejectCallback(err);
    }
  });

  return {
    server,
    waitForCallback: () => callbackPromise.finally(() => {
      clearTimeout(timeout);
      server.close();
    }),
    close: () => {
      clearTimeout(timeout);
      server.close();
    },
  };
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCodeForTokens(config, code, verifier) {
  const isJson = config.tokenContentType === 'application/json';

  const body = isJson
    ? JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
        ...(config.extraTokenParams || {}),
      })
    : new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: config.redirectUri,
        ...(config.extraTokenParams || {}),
      }).toString();

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      ...(config.extraTokenHeaders || {}),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}
