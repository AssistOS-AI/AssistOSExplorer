import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { generatePKCE, buildAuthUrl, startCallbackServer, exchangeCodeForTokens } from '../pkce-flow.mjs';
import kiroEventStreamConverter from '../format-converters/kiro-eventstream.mjs';
import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('adapter:kiro');

// ---- Constants (ported from kiro-gateway server.mjs lines 23-38) ----

const KIRO_AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const COGNITO_DOMAIN = 'kiro-prod-us-east-1.auth.us-east-1.amazoncognito.com';
const CLIENT_ID = '59bd15eh40ee7pc20h0bkcu7id';
const SCOPES = 'email openid';
const REFRESH_ENDPOINT = `${KIRO_AUTH_BASE}/refreshToken`;
const KIRO_API_HOST = 'q.us-east-1.amazonaws.com';
const OAUTH_CALLBACK_PORT = 3128;
const REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}/oauth/callback`;

const FINGERPRINT = randomBytes(8).toString('hex');
const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

// ---- PKCE verifier store: state -> verifier (cleanup after 10 min) ----

const pkceVerifiers = new Map();

function storePKCEVerifier(state, verifier) {
  pkceVerifiers.set(state, verifier);
  setTimeout(() => pkceVerifiers.delete(state), 10 * 60 * 1000);
}

// ---- JWT decode (no verification) ----

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ---- Adapter interface ----

export default {
  name: 'axiologic_kiro',
  authType: 'pkce',
  callbackPort: OAUTH_CALLBACK_PORT,
  refreshMarginMs: TOKEN_REFRESH_MARGIN_MS,

  // Provider template for auto-provisioning in DB
  providerTemplate: {
    display_name: 'Kiro (AWS Claude)',
    protocol: 'openai',
    base_url: `https://${KIRO_API_HOST}/generateAssistantResponse`,
    billing_type: 'subscription',
    auth_type: 'managed',
  },

  formatConverter: kiroEventStreamConverter,

  /**
   * Start the Kiro PKCE auth flow.
   * Generates PKCE challenge, builds auth URL via Kiro auth service, starts callback server.
   * Returns { authUrl } for auth-manager.
   */
  async startAuth() {
    const { verifier, challenge } = generatePKCE();
    const state = randomBytes(16).toString('hex');

    storePKCEVerifier(state, verifier);

    // Build auth URL using Kiro auth service /login endpoint (not Cognito directly).
    // Format: /login?idp=Google&redirect_uri=...&code_challenge=...&code_challenge_method=S256&state=...
    const authUrl = buildAuthUrl(
      {
        authUrl: `${KIRO_AUTH_BASE}/login`,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scopes: null, // Kiro login endpoint doesn't take scope param
        extraAuthParams: {
          idp: 'Google',
          prompt: 'select_account',
        },
      },
      challenge,
      state
    );

    log.info('PKCE auth flow started', { authUrl: authUrl.slice(0, 120) + '...' });

    return { authUrl };
  },

  /**
   * Exchange the authorization code for tokens via Kiro Desktop Auth service.
   * Called by auth-manager when the PKCE callback arrives.
   *
   * @param {string} code - authorization code from callback
   * @param {string} state - state parameter from callback (maps to stored verifier)
   * @returns {{ accessToken, refreshToken, expiresAt, email, profileArn }}
   */
  async exchangeCode(code, state) {
    const verifier = pkceVerifiers.get(state);
    if (!verifier) {
      throw new Error('Invalid or expired PKCE state — verifier not found');
    }
    pkceVerifiers.delete(state);

    // Kiro Desktop Auth uses JSON body with code, code_verifier, redirect_uri
    // (ported from kiro-gateway lines 1178-1192)
    const tokenData = await exchangeCodeForTokens(
      {
        tokenUrl: `${KIRO_AUTH_BASE}/oauth/token`,
        tokenContentType: 'application/json',
        redirectUri: REDIRECT_URI,
        extraTokenHeaders: {
          'User-Agent': `KiroIDE-0.7.45-${FINGERPRINT}`,
          'Accept': 'application/json, text/plain, */*',
        },
      },
      code,
      verifier
    );

    // Kiro Desktop Auth returns camelCase: accessToken, refreshToken, expiresIn, profileArn
    const creds = {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: Date.now() + (tokenData.expiresIn || 3600) * 1000,
      email: tokenData.email || null,
      profileArn: tokenData.profileArn || null,
    };

    // If no email in response, try to decode from JWT idToken
    if (!creds.email && tokenData.idToken) {
      const idPayload = decodeJwtPayload(tokenData.idToken);
      creds.email = idPayload?.email || null;
    }

    log.info('Token exchange complete', { email: creds.email });
    return creds;
  },

  /**
   * Refresh an expiring Kiro token using the stored refresh token.
   * Ported from kiro-gateway lines 291-324.
   *
   * @param {{ refreshToken: string }} creds
   * @returns {{ accessToken, refreshToken?, expiresAt, profileArn? }}
   */
  async refreshToken(creds) {
    if (!creds.refreshToken) {
      throw new Error('No refresh token available for Kiro token refresh');
    }

    log.debug('Refreshing Kiro token');

    const res = await fetch(REFRESH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `KiroIDE-0.7.45-${randomBytes(8).toString('hex')}`,
      },
      body: JSON.stringify({ refreshToken: creds.refreshToken }),
    });

    if (!res.ok) {
      const body = await res.text();
      log.error('Kiro token refresh failed', { status: res.status, body: body.slice(0, 200) });
      throw new Error(`Kiro token refresh failed: ${res.status}`);
    }

    const data = await res.json();

    const updated = {
      accessToken: data.accessToken,
      expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
    };

    // Kiro may rotate the refresh token
    if (data.refreshToken) {
      updated.refreshToken = data.refreshToken;
    }

    if (data.profileArn) {
      updated.profileArn = data.profileArn;
    }

    log.info('Kiro token refreshed');
    return updated;
  },

  /**
   * Build Kiro-specific request headers for upstream API calls.
   * Spoofs KiroIDE identity as required by the Kiro API.
   * Ported from kiro-gateway lines 350-362.
   *
   * @param {{ accessToken: string }} creds
   * @returns {object} headers
   */
  async getHeaders(creds) {
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': `aws-sdk-js/1.0.27 KiroIDE-0.7.45-${FINGERPRINT}`,
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-agent-mode': 'vibe',
      'amz-sdk-invocation-id': randomUUID(),
      'amz-sdk-request': 'attempt=1; max=3',
    };
  },
};
