const GOOGLE_SDK_URL = 'https://accounts.google.com/gsi/client';
const LOAD_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

function localPath(value, origin) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
        || /[\\\s\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_local_path');
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || parsed.hash || parsed.pathname.startsWith('//')) throw new Error('invalid_local_path');
    return `${parsed.pathname}${parsed.search}`;
}

function readConfiguration(document, origin) {
    const config = JSON.parse(document.getElementById('google-sign-in-config')?.textContent || 'null');
    if (!config || typeof config !== 'object' || Array.isArray(config)
        || typeof config.clientId !== 'string' || !/^[A-Za-z0-9._-]{1,512}$/.test(config.clientId)
        || typeof config.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(config.nonce)
        || typeof config.transaction !== 'string' || !/^[a-f0-9]{64}$/.test(config.transaction)
        || !Number.isSafeInteger(config.expiresAt) || config.expiresAt <= 0
        || (config.reauthentication !== undefined && typeof config.reauthentication !== 'boolean')) {
        throw new Error('invalid_configuration');
    }
    return {
        clientId: config.clientId,
        nonce: config.nonce,
        transaction: config.transaction,
        expiresAt: config.expiresAt,
        reauthentication: config.reauthentication === true,
        credentialUrl: localPath(config.credentialUrl, origin),
        cancelUrl: localPath(config.cancelUrl, origin),
        cancelRedirectUrl: localPath(config.cancelRedirectUrl, origin),
    };
}

