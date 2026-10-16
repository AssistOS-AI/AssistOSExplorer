import { decodeJwtPayload, fetchJson } from './common.mjs';

// Public native-app client used by the Grok CLI device authorization flow.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const AUTH_BASE = 'https://auth.x.ai/oauth2';
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';

function oauthError(code, message, terminalOAuthFlow = false) {
    return Object.assign(new Error(message), { code, terminalOAuthFlow });
}

async function postForm(path, fields) {
    try {
        return await fetchJson(`${AUTH_BASE}/${path}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'soul-gateway/2.0',
            },
            body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }).toString(),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (err) {
        // Provider response bodies can contain credentials; expose only known codes.
        const code = ['authorization_pending', 'slow_down', 'access_denied',
            'authorization_denied', 'expired_token'].includes(err.code)
            ? err.code : 'oauth_error';
        throw oauthError(code, `SuperGrok authorization failed (${code})`);
    }
}

function positiveSeconds(value, fallback) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function credentials(data, now, previousRefreshToken = null) {
    if (typeof data.access_token !== 'string' || !data.access_token ||
        !(data.refresh_token || previousRefreshToken)) {
        throw oauthError('invalid_token_response', 'SuperGrok returned incomplete tokens', true);
    }
    // JWT claims only supply display metadata and an earlier refresh deadline.
    const identity = decodeJwtPayload(data.id_token);
    const access = decodeJwtPayload(data.access_token);
    const deadline = now + positiveSeconds(data.expires_in, 3600) * 1000;
    const jwtDeadline = Number(access?.exp) * 1000;
    return {
        label: identity?.email || 'SuperGrok',
        externalAccountId: identity?.sub || access?.sub || null,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || previousRefreshToken,
        accessTokenExpiresAt: new Date(Number.isFinite(jwtDeadline) && jwtDeadline > 0
            ? Math.min(deadline, jwtDeadline) : deadline).toISOString(),
        tokenType: 'Bearer',
        scope: data.scope || SCOPE,
    };
}

export function createSuperGrokAdapter({ now = Date.now } = {}) {
    return {
        key: 'xai-supergrok',
        flowType: 'device_code',
        refreshMarginSeconds: 120,

        async startFlow() {
            const data = await postForm('device/code', { scope: SCOPE });
            if (!data.device_code || !data.user_code || !data.verification_uri) {
                throw new Error('SuperGrok returned an incomplete device authorization');
            }
            const interval = Math.max(1, positiveSeconds(data.interval, 5));
            const expiresIn = positiveSeconds(data.expires_in, 300);
            return {
                userCode: data.user_code,
                verificationUri: data.verification_uri,
                verificationUriComplete: data.verification_uri_complete || null,
                interval,
                expiresIn,
                // OAuthManager retains this state privately and returns only public fields.
                deviceState: {
                    code: data.device_code,
                    deadline: now() + expiresIn * 1000,
                    intervalMs: interval * 1000,
                    nextPoll: now() + interval * 1000,
                    polling: false,
                },
            };
        },

        async pollDeviceFlow(ctx) {
            const state = ctx.deviceState;
            if (!state?.code || now() >= state.deadline) {
                if (state) state.code = null;
                throw oauthError('expired_token', 'SuperGrok authorization expired; add the account again', true);
            }
            if (state.polling || now() < state.nextPoll) {
                throw oauthError('authorization_pending', 'SuperGrok authorization pending');
            }
            state.polling = true;
            try {
                const data = await postForm('token', {
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: state.code,
                });
                const result = credentials(data, now());
                state.code = null;
                return result;
            } catch (err) {
                if (err.code === 'slow_down') state.intervalMs += 5000;
                if (!['slow_down', 'authorization_pending'].includes(err.code)) {
                    state.code = null;
                    err.terminalOAuthFlow = true;
                }
                throw err;
            } finally {
                state.nextPoll = now() + state.intervalMs;
                state.polling = false;
            }
        },

        async refreshTokens(tokens) {
            if (!tokens.refreshToken) throw new Error('SuperGrok refresh token is missing');
            const data = await postForm('token', {
                grant_type: 'refresh_token',
                refresh_token: tokens.refreshToken,
            });
            return credentials(data, now(), tokens.refreshToken);
        },
    };
}

export const oauthAdapter = createSuperGrokAdapter();
export default oauthAdapter;
