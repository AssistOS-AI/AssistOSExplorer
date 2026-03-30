import { generatePKCE, buildAuthUrl, startCallbackServer, exchangeCodeForTokens } from '../pkce-flow.mjs';
import { createLogger } from '../../utils/logger.mjs';
import { randomUUID } from 'node:crypto';

const log = createLogger('anthropic-auth');

const verifiers = new Map();

export default {
  name: 'anthropic',
  authType: 'pkce',
  callbackPort: 54545,
  refreshMarginMs: 24 * 60 * 60 * 1000, // 1 day — tokens last ~1 year

  config: {
    authUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://claude.ai/oauth/token',
    clientId: process.env.ANTHROPIC_OAUTH_CLIENT_ID || '',
    scopes: '',
    callbackPort: 54545,
    redirectUri: 'http://localhost:54545/oauth/callback',
    tokenContentType: 'application/x-www-form-urlencoded',
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
        log.error('Anthropic OAuth callback error', { error });
        return;
      }
    }).catch(err => log.error('Anthropic callback error', { error: err.message }));

    return { authUrl };
  },

  async exchangeCode(code, state) {
    const verifier = verifiers.get(state);
    if (!verifier) throw new Error('No PKCE verifier found for this state');
    verifiers.delete(state);

    const tokenRes = await exchangeCodeForTokens(this.config, code, verifier);

    return {
      accessToken: tokenRes.access_token || tokenRes.key,
      refreshToken: null, // Anthropic tokens are long-lived (~1 year)
      expiresAt: tokenRes.expires_in ? Date.now() + tokenRes.expires_in * 1000 : Date.now() + 365 * 24 * 60 * 60 * 1000,
      email: tokenRes.email || null,
    };
  },

  async refreshToken(creds) {
    // Anthropic tokens last ~1 year, no refresh needed
    // If token is actually expired, user must re-auth
    if (creds.expiresAt && Date.now() > creds.expiresAt) {
      throw new Error('Anthropic token expired — re-authentication required');
    }
    return creds;
  },

  async getHeaders(creds) {
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
    };
  },

  formatConverter: null, // Anthropic format handled by existing anthropic-proxy.mjs
  credentialsDir: '/shared/soul-gateway/providers/anthropic/',
};
