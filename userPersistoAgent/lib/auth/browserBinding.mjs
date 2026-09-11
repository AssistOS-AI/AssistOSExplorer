import { randomBytes } from 'node:crypto';

// Per-browser proof that binds email challenges to the browser that started
// them. The server stores only a digest inside the bound attempt key.
export const BROWSER_COOKIE = 'up_browser';
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export function readBrowserProof(req) {
    const values = String(req.headers.cookie || '').split(';').map((part) => part.trim())
        .filter((part) => part.startsWith(`${BROWSER_COOKIE}=`)).map((part) => part.slice(BROWSER_COOKIE.length + 1));
    return values.length === 1 && PROOF.test(values[0]) ? values[0] : '';
}

export function appendSetCookie(res, header) {
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), header]);
}

// HttpOnly and SameSite=Strict: the wizard's same-origin fetches and native
// form posts carry it; cross-site requests never do.
export function ensureBrowserProof(req, res, { path, secure }) {
    const existing = readBrowserProof(req);
    if (existing) return existing;
    const value = randomBytes(32).toString('base64url');
    appendSetCookie(res, `${BROWSER_COOKIE}=${value}; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    return value;
}

// The Router sets x-forwarded-prefix after stripping client-supplied values.
// Scope the cookie to this agent's browser-visible service path.
export function forwardedServicePath(req) {
    const prefix = String(req.headers['x-forwarded-prefix'] || '');
    const segments = prefix.split('/').slice(1);
    const valid = prefix.startsWith('/') && segments.every((segment) => PREFIX_SEGMENT.test(segment) && segment !== '..' && segment !== '.');
    return `${valid ? prefix : ''}/service/`;
}

export function forwardedSecure(req) {
    return req.headers['x-forwarded-proto'] === 'https';
}

// Only the Router's route-scoped HMAC partition is trusted; the Router strips
// client-supplied x-ploinky-* headers. Absent (public routes) means shared.
export function rateSourceOf(req) {
    const value = req.headers['x-ploinky-rate-source'];
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

export function expectedOrigin(req) {
    const proto = req.headers['x-forwarded-proto'];
    const host = req.headers['x-forwarded-host'];
    if ((proto === 'http' || proto === 'https') && typeof host === 'string' && host) return `${proto}://${host}`;
    return `http://${req.headers.host}`;
}

// Browsers always send Origin on POST. A foreign or null Origin is refused;
// a request without one is not a browser request and cannot carry the cookie
// cross-site.
export function assertSameOrigin(req) {
    const origin = req.headers.origin;
    const expected = expectedOrigin(req);
    if (origin === undefined) return expected;
    let parsed;
    try { parsed = new URL(expected); } catch { parsed = null; }
    if (typeof origin !== 'string' || !parsed || parsed.origin !== expected || origin !== expected) {
        throw Object.assign(new Error('invalid_origin'), { code: 'invalid_origin', statusCode: 403 });
    }
    return origin;
}
