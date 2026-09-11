import { publicKeyRequestFromServer } from './auth-api.js';

// Protocol-agnostic passwordless sign-in wizard. Talks only to `adapter`
// (see sso-adapter.js / oidc-adapter.js); every screen is rebuilt with
// createElement/textContent and mounted with `root.replaceChildren(...)`.
// Every async operation captures the transition epoch in effect when it
// started; any screen transition bumps the epoch, so a late result can
// never change the view. `dispose()` stops the clock and aborts any
// in-flight passkey prompt.
export function mountWizard({ root, document, adapter, storage = null, clock = null, credentials = undefined }) {
    const ticker = clock || {
        now: () => Date.now(),
        setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: (id) => globalThis.clearInterval(id),
    };

    let epoch = 0;
    let screen = 'loading';
    let mode = 'login';
    let email = '';
    let config = { setupComplete: true, registration: false, methods: {}, adminPassword: false };
    let expiresAt = 0;
    let discovery = null;
    let challenge = null;
    let locked = false;
    let pendingNotice = adapter.notice || '';
    let timerNode = null;
    let resendState = null; // { node, resendAt }
    let passkeyAbort = null;
    let intervalId = null;
    let disposed = false;

    // ---- small DOM helpers -------------------------------------------------
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
        return h('p', { className: 'status', role: error ? 'alert' : undefined, 'aria-live': error ? undefined : 'polite', text: message || '' });
    }
    function heading(text) {
        return h('h1', { tabindex: '-1', text });
    }
    function backButton(onClick, label = 'Back') {
        return h('button', { type: 'button', className: 'auth-link', text: label, onClick });
    }

    // ---- persistence ---------------------------------------------------------
    function persist() {
        if (!storage) return;
        try { storage.setItem(adapter.storageKey, JSON.stringify({ mode, email })); } catch { /* best effort */ }
    }
    function readPersisted() {
        if (!storage) return null;
        try {
            const raw = storage.getItem(adapter.storageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            return { mode: parsed.mode === 'register' ? 'register' : 'login', email: typeof parsed.email === 'string' ? parsed.email : '' };
        } catch { return null; }
    }

    // ---- error copy ------------------------------------------------------
    const BASE_ERROR_MESSAGES = {
        invalid_email: 'Enter a valid email address.',
        code_expired: 'That code expired. Request a new code.',
        too_many_attempts: 'Too many incorrect codes. Start over.',
        delivery_failed: 'We could not send the code. Try again later.',
        account_not_found: 'No account uses this email.',
        account_exists: 'An account already uses this email. Sign in instead.',
        registration_disabled: 'Registration is not available.',
        auth_method_disabled: 'This sign-in method is not available.',
        access_denied: 'This sign-in method is not available.',
        authentication_failed: 'Unable to sign in. Check your details and try again.',
        admin_password_unavailable: 'Administrator sign-in is not available.',
        attempt_invalid: 'This sign-in attempt is no longer available. Start over.',
    };
    function errorMessage(error, { onAdminScreen = false } = {}) {
        const code = (error && error.code) || '';
        if (code === 'authentication_failed' && onAdminScreen) return 'Unable to sign in with that administrator password.';
        if (code === 'code_invalid') {
            const base = 'That code is not correct.';
            return Number.isSafeInteger(error.attemptsRemaining) ? `${base} ${error.attemptsRemaining} attempts left.` : base;
        }
        if (code === 'rate_limited' || code === 'resend_too_soon') {
            return Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0
                ? `Too many requests. Wait ${error.retryAfter} s and try again.`
                : 'Too many requests. Try again.';
        }
        return BASE_ERROR_MESSAGES[code] || 'Something went wrong. Try again.';
    }
    function collisionMessage(forEmail) {
        return forEmail ? `An account already uses ${forEmail}. Sign in instead.` : 'An account already uses this email. Sign in instead.';
    }

    // ---- transition plumbing ----------------------------------------------
    // Every render goes through commit(): it bumps the epoch (invalidating
    // any in-flight operation's ability to act on stale results), aborts a
    // pending passkey prompt, replaces the DOM, and focuses the new h1. A
    // single remaining-time indicator is appended after the screen's own
    // content on every screen except completing/expired, where it is moot.
    function commit(name, node) {
        epoch += 1;
        passkeyAbort?.abort();
        passkeyAbort = null;
        screen = name;
        resendState = null;
        if (expiresAt && name !== 'completing' && name !== 'expired') {
            timerNode = h('p', { className: 'auth-timer', 'aria-live': 'polite' });
            node.append(timerNode);
        } else {
            timerNode = null;
        }
        root.replaceChildren(node);
        const h1 = root.querySelector('h1');
        h1?.focus();
        onTick();
        return epoch;
    }
    function stale(capturedEpoch) {
        onTick();
        return disposed || capturedEpoch !== epoch;
    }

    // Adapters prepare the handoff without navigating. The current operation
    // alone may submit the OIDC form or follow a successful SSO callback.
    function finish(capturedEpoch, result) {
        if (stale(capturedEpoch)) return;
        showCompleting();
        adapter.complete?.(result);
    }

    function onTick() {
        if (disposed) return;
        if (expiresAt && timerNode) {
            const remaining = Math.max(0, expiresAt - ticker.now());
            const totalSeconds = Math.ceil(remaining / 1000);
            timerNode.textContent = `Expires in ${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
        }
        if (resendState) {
            const remaining = Math.max(0, Math.ceil((resendState.resendAt - ticker.now()) / 1000));
            resendState.node.disabled = remaining > 0 || locked;
            resendState.node.textContent = remaining > 0 ? `Resend in ${remaining} s` : 'Resend';
        }
        if (expiresAt && ticker.now() >= expiresAt && screen !== 'expired' && screen !== 'completing') showExpired();
    }
    function startTicking() {
        if (intervalId !== null) return;
        intervalId = ticker.setInterval(() => onTick(), 1000);
    }

    // ---- shared little widgets ---------------------------------------------
    function noticeStatus() {
        const NOTICE_MESSAGES = {
            'google-cancelled': 'Google sign-in was cancelled.',
            'google-denied': 'Google did not complete sign-in.',
            'google-unavailable': 'Google sign-in is not available right now.',
        };
        if (!pendingNotice || !NOTICE_MESSAGES[pendingNotice]) return null;
        const message = NOTICE_MESSAGES[pendingNotice];
        pendingNotice = '';
        return status(message);
    }
    function googleButton(onFailure) {
        return h('button', { type: 'button', className: 'google-button', onClick: async (event) => {
            const capturedEpoch = epoch;
            const button = event.currentTarget;
            button.disabled = true;
            try {
                const result = await adapter.startGoogle();
                if (stale(capturedEpoch)) {
                    try { await adapter.cancelGoogle?.(result); } catch { /* expires server-side if unreachable */ }
                    return;
                }
                adapter.continueGoogle?.(result);
            } catch (error) {
                if (stale(capturedEpoch)) return;
                button.disabled = false;
                onFailure('Unable to continue with Google. Try another sign-in method.');
            }
        } }, [
            h('span', { className: 'google-icon', 'aria-hidden': 'true' }),
            h('span', { text: 'Continue with Google' }),
        ]);
    }

    // ---- screens ------------------------------------------------------------
    function showLoading() {
        commit('loading', h('section', { className: 'auth-panel' }, [heading('Loading…')]));
    }

    function showStart(initialError = '') {
        if (!config.registration) mode = 'login';
        const form = h('form', { className: 'auth-panel start-panel' });
        const errorNode = status(initialError, { error: true });
        const emailInput = h('input', { id: 'auth-email', name: 'email', type: 'email', autocomplete: 'email', required: true });
        emailInput.value = email;
        const children = [heading(mode === 'register' ? 'Create an account' : 'Sign in')];
        if (!config.setupComplete) children.push(h('p', { className: 'auth-copy', text: 'This workspace is not set up yet. The first completed sign-in becomes its administrator.' }));
        if (adapter.clientName) children.push(h('p', { className: 'auth-copy' }, [h('span', { text: 'Continue to ' }), h('strong', { text: adapter.clientName })]));
        const notice = noticeStatus();
        if (notice) children.push(notice);
        if (config.methods.google) children.push(googleButton((message) => { errorNode.textContent = message; errorNode.setAttribute('role', 'alert'); }));
        children.push(h('label', { for: 'auth-email', text: 'Email' }), emailInput);
        children.push(h('button', { type: 'submit', text: 'Next' }));
        children.push(errorNode);
        if (config.registration) {
            children.push(mode === 'login'
                ? h('p', { className: 'auth-switch' }, [h('span', { text: 'New here? ' }), h('button', { type: 'button', className: 'auth-link', text: 'Create an account', onClick: () => { mode = 'register'; email = emailInput.value.trim(); persist(); showStart(); } })])
                : h('p', { className: 'auth-switch' }, [h('span', { text: 'Already have an account? ' }), h('button', { type: 'button', className: 'auth-link', text: 'Sign in', onClick: () => { mode = 'login'; email = emailInput.value.trim(); persist(); showStart(); } })]));
        }
        if (config.adminPassword) children.push(h('button', { type: 'button', className: 'auth-link auth-admin-switch', text: 'Administrator sign-in', onClick: () => showAdmin() }));
        if (typeof adapter.abort === 'function') children.push(h('button', { type: 'button', className: 'auth-link', text: 'Cancel', onClick: () => { showCompleting(); adapter.abort(); } }));
        form.append(...children);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void beginDiscovery(emailInput.value.trim(), form);
        });
        commit('start', form);
    }

    async function beginDiscovery(candidateEmail, form) {
        const capturedEpoch = epoch;
        const button = form.querySelector('button[type="submit"]');
        const errorNode = form.querySelector('.status');
        button.disabled = true;
        try {
            const data = await adapter.discover(candidateEmail);
            if (stale(capturedEpoch)) return;
            email = candidateEmail;
            discovery = data;
            persist();
            afterDiscover(data);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            button.disabled = false;
            if (handleGlobalError(error)) return;
            errorNode.textContent = errorMessage(error);
            errorNode.setAttribute('role', 'alert');
        }
    }

    function afterDiscover(data) {
        if (mode === 'login') {
            if (data.exists) return showChooser(data.methods);
            if (!config.registration) return showNoAccount();
            if (!config.methods.emailCode) return showGoogleRegistration();
            return showConfirmCreate();
        }
        if (data.exists) return showConfirmSignIn();
        if (!config.methods.emailCode) return showGoogleRegistration();
        return sendEmailCode('register');
    }

    function showGoogleRegistration() {
        const errorNode = status('', { error: true });
        commit('googleRegistration', h('section', { className: 'auth-panel' }, [
            heading('Create an account with Google'),
            status('Email registration is not available. Continue with Google to create an account.'),
            googleButton((message) => { errorNode.textContent = message; }),
            errorNode,
            backButton(() => showStart()),
        ]));
    }

    function showConfirmCreate() {
        const form = h('form', { className: 'auth-panel confirm-panel' }, [
            heading('Create an account?'),
            status(`No account uses ${email}. Create one?`),
            h('button', { type: 'submit', text: 'Create account' }),
            backButton(() => showStart(), 'Back'),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            form.querySelector('button[type="submit"]').disabled = true;
            mode = 'register';
            persist();
            void sendEmailCode('register');
        });
        commit('confirmCreate', form);
    }

    function showNoAccount() {
        commit('noAccount', h('section', { className: 'auth-panel' }, [
            heading('No account found'),
            status(`No account uses ${email}.`),
            backButton(() => showStart()),
        ]));
    }

    function showConfirmSignIn() {
        const form = h('form', { className: 'auth-panel confirm-panel' }, [
            heading('Sign in instead?'),
            status(`An account already uses ${email}. Sign in instead?`),
            h('button', { type: 'submit', text: 'Sign in' }),
            backButton(() => showStart(), 'Back'),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            mode = 'login';
            persist();
            showChooser(discovery.methods);
        });
        commit('confirmSignIn', form);
    }

    // The email option is a fixed action for the already-discovered address —
    // never an editable field, which would silently bypass discovery for a
    // different address. It is listed and focused first when usable.
    function showChooser(methods, initialError = '') {
        const usable = ['emailCode', 'passkey', 'totp'].filter((method) => {
            if (method === 'passkey') return methods.passkey && credentials && typeof credentials.get === 'function';
            return methods[method];
        });
        if (!usable.length) return showNoMethods();
        const list = h('div', { className: 'auth-method-list' });
        let emailButton = null;
        for (const method of usable) {
            if (method === 'emailCode') {
                emailButton = h('button', { type: 'button', text: 'Email me a code', onClick: (event) => chooseEmailCode(event.currentTarget) });
                list.append(emailButton);
            } else if (method === 'passkey') {
                list.append(h('button', { type: 'button', text: 'Use a passkey', onClick: () => void startPasskeyFlow() }));
            } else if (method === 'totp') {
                list.append(h('button', { type: 'button', text: 'Use an authenticator app', onClick: () => showTotp() }));
            }
        }
        commit('chooser', h('section', { className: 'auth-panel chooser-panel' }, [
            heading('Choose how to sign in'),
            list,
            ...(initialError ? [status(initialError, { error: true })] : []),
            backButton(() => showStart()),
        ]));
        emailButton?.focus();
    }

    function chooseEmailCode(button) {
        button.disabled = true;
        void sendEmailCode('login');
    }

    function showNoMethods() {
        commit('noMethods', h('section', { className: 'auth-panel' }, [
            heading('No sign-in method available'),
            status('No sign-in method is available for this account here. Continue with Google if the account uses Google, or contact your administrator.'),
            backButton(() => showStart()),
        ]));
    }

    // ---- email code -----------------------------------------------------
    // Initial send: every outcome leaves the caller's screen (code screen on
    // success, start screen with an inline error on failure), so no local
    // button re-enable is needed on failure.
    async function sendEmailCode(purpose) {
        const capturedEpoch = epoch;
        try {
            const data = await adapter.startEmail({ email, purpose, resend: false });
            if (stale(capturedEpoch)) return;
            challenge = data.challenge;
            locked = false;
            showCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            showStart(errorMessage(error));
        }
    }

    // Resend: must stay on the code screen and keep the entered code on
    // failure (rate_limited, resend_too_soon, delivery_failed are routine).
    async function resendEmailCode(resendButton, errorNode) {
        const capturedEpoch = epoch;
        resendButton.disabled = true;
        try {
            const data = await adapter.startEmail({ email, purpose: challenge.purpose, resend: true });
            if (stale(capturedEpoch)) return;
            challenge = data.challenge;
            locked = false;
            showCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            errorNode.textContent = errorMessage(error);
            errorNode.setAttribute('role', 'alert');
            onTick();
        }
    }

    function showCode(initialError = '') {
        const form = h('form', { className: 'auth-panel code-panel' });
        const deliveryMessages = {
            accepted: `We sent a code to ${challenge.email}.`,
            unknown: `We tried to send a code to ${challenge.email}. If it does not arrive, request a new one.`,
            'development-log': 'Development mode: the code was written to the server log.',
        };
        const errorNode = status(initialError, { error: true });
        const codeInput = h('input', { id: 'auth-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });
        const verifyButton = h('button', { type: 'submit', text: 'Verify' });
        const resendButton = h('button', { type: 'button', text: 'Resend', onClick: () => void resendEmailCode(resendButton, errorNode) });
        const changeEmail = h('button', { type: 'button', className: 'auth-link', text: 'Change email', onClick: () => void leaveCode(codeInput, () => showStart()) });
        const cancelButton = h('button', { type: 'button', className: 'auth-link', text: 'Cancel', onClick: () => void leaveCode(codeInput, () => showStart()) });
        verifyButton.disabled = locked;
        resendButton.disabled = true;
        form.append(
            heading(`Enter the 6-digit code sent to ${challenge.email}`),
            status(deliveryMessages[challenge.delivery] || ''),
            h('label', { for: 'auth-code', text: 'Code' }),
            codeInput,
            verifyButton,
            resendButton,
            errorNode,
        );
        if (locked) form.append(h('button', { type: 'button', text: 'Start over', onClick: () => void leaveCode(codeInput, () => showStart()) }));
        form.append(changeEmail, cancelButton);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void verifyCode(codeInput, verifyButton, errorNode);
        });
        commit('code', form);
        resendState = { node: resendButton, resendAt: challenge.resendAt };
        onTick();
    }

    // Change email / Cancel both leave the code screen the same way: clear
    // the code immediately (never let it linger while cancel() is in
    // flight), cancel the server-side attempt (a dropped fetch result is not
    // enough), then return to start with the email unchanged.
    async function leaveCode(codeInput, after) {
        codeInput.value = '';
        showLoading();
        const capturedEpoch = epoch;
        try { await adapter.cancel(); } catch { /* best effort */ }
        if (stale(capturedEpoch)) return;
        after();
    }

    async function verifyCode(codeInput, verifyButton, errorNode) {
        const capturedEpoch = epoch;
        const code = codeInput.value.trim();
        verifyButton.disabled = true;
        try {
            const result = await adapter.verifyEmail(code);
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            codeInput.value = '';
            if (handleGlobalError(error)) return;
            if (error.code === 'too_many_attempts') { locked = true; showCode(errorMessage(error)); return; }
            verifyButton.disabled = false;
            errorNode.textContent = errorMessage(error);
            errorNode.setAttribute('role', 'alert');
        }
    }

    // ---- passkey ----------------------------------------------------------
    async function startPasskeyFlow(initialError = '') {
        const capturedEpoch = commit('passkey', h('section', { className: 'auth-panel passkey-panel' }, [
            heading('Sign in with a passkey'),
            status(initialError || 'Follow your browser’s instructions.', { error: Boolean(initialError) }),
            ...(initialError ? [h('button', { type: 'button', text: 'Try again', onClick: () => void startPasskeyFlow() }), backButton(() => showChooser(discovery.methods))] : []),
        ]));
        if (initialError) return;
        const controller = new AbortController();
        passkeyAbort = controller;
        try {
            const options = await adapter.passkeyOptions(email);
            if (stale(capturedEpoch)) return;
            const assertion = await credentials.get({ publicKey: publicKeyRequestFromServer(options.publicKey), signal: controller.signal });
            if (stale(capturedEpoch)) return;
            const result = await adapter.verifyPasskey({ email, challengeKey: options.challengeKey, assertion });
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            void startPasskeyFlow('Unable to use this passkey.');
        } finally {
            if (passkeyAbort === controller) passkeyAbort = null;
        }
    }

    // ---- authenticator app -------------------------------------------------
    function showTotp(initialError = '') {
        const form = h('form', { className: 'auth-panel totp-panel' });
        const errorNode = status(initialError, { error: true });
        const tokenInput = h('input', { id: 'auth-token', name: 'token', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });
        const verifyButton = h('button', { type: 'submit', text: 'Verify' });
        form.append(
            heading('Sign in with an authenticator'),
            h('label', { for: 'auth-token', text: 'Code' }),
            tokenInput,
            verifyButton,
            errorNode,
            backButton(() => showChooser(discovery.methods)),
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void verifyTotp(tokenInput, verifyButton, errorNode);
        });
        commit('totp', form);
    }

    async function verifyTotp(tokenInput, verifyButton, errorNode) {
        const capturedEpoch = epoch;
        const token = tokenInput.value.trim();
        verifyButton.disabled = true;
        try {
            const result = await adapter.verifyTotp({ email, token });
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            tokenInput.value = '';
            if (handleGlobalError(error)) return;
            verifyButton.disabled = false;
            errorNode.textContent = errorMessage(error);
            errorNode.setAttribute('role', 'alert');
        }
    }

    // ---- administrator ------------------------------------------------------
    function showAdmin(initialError = '') {
        const form = h('form', { className: 'auth-panel admin-panel' });
        const errorNode = status(initialError, { error: true });
        const passwordInput = h('input', { id: 'auth-admin-password', name: 'password', type: 'password', autocomplete: 'current-password', maxlength: '1024', required: true });
        const contactInput = !config.setupComplete ? h('input', { id: 'auth-admin-contact', name: 'contactEmail', type: 'email', autocomplete: 'email' }) : null;
        const verifyButton = h('button', { type: 'submit', text: 'Sign in' });
        form.append(
            heading('Administrator sign-in'),
            h('p', { className: 'auth-copy', text: 'Use the administrator password configured for this deployment.' }),
            h('label', { for: 'auth-admin-password', text: 'Password' }),
            passwordInput,
        );
        if (contactInput) {
            form.append(h('label', { for: 'auth-admin-contact', text: 'Contact email (optional)' }), contactInput,
                h('p', { className: 'auth-copy', text: 'Stored unverified. You can verify it later in My Account.' }));
        }
        form.append(verifyButton, errorNode, backButton(() => showStart()));
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitAdmin(passwordInput, contactInput, verifyButton, errorNode);
        });
        commit('admin', form);
    }

    async function submitAdmin(passwordInput, contactInput, verifyButton, errorNode) {
        const capturedEpoch = epoch;
        const password = passwordInput.value;
        const contactEmail = contactInput ? contactInput.value.trim() : '';
        verifyButton.disabled = true;
        try {
            const result = await adapter.adminLogin({ password, contactEmail });
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            passwordInput.value = '';
            if (handleGlobalError(error)) return;
            verifyButton.disabled = false;
            errorNode.textContent = errorMessage(error, { onAdminScreen: true });
            errorNode.setAttribute('role', 'alert');
        }
    }

    // ---- collision / registration-disabled / expiry -------------------------
    function showCollision() {
        const form = h('form', { className: 'auth-panel confirm-panel' }, [
            heading('Sign in instead?'),
            status(collisionMessage(email)),
            h('button', { type: 'submit', text: 'Sign in' }),
            backButton(() => showStart(), 'Back'),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void resolveCollision();
        });
        commit('collision', form);
    }

    async function resolveCollision() {
        const capturedEpoch = epoch;
        mode = 'login';
        try {
            const data = await adapter.discover(email);
            if (stale(capturedEpoch)) return;
            discovery = data;
            persist();
            showChooser(data.methods);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            showStart(errorMessage(error));
        }
    }

    function showExpired() {
        const isOidc = adapter.flow === 'oidc';
        commit('expired', h('section', { className: 'auth-panel' }, [
            heading('This sign-in request expired'),
            status(isOidc ? `This sign-in request expired. Close this window and start again from ${adapter.clientName}.` : 'This sign-in request expired.'),
            h('button', { type: 'button', text: isOidc ? 'Close window' : 'Start again', onClick: () => adapter.restart() }),
        ]));
    }

    function showCompleting() {
        commit('completing', h('section', { className: 'auth-panel' }, [heading('Signing you in…'), status('Signing you in…')]));
    }

    // Codes shared by many call sites: expiry-like errors always win, then
    // account_exists (late collision) and registration_disabled, which return
    // to a specific screen instead of an inline message on the caller's screen.
    function handleGlobalError(error) {
        const code = (error && error.code) || '';
        if (['attempt_expired', 'login_request_expired', 'login_request_invalid'].includes(code)) { showExpired(); return true; }
        if (code === 'account_exists') { showCollision(); return true; }
        if (code === 'registration_disabled') { mode = 'login'; showStart(errorMessage(error)); return true; }
        return false;
    }

    function defaultMode() {
        if (!config.registration) return 'login';
        if (!config.setupComplete || adapter.screenHint === 'signup') return 'register';
        return 'login';
    }

    async function handleInitialFailure(failure, initialEmail, attemptResult) {
        email = initialEmail || '';
        if (failure.code === 'account_exists') return showCollision();
        if (failure.action === 'email-verify') {
            const liveChallenge = attemptResult.attempt && attemptResult.attempt.status === 'active' ? attemptResult.attempt.challenge : null;
            if (liveChallenge && !liveChallenge.expired) {
                email = liveChallenge.email;
                mode = liveChallenge.purpose === 'register' ? 'register' : 'login';
                challenge = liveChallenge;
                locked = Boolean(attemptResult.attempt.locked);
                return showCode(errorMessage(failure));
            }
            mode = defaultMode();
            return showStart(errorMessage(failure));
        }
        if (failure.action === 'totp' || failure.action === 'passkey-verify') {
            mode = 'login';
            const capturedEpoch = epoch;
            const message = failure.action === 'totp' ? errorMessage(failure) : 'Unable to use this passkey.';
            try {
                const data = await adapter.discover(email);
                if (stale(capturedEpoch)) return;
                discovery = data;
                if (failure.action === 'totp') return showTotp(message);
                return showChooser(data.methods, message);
            } catch (error) {
                if (stale(capturedEpoch) || handleGlobalError(error)) return;
                // Discovery itself failed; there is no chooser to show the
                // passkey error on, so fall back to a usable start screen.
                mode = defaultMode();
                return showStart(message);
            }
        }
        if (failure.action === 'admin-login') return showAdmin(errorMessage(failure, { onAdminScreen: true }));
        mode = defaultMode();
        return showStart(errorMessage(failure));
    }

    // ---- boot -----------------------------------------------------------
    async function boot() {
        showLoading();
        const capturedEpoch = epoch;
        const persisted = readPersisted();
        let result;
        try {
            result = await adapter.attempt();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            showExpired();
            return;
        }
        if (stale(capturedEpoch)) return;
        if (result.completed) { finish(capturedEpoch, result.handoff); return; }
        config = { setupComplete: result.setupComplete, registration: result.registration, methods: result.methods || {}, adminPassword: result.adminPassword };
        expiresAt = result.expiresAt;
        startTicking();
        if (adapter.initialFailure) { await handleInitialFailure(adapter.initialFailure, adapter.initialEmail, result); return; }
        const liveChallenge = result.attempt && result.attempt.status === 'active' ? result.attempt.challenge : null;
        if (liveChallenge && !liveChallenge.expired) {
            email = liveChallenge.email;
            mode = liveChallenge.purpose === 'register' ? 'register' : 'login';
            challenge = liveChallenge;
            locked = Boolean(result.attempt.locked);
            showCode();
            return;
        }
        mode = (persisted && persisted.mode) || defaultMode();
        if (!config.registration) mode = 'login';
        email = (persisted && persisted.email) || '';
        showStart();
    }

    void boot();

    return {
        dispose() {
            disposed = true;
            passkeyAbort?.abort();
            passkeyAbort = null;
            if (intervalId !== null) { ticker.clearInterval(intervalId); intervalId = null; }
        },
    };
}