export function mountGoogleSignIn({
    document = globalThis.document,
    window = globalThis.window,
    fetch = globalThis.fetch?.bind(globalThis),
    now = Date.now,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
    navigate = (path) => window.location.assign(path),
    loadTimeoutMs = LOAD_TIMEOUT_MS,
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
    const button = document.getElementById('google-sign-in-button');
    const status = document.getElementById('google-sign-in-status');
    const cancelButton = document.getElementById('google-sign-in-cancel');
    const retryButton = document.getElementById('google-sign-in-retry');
    const timerLabel = document.getElementById('google-sign-in-timer');
    if (!button || !status || !cancelButton || !retryButton) throw new Error('missing_sign_in_page');

    let config;
    let phase = 'loading';
    let generation = 0;
    let clockTimer;
    let cleanupLoad;
    let activeRequest;
    let googleId;

    function clearClock() {
        if (clockTimer !== undefined) clearTimeout(clockTimer);
        clockTimer = undefined;
    }

    function stopWork() {
        generation += 1;
        cleanupLoad?.();
        cleanupLoad = undefined;
        activeRequest?.abort();
        activeRequest = undefined;
        button.replaceChildren();
        button.hidden = true;
        retryButton.hidden = true;
        try { googleId?.cancel?.(); } catch { /* The SDK may already be unloading. */ }
    }

    function expire() {
        if (['disposed', 'complete', 'expired'].includes(phase)) return;
        phase = 'expired';
        clearClock();
        stopWork();
        status.textContent = 'This sign-in attempt expired. Return to sign-in and start again.';
        cancelButton.disabled = false;
        cancelButton.textContent = 'Return to sign-in';
        if (timerLabel) timerLabel.textContent = 'Sign-in attempt expired.';
    }

    function isCurrent(version) {
        if (version !== generation || ['disposed', 'complete', 'expired'].includes(phase)) return false;
        if (now() >= config.expiresAt) { expire(); return false; }
        return true;
    }

    function updateClock() {
        clearClock();
        const remaining = config.expiresAt - now();
        if (remaining <= 0) return expire();
        if (timerLabel) timerLabel.textContent = `This attempt expires in ${Math.ceil(remaining / 60_000)} minute${remaining > 60_000 ? 's' : ''}.`;
        clockTimer = setTimeout(updateClock, Math.min(remaining, 1000));
    }

    async function post(path, body, version, allowExpired = false) {
        const controller = new AbortController();
        activeRequest = controller;
        let rejectTimeout;
        const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
        let rejectAbort;
        const aborted = new Promise((_, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(new Error('request_aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const timeoutId = setTimeout(() => {
            controller.abort();
            rejectTimeout(new Error('request_timeout'));
        }, requestTimeoutMs);
        try {
            const response = await Promise.race([fetch(path, {
                method: 'POST',
                credentials: 'same-origin',
                redirect: 'error',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            }).then(async (result) => ({ result, payload: await result.json() })), timeout, aborted]);
            if (version !== generation || phase === 'disposed' || (!allowExpired && !isCurrent(version))) return null;
            if (!response.result.ok || response.payload?.ok !== true) {
                throw new Error(response.payload?.error === 'google_recent_authentication_required'
                    ? 'google_recent_authentication_required' : 'request_failed');
            }
            return localPath(response.payload.redirectUrl, window.location.origin);
        } finally {
            clearTimeout(timeoutId);
            controller.signal.removeEventListener('abort', onAbort);
            if (activeRequest === controller) activeRequest = undefined;
        }
    }

    async function completeCredential(response, version) {
        if (!isCurrent(version) || phase !== 'ready') return;
        phase = 'verifying';
        button.replaceChildren();
        button.hidden = true;
        status.textContent = 'Completing Google sign-in…';
        if (typeof response?.credential !== 'string' || !response.credential || response.credential.length > 32_768) {
            phase = 'failed';
            status.textContent = 'Google did not return a usable sign-in response. Return to sign-in and start again.';
            cancelButton.textContent = 'Return to sign-in';
            return;
        }
        try {
            const redirectUrl = await post(config.credentialUrl, {
                transaction: config.transaction,
                credential: response.credential,
            }, version);
            if (!redirectUrl || !isCurrent(version) || phase !== 'verifying') return;
            phase = 'complete';
            clearClock();
            stopWork();
            cancelButton.disabled = true;
            status.textContent = 'Signed in. Continuing…';
            navigate(redirectUrl);
        } catch (error) {
            if (!isCurrent(version) || phase !== 'verifying') return;
            phase = 'failed';
            status.textContent = error.message === 'google_recent_authentication_required'
                ? 'Google needs a recent sign-in to confirm this action. Sign in to Google again, or return and use another existing sign-in method.'
                : 'Google sign-in could not be completed. Return to sign-in and start a new attempt.';
            cancelButton.textContent = 'Return to sign-in';
        }
    }

    function loadSdk() {
        const available = window.google?.accounts?.id;
        if (typeof available?.initialize === 'function' && typeof available?.renderButton === 'function') return Promise.resolve(available);
        return new Promise((resolve, reject) => {
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
                if (cleanupLoad === abortLoad) cleanupLoad = undefined;
                if (error) reject(error);
                else resolve(window.google.accounts.id);
            }
            function onLoad() {
                const sdk = window.google?.accounts?.id;
                finish(typeof sdk?.initialize === 'function' && typeof sdk?.renderButton === 'function'
                    ? null : new Error('google_sdk_unavailable'));
            }
            function onError() { finish(new Error('google_sdk_unavailable')); }
            function abortLoad() { finish(new Error('google_sdk_cancelled')); }
            cleanupLoad = abortLoad;
            script.src = GOOGLE_SDK_URL;
            script.async = true;
            script.addEventListener('load', onLoad);
            script.addEventListener('error', onError);
            timeoutId = setTimeout(onError, loadTimeoutMs);
            document.head.append(script);
        });
    }

    async function start() {
        const version = generation;
        if (!isCurrent(version) || !['loading', 'load-error'].includes(phase)) return;
        phase = 'loading';
        retryButton.hidden = true;
        status.textContent = 'Loading Google sign-in…';
        try {
            googleId = await loadSdk();
            if (!isCurrent(version) || phase !== 'loading') return;
            googleId.initialize({
                client_id: config.clientId,
                nonce: config.nonce,
                auto_select: false,
                ux_mode: 'popup',
                use_fedcm_for_button: false,
                ...(config.reauthentication ? { essential_claims: 'auth_time' } : {}),
                callback: (response) => { void completeCredential(response, version); },
            });
            phase = 'ready';
            button.hidden = false;
            googleId.renderButton(button, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with' });
            status.textContent = 'Choose Sign in with Google to continue. Allow the Google popup if your browser blocks it.';
        } catch {
            if (!isCurrent(version) || !['loading', 'ready'].includes(phase)) return;
            phase = 'load-error';
            button.replaceChildren();
            button.hidden = true;
            status.textContent = 'Google sign-in could not load. Check your connection or browser blocking settings, then try again.';
            retryButton.hidden = false;
        }
    }

    async function cancel() {
        if (!config || ['disposed', 'complete', 'canceling'].includes(phase)) return;
        const allowExpired = phase === 'expired' || now() >= config.expiresAt;
        stopWork();
        phase = 'canceling';
        const version = generation;
        cancelButton.disabled = true;
        status.textContent = 'Returning to sign-in…';
        try {
            const redirectUrl = await post(config.cancelUrl, { transaction: config.transaction }, version, allowExpired);
            if (!redirectUrl || version !== generation || phase !== 'canceling') return;
            phase = 'complete';
            clearClock();
            navigate(redirectUrl);
        } catch {
            if (version !== generation || phase !== 'canceling') return;
            phase = 'complete';
            clearClock();
            navigate(config.cancelRedirectUrl);
        }
    }

    function retry() {
        if (phase === 'load-error') { generation += 1; void start(); }
    }

    function dispose() {
        if (phase === 'disposed') return;
        phase = 'disposed';
        clearClock();
        stopWork();
        cancelButton.disabled = true;
        cancelButton.removeEventListener('click', cancel);
        retryButton.removeEventListener('click', retry);
        window.removeEventListener('pagehide', dispose);
    }

    retryButton.hidden = true;
    try {
        config = readConfiguration(document, window.location.origin);
    } catch {
        phase = 'invalid';
        button.replaceChildren();
        button.hidden = true;
        cancelButton.disabled = true;
        status.textContent = 'This Google sign-in page is invalid. Return using your browser and start again.';
        return { ready: Promise.resolve(), dispose };
    }
    cancelButton.addEventListener('click', cancel);
    retryButton.addEventListener('click', retry);
    window.addEventListener('pagehide', dispose);
    updateClock();
    return { ready: start(), dispose };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('google-sign-in-config')) {
    mountGoogleSignIn();
}
