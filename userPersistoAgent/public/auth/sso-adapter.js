import { assertionCredentialToServer } from './auth-api.js';

// Router SSO protocol adapter for the shared wizard. Every call is a same-
// origin JSON POST against /service/auth/<path>, resolved relative to the
// current page (which already carries the service prefix). The wizard never
// talks to fetch/location/navigation directly; this module is the only place
// that knows the SSO wire format described in service/ssoWizard.mjs.
export function createSsoAdapter({ location, fetch, navigate }) {
    const params = new URLSearchParams(location.search);
    const requestId = params.get('requestId') || params.get('providerState') || '';
    const state = params.get('state') || '';
    const returnTo = params.get('returnTo') || '';
    const notice = params.get('notice') || '';

    function requestError(data, status) {
        const error = new Error((data && data.error) || `Request failed (${status})`);
        error.code = (data && data.error) || '';
        error.status = status;
        if (Number.isSafeInteger(data && data.retryAfter)) error.retryAfter = data.retryAfter;
        if (Number.isSafeInteger(data && data.attemptsRemaining)) error.attemptsRemaining = data.attemptsRemaining;
        return error;
    }

    async function post(path, body) {
        const url = new URL(path, location.href);
        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body || {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) throw requestError(data, response.status);
        return data;
    }

    // Builds the Router callback URL and hands the browser off to it. The
    // handoff code is single use; the state is preserved for the Router.
    function complete(handoff) {
        const url = new URL(handoff.redirectUri, location.origin);
        url.searchParams.set('state', handoff.state || state);
        url.searchParams.set('code', handoff.code);
        navigate(url.toString());
    }

    return {
        flow: 'sso',
        clientName: '',
        screenHint: '',
        storageKey: `userpersisto-wizard:sso:${requestId}`,
        notice,

        // A lost response can replay its own staged handoff; the wizard must
        // complete the same way it would for a live verification.
        attempt() {
            return post('attempt', { requestId, state });
        },
        complete,
        cancel() {
            return post('attempt/cancel', { requestId });
        },
        discover(email) {
            return post('discover', { requestId, email });
        },
        startEmail({ email, purpose, resend }) {
            return post('email-code/start', { requestId, email, purpose, ...(resend ? { resend: true } : {}) });
        },
        verifyEmail(code) {
            return post('email-code/verify', { requestId, state, code });
        },
        verifyTotp({ email, token }) {
            return post('totp/verify', { requestId, state, email, token });
        },
        verifyPasskey({ email, challengeKey, assertion }) {
            return post('passkey/verify', { requestId, state, email, challengeKey, assertion: assertionCredentialToServer(assertion) });
        },
        passkeyOptions(email) {
            return post('passkey/options', { requestId, email });
        },
        adminLogin({ password, contactEmail }) {
            return post('admin/login', { requestId, state, password, ...(contactEmail ? { contactEmail } : {}) });
        },
        startGoogle() {
            return post('google/start', { requestId, state });
        },
        continueGoogle(result) {
            navigate(result.authorizationUrl);
        },
        cancelGoogle(result) {
            return post('attempt/cancel', { requestId, googleTransaction: result.transaction });
        },
        restart() {
            const target = new URLSearchParams();
            target.set('returnTo', returnTo || '/');
            target.set('prompt', 'login');
            navigate(`/auth/login?${target.toString()}`);
        },
    };
}
