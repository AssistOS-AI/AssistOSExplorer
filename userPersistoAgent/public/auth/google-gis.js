// Google Identity Services browser helpers shared by the sign-in wizard and
// the standalone reauth page. Neither helper sees a credential.
export const GOOGLE_SDK_URL = 'https://accounts.google.com/gsi/client';
export const GOOGLE_SDK_TIMEOUT_MS = 10_000;
// The SDK opens its sign-in popup through this page's window.open at 500x550,
// so Google's account chooser, passkey and consent screens scroll to their
// buttons. The width matches the SDK's own larger popup variant.
const GOOGLE_POPUP_ORIGIN = 'https://accounts.google.com';
const GOOGLE_POPUP_WIDTH = 590;
const GOOGLE_POPUP_HEIGHT = 900;
// Leaves room for the popup's title and address bars on the screen.
const GOOGLE_POPUP_FRAME = 80;
const POPUP_GEOMETRY_FEATURES = new Set(['width', 'innerwidth', 'height', 'innerheight', 'left', 'screenx', 'top', 'screeny']);

export function googlePopupFeatures(url, features, screen) {
    let origin;
    try { origin = new URL(String(url)).origin; } catch { return features; }
    if (origin !== GOOGLE_POPUP_ORIGIN || typeof features !== 'string') return features;
    const requested = features.split(',').map((feature) => feature.trim()).filter(Boolean);
    const kept = requested.filter((feature) => !POPUP_GEOMETRY_FEATURES.has(feature.split('=')[0].trim().toLowerCase()));
    // A call without geometry keeps the browser's own choice of window.
    if (kept.length === requested.length) return features;
    const width = Math.min(GOOGLE_POPUP_WIDTH, screen.availWidth - GOOGLE_POPUP_FRAME);
    const height = Math.min(GOOGLE_POPUP_HEIGHT, screen.availHeight - GOOGLE_POPUP_FRAME);
    const left = (Number.isFinite(screen.availLeft) ? screen.availLeft : 0) + Math.round((screen.availWidth - width) / 2);
    const top = (Number.isFinite(screen.availTop) ? screen.availTop : 0)
        + Math.max(0, Math.round((screen.availHeight - height - GOOGLE_POPUP_FRAME) / 2));
    return [...kept, `width=${width}`, `height=${height}`, `left=${left}`, `top=${top}`].join(',');
}

// Returns a function that restores the original window.open.
export function enlargeGooglePopups(window) {
    const open = window.open;
    if (typeof open !== 'function') return undefined;
    function openEnlarged(...args) {
        if (args.length > 2) args[2] = googlePopupFeatures(args[0], args[2], window.screen);
        return open.apply(window, args);
    }
    window.open = openEnlarged;
    return () => { if (window.open === openEnlarged) window.open = open; };
}

function usableSdk(window) {
    const sdk = window.google?.accounts?.id;
    return typeof sdk?.initialize === 'function' && typeof sdk?.renderButton === 'function' ? sdk : null;
}

// Loads the SDK once per call. `abort()` rejects a pending load with
// `google_sdk_cancelled` and removes its script element.
export function loadGoogleSdk({ document, window, setTimeout, clearTimeout, timeoutMs = GOOGLE_SDK_TIMEOUT_MS }) {
    const available = usableSdk(window);
    if (available) return { promise: Promise.resolve(available), abort() {} };
    let abort = () => {};
    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        let settled = false;
        let timeoutId;
        function finish(error) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            script.removeEventListener('load', onLoad);
            script.removeEventListener('error', onError);
            if (error) script.remove();
            if (error) reject(error);
            else resolve(window.google.accounts.id);
        }
        function onLoad() { finish(usableSdk(window) ? null : new Error('google_sdk_unavailable')); }
        function onError() { finish(new Error('google_sdk_unavailable')); }
        abort = () => finish(new Error('google_sdk_cancelled'));
        script.src = GOOGLE_SDK_URL;
        script.async = true;
        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
        timeoutId = setTimeout(onError, timeoutMs);
        document.head.append(script);
    });
    return { promise, abort: () => abort() };
}

// Same-origin local paths only: no scheme, authority, backslash or controls.
export function googleLocalPath(value, origin) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
        || /[\\\s\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_local_path');
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.hash || parsed.pathname.startsWith('//')) throw new Error('invalid_local_path');
    return `${parsed.pathname}${parsed.search}`;
}

// Posts Google's ID token to the transaction's same-origin verifier and
// returns the validated local resume path it answers with.
export async function postGoogleCredential({ fetch, origin, credentialUrl, transaction, credential }) {
    const response = await fetch(googleLocalPath(credentialUrl, origin), {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ transaction, credential }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) throw Object.assign(new Error('google_authentication_failed'), { code: 'google_authentication_failed' });
    return googleLocalPath(payload.redirectUrl, origin);
}
