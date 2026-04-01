import { generatePKCE, buildAuthUrl, startCallbackServer, exchangeCodeForTokens } from '../pkce-flow.mjs';
import anthropicMessagesConverter from '../format-converters/anthropic-messages.mjs';
import { createLogger } from '../../utils/logger.mjs';
import { randomUUID } from 'node:crypto';

const log = createLogger('anthropic-auth');

const verifiers = new Map();

export default {
  name: 'anthropic',
  authType: 'pkce',
  callbackPort: 54545,
  refreshMarginMs: 24 * 60 * 60 * 1000, // 1 day — tokens last ~1 year

  // Provider template for auto-provisioning in DB.
  // NOTE: Direct Anthropic API calls with OAuth tokens require Chrome TLS
  // fingerprinting (utls) due to Cloudflare. CLIProxyAPIPlus handles this
  // with utls_transport.go. Node.js fetch() lacks this, so we route through
  // CLIProxyAPIPlus which has proper TLS fingerprinting.
  providerTemplate: {
    display_name: 'Anthropic Claude (OAuth)',
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com/v1/messages',
    billing_type: 'subscription',
    auth_type: 'managed',
  },

  config: {
    authUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scopes: 'org:create_api_key user:profile user:inference',
    callbackPort: 54545,
    redirectUri: 'http://localhost:54545/callback',
    tokenContentType: 'application/json',
    extraAuthParams: {
      code: 'true',
    },
    extraTokenHeaders: {
      'User-Agent': 'claude-code/1.0.0',
      'Origin': 'https://claude.ai',
      'Referer': 'https://claude.ai/',
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

    // Anthropic uses a specific JSON body format (matching CLIProxyAPI Go source)
    // Code may contain state after # separator
    const codeParts = code.split('#');
    const parsedCode = codeParts[0];
    const parsedState = codeParts[1] || state;

    const body = {
      code: parsedCode,
      state: parsedState,
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier,
    };

    log.info('Anthropic token exchange', { tokenUrl: this.config.tokenUrl, hasCode: !!parsedCode, hasVerifier: !!verifier });

    const res = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(this.config.extraTokenHeaders || {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    const tokenRes = await res.json();
    const accessToken = tokenRes.access_token || tokenRes.key;

    let email = tokenRes.email || null;
    // Extract email from account object in token response
    if (!email && tokenRes.account?.email_address) {
      email = tokenRes.account.email_address;
    }

    return {
      accessToken,
      refreshToken: null, // Anthropic tokens are long-lived (~1 year)
      expiresAt: tokenRes.expires_in ? Date.now() + tokenRes.expires_in * 1000 : Date.now() + 365 * 24 * 60 * 60 * 1000,
      email,
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

  async validateToken(creds) {
    try {
      // Use /v1/messages with a minimal invalid request — a 400 (bad request)
      // means the token is valid; 401/403 means it's not
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [] }),
        signal: AbortSignal.timeout(10000),
      });
      // 400 = token works but request is invalid (expected), 401/403 = token dead
      return res.status !== 401 && res.status !== 403;
    } catch {
      return false;
    }
  },

  async getHeaders(creds) {
    // OAuth tokens (sk-ant-oat01-...) MUST use Authorization: Bearer,
    // NOT x-api-key. The x-api-key header is only for true API keys.
    // Critical: anthropic-beta must include "oauth-2025-04-20" to enable
    // OAuth token auth — without it Anthropic returns "OAuth authentication
    // is currently not supported". Headers match CLIProxyAPIPlus
    // claude_executor.go applyClaudeHeaders().
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
    };
  },

  knownModels: [
    'claude-sonnet-4-6', 'claude-opus-4-6',
    'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805',
    'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
    'claude-3-haiku-20240307',
  ],

  formatConverter: anthropicMessagesConverter, // Convert OpenAI chat → Anthropic Messages API
  credentialsDir: '/shared/soul-gateway/providers/anthropic/',
};
