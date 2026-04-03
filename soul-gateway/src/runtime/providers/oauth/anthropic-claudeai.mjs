import { buildPkceAuthUrl, computeExpiryIso, exchangeAuthorizationCode, refreshAccessToken, generatePkceVerifier } from './common.mjs';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'http://localhost:54545/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

const verifiers = new Map();

export const oauthAdapter = {
  key: 'anthropic-claudeai',
  flowType: 'auth_code_pkce',
  refreshMarginSeconds: 86_400,

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
          code: 'true',
        },
      }),
    };
  },

  async handleCallback(ctx) {
    const verifier = verifiers.get(ctx.flowId);
    if (!verifier) {
      throw new Error('Anthropic Claude.ai OAuth verifier not found or expired');
    }
    verifiers.delete(ctx.flowId);

    const [rawCode, stateFromCode] = String(ctx.code || '').split('#');
    const tokenData = await exchangeAuthorizationCode({
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      code: rawCode,
      redirectUri: REDIRECT_URI,
      verifier,
      state: stateFromCode || ctx.flowId,
      contentType: 'application/json',
      headers: {
        'User-Agent': 'claude-code/1.0.0',
        Origin: 'https://claude.ai',
        Referer: 'https://claude.ai/',
      },
    });

    return {
      label: tokenData.account?.email_address || 'Anthropic Claude.ai',
      externalAccountId: tokenData.account?.uuid || tokenData.account?.email_address || null,
      accessToken: tokenData.access_token || tokenData.key,
      refreshToken: tokenData.refresh_token || null,
      accessTokenExpiresAt: computeExpiryIso(tokenData.expires_in, 365 * 24 * 60 * 60 * 1000),
      tokenType: tokenData.token_type || 'Bearer',
      scope: SCOPES,
      metadata: {
        email: tokenData.account?.email_address || null,
        organizationUuid: tokenData.organization?.uuid || null,
        organizationName: tokenData.organization?.name || null,
      },
    };
  },

  async refreshTokens(tokens) {
    if (!tokens.refreshToken) {
      if (tokens.accessToken) {
        return {
          accessToken: tokens.accessToken,
          refreshToken: null,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt || null,
          tokenType: tokens.tokenType || 'Bearer',
        };
      }
      throw new Error('Anthropic Claude.ai refresh requires a refresh token');
    }

    const tokenData = await refreshAccessToken({
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      refreshToken: tokens.refreshToken,
      contentType: 'application/json',
    });

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || tokens.refreshToken,
      accessTokenExpiresAt: computeExpiryIso(tokenData.expires_in, 365 * 24 * 60 * 60 * 1000),
      tokenType: tokenData.token_type || 'Bearer',
    };
  },
};

export default oauthAdapter;
