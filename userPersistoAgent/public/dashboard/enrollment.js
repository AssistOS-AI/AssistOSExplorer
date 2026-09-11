import {
    assertionCredentialToServer,
    attestationCredentialToServer,
    publicKeyCreationFromServer,
    publicKeyRequestFromServer,
} from '../auth/auth-api.js';

// Sensitive account changes need a fresh confirmation: the server issues a
// single-use grant for exactly one operation, which is used immediately and
// never stored. Codes, passwords and setup secrets are cleared on every
// transition, cancellation, profile change and page exit.
const REAUTH_LABELS = Object.freeze({
    emailCode: 'Email me a code',
    totp: 'Authenticator app code',
    passkey: 'Passkey',
    adminPassword: 'Administrator password',
    google: 'Google Account',
});
const OPERATION_TITLES = Object.freeze({
    'passkey.register': 'Confirm it is you to add a passkey',
    'totp.enroll': 'Confirm it is you to set up an authenticator',
    'contact.verify': 'Confirm it is you to verify a sign-in email',
});

function errorCode(error) {
    return error?.payload?.reason || error?.payload?.error
        || error?.data?.reason || error?.data?.error || error?.reason || error?.message;
}

function enrollmentError(error, fallback) {
    const code = errorCode(error);
    const payload = error?.payload || {};
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') return 'Passkey request was canceled. You can try again.';
    if (error?.name === 'SecurityError') return 'Passkeys are unavailable at this address. Open your workspace using its secure address.';
    if (code === 'invalid_token') return 'That code did not match. Enter the current six-digit code from your authenticator.';
    if (code === 'code_invalid') {
        return `That code did not match.${Number.isInteger(payload.attemptsRemaining) ? ` ${payload.attemptsRemaining} attempt${payload.attemptsRemaining === 1 ? '' : 's'} left.` : ''}`;
    }
    if (code === 'code_expired') return 'That code expired. Request a new code.';
    if (code === 'too_many_attempts') return 'Too many incorrect codes. Start again.';
    if (code === 'rate_limited' || code === 'resend_too_soon') {
        return `Too many attempts. ${Number.isInteger(payload.retryAfter) ? `Wait ${payload.retryAfter} s and try again.` : 'Wait and try again.'}`;
    }
    if (code === 'delivery_failed') return 'We could not send the code. Try again later.';
    if (code === 'setup_expired' || code === 'setup_not_found' || code === 'setup_superseded') return 'This setup has expired. Cancel and start again.';
    if (code === 'auth_method_disabled') return 'This sign-in method is disabled by your administrator.';
    if (code === 'operation_grant_required' || code === 'attempt_invalid') return 'Confirm it is you again to continue.';
    if (code === 'authentication_failed') return 'We could not confirm it is you.';
    if (code === 'reauthentication_unavailable') return 'That confirmation method is not available for this account.';
    if (code === 'google_account_mismatch') return 'Choose the Google Account already linked to this account.';
    if (code === 'google_recent_authentication_required' || code === 'google_transaction_invalid') {
        return 'Google could not confirm a recent sign-in. Sign in to your Google Account again, then retry.';
    }
    if (code === 'google_popup_blocked') return 'Allow the Google confirmation window, then try again.';
    if (code === 'verified_email_required') return 'Verify a sign-in email first.';
    if (code === 'email_taken') return 'Another account already uses this email.';
    if (code === 'sign_in_email_exists') return 'This account already has a verified sign-in email.';
    if (code === 'invalid_email') return 'Enter a valid email address.';
    return fallback;
}

function checkedResult(result) {
    if (!result || result.ok === false || result.error) {
        const error = new Error(result?.error || result?.reason || 'Enrollment failed');
        error.payload = result;
        throw error;
    }
    return result;
}

