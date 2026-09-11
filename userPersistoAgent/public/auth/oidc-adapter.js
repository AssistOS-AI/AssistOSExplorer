import { assertionCredentialToServer } from './auth-api.js';

// OIDC interaction protocol adapter for the shared wizard. Read-only actions
// are JSON-over-form-urlencoded fetches against `${base}/${action}`; every
// credential completion (and abort) is a real form POST that lets the engine
// finish the interaction with a redirect, matching lib/oidc/http.mjs.
export function createOidcAdapter({ config, document, fetch, navigate, closeWindow }) {
    function requestError(data, status) {
        const error = new Error((data && data.error) || `Request failed (${status})`);
        error.code = (data && data.error) || '';
        error.status = status;
        if (Number.isSafeInteger(data && data.retryAfter)) error.retryAfter = data.retryAfter;
        if (Number.isSafeInteger(data && data.attemptsRemaining)) error.attemptsRemaining = data.attemptsRemaining;
        return error;
    }

    async function postJson(action, fields = {}) {
        const response = await fetch(`${config.base}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            credentials: 'same-origin',
            body: new URLSearchParams({ csrf: config.csrf, ...fields }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) throw requestError(data, response.status);
        return data;
    }

    // Never fetched: the server finishes the interaction with a redirect (or
    // re-renders this same shell with a 400 and a fresh config.failure), so
    // the browser must navigate the way a real credential form would. Every
    // native action is refused without the csrf field (see lib/oidc/http.mjs).
    function submitForm(action, fields = {}) {
        const form = document.createElement('form');
        form.setAttribute('method', 'post');
        form.setAttribute('action', `${config.base}/${action}`);
        for (const [name, value] of Object.entries({ csrf: config.csrf, ...fields })) {
            const input = document.createElement('input');
            input.setAttribute('type', 'hidden');
            input.setAttribute('name', name);
            input.setAttribute('value', value);
            form.append(input);
        }
        document.body.append(form);
        form.submit();
    }

    return {
        flow: 'oidc',
        clientName: (config.client && config.client.name) || '',
        screenHint: config.screenHint === 'signup' ? 'signup' : '',
        storageKey: `userpersisto-wizard:oidc:${config.base.split('/').pop() || config.base}`,
        notice: config.notice || '',
        initialFailure: config.failure || null,
        initialEmail: config.email || '',

        complete({ action, fields }) {
            submitForm(action, fields);
        },

        attempt() {
            return postJson('attempt');
        },
        cancel() {
            return postJson('attempt-cancel');
        },
        discover(email) {
            return postJson('discover', { email });
        },
        startEmail({ email, purpose, resend }) {
            return postJson('email-start', { email, purpose, ...(resend ? { resend: 'true' } : {}) });
        },
        passkeyOptions(email) {
            return postJson('passkey-options', { email });
        },
        verifyEmail(code) {
            return { action: 'email-verify', fields: { code } };
        },
        verifyTotp({ email, token }) {
            return { action: 'totp', fields: { email, token } };
        },
        verifyPasskey({ assertion }) {
            // email/challengeKey are retained server-side against the interaction
            // uid; only the assertion travels with the completion.
            return { action: 'passkey-verify', fields: { assertion: JSON.stringify(assertionCredentialToServer(assertion)) } };
        },
        adminLogin({ password, contactEmail }) {
            return { action: 'admin-login', fields: { password, ...(contactEmail ? { contactEmail } : {}) } };
        },
        startGoogle() {
            return postJson('google');
        },
        continueGoogle(data) {
            navigate(data.authorizationUrl);
        },
        cancelGoogle(data) {
            return postJson('attempt-cancel', { googleTransaction: data.transaction });
        },
        abort() {
            submitForm('abort');
        },
        restart() {
            if (typeof closeWindow === 'function') closeWindow();
        },
    };
}
