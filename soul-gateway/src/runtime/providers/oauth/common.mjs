import { createHash, randomBytes } from 'node:crypto';

const JSON_HEADERS = {
    Accept: 'application/json',
};

export function generatePkceVerifier() {
    return randomBytes(32).toString('base64url');
}

export function generatePkceChallenge(verifier) {
    return createHash('sha256').update(verifier).digest('base64url');
}

export function buildPkceAuthUrl({
    authUrl,
    clientId,
    redirectUri,
    scopes,
    state,
    verifier,
    extraParams = {},
}) {
    const url = new URL(authUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    if (scopes) {
        url.searchParams.set(
            'scope',
            Array.isArray(scopes) ? scopes.join(' ') : scopes
        );
    }
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', generatePkceChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');

    for (const [key, value] of Object.entries(extraParams)) {
        if (value == null || value === '') continue;
        url.searchParams.set(key, String(value));
    }

    return url.toString();
}

export async function requestDeviceCode({
    deviceCodeUrl,
    clientId,
    scopes,
    extraParams = {},
    headers = {},
    signal,
}) {
    const body = new URLSearchParams({
        client_id: clientId,
        ...(scopes
            ? { scope: Array.isArray(scopes) ? scopes.join(' ') : scopes }
            : {}),
    });

    for (const [key, value] of Object.entries(extraParams)) {
        if (value == null || value === '') continue;
        body.set(key, String(value));
    }

    const data = await fetchJson(deviceCodeUrl, {
        method: 'POST',
        headers: {
            ...JSON_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            ...headers,
        },
        body: body.toString(),
        signal,
    });

    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri || data.verification_url || null,
        verificationUriComplete: data.verification_uri_complete || null,
        interval: data.interval || 5,
        expiresIn: data.expires_in || null,
        raw: data,
    };
}

export async function pollDeviceCodeOnce({
    tokenUrl,
    clientId,
    deviceCode,
    extraParams = {},
    headers = {},
    signal,
}) {
    const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
    });

    for (const [key, value] of Object.entries(extraParams)) {
        if (value == null || value === '') continue;
        body.set(key, String(value));
    }

    try {
        return await fetchJson(tokenUrl, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'Content-Type': 'application/x-www-form-urlencoded',
                ...headers,
            },
            body: body.toString(),
            signal,
        });
    } catch (err) {
        const code = err.data?.error || err.code || 'oauth_error';
        const pendingError = new Error(
            err.data?.error_description || err.message
        );
        pendingError.code = code;
        pendingError.error = code;
        pendingError.data = err.data || null;
        throw pendingError;
    }
}

export async function exchangeAuthorizationCode({
    tokenUrl,
    clientId,
    code,
    redirectUri,
    verifier,
    state = null,
    contentType = 'application/x-www-form-urlencoded',
    extraParams = {},
    headers = {},
    signal,
}) {
    const payload = {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        ...(state ? { state } : {}),
        ...extraParams,
    };

    return fetchOAuthToken(tokenUrl, {
        payload,
        contentType,
        headers,
        signal,
    });
}

export async function refreshAccessToken({
    tokenUrl,
    refreshToken,
    clientId = null,
    contentType = 'application/x-www-form-urlencoded',
    extraParams = {},
    headers = {},
    signal,
}) {
    const payload = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(clientId ? { client_id: clientId } : {}),
        ...extraParams,
    };

    return fetchOAuthToken(tokenUrl, {
        payload,
        contentType,
        headers,
        signal,
    });
}

export async function fetchJson(
    url,
    { method = 'GET', headers = {}, body, signal } = {}
) {
    const response = await fetch(url, {
        method,
        headers,
        body,
        signal,
    });

    const text = await response.text();
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }

    if (!response.ok) {
        const error = new Error(
            data.error_description || data.message || `HTTP ${response.status}`
        );
        error.status = response.status;
        error.data = data;
        error.code = data.error || null;
        throw error;
    }

    return data;
}

export function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

export function computeExpiryIso(expiresInSeconds, fallbackMs = null) {
    if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
        return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    }
    if (Number.isFinite(fallbackMs) && fallbackMs > 0) {
        return new Date(Date.now() + fallbackMs).toISOString();
    }
    return null;
}

async function fetchOAuthToken(
    tokenUrl,
    { payload, contentType, headers, signal }
) {
    if (contentType === 'application/json') {
        return fetchJson(tokenUrl, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'Content-Type': 'application/json',
                ...headers,
            },
            body: JSON.stringify(payload),
            signal,
        });
    }

    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
        if (value == null || value === '') continue;
        body.set(key, String(value));
    }

    return fetchJson(tokenUrl, {
        method: 'POST',
        headers: {
            ...JSON_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            ...headers,
        },
        body: body.toString(),
        signal,
    });
}