export class AccountEnrollment {
    constructor(element, { callTool, onEnrolled = async () => {}, browser = globalThis } = {}) {
        this.element = element;
        this.callTool = callTool;
        this.onEnrolled = onEnrolled;
        this.browser = browser;
        this.operation = 0;
        this.disposed = false;
        this.busy = false;
        this.pending = false;
        this.activeMethod = '';
        this.confirmation = null;
        this.setupId = '';
        this.contactEmail = '';
        this.element.classList.add('up-enrollment');
        this.element.innerHTML = `
            <section class="up-contact" data-contact hidden>
                <div><h3>Sign-in email</h3><p data-contact-status></p></div>
                <form class="up-contact-form" data-contact-form autocomplete="off">
                    <label>Email to verify<input data-contact-email type="email" autocomplete="email" maxlength="254" spellcheck="false" required></label>
                    <div class="up-enrollment-actions"><button type="submit" data-contact-start>Verify this email</button></div>
                </form>
                <form class="up-contact-form" data-contact-code-form hidden autocomplete="off">
                    <label>Six-digit code from that email<input data-contact-code inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
                    <div class="up-enrollment-actions"><button type="submit" data-contact-verify>Verify email</button><button type="button" class="up-secondary" data-contact-resend>Send a new code</button><button type="button" class="up-secondary" data-contact-cancel>Cancel</button></div>
                </form>
            </section>
            <div class="up-method">
                <div><h3>Passkeys</h3><p>Sign in with your device, fingerprint, or security key.</p><p data-passkey-status></p></div>
                <button type="button" data-passkey-start>Add a passkey</button>
            </div>
            <div class="up-method">
                <div><h3>Authenticator app</h3><p>Use a one-time code from an authenticator app.</p><p data-totp-status></p></div>
                <button type="button" data-totp-start>Set up authenticator</button>
            </div>
            <form class="up-reauth" data-reauth hidden autocomplete="off">
                <h3 data-reauth-title tabindex="-1"></h3>
                <label>Confirm with<select data-reauth-method></select></label>
                <label data-reauth-code-label hidden>Six-digit code<input data-reauth-code inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></label>
                <label data-reauth-password-label hidden>Administrator password<input data-reauth-password type="password" autocomplete="current-password" maxlength="1024"></label>
                <div class="up-enrollment-actions"><button type="submit" data-reauth-submit>Continue</button><button type="button" class="up-secondary" data-reauth-cancel>Cancel</button></div>
            </form>
            <form class="up-totp-setup" data-totp-setup hidden autocomplete="off">
                <p>Add a new account in your authenticator app using this setup key, then enter its current code.</p>
                <label>Setup key<input data-totp-secret readonly autocomplete="off" spellcheck="false"></label>
                <details><summary>Manual setup URI</summary><textarea data-totp-uri readonly rows="3" autocomplete="off" spellcheck="false" aria-label="Authenticator setup URI"></textarea></details>
                <label>Six-digit code<input data-totp-token inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
                <div class="up-enrollment-actions"><button type="submit" data-totp-confirm>Confirm authenticator</button><button type="button" class="up-secondary" data-totp-cancel>Cancel</button></div>
            </form>
            <p class="up-enrollment-status" data-enrollment-status role="status" aria-live="polite"></p>`;
        const select = (name) => this.element.querySelector(`[data-${name}]`);
        this.passkeyButton = select('passkey-start');
        this.passkeyStatus = select('passkey-status');
        this.totpButton = select('totp-start');
        this.totpStatus = select('totp-status');
        this.setupForm = select('totp-setup');
        this.secretInput = select('totp-secret');
        this.uriInput = select('totp-uri');
        this.tokenInput = select('totp-token');
        this.confirmButton = select('totp-confirm');
        this.reauthForm = select('reauth');
        this.reauthTitle = select('reauth-title');
        this.reauthMethod = select('reauth-method');
        this.reauthCodeLabel = select('reauth-code-label');
        this.reauthCodeInput = select('reauth-code');
        this.reauthPasswordLabel = select('reauth-password-label');
        this.reauthPasswordInput = select('reauth-password');
        this.reauthSubmit = select('reauth-submit');
        this.contactSection = select('contact');
        this.contactStatus = select('contact-status');
        this.contactForm = select('contact-form');
        this.contactEmailInput = select('contact-email');
        this.contactStartButton = select('contact-start');
        this.contactCodeForm = select('contact-code-form');
        this.contactCodeInput = select('contact-code');
        this.contactVerifyButton = select('contact-verify');
        this.contactResendButton = select('contact-resend');
        this.status = select('enrollment-status');
        this.passkeyButton.addEventListener('click', () => void this.startPasskey());
        this.totpButton.addEventListener('click', () => void this.startTotp());
        select('totp-cancel').addEventListener('click', () => this.cancel());
        select('reauth-cancel').addEventListener('click', () => this.cancel());
        select('contact-cancel').addEventListener('click', () => this.cancel());
        this.setupForm.addEventListener('submit', (event) => { event.preventDefault(); void this.verifyTotp(); });
        this.reauthForm.addEventListener('submit', (event) => { event.preventDefault(); void this.submitConfirmation(); });
        this.reauthMethod.addEventListener('change', () => this.selectConfirmationMethod(this.reauthMethod.value));
        this.contactForm.addEventListener('submit', (event) => { event.preventDefault(); void this.startContactVerification(); });
        this.contactCodeForm.addEventListener('submit', (event) => { event.preventDefault(); void this.verifyContactCode(); });
        this.contactResendButton.addEventListener('click', () => void this.resendContactCode());
        this.pageHide = () => this.cancel();
        this.browser.addEventListener?.('pagehide', this.pageHide);
        this.loadStyles();
        this.updateProfile(null);
    }

