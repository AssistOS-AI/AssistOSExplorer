import { generatePKCE, buildAuthUrl, startCallbackServer, exchangeCodeForTokens } from '../pkce-flow.mjs';
import { createResponsesOnlyConverter } from '../format-converters/copilot-responses.mjs';
import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('codex-auth');

// PKCE state → verifier mapping
const verifiers = new Map();

export default {
  name: 'codex',
  authType: 'pkce',
  callbackPort: 1455,
  refreshMarginMs: 5 * 60 * 1000, // 5 minutes

  // Provider template for auto-provisioning in DB
  providerTemplate: {
    display_name: 'OpenAI Codex (OAuth)',
    protocol: 'openai',
    base_url: 'https://chatgpt.com/backend-api/codex',
    billing_type: 'subscription',
    auth_type: 'managed',
  },

  config: {
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scopes: 'openid email profile offline_access',
    callbackPort: 1455,
    redirectUri: 'http://localhost:1455/auth/callback',
    tokenContentType: 'application/x-www-form-urlencoded',
    extraAuthParams: {
      audience: 'https://api.openai.com/v1',
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
      prompt: 'login',
    },
  },

  async startAuth() {
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomUUID();
    verifiers.set(state, verifier);
    setTimeout(() => verifiers.delete(state), 10 * 60 * 1000); // cleanup after 10min

    const authUrl = buildAuthUrl(this.config, challenge, state);

    // Start callback server
    const { waitForCallback } = startCallbackServer(this.config.callbackPort);

    // Wait for callback in background, then exchange code
    waitForCallback().then(async ({ code, state: cbState, error }) => {
      if (error || !code) {
        log.error('Codex OAuth callback error', { error });
        return;
      }
      const v = verifiers.get(cbState);
      if (!v) {
        log.error('No verifier found for state', { state: cbState });
        return;
      }
      verifiers.delete(cbState);
      // exchangeCode will be called by auth-manager via handlePKCECallback
    }).catch(err => log.error('Codex callback error', { error: err.message }));

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
      email: null, // OpenAI doesn't return email in token response
    };
  },

  async refreshToken(creds) {
    if (!creds.refreshToken) throw new Error('No refresh token available');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: creds.refreshToken,
    });

    const res = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`Codex token refresh failed: ${res.status}`);
    const data = await res.json();

    return {
      ...creds,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
    };
  },

  async getHeaders(creds) {
    return {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'User-Agent': 'codex-cli/1.0.0',
    };
  },

  // Known Codex/OpenAI models (token scope doesn't allow /v1/models listing)
  knownModels: [
    'gpt-5.4', 'gpt-5.4-mini',
    'gpt-5.3-codex', 'gpt-5.3-codex-spark',
    'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'gpt-5.1',
    'gpt-5-codex', 'gpt-5-codex-mini', 'gpt-5',
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini',
    'o3', 'o3-mini', 'o4-mini',
  ],

  // Codex backend only serves the Responses API (no /chat/completions)
  // All models go to chatgpt.com/backend-api/codex/responses
  formatConverter: createResponsesOnlyConverter('codex-responses'),
  credentialsDir: '/shared/soul-gateway/providers/codex/',
};
