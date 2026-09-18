import { DEFAULT_PASSWORD_POLICY, newPasswordProblem, passwordReasonMessage } from './password-rules.js';

// Standalone reset page. The emailed link carries its token in the URL
// fragment, so it never reaches a server access log; this module reads it once,
// removes it from the address bar with history.replaceState and keeps it in
// memory only. The page has no parent, no browser proof and no ambient
// authority: the server authorizes every call from the token alone.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATUS_PATH = 'password/reset/status';
const COMPLETE_PATH = 'password/reset';
const INVALID_MESSAGE = 'This reset link is invalid or has expired. Request a new one from the sign-in page.';

function readToken(location) {
    const raw = String(location?.hash || '');
    const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
    return params.get('token') || '';
}

export function mountReset({ root, document, fetch, location, history = null, navigate, clock = null }) {
    const ticker = clock || { now: () => Date.now() };
    let token = '';
    let email = '';
    let passwordPolicy = DEFAULT_PASSWORD_POLICY;
    let busy = false;

    function h(tag, attributes = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(attributes)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'className') node.setAttribute('class', value);
            else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
            else node.setAttribute(key, value === true ? '' : String(value));
        }
        node.append(...children.filter(Boolean));
        return node;
    }
    function status(message, { error = false } = {}) {
        return h('p', { className: 'status', role: error ? 'alert' : undefined, text: message || '' });
    }
    function heading(text) {
        return h('h1', { tabindex: '-1', text });
    }
    function accountEmailField() {
        const input = h('input', { id: 'reset-account-email', name: 'email', type: 'email', autocomplete: 'username', readonly: true, className: 'auth-readonly' });
        input.value = email;
        return [h('label', { for: 'reset-account-email', text: 'Email' }), input];
    }
    function render(name, node) {
        for (const input of root.querySelectorAll('input')) input.value = '';
        root.replaceChildren(node);
        root.querySelector('h1')?.focus();
        return name;
    }
    function errorMessage(error) {
        const code = error?.code || '';
        if (code === 'invalid_password') return passwordReasonMessage(error.reason, passwordPolicy);
        if (code === 'password_mismatch') return 'The passwords do not match.';
        if (code === 'rate_limited' || code === 'resend_too_soon') {
            return Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0
                ? `Too many attempts. Wait ${error.retryAfter} s and try again.`
                : 'Too many attempts. Try again later.';
        }
        return 'Something went wrong. Try again.';
    }

    async function post(path, body) {
        const response = await fetch(new URL(path, location.href).toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
            const error = new Error(data.error || `Request failed (${response.status})`);
            error.code = data.error || '';
            error.status = response.status;
            if (Number.isSafeInteger(data.retryAfter)) error.retryAfter = data.retryAfter;
            if (typeof data.reason === 'string') error.reason = data.reason;
            throw error;
        }
        return data;
    }

    function showLoading() {
        render('loading', h('section', { className: 'auth-panel reset-panel' }, [heading('Loading…')]));
    }

    function showInvalid() {
        render('invalid', h('section', { className: 'auth-panel reset-invalid-panel' }, [
            heading('This link is not valid'),
            status(INVALID_MESSAGE),
            h('button', { type: 'button', text: 'Go to sign in', onClick: () => navigate('/auth/login?returnTo=%2F') }),
        ]));
    }

    // A failure other than an invalid link (a rate limit, a server error, no
    // network) keeps the in-memory token so the check can run again; the
    // address bar no longer holds it, so a reload could not.
    function showRetry(error) {
        render('retry', h('section', { className: 'auth-panel reset-retry-panel' }, [
            heading('We could not check this link'),
            status(error?.code === 'rate_limited' ? errorMessage(error) : 'Something went wrong. Try again.', { error: true }),
            h('button', { type: 'button', text: 'Try again', onClick: () => { void load(); } }),
        ]));
    }

    function showChanged() {
        render('changed', h('section', { className: 'auth-panel reset-changed-panel' }, [
            heading('Password changed'),
            status('Your password was changed. Every session was signed out.'),
            h('button', { type: 'button', text: 'Sign in', onClick: () => navigate('/auth/login?returnTo=%2F') }),
        ]));
    }

    function showChoose(initialError = '') {
        const form = h('form', { className: 'auth-panel reset-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const passwordInput = h('input', { id: 'reset-new-password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, 'aria-describedby': 'reset-password-hint' });
        const confirmInput = h('input', { id: 'reset-confirm-password', name: 'passwordConfirmation', type: 'password', autocomplete: 'new-password', required: true });
        const submitButton = h('button', { type: 'submit', text: 'Change password' });
        form.append(
            heading('Choose a new password'),
            ...accountEmailField(),
            h('label', { for: 'reset-new-password', text: 'New password' }), passwordInput,
            h('label', { for: 'reset-confirm-password', text: 'Confirm new password' }), confirmInput,
            h('p', { id: 'reset-password-hint', className: 'auth-copy auth-hint', text: `Use at least ${passwordPolicy.minLength} characters.` }),
            submitButton,
            errorNode,
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submit(passwordInput, confirmInput, submitButton, errorNode);
        });
        render('choose', form);
    }

    async function submit(passwordInput, confirmInput, submitButton, errorNode) {
        if (busy) return;
        const password = passwordInput.value;
        const confirmation = confirmInput.value;
        const problem = newPasswordProblem(password, confirmation, passwordPolicy);
        if (problem?.code === 'password_mismatch') {
            confirmInput.value = '';
            errorNode.textContent = errorMessage(problem);
            errorNode.setAttribute('role', 'alert');
            confirmInput.focus();
            return;
        }
        if (problem) {
            errorNode.textContent = errorMessage(problem);
            errorNode.setAttribute('role', 'alert');
            passwordInput.focus();
            return;
        }
        busy = true;
        submitButton.disabled = true;
        passwordInput.disabled = true;
        confirmInput.disabled = true;
        const submittedPassword = password;
        try {
            await post(COMPLETE_PATH, { token, password: submittedPassword, passwordConfirmation: confirmation });
            passwordInput.value = '';
            confirmInput.value = '';
            busy = false;
            showChanged();
        } catch (error) {
            busy = false;
            if (error?.code === 'reset_link_invalid') { showInvalid(); return; }
            passwordInput.value = '';
            confirmInput.value = '';
            passwordInput.disabled = false;
            confirmInput.disabled = false;
            submitButton.disabled = false;
            errorNode.textContent = error?.code === 'rate_limited' || error?.code === 'invalid_password' || error?.code === 'password_mismatch'
                ? errorMessage(error)
                : 'We could not change the password. Try again.';
            errorNode.setAttribute('role', 'alert');
            passwordInput.focus();
        }
    }

    async function boot() {
        token = readToken(location);
        // The token never stays in the address bar or history.
        try { history?.replaceState?.({}, document.title || '', `${location.pathname || ''}${location.search || ''}`); } catch { /* best effort */ }
        if (!TOKEN_PATTERN.test(token)) { showInvalid(); return; }
        await load();
    }

    async function load() {
        if (busy) return;
        busy = true;
        showLoading();
        try {
            const inspected = await post(STATUS_PATH, { token });
            email = String(inspected.email || '');
            passwordPolicy = { ...DEFAULT_PASSWORD_POLICY, ...(inspected.passwordPolicy || {}) };
            busy = false;
            showChoose();
        } catch (error) {
            busy = false;
            if (error?.code === 'reset_link_invalid') showInvalid();
            else showRetry(error);
        }
    }

    void boot();

    return {
        dispose() { busy = false; },
        state() { return { email, passwordPolicy }; },
        now: () => ticker.now(),
    };
}