    loadStyles() {
        const document = this.element.ownerDocument;
        if (!document?.head || document.querySelector('link[data-userpersisto-enrollment]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('./enrollment.css', import.meta.url).href;
        link.dataset.userpersistoEnrollment = '';
        document.head.append(link);
    }

    enabled(method) {
        return !!this.profile?.user && this.profile.allowedAuthMethods?.includes(method) === true;
    }

    // Passkey and authenticator sign-in are reached through a verified sign-in email.
    signInEmailVerified() {
        return this.profile?.emailVerified === true;
    }

    updateProfile(profile) {
        if (this.disposed) return;
        const activeStillAllowed = !this.activeMethod || this.activeMethod === 'contact'
            || (profile?.allowedAuthMethods?.includes(this.activeMethod) && profile?.emailVerified === true);
        const confirmationStillAllowed = !this.confirmation || profile?.reauthenticationMethods?.includes(this.confirmation.method);
        if (this.profile?.user?.id !== profile?.user?.id || !activeStillAllowed || !confirmationStillAllowed) {
            this.clearSensitiveState();
            this.setStatus('');
        }
        this.profile = profile;
        this.render();
    }

    render() {
        if (this.disposed) return;
        const passkey = this.profile?.enrollments?.passkey || {};
        const totp = this.profile?.enrollments?.totp || {};
        const verified = this.signInEmailVerified();
        const passkeyAvailable = this.browser.isSecureContext === true && typeof this.browser.navigator?.credentials?.create === 'function';
        this.passkeyStatus.textContent = !this.enabled('passkey') ? 'Disabled by your administrator.'
            : !verified ? 'Verify a sign-in email first.'
                : !passkeyAvailable ? 'Use a secure address and a browser that supports passkeys.'
                    : passkey.configured ? `${passkey.count || 1} passkey${(passkey.count || 1) === 1 ? '' : 's'} configured.` : 'No passkey configured yet.';
        this.passkeyButton.textContent = passkey.configured ? 'Add another passkey' : 'Add a passkey';
        this.passkeyButton.disabled = this.busy || !this.enabled('passkey') || !verified || !passkeyAvailable;
        this.totpStatus.textContent = !this.enabled('totp') ? 'Disabled by your administrator.'
            : !verified ? 'Verify a sign-in email first.'
                : this.pending ? 'Enter a code below to finish setup.'
                    : totp.configured ? 'Authenticator configured. Replacing it keeps the current one working until the new one is confirmed, then signs you out everywhere.'
                        : totp.pending ? 'Setup is unfinished. Start again to get a new key.' : 'No authenticator configured yet.';
        this.totpButton.textContent = totp.configured ? 'Replace authenticator' : 'Set up authenticator';
        this.totpButton.disabled = this.busy || this.pending || !this.enabled('totp') || !verified;
        this.confirmButton.disabled = this.busy || !this.pending || !this.enabled('totp');
        this.tokenInput.disabled = this.confirmButton.disabled;
        this.setupForm.hidden = !this.pending || !this.enabled('totp');
        this.renderConfirmation();
        this.renderContact();
    }

    renderConfirmation() {
        const flow = this.confirmation;
        this.reauthForm.hidden = !flow;
        if (!flow) return;
        this.reauthTitle.textContent = OPERATION_TITLES[flow.operation] || 'Confirm it is you';
        const methods = this.profile?.reauthenticationMethods || [];
        if (this.reauthMethod.dataset?.methods !== methods.join(',')) {
            this.reauthMethod.replaceChildren(...methods.map((method) => {
                const option = this.element.ownerDocument?.createElement?.('option') || { value: '', textContent: '' };
                option.value = method;
                option.textContent = REAUTH_LABELS[method] || method;
                return option;
            }));
            if (this.reauthMethod.dataset) this.reauthMethod.dataset.methods = methods.join(',');
        }
        this.reauthMethod.value = flow.method;
        const needsCode = flow.method === 'totp' || (flow.method === 'emailCode' && flow.codeSent);
        this.reauthCodeLabel.hidden = !needsCode;
        this.reauthPasswordLabel.hidden = flow.method !== 'adminPassword';
        this.reauthSubmit.textContent = flow.method === 'emailCode' && !flow.codeSent ? 'Email me a code'
            : flow.method === 'passkey' ? 'Use a passkey' : flow.method === 'google' ? 'Confirm with Google' : 'Continue';
        this.reauthSubmit.disabled = this.busy;
        this.reauthMethod.disabled = this.busy;
    }

    renderContact() {
        const show = Boolean(this.profile?.user) && !this.signInEmailVerified();
        this.contactSection.hidden = !show;
        if (!show) return;
        const contact = this.profile.contact?.email || '';
        this.contactStatus.textContent = contact
            ? `This account has no verified sign-in email. Its contact address ${contact} is not verified and cannot be used to sign in.`
            : 'This account has no verified sign-in email. Verify one to sign in with email codes or add a passkey or authenticator.';
        if (!this.contactEmail && !this.contactEmailInput.value && contact) this.contactEmailInput.value = contact;
        const awaitingCode = Boolean(this.contactEmail);
        this.contactForm.hidden = awaitingCode || Boolean(this.confirmation);
        this.contactCodeForm.hidden = !awaitingCode;
        this.contactStartButton.disabled = this.busy;
        this.contactVerifyButton.disabled = this.busy;
        this.contactResendButton.disabled = this.busy;
    }

    setStatus(message, error = false) {
        if (this.disposed) return;
        this.status.textContent = message;
        this.status.classList.toggle('error', error);
    }

    clearSensitiveState() {
        this.operation += 1;
        const google = this.googleConfirmation;
        this.googleConfirmation = null;
        try { google?.popup?.close(); } catch (_) { /* A provider may isolate its window. */ }
        if (google?.transaction) void Promise.resolve(this.callTool('reauth_cancel', {
            method: 'google', operation: google.operation, transaction: google.transaction,
        })).catch(() => {});
        this.abortController?.abort();
        this.abortController = null;
        this.pending = false;
        this.activeMethod = '';
        this.busy = false;
        this.confirmation = null;
        this.setupId = '';
        this.contactEmail = '';
        this.secretInput.value = '';
        this.uriInput.value = '';
        this.tokenInput.value = '';
        this.reauthCodeInput.value = '';
        this.reauthPasswordInput.value = '';
        this.contactCodeInput.value = '';
        this.setupForm.hidden = true;
        this.reauthForm.hidden = true;
        this.contactCodeForm.hidden = true;
    }

    cancel() {
        const confirming = this.confirmation?.method === 'emailCode' && this.confirmation.codeSent;
        this.clearSensitiveState();
        this.setStatus('');
        this.render();
        // Unfinished server-side code challenges are cancelled, not just forgotten.
        if (confirming && !this.disposed) void Promise.resolve(this.callTool('reauth_cancel', {})).catch(() => {});
    }

    current(operation) {
        return !this.disposed && operation === this.operation && this.element.isConnected !== false;
    }

    // Shows the confirmation step for one operation; `resume(grant)` runs the
    // operation once the server has issued its single-use grant.
    requestConfirmation(operation, activeMethod, resume) {
        this.clearSensitiveState();
        const methods = this.profile?.reauthenticationMethods || [];
        if (!methods.length) {
            this.render();
            this.setStatus('No confirmation method is available for this account. Contact your administrator.', true);
            return;
        }
        this.activeMethod = activeMethod;
        this.confirmation = { operation, method: methods[0], codeSent: false, resume };
        this.render();
        this.setStatus('');
        this.reauthTitle.focus?.();
    }

    selectConfirmationMethod(method) {
        if (!this.confirmation || this.busy) return;
        const wasSent = this.confirmation.method === 'emailCode' && this.confirmation.codeSent;
        this.reauthCodeInput.value = '';
        this.reauthPasswordInput.value = '';
        this.confirmation = { ...this.confirmation, method, codeSent: false };
        this.render();
        if (wasSent) void Promise.resolve(this.callTool('reauth_cancel', {})).catch(() => {});
    }

    async submitConfirmation() {
        const flow = this.confirmation;
        if (this.disposed || this.busy || !flow) return;
        const operation = this.operation;
        const { method } = flow;
        const code = this.reauthCodeInput.value.trim();
        const password = this.reauthPasswordInput.value;
        if ((method === 'totp' || (method === 'emailCode' && flow.codeSent)) && !/^\d{6}$/.test(code)) {
            this.setStatus('Enter the six-digit code.', true);
            return;
        }
        if (method === 'adminPassword' && !password) {
            this.setStatus('Enter the administrator password.', true);
            return;
        }
        this.busy = true;
        this.render();
        try {
            if (method === 'emailCode' && !flow.codeSent) {
                const started = checkedResult(await this.callTool('reauth_start', { operation: flow.operation, method }));
                if (!this.current(operation)) return;
                this.confirmation = { ...flow, codeSent: true };
                this.setStatus(started.challenge?.delivery === 'unknown'
                    ? 'We tried to send a code to your sign-in email. If it does not arrive, request a new one.'
                    : 'We sent a code to your sign-in email.');
                return;
            }
            const proof = { operation: flow.operation, method };
            if (method === 'emailCode') proof.code = code;
            if (method === 'totp') proof.token = code;
            if (method === 'adminPassword') proof.password = password;
            if (method === 'passkey') {
                this.setStatus('Follow your browser’s instructions to use your passkey.');
                const options = checkedResult(await this.callTool('reauth_start', { operation: flow.operation, method }));
                if (!this.current(operation)) return;
                this.abortController = new AbortController();
                const credential = await this.browser.navigator.credentials.get({
                    publicKey: publicKeyRequestFromServer(options.publicKey), signal: this.abortController.signal,
                });
                if (!this.current(operation)) return;
                if (!credential) throw new Error('No credential returned');
                proof.challengeKey = options.challengeKey;
                proof.assertion = assertionCredentialToServer(credential);
            }
            const confirmed = method === 'google'
                ? await this.confirmWithGoogle(flow, operation)
                : checkedResult(await this.callTool('reauth_verify', proof));
            if (!this.current(operation)) return;
            this.reauthCodeInput.value = '';
            this.reauthPasswordInput.value = '';
            this.confirmation = null;
            this.busy = false;
            this.abortController = null;
            this.setStatus('');
            await flow.resume(confirmed.grant, operation);
        } catch (error) {
            if (this.current(operation)) {
                this.reauthCodeInput.value = '';
                this.reauthPasswordInput.value = '';
                this.setStatus(enrollmentError(error, 'We could not confirm it is you. Try again.'), true);
            }
        } finally {
            if (this.current(operation)) { this.busy = false; this.render(); }
        }
    }

    async confirmWithGoogle(flow, operation) {
        // Open synchronously from the click. The parent retains the operation
        // in memory and polls its authenticated endpoint; the provider receives
        // no operation grant and cannot message a grant into this page.
        const popup = this.browser.open?.('about:blank', '_blank', 'popup,width=520,height=680');
        if (!popup) throw new Error('google_popup_blocked');
        try { popup.opener = null; } catch (_) { /* Opener access is not used. */ }
        this.googleConfirmation = { popup, operation: flow.operation };
        let transaction;
        try {
            const started = checkedResult(await this.callTool('reauth_start', { operation: flow.operation, method: 'google' }));
            transaction = started.transaction;
            if (!this.current(operation)) {
                await this.callTool('reauth_cancel', { method: 'google', operation: flow.operation, transaction });
                return null;
            }
            this.googleConfirmation.transaction = transaction;
            popup.location = started.authorizationUrl;
            this.setStatus('Confirm with Google in the opened window. If you close it, select Cancel to try again.');
            const deadline = Date.now() + 300_000;
            while (this.current(operation) && Date.now() < deadline) {
                const result = checkedResult(await this.callTool('reauth_google_complete', { operation: flow.operation, transaction }));
                if (!this.current(operation)) return null;
                if (!result.pending) {
                    this.googleConfirmation = null;
                    return result;
                }
                // Google can isolate its browsing context, making `.closed`
                // appear true while authentication is live. Only explicit
                // cancellation, completion or expiry ends this operation.
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (this.current(operation)) throw new Error('google_transaction_invalid');
            return null;
        } finally {
            try { popup.close(); } catch (_) { /* Window isolation is harmless. */ }
            if (this.current(operation) && this.googleConfirmation?.transaction === transaction) {
                this.googleConfirmation = null;
                if (transaction) void Promise.resolve(this.callTool('reauth_cancel', {
                    method: 'google', operation: flow.operation, transaction,
                })).catch(() => {});
            }
        }
    }

    async startPasskey() {
        if (this.disposed || this.busy || this.passkeyButton.disabled) return;
        this.requestConfirmation('passkey.register', 'passkey', (grant, operation) => this.registerPasskey(grant, operation));
    }

    async registerPasskey(grant, operation) {
        if (!this.current(operation)) return;
        this.activeMethod = 'passkey';
        this.busy = true;
        this.render();
        this.setStatus('Follow your browser’s instructions to create a passkey.');
        this.abortController = new AbortController();
        try {
            const origin = this.browser.location.origin;
            const start = checkedResult(await this.callTool('userpersisto_passkey_registration_options', { origin, grant }));
            if (!this.current(operation)) return;
            const credential = await this.browser.navigator.credentials.create({
                publicKey: publicKeyCreationFromServer(start.publicKey), signal: this.abortController.signal,
            });
            if (!this.current(operation)) return;
            if (!credential) throw new Error('No credential returned');
            checkedResult(await this.callTool('userpersisto_passkey_registration_verify', {
                attestation: attestationCredentialToServer(credential), challengeKey: start.challengeKey, origin,
            }));
            if (!this.current(operation)) return;
            this.profile = { ...this.profile, enrollments: { ...this.profile.enrollments,
                passkey: { configured: true, count: (this.profile.enrollments?.passkey?.count || 0) + 1 },
            } };
            this.setStatus('Passkey added. You can use it the next time you sign in.');
            try { await this.onEnrolled(); } catch (_) {
                if (this.current(operation)) this.setStatus('Passkey added. Refresh your profile to see its current status.');
            }
        } catch (error) {
            if (this.current(operation)) this.setStatus(enrollmentError(error, 'Unable to add a passkey. Try again.'), true);
        } finally {
            if (this.current(operation)) { this.abortController = null; this.activeMethod = ''; this.busy = false; this.render(); }
        }
    }

    async startTotp() {
        if (this.disposed || this.busy || this.totpButton.disabled) return;
        this.requestConfirmation('totp.enroll', 'totp', (grant, operation) => this.beginTotp(grant, operation));
    }

    async beginTotp(grant, operation) {
        if (!this.current(operation)) return;
        this.activeMethod = 'totp';
        this.busy = true;
        this.render();
        this.setStatus('Preparing authenticator setup…');
        try {
            const setup = checkedResult(await this.callTool('userpersisto_totp_setup_start', { grant }));
            if (!this.current(operation)) return;
            if (typeof setup.secret !== 'string' || !/^[A-Z2-7]+=*$/.test(setup.secret)) throw new Error('Invalid setup key');
            this.secretInput.value = setup.secret;
            this.uriInput.value = String(setup.otpauthUrl || '');
            this.setupId = String(setup.setupId || '');
            this.pending = true;
            this.setStatus('Keep this setup key private. It is cleared when you leave or cancel.');
        } catch (error) {
            if (this.current(operation)) this.setStatus(enrollmentError(error, 'Unable to start authenticator setup. Try again.'), true);
        } finally {
            if (this.current(operation)) { this.busy = false; this.render(); if (this.pending) this.tokenInput.focus(); }
        }
    }

    async verifyTotp() {
        if (this.disposed || this.busy || !this.pending || !this.enabled('totp')) return;
        const token = this.tokenInput.value.trim();
        if (!/^\d{6}$/.test(token)) { this.setStatus('Enter the current six-digit code from your authenticator.', true); return; }
        const operation = this.operation;
        this.busy = true;
        this.render();
        try {
            const result = checkedResult(await this.callTool('userpersisto_totp_setup_verify', { token, setupId: this.setupId }));
            if (!this.current(operation)) return;
            this.clearSensitiveState();
            const completedOperation = this.operation;
            this.profile = { ...this.profile, enrollments: { ...this.profile.enrollments,
                totp: { configured: true, pending: false },
            } };
            this.render();
            this.setStatus(result.replaced
                ? 'Authenticator replaced. Other sessions are signed out; sign in again with the new authenticator when asked.'
                : 'Authenticator configured. You can use its codes to sign in.');
            try { await this.onEnrolled(); } catch (_) {
                if (this.current(completedOperation)) this.setStatus('Authenticator configured. Refresh your profile to see its current status.');
            }
        } catch (error) {
            if (this.current(operation)) this.setStatus(enrollmentError(error, 'Unable to confirm the code. Try again.'), true);
        } finally {
            if (this.current(operation)) { this.busy = false; this.tokenInput.value = ''; this.render(); }
        }
    }

    async startContactVerification() {
        if (this.disposed || this.busy || this.signInEmailVerified()) return;
        const email = this.contactEmailInput.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.setStatus('Enter a valid email address.', true); return; }
        this.requestConfirmation('contact.verify', 'contact', (grant, operation) => this.sendContactCode(email, grant, operation));
        this.contactEmailInput.value = email;
    }

    async sendContactCode(email, grant, operation, resend = false) {
        if (!this.current(operation)) return;
        this.activeMethod = 'contact';
        this.busy = true;
        this.render();
        try {
            const result = checkedResult(await this.callTool('contact_start', resend ? { email, resend: true } : { email, grant }));
            if (!this.current(operation)) return;
            this.contactEmail = email;
            this.contactCodeInput.value = '';
            this.setStatus(result.challenge?.delivery === 'unknown'
                ? `We tried to send a code to ${email}. If it does not arrive, request a new one.`
                : `We sent a code to ${email}.`);
        } catch (error) {
            if (this.current(operation)) this.setStatus(enrollmentError(error, 'Unable to send a code to that email. Try again.'), true);
        } finally {
            if (this.current(operation)) { this.busy = false; this.render(); if (this.contactEmail) this.contactCodeInput.focus?.(); }
        }
    }

    async resendContactCode() {
        if (this.disposed || this.busy || !this.contactEmail) return;
        await this.sendContactCode(this.contactEmail, '', this.operation, true);
    }

    async verifyContactCode() {
        if (this.disposed || this.busy || !this.contactEmail) return;
        const code = this.contactCodeInput.value.trim();
        if (!/^\d{6}$/.test(code)) { this.setStatus('Enter the six-digit code from that email.', true); return; }
        const operation = this.operation;
        this.busy = true;
        this.render();
        try {
            const result = checkedResult(await this.callTool('contact_verify', { code }));
            if (!this.current(operation)) return;
            this.clearSensitiveState();
            const completedOperation = this.operation;
            this.profile = { ...this.profile, emailVerified: true, user: { ...this.profile.user, email: result.email } };
            this.render();
            this.setStatus(`${result.email} is now your verified sign-in email.`);
            try { await this.onEnrolled(); } catch (_) {
                if (this.current(completedOperation)) this.setStatus('Email verified. Refresh your profile to see its current status.');
            }
        } catch (error) {
            if (this.current(operation)) { this.contactCodeInput.value = ''; this.setStatus(enrollmentError(error, 'Unable to verify that code. Try again.'), true); }
        } finally {
            if (this.current(operation)) { this.busy = false; this.render(); }
        }
    }

    dispose() {
        this.clearSensitiveState();
        this.disposed = true;
        this.browser.removeEventListener?.('pagehide', this.pageHide);
        this.element.replaceChildren();
        this.profile = null;
    }
}
