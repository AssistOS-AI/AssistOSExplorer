import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getAuthPolicy } from '../policy.mjs';
import { googleOnlyAuthentication } from './production.mjs';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_CALLBACK_PATH = '/service/auth/google/callback';
export const GOOGLE_LOCAL_CLIENT_ID = '709999050125-42jmthte7dsv6822o2u8bt20m1ntv7p0.apps.googleusercontent.com';
export const GOOGLE_LOCAL_REDIRECT_URI = `http://localhost:8080/base-agent-additional-server/userPersistoAgent/7000${GOOGLE_CALLBACK_PATH}`;
const GOOGLE_TOKEN_ISSUERS = [GOOGLE_ISSUER, 'accounts.google.com'];
const VARIABLES = ['USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_REDIRECT_URI', 'USERPERSISTO_SETTINGS_KEY'];
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    timeoutDuration: 10_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
});

export function googleError(code = 'google_authentication_failed', statusCode = 400) {
    return Object.assign(new Error('Unable to continue with Google. Start sign-in again or use an existing sign-in method.'), { code, statusCode });
}

function configuration() {
    let [clientId, redirectUri, settingsKey] = VARIABLES.map((name) => String(process.env[name] || '').trim());
    const localDefault = !clientId && !redirectUri;
    if (localDefault) {
        clientId = GOOGLE_LOCAL_CLIENT_ID;
        redirectUri = GOOGLE_LOCAL_REDIRECT_URI;
    }
    const required = { USERPERSISTO_GOOGLE_CLIENT_ID: clientId, USERPERSISTO_GOOGLE_REDIRECT_URI: redirectUri, USERPERSISTO_SETTINGS_KEY: settingsKey };
    const missing = Object.keys(required).filter((name) => !required[name]);
    let redirect;
    try {
        redirect = new URL(redirectUri);
        if (redirect.href !== redirectUri || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname.startsWith('//')
            || !redirect.pathname.endsWith(GOOGLE_CALLBACK_PATH)
            || (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)))) redirect = null;
    } catch { redirect = null; }
    // Defaults remain local. An operator may explicitly pair the distributed
    // public client with an HTTPS deployment whose origin its owner registered
    // with Google; this never infers an origin or relaxes shared HTTP origins.
    const explicitHttps = !localDefault && !!clientId && !!redirectUri && redirect?.protocol === 'https:';
    const originAllowed = clientId !== GOOGLE_LOCAL_CLIENT_ID || explicitHttps
        || ['http://localhost:8080', 'http://127.0.0.1:8080'].includes(redirect?.origin);
    const valid = !missing.length && !!redirect && originAllowed && clientId.length <= 512 && !/\s/.test(clientId);
    return { mode: 'gis', clientId, redirectUri, redirect, missing, valid, configurationSource: localDefault ? 'local-default' : 'environment',
        fingerprint: createHash('sha256').update(JSON.stringify([GOOGLE_ISSUER, 'gis', clientId, redirectUri, settingsKey])).digest('base64url') };
}

// Google is usable during unclaimed setup too: the first completed Google
// sign-in may claim the initial administrator through the setup decision.
export async function getGoogleStatus() {
    const config = configuration();
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods.includes('google');
    return { enabled, configured: config.valid, available: enabled && config.valid,
        mode: config.mode, missing: config.missing, redirectUri: config.redirect?.href || '', clientId: config.clientId,
        secretRequired: false, configurationSource: config.configurationSource,
        policySource: googleOnlyAuthentication() ? 'production' : process.env.USERPERSISTO_AUTH_METHODS?.trim() ? 'environment' : 'stored-or-default',
        reason: !enabled ? 'disabled' : !config.valid ? 'configuration_incomplete' : 'ready' };
}

export async function requireGoogleConfiguration() {
    if (!(await getGoogleStatus()).available) throw googleError('google_unavailable', 403);
    return configuration();
}

function verifiedIdentity(config, claims, payload) {
    const now = Math.floor(Date.now() / 1000);
    if (!claims || !GOOGLE_TOKEN_ISSUERS.includes(claims.iss)
        || typeof payload?.nonce !== 'string' || !payload.nonce || claims.nonce !== payload.nonce
        || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || /[\u0000-\u0020\u007f]/.test(claims.sub)
        || (claims.azp !== undefined && claims.azp !== config.clientId)
        || (Array.isArray(claims.aud) && (claims.aud.some((audience) => typeof audience !== 'string') || (claims.aud.length > 1 && claims.azp !== config.clientId)))
        || !(Array.isArray(claims.aud) ? claims.aud.includes(config.clientId) : claims.aud === config.clientId)
        || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 600
        || !Number.isSafeInteger(claims.exp) || claims.exp <= now - 30 || claims.exp <= claims.iat
        || typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)
        || claims.email_verified !== true
        || (claims.hd !== undefined && (typeof claims.hd !== 'string' || !/^[A-Za-z0-9.-]+$/.test(claims.hd) || claims.hd.length > 253))) {
        throw googleError();
    }
    // A new ID token or account choice alone is not fresh authentication.
    // Account confirmation requires Google's signed recent authentication time.
    if (payload.flow === 'reauth' && (!Number.isSafeInteger(claims.auth_time)
        || claims.auth_time < now - 300 || claims.auth_time > now + 30)) {
        throw googleError('google_recent_authentication_required', 401);
    }
    return { issuer: GOOGLE_ISSUER, subject: claims.sub, email: claims.email.trim().toLowerCase(), emailVerified: true,
        ...(payload.flow === 'reauth' ? { authenticatedAt: claims.auth_time * 1000 } : {}),
        ...(claims.hd ? { hostedDomain: claims.hd.toLowerCase() } : {}) };
}

// Injectable key resolution is a construction-only test seam. Neither
// environment variables nor HTTP input can select an upstream issuer or disable TLS.
export function createGoogleProtocol({ jwks = googleJwks } = {}) {
    return {
        async verifyCredential(config, credential, payload) {
            try {
                if (config.mode !== 'gis' || typeof credential !== 'string' || credential.length > 16_384
                    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) throw googleError();
                const verified = await jwtVerify(credential, jwks, {
                    algorithms: ['RS256'],
                    issuer: GOOGLE_TOKEN_ISSUERS,
                    audience: config.clientId,
                    clockTolerance: 30,
                    requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'email', 'email_verified'],
                });
                return verifiedIdentity(config, verified.payload, payload);
            } catch (error) {
                if (error?.code === 'google_recent_authentication_required') throw error;
                throw googleError();
            }
        },
    };
}
