import {
    computeExpiryIso,
    fetchJson,
    pollDeviceCodeOnce,
    requestDeviceCode,
    refreshAccessToken,
} from './common.mjs';

const CLIENT_ID =
    '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = 'REDACTED-GEMINI-OAUTH-CLIENT-SECRET';
const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const flows = new Map();

export const oauthAdapter = {
    key: 'google-gemini',
    flowType: 'device_code',
    refreshMarginSeconds: 300,

    async startFlow(ctx) {
        const flow = await requestDeviceCode({
            deviceCodeUrl: DEVICE_CODE_URL,
            clientId: CLIENT_ID,
            scopes: SCOPES,
        });

        flows.set(ctx.flowId, {
            deviceCode: flow.deviceCode,
            interval: flow.interval,
        });

        return {
            type: 'device-flow',
            flowType: 'device_code',
            deviceCode: flow.deviceCode,
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            verificationUriComplete: flow.verificationUriComplete,
            interval: flow.interval,
            expiresIn: flow.expiresIn,
        };
    },

    async pollDeviceFlow(ctx) {
        const flow = flows.get(ctx.flowId);
        if (!flow) {
            throw new Error('Google Gemini OAuth flow expired or not found');
        }

        const tokenData = await pollDeviceCodeOnce({
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID,
            deviceCode: flow.deviceCode,
            extraParams: {
                client_secret: CLIENT_SECRET,
            },
        });

        const user = await fetchGoogleUser(tokenData.access_token);
        flows.delete(ctx.flowId);

        return {
            label: user.email || 'Google Gemini',
            externalAccountId: user.sub || user.email || null,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token || null,
            accessTokenExpiresAt: computeExpiryIso(tokenData.expires_in),
            tokenType: tokenData.token_type || 'Bearer',
            scope: tokenData.scope || SCOPES,
            metadata: {
                email: user.email || null,
                name: user.name || null,
            },
        };
    },

    async refreshTokens(tokens) {
        if (!tokens.refreshToken) {
            throw new Error('Google Gemini refresh requires a refresh token');
        }

        const tokenData = await refreshAccessToken({
            tokenUrl: TOKEN_URL,
            clientId: CLIENT_ID,
            refreshToken: tokens.refreshToken,
            extraParams: {
                client_secret: CLIENT_SECRET,
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

async function fetchGoogleUser(accessToken) {
    try {
        return await fetchJson(USERINFO_URL, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
    } catch {
        return {};
    }
}
