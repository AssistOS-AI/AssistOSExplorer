import {
    fetchJson,
    pollDeviceCodeOnce,
    requestDeviceCode,
    computeExpiryIso,
} from './common.mjs';

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const GITHUB_API_VERSION = '2025-04-01';
const COPILOT_CHAT_VERSION = '0.26.7';

const flows = new Map();

export const oauthAdapter = {
    key: 'github-copilot',
    flowType: 'device_code',
    refreshMarginSeconds: 60,

    async startFlow(ctx) {
        const flow = await requestDeviceCode({
            deviceCodeUrl: GITHUB_DEVICE_CODE_URL,
            clientId: GITHUB_CLIENT_ID,
            scopes: 'read:user',
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
            throw new Error('Copilot OAuth flow expired or not found');
        }

        const tokenData = await pollDeviceCodeOnce({
            tokenUrl: GITHUB_TOKEN_URL,
            clientId: GITHUB_CLIENT_ID,
            deviceCode: flow.deviceCode,
        });

        const githubToken = tokenData.access_token;
        const user = await fetchGitHubUser(githubToken);
        const copilotToken = await exchangeForCopilotToken(githubToken);

        flows.delete(ctx.flowId);

        return {
            label: user.email || user.login || 'GitHub Copilot',
            externalAccountId: user.id ? String(user.id) : user.login || null,
            accessToken: copilotToken.token,
            refreshToken: githubToken,
            accessTokenExpiresAt: copilotToken.expires_at
                ? new Date(copilotToken.expires_at * 1000).toISOString()
                : computeExpiryIso(copilotToken.refresh_in || 1800),
            tokenType: 'Bearer',
            scope: tokenData.scope || 'read:user',
            metadata: {
                email: user.email || null,
                login: user.login || null,
                githubAccessToken: githubToken,
            },
        };
    },

    async refreshTokens(tokens) {
        if (!tokens.refreshToken) {
            throw new Error('Copilot refresh requires the GitHub OAuth token');
        }

        const data = await exchangeForCopilotToken(tokens.refreshToken);
        return {
            accessToken: data.token,
            refreshToken: tokens.refreshToken,
            accessTokenExpiresAt: data.expires_at
                ? new Date(data.expires_at * 1000).toISOString()
                : computeExpiryIso(data.refresh_in || 1800),
            tokenType: 'Bearer',
        };
    },
};

export default oauthAdapter;

async function fetchGitHubUser(githubToken) {
    try {
        return await fetchJson(GITHUB_USER_URL, {
            headers: {
                Authorization: `token ${githubToken}`,
                Accept: 'application/json',
                'User-Agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
            },
        });
    } catch {
        return {};
    }
}

async function exchangeForCopilotToken(githubToken) {
    return fetchJson(COPILOT_TOKEN_URL, {
        headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/json',
            'content-type': 'application/json',
            'user-agent': `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
            'x-github-api-version': GITHUB_API_VERSION,
            'editor-version': 'vscode/1.104.3',
            'editor-plugin-version': `copilot-chat/${COPILOT_CHAT_VERSION}`,
        },
    });
}
