import { createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { getAuthPolicy } from '../policy.mjs';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_CALLBACK_PATH = '/service/auth/google/callback';
const VARIABLES = ['USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_CLIENT_SECRET', 'USERPERSISTO_GOOGLE_REDIRECT_URI', 'USERPERSISTO_SETTINGS_KEY'];

export function googleError(code = 'google_authentication_failed', statusCode = 400) {
    return Object.assign(new Error('Unable to continue with Google. Start sign-in again or use an existing sign-in method.'), { code, statusCode });
}

function configuration() {
    const [clientId, clientSecret, redirectUri, settingsKey] = VARIABLES.map((name) => String(process.env[name] || '').trim());
    const missing = VARIABLES.filter((name) => !String(process.env[name] || '').trim());
    let redirect;
    try {
        redirect = new URL(redirectUri);
        if (redirect.href !== redirectUri || redirect.username || redirect.password || redirect.search || redirect.hash
            || !redirect.pathname.endsWith(GOOGLE_CALLBACK_PATH)
            || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)))) redirect = null;
    } catch { redirect = null; }
    const valid = !missing.length && !!redirect && clientId.length <= 512 && clientSecret.length <= 4096;
    return { clientId, clientSecret, redirectUri, redirect, missing, valid,
        fingerprint: createHash('sha256').update(JSON.stringify([GOOGLE_ISSUER, clientId, clientSecret, redirectUri, settingsKey])).digest('base64url') };
}

// Google is usable during unclaimed setup too: the first completed Google
// sign-in may claim the initial administrator through the setup decision.
export async function getGoogleStatus() {
    const config = configuration();
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods.includes('google');
    return { enabled, configured: config.valid, available: enabled && config.valid,
        missing: config.missing, redirectUri: config.redirect?.href || '', clientId: config.clientId,
        secretPresent: !!config.clientSecret, configurationSource: 'environment',
        policySource: process.env.USERPERSISTO_AUTH_METHODS?.trim() ? 'environment' : 'stored-or-default',
        reason: !enabled ? 'disabled' : !config.valid ? 'configuration_incomplete' : 'ready' };
}

export async function requireGoogleConfiguration() {
    if (!(await getGoogleStatus()).available) throw googleError('google_unavailable', 403);
    return configuration();
}

// The injectable discovery function is a construction-only test seam. Neither
// environment variables nor HTTP input can select an upstream issuer or disable TLS.
export function createGoogleProtocol({ discover = (config) => oidc.discovery(new URL(GOOGLE_ISSUER), config.clientId,
    { id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 30 }, oidc.ClientSecretPost(config.clientSecret),
    { timeout: 10, execute: [oidc.enableNonRepudiationChecks] }) } = {}) {
    let cached;
    async function client(config) {
        if (!cached || cached.fingerprint !== config.fingerprint) {
            const entry = { fingerprint: config.fingerprint };
            entry.promise = discover(config).catch(() => {
                if (cached === entry) cached = undefined;
                throw googleError('google_provider_unavailable', 503);
            });
            cached = entry;
        }
        return cached.promise;
    }
    return {
        async authorization(config, { reauthentication = false } = {}) {
            const provider = await client(config);
            const verifier = oidc.randomPKCECodeVerifier();
            const state = oidc.randomState();
            const nonce = oidc.randomNonce();
            const url = oidc.buildAuthorizationUrl(provider, { scope: 'openid email', response_type: 'code', response_mode: 'query',
                redirect_uri: config.redirectUri, state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
                ...(reauthentication ? { prompt: 'select_account', claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) } : {}) });
            return { url: url.href, state, nonce, verifier };
        },
        async exchange(config, callback, payload) {
            try {
                const provider = await client(config);
                const tokens = await oidc.authorizationCodeGrant(provider, callback, {
                    pkceCodeVerifier: payload.verifier, expectedState: payload.state, expectedNonce: payload.nonce, idTokenExpected: true,
                });
                const claims = tokens.claims();
                const now = Math.floor(Date.now() / 1000);
                const issuer = provider.serverMetadata().issuer;
                if (!tokens.id_token || !claims || claims.iss !== issuer
                    || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || /[\u0000-\u0020\u007f]/.test(claims.sub)
                    || (claims.azp !== undefined && claims.azp !== config.clientId)
                    || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId)
                    || !(Array.isArray(claims.aud) ? claims.aud.includes(config.clientId) : claims.aud === config.clientId)
                    || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 600
                    || !Number.isSafeInteger(claims.exp) || claims.exp <= now - 30 || claims.exp <= claims.iat
                    || typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
                    || claims.email_verified !== true
                    || (claims.hd !== undefined && (typeof claims.hd !== 'string' || !/^[A-Za-z0-9.-]+$/.test(claims.hd) || claims.hd.length > 253))) {
                    throw googleError();
                }
                // Google's supported account chooser does not guarantee a new
                // credential prompt. Require its signed authentication time;
                // neither fresh token issuance nor consent is fresh proof.
                if (payload.flow === 'reauth' && (!Number.isSafeInteger(claims.auth_time)
                    || claims.auth_time < now - 300 || claims.auth_time > now + 30)) {
                    throw googleError('google_recent_authentication_required', 401);
                }
                return { issuer: GOOGLE_ISSUER, subject: claims.sub, email: claims.email.trim().toLowerCase(), emailVerified: true,
                    ...(payload.flow === 'reauth' ? { authenticatedAt: claims.auth_time * 1000 } : {}),
                    ...(claims.hd ? { hostedDomain: claims.hd.toLowerCase() } : {}) };
            } catch (error) {
                if (error?.code === 'google_recent_authentication_required') throw error;
                throw googleError();
            }
        },
    };
}
