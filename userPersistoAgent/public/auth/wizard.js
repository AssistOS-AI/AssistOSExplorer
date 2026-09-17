import { publicKeyRequestFromServer } from './auth-api.js';
import { DEFAULT_PASSWORD_POLICY, newPasswordProblem, passwordReasonMessage } from './password-rules.js';

// Protocol-agnostic, email-first sign-in wizard. Talks only to `adapter`
// (see sso-adapter.js / oidc-adapter.js); every screen is rebuilt with
// createElement/textContent and mounted with `root.replaceChildren(...)`.
// Every async operation captures the transition epoch in effect when it
// started; any screen transition bumps the epoch, so a late result can
// never change the view. Transitions also empty password and code inputs.
// `dispose()` stops the clock and aborts any in-flight passkey prompt.
// Everything the wizard shows is advisory: the server authorizes every step.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXPIRY_CODES = new Set(['attempt_expired', 'login_request_expired', 'login_request_invalid']);
const RETRY_NOW_DELIVERIES = new Set(['failed', 'pending']);

export function mountWizard({ root, document, adapter, storage = null, clock = null, credentials = undefined }) {
    const ticker = clock || {
        now: () => Date.now(),
        setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: (id) => globalThis.clearInterval(id),
    };

    let epoch = 0;
    let screen = 'loading';
    let email = '';
    let config = { setupComplete: true, registration: false, signup: { email: false, google: false }, methods: {}, passwordPolicy: DEFAULT_PASSWORD_POLICY };
    let expiresAt = 0;
    let discovery = null; // { email, exists, methods }
    let challenge = null; // pending login code
    let signup = null; // pending signup challenge
    let locked = false;
    let pendingNotice = adapter.notice || '';
    let timerNode = null;
    let resendState = null; // { node, resendAt, label }
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
    function showError(node, message) {
        node.textContent = message;
        node.setAttribute('role', 'alert');
    }
    function heading(text) {
        return h('h1', { tabindex: '-1', text });
    }
    function backButton(onClick, label = 'Back') {
        return h('button', { type: 'button', className: 'auth-link', text: label, onClick });
    }
    // The address a screen acts on, shown read-only so password managers can
    // pair it with the password field.
    function accountEmailField(id) {
        const input = h('input', { id, name: 'email', type: 'email', autocomplete: 'username', readonly: true, className: 'auth-readonly' });
        input.value = email;
        return [h('label', { for: id, text: 'Email' }), input];
    }
    function passwordPolicy() {
        return { ...DEFAULT_PASSWORD_POLICY, ...(config.passwordPolicy || {}) };
    }

    // ---- persistence: only the email address is kept -------------------------
    function persist() {
        if (!storage) return;
        try { storage.setItem(adapter.storageKey, JSON.stringify({ email })); } catch { /* best effort */ }
    }
    function readPersisted() {
        if (!storage) return '';
        try {
            const parsed = JSON.parse(storage.getItem(adapter.storageKey) || 'null');
            return parsed && typeof parsed.email === 'string' ? parsed.email : '';
        } catch { return ''; }
    }

    // ---- error copy ------------------------------------------------------
    const BASE_ERROR_MESSAGES = {
        invalid_email: 'Enter a valid email address.',
        password_mismatch: 'The passwords do not match.',
        code_expired: 'That code expired. Request a new code.',
        too_many_attempts: 'Too many incorrect codes. Start over.',
        delivery_failed: 'We could not send the code. Try again later.',
        account_not_found: 'No account can sign in with this email here.',
        registration_disabled: 'Registration is not available.',
        auth_method_disabled: 'This sign-in method is not available.',
        access_denied: 'This sign-in method is not available.',
        authentication_failed: 'Unable to sign in. Check your details and try again.',
        signup_restart_required: 'Choose your password again to continue.',
        attempt_invalid: 'This sign-in attempt is no longer available. Start over.',
        invalid_redirect_uri: 'The sign-in callback address is invalid.',
        redirect_origin_not_allowed: 'Sign-in is not enabled for this address. Use a configured workspace address or contact the workspace administrator.',
        browser_origin_not_allowed: 'This address is not enabled for authentication.',
        auth_origin_topology_unavailable: 'The workspace authentication addresses are temporarily unavailable. Try again after the workspace is ready.',
        auth_origin_topology_invalid: 'The workspace authentication configuration is invalid. Contact the workspace administrator.',
    };
    function errorMessage(error, { password = false } = {}) {
        const code = (error && error.code) || '';
        if (code === 'authentication_failed' && password) return 'That password is not correct. Try again or choose another way to sign in.';
        if (code === 'invalid_password') return passwordReasonMessage(error.reason, passwordPolicy());
        if (code === 'code_invalid') {
            const base = 'That code is not correct.';
            return Number.isSafeInteger(error.attemptsRemaining) ? `${base} ${error.attemptsRemaining} attempts left.` : base;
        }
        if (code === 'rate_limited' && error.reason === 'send_limit') {
            return adapter.flow === 'oidc'
                ? `Too many codes were requested. Close this window and start again from ${adapter.clientName || 'the application'}.`
                : 'Too many codes were requested. Start again.';
        }
        if (code === 'rate_limited' || code === 'resend_too_soon') {
            return Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0
                ? `Too many attempts. Wait ${error.retryAfter} s and try again.`
                : 'Too many attempts. Try again later.';
        }
        return BASE_ERROR_MESSAGES[code] || 'Something went wrong. Try again.';
    }

    // ---- transition plumbing ----------------------------------------------
    // Every render goes through commit(): it empties secrets in the outgoing
    // screen, bumps the epoch (invalidating any in-flight operation's ability
    // to act on stale results), aborts a pending passkey prompt, replaces the
    // DOM, and focuses the new h1. A single remaining-time indicator is
    // appended on every screen except completing/expired, where it is moot.
    function clearSecrets() {
        for (const input of root.querySelectorAll('input')) {
            if (input.type === 'password' || input.name === 'code' || input.name === 'token') input.value = '';
        }
    }
    function commit(name, node) {
        clearSecrets();
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
        root.querySelector('h1')?.focus();
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
            resendState.node.disabled = remaining > 0 || locked || resendState.busy === true;
            resendState.node.textContent = remaining > 0 ? `${resendState.label} in ${remaining} s` : resendState.label;
        }
        if (expiresAt && ticker.now() >= expiresAt && screen !== 'expired' && screen !== 'completing') showExpired();
    }
    function startTicking() {
        if (intervalId !== null) return;
        intervalId = ticker.setInterval(() => onTick(), 1000);
    }

    // ---- shared widgets ---------------------------------------------------
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
            } catch {
                if (stale(capturedEpoch)) return;
                button.disabled = false;
                onFailure('Unable to continue with Google. Try another sign-in method.');
            }
        } }, [
            h('span', { className: 'google-icon', 'aria-hidden': 'true' }),
            h('span', { text: 'Sign in with Google' }),
        ]);
    }

    // ---- S0 loading / S1 start ------------------------------------------
    function showLoading() {
        commit('loading', h('section', { className: 'auth-panel' }, [heading('Loading…')]));
    }

    function showStart(initialError = '') {
        const form = h('form', { className: 'auth-panel start-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const emailInput = h('input', { id: 'auth-email', name: 'email', type: 'email', autocomplete: 'email', required: true, spellcheck: 'false' });
        emailInput.value = email;
        const nextButton = h('button', { type: 'submit', text: 'Next' });
        const children = [heading(adapter.screenHint === 'signup' ? 'Create your account' : 'Sign in')];
        if (!config.setupComplete) children.push(h('p', { className: 'auth-copy', text: 'This workspace is not set up yet. The first completed sign-in becomes its administrator.' }));
        if (adapter.clientName) children.push(h('p', { className: 'auth-copy' }, [h('span', { text: 'Continue to ' }), h('strong', { text: adapter.clientName })]));
        const notice = noticeStatus();
        if (notice) children.push(notice);
        if (config.methods.google) children.push(googleButton((message) => showError(errorNode, message)));
        children.push(h('label', { for: 'auth-email', text: 'Email' }), emailInput, nextButton, errorNode);
        if (typeof adapter.abort === 'function') children.push(h('button', { type: 'button', className: 'auth-link', text: 'Cancel', onClick: () => { showCompleting(); adapter.abort(); } }));
        form.append(...children);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (nextButton.disabled) return;
            const candidate = emailInput.value.trim();
            if (!EMAIL_PATTERN.test(candidate)) {
                showError(errorNode, errorMessage({ code: 'invalid_email' }));
                emailInput.focus();
                return;
            }
            void beginDiscovery(candidate, nextButton, errorNode);
        });
        commit('start', form);
    }

    async function beginDiscovery(candidate, button, errorNode) {
        const capturedEpoch = epoch;
        button.disabled = true;
        try {
            const data = await adapter.discover(candidate);
            if (stale(capturedEpoch)) return;
            email = candidate;
            discovery = { email: candidate, exists: data.exists === true, methods: data.methods || {} };
            persist();
            afterDiscover();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            button.disabled = false;
            if (handleGlobalError(error)) return;
            showError(errorNode, errorMessage(error));
        }
    }

    function afterDiscover() {
        if (discovery.exists) return showPassword();
        if (config.signup?.email) return showSignupOffer();
        if (config.signup?.google) return showGoogleRegistration();
        return showNoAccount();
    }

    // Discovery for the current address, reused while it still applies.
    async function withDiscovery(then, onFailure) {
        if (discovery?.email === email) return then();
        showLoading();
        const capturedEpoch = epoch;
        try {
            const data = await adapter.discover(email);
            if (stale(capturedEpoch)) return;
            discovery = { email, exists: data.exists === true, methods: data.methods || {} };
            return then();
        } catch (error) {
            if (stale(capturedEpoch) || handleGlobalError(error)) return;
            return onFailure ? onFailure(error) : showStart(errorMessage(error));
        }
    }

    // ---- S2 password ---------------------------------------------------
    function showPassword(initialError = '') {
        const usable = config.methods.password === true && discovery?.methods?.password === true;
        const form = h('form', { className: 'auth-panel password-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const passwordInput = h('input', { id: 'auth-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, disabled: !usable });
        const loginButton = h('button', { type: 'submit', text: 'Log in', disabled: !usable });
        const anotherWay = h('button', { type: 'button', className: 'auth-link', text: 'Try another way', onClick: () => { void withDiscovery(() => showMethods()); } });
        const children = [heading('Enter your password'), ...accountEmailField('auth-account-email'),
            h('label', { for: 'auth-password', text: 'Password' }), passwordInput];
        // Neutral wording: neither blocked status nor Google linkage is disclosed.
        if (!usable) {
            children.push(status(config.methods.password === true
                ? 'Password sign-in is not available for this account here. Choose Try another way.'
                : 'Password sign-in is not available in this workspace.'));
        }
        children.push(loginButton, errorNode, anotherWay, backButton(() => showStart()));
        form.append(...children);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!usable || loginButton.disabled) return;
            void submitPassword(passwordInput, loginButton, errorNode);
        });
        commit('password', form);
        if (!usable) anotherWay.focus();
    }

    async function submitPassword(passwordInput, loginButton, errorNode) {
        const password = passwordInput.value;
        if (!password) {
            showError(errorNode, 'Enter your password.');
            passwordInput.focus();
            return;
        }
        // The value leaves the page only inside this request.
        passwordInput.value = '';
        const capturedEpoch = epoch;
        loginButton.disabled = true;
        try {
            const result = await adapter.passwordLogin({ email, password });
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            loginButton.disabled = false;
            showError(errorNode, errorMessage(error, { password: true }));
            passwordInput.focus();
        }
    }

    // ---- S3 alternative methods ------------------------------------------
    function showMethods(initialError = '') {
        const methods = discovery?.methods || {};
        const webAuthn = Boolean(credentials && typeof credentials.get === 'function');
        const entries = [
            { key: 'emailCode', label: 'Email me a code', run: (button) => chooseEmailCode(button) },
            { key: 'passkey', label: 'Use a passkey', run: () => { void startPasskeyFlow(); } },
            { key: 'totp', label: 'Use an authenticator app', run: () => showTotp() },
        ];
        const list = h('div', { className: 'auth-method-list' });
        let firstUsable = null;
        for (const entry of entries) {
            let reason = '';
            if (config.methods[entry.key] !== true) reason = 'Not available in this workspace.';
            else if (entry.key === 'passkey' && !webAuthn) reason = 'Not available in this browser or at this address.';
            else if (methods[entry.key] !== true) reason = 'Not available for this account.';
            const reasonId = `auth-method-${entry.key}-reason`;
            const button = h('button', { type: 'button', text: entry.label, disabled: Boolean(reason), 'aria-describedby': reason ? reasonId : undefined,
                onClick: (event) => { if (!event.currentTarget.disabled) entry.run(event.currentTarget); } });
            list.append(h('div', { className: 'auth-method' }, [button, reason ? h('p', { id: reasonId, className: 'auth-method-reason', text: reason }) : null]));
            if (!reason && !firstUsable) firstUsable = button;
        }
        const children = [heading('Try another way'), list,
            h('p', { className: 'auth-copy', text: 'Sign-in methods are managed from My Account after you sign in.' })];
        if (!firstUsable) children.push(status('If this account uses Google, go back and choose Sign in with Google. Otherwise contact your workspace administrator.'));
        children.push(status(initialError, { error: true }),
            h('button', { type: 'button', className: 'auth-link', text: 'Use your password', onClick: () => showPassword() }),
            backButton(() => showStart()));
        commit('methods', h('section', { className: 'auth-panel methods-panel' }, children));
        firstUsable?.focus();
    }

    function chooseEmailCode(button) {
        button.disabled = true;
        void sendLoginCode();
    }

    // ---- S4 / S5 signup offer and password ------------------------------
    function showSignupOffer() {
        const form = h('form', { className: 'auth-panel signup-offer-panel' }, [
            heading('Create an account?'),
            status(`No account uses ${email}.`),
            h('button', { type: 'submit', text: 'Sign up' }),
            backButton(() => showStart()),
        ]);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            showSignupPassword();
        });
        commit('signupOffer', form);
    }

    function showSignupPassword(initialError = '') {
        const policy = passwordPolicy();
        const form = h('form', { className: 'auth-panel signup-password-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const passwordInput = h('input', { id: 'auth-new-password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, 'aria-describedby': 'auth-password-hint' });
        const confirmInput = h('input', { id: 'auth-confirm-password', name: 'passwordConfirmation', type: 'password', autocomplete: 'new-password', required: true });
        const createButton = h('button', { type: 'submit', text: 'Create account' });
        const back = backButton(() => { if (!createButton.disabled) showStart(); });
        form.append(
            heading('Create your password'),
            ...accountEmailField('auth-signup-email'),
            h('label', { for: 'auth-new-password', text: 'Password' }), passwordInput,
            h('label', { for: 'auth-confirm-password', text: 'Confirm password' }), confirmInput,
            h('p', { id: 'auth-password-hint', className: 'auth-copy auth-hint', text: `Use at least ${policy.minLength} characters.` }),
            createButton,
            errorNode,
            back,
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitSignup({ passwordInput, confirmInput, createButton, back, errorNode });
        });
        commit('signupPassword', form);
    }

    async function submitSignup({ passwordInput, confirmInput, createButton, back, errorNode }) {
        if (createButton.disabled) return;
        const password = passwordInput.value;
        const passwordConfirmation = confirmInput.value;
        // The server repeats every check with the policy it published.
        const problem = newPasswordProblem(password, passwordConfirmation, passwordPolicy());
        if (problem?.code === 'password_mismatch') {
            confirmInput.value = '';
            showError(errorNode, errorMessage(problem));
            confirmInput.focus();
            return;
        }
        if (problem) {
            showError(errorNode, errorMessage(problem));
            passwordInput.focus();
            return;
        }
        const capturedEpoch = epoch;
        passwordInput.disabled = true;
        confirmInput.disabled = true;
        createButton.disabled = true;
        back.disabled = true;
        try {
            const data = await adapter.startSignup({ email, password, passwordConfirmation });
            passwordInput.value = '';
            confirmInput.value = '';
            if (stale(capturedEpoch)) return;
            signup = data.challenge;
            locked = false;
            showSignupCode();
        } catch (error) {
            passwordInput.value = '';
            confirmInput.value = '';
            if (stale(capturedEpoch)) return;
            if (await recoverUncertainSignup(error, capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            // Nothing was staged: the password is chosen again.
            passwordInput.disabled = false;
            confirmInput.disabled = false;
            createButton.disabled = false;
            back.disabled = false;
            showError(errorNode, errorMessage(error));
            passwordInput.focus();
        }
    }

    // ---- S6 / S6b signup verification ------------------------------------
    function showSignupCode(initialError = '') {
        const sendFailed = RETRY_NOW_DELIVERIES.has(signup.delivery);
        const form = h('form', { className: 'auth-panel signup-code-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const codeInput = h('input', { id: 'auth-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true,
            disabled: sendFailed || locked });
        const verifyButton = h('button', { type: 'submit', text: 'Verify', disabled: sendFailed || locked });
        const controls = { codeInput, verifyButton, sendFailed };
        const deliveryMessages = {
            accepted: `We sent a code to ${signup.email}.`,
            unknown: `We tried to send a code to ${signup.email}. If it does not arrive, request a new one.`,
            'development-log': 'Development mode: the code was written to the server log.',
        };
        const children = [heading(sendFailed ? 'We could not send the code' : `Enter the 6-digit code sent to ${signup.email}`)];
        if (sendFailed) {
            children.push(status(`The code for ${signup.email} was not sent.`),
                h('p', { className: 'auth-copy', text: 'The password you chose is kept for this sign-up. Send the code again when you are ready.' }));
        } else {
            children.push(status(deliveryMessages[signup.delivery] || ''),
                h('p', { className: 'auth-copy', text: 'Your account is created only after you enter this code.' }));
        }
        children.push(h('label', { for: 'auth-code', text: 'Code' }), codeInput, verifyButton);
        let nextResend = null;
        if (sendFailed) {
            const sendAgain = h('button', { type: 'button', text: 'Send again', onClick: () => { if (!sendAgain.disabled) void resendSignupCode(sendAgain, errorNode, controls); } });
            controls.sendButton = sendAgain;
            children.push(sendAgain);
        } else {
            const resendButton = h('button', { type: 'button', className: 'auth-secondary', text: 'Resend code', onClick: () => { if (!resendButton.disabled) void resendSignupCode(resendButton, errorNode, controls); } });
            controls.sendButton = resendButton;
            children.push(resendButton);
            nextResend = { node: resendButton, resendAt: signup.resendAt, label: 'Resend code' };
        }
        children.push(errorNode);
        if (locked) children.push(h('button', { type: 'button', text: 'Start over', onClick: () => { void leaveSignup(() => showStart()); } }));
        controls.changeEmailButton = h('button', { type: 'button', className: 'auth-link', text: 'Change email', onClick: () => { if (!controls.changeEmailButton.disabled) showSignupEmail(); } });
        children.push(controls.changeEmailButton,
            h('button', { type: 'button', className: 'auth-link', text: 'Cancel', onClick: () => { void leaveSignup(() => showStart()); } }));
        form.append(...children);
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!verifyButton.disabled) void verifySignupCode(codeInput, verifyButton, errorNode, controls);
        });
        commit('signupCode', form);
        resendState = nextResend;
        onTick();
    }

    function signupBusy(controls, busy) {
        controls.verifyButton.disabled = controls.codeInput.disabled = busy || controls.sendFailed || locked;
        controls.changeEmailButton.disabled = busy;
        controls.sendButton.disabled = busy || locked;
        if (resendState?.node === controls.sendButton) resendState.busy = busy;
        onTick();
    }

    async function resendSignupCode(button, errorNode, controls) {
        const capturedEpoch = epoch;
        signupBusy(controls, true);
        try {
            const data = await adapter.resendSignup();
            if (stale(capturedEpoch)) return;
            signup = data.challenge;
            locked = false;
            showSignupCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (await recoverUncertainSignup(error, capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            signupBusy(controls, false);
            showError(errorNode, errorMessage(error));
            const panel = button.parentElement;
            if (error.code === 'rate_limited' && error.reason === 'send_limit' && adapter.flow !== 'oidc' && panel && !panel.querySelector('[data-start-again]')) {
                panel.append(h('button', { type: 'button', 'data-start-again': true, text: 'Start again', onClick: () => adapter.restart() }));
            }
            onTick();
        }
    }

    async function verifySignupCode(codeInput, verifyButton, errorNode, controls) {
        const capturedEpoch = epoch;
        const code = codeInput.value.trim();
        signupBusy(controls, true);
        try {
            const result = await adapter.verifySignup(code);
            finish(capturedEpoch, result);
        } catch (error) {
            if (stale(capturedEpoch)) return;
            codeInput.value = '';
            if (handleGlobalError(error)) return;
            if (error.code === 'too_many_attempts') { locked = true; showSignupCode(errorMessage(error)); return; }
            signupBusy(controls, false);
            showError(errorNode, errorMessage(error));
        }
    }

    function showSignupEmail(initialError = '') {
        const form = h('form', { className: 'auth-panel signup-email-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const emailInput = h('input', { id: 'auth-change-email', name: 'email', type: 'email', autocomplete: 'email', required: true, spellcheck: 'false' });
        emailInput.value = signup.email;
        const sendButton = h('button', { type: 'submit', text: 'Send code' });
        const back = backButton(() => { if (!sendButton.disabled) showSignupCode(); });
        form.append(
            heading('Change your email'),
            h('label', { for: 'auth-change-email', text: 'Email' }), emailInput,
            h('p', { className: 'auth-copy', text: 'The password you chose is kept.' }),
            sendButton,
            errorNode,
            back,
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            void submitSignupEmail(emailInput, sendButton, back, errorNode);
        });
        commit('signupEmail', form);
    }

    async function submitSignupEmail(emailInput, sendButton, back, errorNode) {
        if (sendButton.disabled) return;
        const candidate = emailInput.value.trim();
        if (!EMAIL_PATTERN.test(candidate)) {
            showError(errorNode, errorMessage({ code: 'invalid_email' }));
            emailInput.focus();
            return;
        }
        const capturedEpoch = epoch;
        sendButton.disabled = true;
        emailInput.disabled = true;
        back.disabled = true;
        try {
            const data = await adapter.changeSignupEmail(candidate);
            if (stale(capturedEpoch)) return;
            email = candidate;
            persist();
            signup = data.challenge;
            locked = false;
            showSignupCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (await recoverUncertainSignup(error, capturedEpoch, candidate)) return;
            if (['account_exists', 'signup_restart_required'].includes(error?.code)) {
                email = candidate;
                persist();
            }
            if (handleGlobalError(error)) return;
            sendButton.disabled = false;
            emailInput.disabled = false;
            back.disabled = false;
            showError(errorNode, error.code === 'invalid_password' && error.reason === 'equals_email'
                ? 'Choose an email address that is different from your password.' : errorMessage(error));
        }
    }

    // A failed fetch or an unreadable response does not prove the mutation
    // failed. Re-read the bound attempt before asking for another password or
    // showing a code screen whose email or generation may have changed.
    async function recoverUncertainSignup(error, capturedEpoch, attemptedEmail = email) {
        const uncertain = !error?.code || Number(error.status) >= 500 || error.code === 'persistence_unavailable';
        if (!uncertain) return false;
        if (stale(capturedEpoch)) return true;
        await reloadSignupState(attemptedEmail);
        return true;
    }

    async function reloadSignupState(attemptedEmail) {
        showLoading();
        const capturedEpoch = epoch;
        try {
            const result = await adapter.attempt();
            if (stale(capturedEpoch)) return;
            if (result.completed) { finish(capturedEpoch, result.handoff); return; }
            const attempt = result.attempt?.status === 'active' ? result.attempt : null;
            const live = attempt?.challenge;
            if (attempt?.signupPending && live?.purpose === 'register') {
                email = live.email;
                signup = live;
                locked = Boolean(attempt.locked);
                discovery = null;
                persist();
                showSignupCode(live.expired ? errorMessage({ code: 'code_expired' }) : '');
                return;
            }
            email = attemptedEmail;
            signup = null;
            locked = false;
            discovery = null;
            persist();
            showStart('We could not resume this sign-up. Enter your email to continue.');
        } catch (error) {
            if (stale(capturedEpoch) || handleGlobalError(error)) return;
            commit('signupRecovery', h('section', { className: 'auth-panel' }, [
                heading('Check your sign-up status'),
                status('We could not check whether your sign-up was saved. Try again to continue without choosing another password.', { error: true }),
                h('button', { type: 'button', text: 'Try again', onClick: () => { void reloadSignupState(attemptedEmail); } }),
                backButton(() => { void leaveSignup(() => showStart()); }, 'Cancel'),
            ]));
        }
    }

    // Leaving a staged signup cancels it server-side before the next screen,
    // so no pending verifier outlives the user's decision.
    async function leaveSignup(after) {
        for (const input of root.querySelectorAll('input')) if (input.name === 'code') input.value = '';
        showLoading();
        const capturedEpoch = epoch;
        signup = null;
        locked = false;
        try { await adapter.cancel(); } catch { /* best effort */ }
        if (stale(capturedEpoch)) return;
        after();
    }

    // ---- S7 login code ----------------------------------------------------
    async function sendLoginCode() {
        const capturedEpoch = epoch;
        try {
            const data = await adapter.startEmail({ email, purpose: 'login', resend: false });
            if (stale(capturedEpoch)) return;
            challenge = data.challenge;
            locked = false;
            showCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            showMethods(errorMessage(error));
        }
    }

    // Resend stays on the code screen and keeps the entered code on failure.
    async function resendLoginCode(resendButton, errorNode) {
        const capturedEpoch = epoch;
        if (resendState) resendState.busy = true;
        resendButton.disabled = true;
        try {
            const data = await adapter.startEmail({ email, purpose: 'login', resend: true });
            if (stale(capturedEpoch)) return;
            challenge = data.challenge;
            locked = false;
            showCode();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            if (resendState) resendState.busy = false;
            showError(errorNode, errorMessage(error));
            onTick();
        }
    }

    function showCode(initialError = '') {
        const form = h('form', { className: 'auth-panel code-panel', novalidate: true });
        const deliveryMessages = {
            accepted: `We sent a code to ${challenge.email}.`,
            unknown: `We tried to send a code to ${challenge.email}. If it does not arrive, request a new one.`,
            'development-log': 'Development mode: the code was written to the server log.',
        };
        const errorNode = status(initialError, { error: true });
        const codeInput = h('input', { id: 'auth-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });
        const verifyButton = h('button', { type: 'submit', text: 'Verify', disabled: locked });
        const resendButton = h('button', { type: 'button', className: 'auth-secondary', text: 'Resend', onClick: () => { void resendLoginCode(resendButton, errorNode); } });
        form.append(
            heading(`Enter the 6-digit code sent to ${challenge.email}`),
            status(deliveryMessages[challenge.delivery] || ''),
            h('label', { for: 'auth-code', text: 'Code' }),
            codeInput,
            verifyButton,
            resendButton,
            errorNode,
        );
        if (locked) form.append(h('button', { type: 'button', text: 'Start over', onClick: () => { void leaveCode(() => showStart()); } }));
        form.append(
            h('button', { type: 'button', className: 'auth-link', text: 'Try another way', onClick: () => { void leaveCode(() => withDiscovery(() => showMethods())); } }),
            h('button', { type: 'button', className: 'auth-link', text: 'Cancel', onClick: () => { void leaveCode(() => showStart()); } }),
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!verifyButton.disabled) void verifyCode(codeInput, verifyButton, errorNode);
        });
        const pendingResend = { node: resendButton, resendAt: challenge.resendAt, label: 'Resend' };
        commit('code', form);
        resendState = pendingResend;
        onTick();
    }

    // Try another way and Cancel leave the code screen the same way: clear the
    // code immediately, cancel the server-side attempt (a dropped fetch result
    // is not enough), then continue with the email unchanged.
    async function leaveCode(after) {
        for (const input of root.querySelectorAll('input')) if (input.name === 'code') input.value = '';
        showLoading();
        const capturedEpoch = epoch;
        challenge = null;
        locked = false;
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
            showError(errorNode, errorMessage(error));
        }
    }

    // ---- S8 passkey ----------------------------------------------------
    async function startPasskeyFlow(initialError = '') {
        const capturedEpoch = commit('passkey', h('section', { className: 'auth-panel passkey-panel' }, [
            heading('Sign in with a passkey'),
            status(initialError || 'Follow your browser’s instructions.', { error: Boolean(initialError) }),
            ...(initialError ? [h('button', { type: 'button', text: 'Try again', onClick: () => { void startPasskeyFlow(); } })] : []),
            backButton(() => showMethods()),
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

    // ---- S9 authenticator app ------------------------------------------
    function showTotp(initialError = '') {
        const form = h('form', { className: 'auth-panel totp-panel', novalidate: true });
        const errorNode = status(initialError, { error: true });
        const tokenInput = h('input', { id: 'auth-token', name: 'token', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}', required: true });
        const verifyButton = h('button', { type: 'submit', text: 'Verify' });
        form.append(
            heading('Sign in with an authenticator'),
            h('label', { for: 'auth-token', text: 'Code' }),
            tokenInput,
            verifyButton,
            errorNode,
            backButton(() => showMethods()),
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!verifyButton.disabled) void verifyTotp(tokenInput, verifyButton, errorNode);
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
            showError(errorNode, errorMessage(error));
        }
    }

    // ---- S10 / S11 / S12 / S13 / S14 ----------------------------------------
    function showGoogleRegistration() {
        const errorNode = status('', { error: true });
        commit('googleRegistration', h('section', { className: 'auth-panel' }, [
            heading('Create an account with Google'),
            status('Email registration is not available. Sign in with Google to create an account.'),
            googleButton((message) => showError(errorNode, message)),
            errorNode,
            backButton(() => showStart()),
        ]));
    }

    function showNoAccount() {
        commit('noAccount', h('section', { className: 'auth-panel' }, [
            heading('No account found'),
            status(`No account uses ${email}.`),
            config.registration ? null : status('Registration is not available.'),
            backButton(() => showStart()),
        ]));
    }

    function showCollision() {
        const form = h('form', { className: 'auth-panel collision-panel' });
        const errorNode = status('', { error: true });
        const loginButton = h('button', { type: 'submit', text: 'Log in' });
        form.append(
            heading('Log in instead?'),
            status(email ? `An account already uses ${email}. Log in instead.` : 'An account already uses this email. Log in instead.'),
            loginButton,
            errorNode,
            backButton(() => showStart()),
        );
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!loginButton.disabled) void resolveCollision(loginButton, errorNode);
        });
        commit('collision', form);
    }

    async function resolveCollision(button, errorNode) {
        const capturedEpoch = epoch;
        button.disabled = true;
        try {
            const data = await adapter.discover(email);
            if (stale(capturedEpoch)) return;
            discovery = { email, exists: data.exists === true, methods: data.methods || {} };
            persist();
            if (discovery.exists) showPassword();
            else afterDiscover();
        } catch (error) {
            if (stale(capturedEpoch)) return;
            if (handleGlobalError(error)) return;
            button.disabled = false;
            showError(errorNode, errorMessage(error));
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

    // Codes shared by many call sites: expiry always wins; an existing account
    // and closed registration leave any staged signup; a signup whose staging
    // is gone returns to choosing a password with the email kept.
    function handleGlobalError(error) {
        const code = (error && error.code) || '';
        if (EXPIRY_CODES.has(code)) { showExpired(); return true; }
        if (code === 'account_exists') {
            if (signup) void leaveSignup(() => showCollision());
            else showCollision();
            return true;
        }
        if (code === 'registration_disabled') {
            const message = errorMessage(error);
            if (signup) void leaveSignup(() => showStart(message));
            else showStart(message);
            return true;
        }
        if (code === 'signup_restart_required') {
            signup = null;
            locked = false;
            showSignupPassword(errorMessage(error));
            return true;
        }
        return false;
    }

    // A native OIDC completion that failed re-renders this page; resume on the
    // screen the user left, with empty secret inputs.
    async function handleInitialFailure(failure, initialEmail, attemptResult) {
        email = initialEmail || '';
        const attempt = attemptResult.attempt && attemptResult.attempt.status === 'active' ? attemptResult.attempt : null;
        const live = attempt?.challenge || null;
        if (EXPIRY_CODES.has(failure.code)) return showExpired();
        if (failure.code === 'account_exists') return showCollision();
        if (failure.action === 'signup-verify') {
            if (failure.code === 'signup_restart_required') return showSignupPassword(errorMessage(failure));
            if (failure.code === 'registration_disabled') return showStart(errorMessage(failure));
            if (live && live.purpose === 'register' && attempt.signupPending) {
                email = live.email;
                signup = live;
                locked = Boolean(attempt.locked);
                return showSignupCode(errorMessage(failure));
            }
            return showStart(errorMessage(failure));
        }
        if (failure.action === 'email-verify') {
            if (live && live.purpose === 'login' && !live.expired) {
                email = live.email;
                challenge = live;
                locked = Boolean(attempt.locked);
                return showCode(errorMessage(failure));
            }
            return showStart(errorMessage(failure));
        }
        if (['password-login', 'totp', 'passkey-verify'].includes(failure.action) && EMAIL_PATTERN.test(email)) {
            const message = failure.action === 'password-login' ? errorMessage(failure, { password: true })
                : failure.action === 'totp' ? errorMessage(failure) : 'Unable to use this passkey.';
            discovery = null;
            return withDiscovery(() => {
                if (failure.action === 'password-login') return showPassword(message);
                if (failure.action === 'totp') return showTotp(message);
                return showMethods(message);
            }, () => showStart(message));
        }
        return showStart(errorMessage(failure));
    }

    // ---- boot -----------------------------------------------------------
    async function boot() {
        showLoading();
        const capturedEpoch = epoch;
        const persistedEmail = readPersisted();
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
        config = {
            setupComplete: result.setupComplete,
            registration: result.registration === true,
            signup: { email: result.signup?.email === true, google: result.signup?.google === true },
            methods: result.methods || {},
            passwordPolicy: { ...DEFAULT_PASSWORD_POLICY, ...(result.passwordPolicy || {}) },
        };
        expiresAt = result.expiresAt;
        startTicking();
        if (adapter.initialFailure) { await handleInitialFailure(adapter.initialFailure, adapter.initialEmail, result); return; }
        const attempt = result.attempt && result.attempt.status === 'active' ? result.attempt : null;
        const live = attempt?.challenge || null;
        // A reload during verification resumes the staged signup without
        // asking for the password again; an expired code offers a new one.
        if (live && live.purpose === 'register' && attempt.signupPending) {
            email = live.email;
            signup = live;
            locked = Boolean(attempt.locked);
            persist();
            showSignupCode(live.expired ? errorMessage({ code: 'code_expired' }) : '');
            return;
        }
        if (live && live.purpose === 'login' && !live.expired) {
            email = live.email;
            challenge = live;
            locked = Boolean(attempt.locked);
            showCode();
            return;
        }
        email = persistedEmail;
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
