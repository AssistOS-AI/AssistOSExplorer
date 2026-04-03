import { buildPkceAuthUrl, computeExpiryIso, decodeJwtPayload, exchangeAuthorizationCode, refreshAccessToken, generatePkceVerifier } from './common.mjs';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPES = 'openid email profile offline_access';

const verifiers = new Map();

export const oauthAdapter = {
  key: 'openai-codex',
  flowType: 'auth_code_pkce',
  refreshMarginSeconds: 300,

  async startFlow(ctx) {
    const verifier = generatePkceVerifier();
    verifiers.set(ctx.flowId, verifier);

    return {
      type: 'pkce',
      flowType: 'auth_code_pkce',
      authUrl: buildPkceAuthUrl({
        authUrl: AUTH_URL,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES,
        state: ctx.flowId,
        verifier,
        extraParams: {
          audience: 'https://api.openai.com/v1',
          codex_cli_simplified_flow: 'true',
          id_token_add_organizations: 'true',
          prompt: 'login',
        },
      }),
    };
  },

  async handleCallback(ctx) {
    const verifier = verifiers.get(ctx.flowId);
    if (!verifier) {
      throw new Error('OpenAI Codex OAuth verifier not found or expired');
    }
    verifiers.delete(ctx.flowId);

    const tokenData = await exchangeAuthorizationCode({
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      code: ctx.code,
      redirectUri: REDIRECT_URI,
      verifier,
      contentType: 'application/x-www-form-urlencoded',
    });

    const idPayload = decodeJwtPayload(tokenData.id_token);
    const externalAccountId = idPayload?.sub || idPayload?.email || null;
    const email = idPayload?.email || null;

    return {
      label: email || 'OpenAI Codex',
      externalAccountId,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      accessTokenExpiresAt: computeExpiryIso(tokenData.expires_in),
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || SCOPES,
      metadata: {
        email,
        idToken: tokenData.id_token || null,
      },
    };
  },

  async refreshTokens(tokens) {
    if (!tokens.refreshToken) {
      throw new Error('OpenAI Codex refresh requires a refresh token');
    }

    const tokenData = await refreshAccessToken({
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      refreshToken: tokens.refreshToken,
      extraParams: {
        scope: SCOPES,
      },
    });

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || tokens.refreshToken,
      accessTokenExpiresAt: computeExpiryIso(tokenData.expires_in),
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || SCOPES,
    };
  },
};

export default oauthAdapter;
