import { AccountEnrollment } from './enrollment.js';
import { updateAccountNavigation } from './api.mjs';

const TOOL_PATHS = Object.freeze({
    userpersisto_passkey_registration_options: 'auth/passkey/options',
    userpersisto_passkey_registration_verify: 'auth/passkey/verify',
    userpersisto_totp_setup_start: 'auth/totp/start',
    userpersisto_totp_setup_verify: 'auth/totp/verify',
});
const METHOD_LABELS = { password: 'Password', emailCode: 'Email code', passkey: 'Passkey', totp: 'Authenticator app' };

export async function dashboardApi(path, payload) {
    const response = await fetch(`api/${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false || result.error) {
        const error = new Error(result.error || result.reason || 'Request failed');
        error.payload = result;
        error.status = response.status;
        throw error;
    }
    return result;
}

export function mountDashboard(document) {
    const select = (id) => document.getElementById(id);
    const status = select('account-status');
    const content = select('account-content');
    const form = select('profile-form');
    const username = select('username');
    const displayName = select('display-name');
    const save = select('save-profile');
    const login = select('account-login');
    const returnTo = new URL('./', import.meta.url).pathname;
    login.href = `/auth/login?${new URLSearchParams({ returnTo })}`;
    const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle('error', error); };
    let disposed = false;
    let sessionExpired = false;

    async function request(path, payload) {
        try {
            return await dashboardApi(path, payload);
        } catch (error) {
            const code = error.payload?.error || error.payload?.reason || error.message;
            if (!disposed && (error.status === 401
                || ['not_authenticated', 'authentication_required', 'invalid_session'].includes(code))) {
                sessionExpired = true;
                updateAccountNavigation(document, null);
                enrollment.updateProfile(null);
                content.hidden = true;
                login.hidden = false;
                save.disabled = true;
                setStatus('Your session has expired. Sign in again to manage your account.', true);
            }
            throw error;
        }
    }

    const enrollment = new AccountEnrollment(select('account-enrollment'), {
        callTool: (name, args) => {
            if (!Object.hasOwn(TOOL_PATHS, name)) throw new Error('Unknown account action');
            return request(TOOL_PATHS[name], args);
        },
        onEnrolled: async () => {
            const { profile } = await request('profile');
            if (!disposed) render(profile, false);
        },
    });

    function render(profile, updateFields = true) {
        if (disposed || sessionExpired) return;
        if (!profile?.user) throw new Error('Profile unavailable');
        updateAccountNavigation(document, profile);
        select('account-email').textContent = profile.user.email || profile.user.id;
        select('account-role').textContent = (profile.roles || []).map((role) => role === 'selfRegistered' ? 'Member' : role).join(', ');
        select('account-methods').textContent = [...new Set((profile.authMethods || []).map((method) => METHOD_LABELS[method.type] || method.name || method.type))].join(' · ') || 'No sign-in methods configured';
        if (updateFields) { username.value = profile.user.username || ''; displayName.value = profile.user.displayName || ''; }
        const hasExplorerAccess = profile.capabilities?.includes('explorer.access') === true;
        select('open-explorer').hidden = !hasExplorerAccess;
        select('workspace-access-message').textContent = hasExplorerAccess
            ? 'Your account has access to Explorer.'
            : 'Your account is ready. Ask your workspace administrator to grant access to Explorer.';
        enrollment.updateProfile(profile);
        content.hidden = false;
    }

    async function load() {
        try {
            const { profile } = await request('profile');
            if (disposed || sessionExpired) return;
            render(profile);
            login.hidden = true;
            setStatus('');
        } catch (error) {
            if (disposed || sessionExpired) return;
            setStatus('Unable to load your account. Refresh the page to try again.', true);
        }
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true;
        setStatus('Saving…');
        try {
            const { profile } = await request('profile', { username: username.value.trim(), displayName: displayName.value.trim() });
            if (disposed || sessionExpired) return;
            render(profile);
            setStatus('Profile saved.');
        } catch (error) {
            if (!disposed && !sessionExpired) setStatus(/username/i.test(error.message)
                ? 'Unable to save that username. Check its format or choose another.'
                : 'Unable to save your profile. Please try again.', true);
        } finally {
            if (!disposed) save.disabled = sessionExpired;
        }
    });
    void load();
    return { dispose() { disposed = true; enrollment.dispose(); } };
}

export function startDashboard(document, host = window) {
    const dashboard = mountDashboard(document);
    host.addEventListener('pagehide', () => dashboard.dispose(), { once: true });
    host.addEventListener('pageshow', (event) => {
        if (event.persisted) host.location.reload();
    });
    return dashboard;
}

if (typeof document !== 'undefined') startDashboard(document);
