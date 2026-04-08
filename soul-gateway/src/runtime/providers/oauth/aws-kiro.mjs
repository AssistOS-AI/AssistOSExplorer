import {
    buildPkceAuthUrl,
    computeExpiryIso,
    decodeJwtPayload,
    exchangeAuthorizationCode,
    generatePkceVerifier,
} from './common.mjs';

const AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const CLIENT_ID = '59bd15eh40ee7pc20h0bkcu7id';
const REDIRECT_URI = 'http://localhost:3128/oauth/callback';
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REFRESH_URL = `${AUTH_BASE}/refreshToken`;

const verifiers = new Map();

export const oauthAdapter = {
    key: 'aws-kiro',
    flowType: 'auth_code_pkce',
    refreshMarginSeconds: 600,

    async startFlow(ctx) {
        const verifier = generatePkceVerifier();
        verifiers.set(ctx.flowId, verifier);

        return {
            type: 'pkce',
            flowType: 'auth_code_pkce',
            authUrl: buildPkceAuthUrl({
                authUrl: `${AUTH_BASE}/login`,
                clientId: CLIENT_ID,
                redirectUri: REDIRECT_URI,
                scopes: null,
                state: ctx.flowId,
                verifier,
                extraParams: {
                    idp: 'Google',
                    prompt: 'select_account',
                },
            }),
        };
    },

    async handleCallback(ctx) {
        const verifier = verifiers.get(ctx.flowId);
        if (!verifier) {
            throw new Error('AWS Kiro OAuth verifier not found or expired');
        }
        verifiers.delete(ctx.flowId);

        const tokenData = await exchangeAuthorizationCode({
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID,
            code: ctx.code,
            redirectUri: REDIRECT_URI,
            verifier,
            contentType: 'application/json',
            headers: {
                'User-Agent': 'KiroIDE-0.7.45-codex',
                Accept: 'application/json, text/plain, */*',
            },
        });

        const idPayload = decodeJwtPayload(
            tokenData.idToken || tokenData.id_token
        );
        const email = tokenData.email || idPayload?.email || null;
        const externalAccountId =
            tokenData.profileArn || idPayload?.sub || email;

        return {
            label: email || 'AWS Kiro',
            externalAccountId,
            accessToken: tokenData.accessToken || tokenData.access_token,
            refreshToken:
                tokenData.refreshToken || tokenData.refresh_token || null,
            accessTokenExpiresAt: computeExpiryIso(
                tokenData.expiresIn || tokenData.expires_in || 3600
            ),
            tokenType: tokenData.tokenType || tokenData.token_type || 'Bearer',
            metadata: {
                email,
                profileArn: tokenData.profileArn || null,
            },
        };
    },

    async refreshTokens(tokens) {
        if (!tokens.refreshToken) {
            throw new Error('AWS Kiro refresh requires a refresh token');
        }

        const response = await fetch(REFRESH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'User-Agent': 'KiroIDE-0.7.45-codex',
            },
            body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        });

        const text = await response.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text };
            }
        }
        if (!response.ok) {
            const error = new Error(
                data.message || `Kiro refresh failed (${response.status})`
            );
            error.status = response.status;
            throw error;
        }

        return {
            accessToken: data.accessToken || data.access_token,
            refreshToken: data.refreshToken || tokens.refreshToken,
            accessTokenExpiresAt: computeExpiryIso(
                data.expiresIn || data.expires_in || 3600
            ),
            tokenType: data.tokenType || data.token_type || 'Bearer',
            metadata: {
                profileArn: data.profileArn || null,
            },
        };
    },
};

export default oauthAdapter;
