import { generatePKCE, buildAuthUrl, startCallbackServer, exchangeCodeForTokens } from '../pkce-flow.mjs';
import { createLogger } from '../../utils/logger.mjs';
import { randomUUID } from 'node:crypto';

const log = createLogger('gemini-auth');

const verifiers = new Map();

export default {
  name: 'gemini',
  authType: 'pkce',
  callbackPort: 51121,
  refreshMarginMs: 5 * 60 * 1000,

  config: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: 'REDACTED-GEMINI-OAUTH-CLIENT-SECRET',
    scopes: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    callbackPort: 51121,
    redirectUri: 'http://localhost:51121/callback',
    tokenContentType: 'application/x-www-form-urlencoded',
    extraAuthParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
    extraTokenParams: {
      client_secret: 'REDACTED-GEMINI-OAUTH-CLIENT-SECRET',
    },
  },

  async startAuth() {
    const { verifier, challenge } = generatePKCE();
    const state = randomUUID();
    verifiers.set(state, verifier);
    setTimeout(() => verifiers.delete(state), 10 * 60 * 1000);

    const authUrl = buildAuthUrl(this.config, challenge, state);

    const { waitForCallback } = startCallbackServer(this.config.callbackPort);

    waitForCallback().then(async ({ code, state: cbState, error }) => {
      if (error || !code) {
        log.error('Gemini OAuth callback error', { error });
        return;
      }
    }).catch(err => log.error('Gemini callback error', { error: err.message }));

    return { authUrl };
  },

  async exchangeCode(code, state) {
    const verifier = verifiers.get(state);
    if (!verifier) throw new Error('No PKCE verifier found for this state');
    verifiers.delete(state);

    const tokenRes = await exchangeCodeForTokens(this.config, code, verifier);

    return {
      accessToken: tokenRes.access_token,
      refreshToken: tokenRes.refresh_token || null,
      expiresAt: tokenRes.expires_in ? Date.now() + tokenRes.expires_in * 1000 : null,
      email: tokenRes.email || null,
    };
  },

  async refreshToken(creds) {
    if (!creds.refreshToken) throw new Error('No refresh token available');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: creds.refreshToken,
    });

    const res = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
    const data = await res.json();

    return {
      ...creds,
      accessToken: data.access_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
    };
  },

  async getHeaders(creds) {
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    };
  },

  // Known Gemini models (model discovery via /models may fail with OAuth tokens)
  knownModels: [
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
    'gemini-2.0-flash', 'gemini-2.0-flash-lite',
    'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.5-flash-8b',
    'gemini-3-flash', 'gemini-3.1-pro',
  ],

  formatConverter: null,
  credentialsDir: '/shared/soul-gateway/providers/gemini/',
};
