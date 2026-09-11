import { publicKeyRequestFromServer, assertionCredentialToServer } from './auth-api.js';

const root = document.querySelector('#auth_content');
const params = new URLSearchParams(window.location.search);
const state = params.get('state') || '';
const requestId = params.get('requestId') || params.get('providerState') || '';

let methods = ['password'];
let defaultMethod = 'password';
let emailChallengeId = '';
let currentView = 'login';
let selectedMethod = '';
let passkeyController = null;
let setup = {
    needsInitialAdmin: false,
    selfRegistrationEnabled: true,
    enabledAuthMethods: ['password']
};

function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (key === 'className') {
            node.className = value;
        } else if (key === 'text') {
            node.textContent = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (value !== undefined && value !== null) {
            node.setAttribute(key, String(value));
        }
    }
    node.append(...children);
    return node;
}

async function request(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
}

function redirectWithCode(result) {
    const redirectUrl = new URL(result.redirectUri, window.location.origin);
    redirectUrl.searchParams.set('state', result.state || state);
    redirectUrl.searchParams.set('code', result.code);
    window.location.assign(redirectUrl.toString());
}

function isCurrentForm(form) {
    return root.querySelector('form') === form;
}

function setStatus(form, message, isError = false) {
    if (!isCurrentForm(form)) return;
    let status = form.querySelector('.status');
    if (!status) {
        status = element('p', { className: 'status', hidden: true });
        form.append(status);
    }
    status.textContent = message || '';
    status.hidden = !message;
    status.classList.toggle('error', isError);
}

function authPayload(extra = {}) {
    return { state, requestId, providerState: requestId, origin: window.location.origin, ...extra };
}

async function submitPassword(form) {
    const email = form.querySelector('[name="email"]').value.trim();
    const password = form.querySelector('[name="password"]').value;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const result = await request('password/login', authPayload({ email, password }));
        if (!isCurrentForm(form)) return;
        redirectWithCode(result);
    } catch (error) {
        setStatus(form, error.message || 'Unable to sign in.', true);
        button.disabled = false;
    }
}

async function submitRegistration(form) {
    const email = form.querySelector('[name="email"]').value.trim();
    const password = form.querySelector('[name="password"]').value;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const result = await request('register', authPayload({ email, password }));
        if (!isCurrentForm(form)) return;
        redirectWithCode(result);
    } catch (error) {
        setStatus(form, error.message || 'Unable to create the account.', true);
        button.disabled = false;
    }
}

async function startEmailCode(form) {
    const email = form.querySelector('[name="email"]').value.trim();
    const button = form.querySelector('[data-email-start]');
    button.disabled = true;
    try {
        const result = await request('email-code/start', authPayload({ email }));
        if (!isCurrentForm(form)) return;
        emailChallengeId = result.challengeId;
        form.querySelector('.email-code-fields').hidden = false;
        form.querySelector('[name="code"]').focus();
        setStatus(form, 'Code sent.');
    } catch (error) {
        setStatus(form, error.message || 'Unable to start email sign-in.', true);
    } finally {
        button.disabled = false;
    }
}

async function verifyEmailCode(form) {
    const code = form.querySelector('[name="code"]').value.trim();
    const button = form.querySelector('[data-email-verify]');
    button.disabled = true;
    try {
        const result = await request('email-code/verify', authPayload({ challengeId: emailChallengeId, code }));
        if (!isCurrentForm(form)) return;
        redirectWithCode(result);
    } catch (error) {
        setStatus(form, error.message || 'Unable to verify the code.', true);
        button.disabled = false;
    }
}

async function submitPasskey(form) {
    const email = form.querySelector('[name="email"]').value.trim();
    const button = form.querySelector('button[type="submit"]');
    if (!window.PublicKeyCredential || !navigator.credentials?.get) {
        setStatus(form, 'Passkeys are not available in this browser.', true);
        return;
    }
    button.disabled = true;
    const controller = new AbortController();
    passkeyController = controller;
    try {
        const options = await request('passkey/options', authPayload({ email }));
        if (!isCurrentForm(form)) return;
        const credential = await navigator.credentials.get({
            publicKey: publicKeyRequestFromServer(options.publicKey),
            signal: controller.signal,
        });
        if (!isCurrentForm(form)) return;
        const result = await request('passkey/verify', authPayload({
            email,
            challengeKey: options.challengeKey,
            assertion: assertionCredentialToServer(credential)
        }));
        if (!isCurrentForm(form)) return;
        redirectWithCode(result);
    } catch (error) {
        setStatus(form, error.message || 'Unable to use this passkey.', true);
        button.disabled = false;
    } finally {
        if (passkeyController === controller) passkeyController = null;
    }
}

async function submitTotp(form) {
    const email = form.querySelector('[name="email"]').value.trim();
    const token = form.querySelector('[name="token"]').value.trim();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const result = await request('totp/verify', authPayload({ email, token }));
        if (!isCurrentForm(form)) return;
        redirectWithCode(result);
    } catch (error) {
        setStatus(form, error.message || 'Unable to verify the authenticator code.', true);
        button.disabled = false;
    }
}

function methodOrder() {
    const ordered = [defaultMethod, ...methods].filter(Boolean);
    return [...new Set(ordered)].filter((method) => methods.includes(method)
        && ['password', 'emailCode', 'passkey', 'totp'].includes(method));
}

function field(label, attributes) {
    const id = `auth-${attributes.name}`;
    return [
        element('label', { for: id, text: label }),
        element('input', { id, ...attributes }),
    ];
}

function switchView(view) {
    currentView = view;
    render();
    root.querySelector('h1')?.focus();
}

function viewSwitch(prompt, label, view) {
    return element('p', { className: 'auth-switch' }, [
        element('span', { text: prompt }),
        element('button', { type: 'button', className: 'auth-link', text: label, onClick: () => switchView(view) }),
    ]);
}

function googleButton(form) {
    return element('button', { type: 'button', className: 'google-button', text: 'Continue with Google', onClick: async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const result = await request('google/start', { requestId, state });
            if (!isCurrentForm(form)) return;
            window.location.assign(result.authorizationUrl);
        } catch {
            setStatus(form, 'Unable to continue with Google. Try another sign-in method.', true);
            button.disabled = false;
        }
    } }, [element('span', { className: 'google-icon', 'aria-hidden': 'true' })]);
}

function render() {
    // Sensitive inputs never survive a view or method switch; the entered email address is carried over.
    const enteredEmail = root.querySelector('input[name="email"]')?.value || '';
    for (const input of root.querySelectorAll('input')) input.value = '';
    passkeyController?.abort();
    passkeyController = null;
    emailChallengeId = '';
    const googleAvailable = !setup.needsInitialAdmin && methods.includes('google');
    const passwordRegistration = setup.needsInitialAdmin || methods.includes('password');
    const canRegister = setup.selfRegistrationEnabled && (passwordRegistration || googleAvailable);
    const registrationTitle = setup.needsInitialAdmin ? 'Create the installation owner' : 'Create an account';
    const registrationCopy = setup.needsInitialAdmin
        ? 'The first account becomes administrator. Only email and password are required.'
        : 'Your account starts with dashboard access by default. Ask an administrator for access to Explorer.';
    const registrationForm = element('form', { className: 'auth-panel registration-panel' }, [
        element('h1', { text: registrationTitle, tabindex: '-1' }),
        element('p', { className: 'auth-copy', text: registrationCopy }),
        ...field('Email', { name: 'email', type: 'email', autocomplete: 'email', required: true }),
        ...field('Password', { name: 'password', type: 'password', minlength: '8', maxlength: '1024', autocomplete: 'new-password', required: true }),
        element('button', { type: 'submit', text: setup.needsInitialAdmin ? 'Create admin account' : 'Create account' }),
        element('p', { className: 'status', hidden: true })
    ]);
    registrationForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitRegistration(registrationForm);
    });
    if (setup.needsInitialAdmin || (currentView === 'register' && canRegister)) {
        if (!passwordRegistration) {
            registrationForm.querySelectorAll('label, input, button[type="submit"]').forEach((node) => node.remove());
        }
        if (googleAvailable) registrationForm.append(googleButton(registrationForm));
        if (!setup.needsInitialAdmin) registrationForm.append(viewSwitch('Already have an account?', 'Sign in', 'login'));
        if (registrationForm.querySelector('[name="email"]')) registrationForm.querySelector('[name="email"]').value = enteredEmail;
        root.replaceChildren(registrationForm);
        return;
    }
    currentView = 'login';

    const passwordForm = element('form', { className: 'auth-panel password-panel' }, [
        element('h1', { text: 'Sign in', tabindex: '-1' }),
        ...field('Email', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
        ...field('Password', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
        element('button', { type: 'submit', text: 'Sign in' }),
        element('p', { className: 'status', hidden: true })
    ]);
    passwordForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitPassword(passwordForm);
    });

    const emailCodeForm = element('form', { className: 'auth-panel email-panel' }, [
        element('h1', { text: 'Sign in with an email code', tabindex: '-1' }),
        ...field('Email', { name: 'email', type: 'email', autocomplete: 'email', required: true }),
        element('button', { type: 'button', 'data-email-start': 'true', text: 'Send code', onClick: () => startEmailCode(emailCodeForm) }),
        element('section', { className: 'email-code-fields', hidden: true }, [
            ...field('Code', { name: 'code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: '6', autocomplete: 'one-time-code' }),
            element('button', { type: 'button', 'data-email-verify': 'true', text: 'Verify', onClick: () => verifyEmailCode(emailCodeForm) })
        ])
    ]);
    emailCodeForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (emailChallengeId) verifyEmailCode(emailCodeForm);
        else startEmailCode(emailCodeForm);
    });

    const passkeyForm = element('form', { className: 'auth-panel passkey-panel' }, [
        element('h1', { text: 'Sign in with a passkey', tabindex: '-1' }),
        ...field('Email', { name: 'email', type: 'email', autocomplete: 'username webauthn', required: true }),
        element('button', { type: 'submit', text: 'Use passkey' })
    ]);
    passkeyForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitPasskey(passkeyForm);
    });

    const totpForm = element('form', { className: 'auth-panel totp-panel' }, [
        element('h1', { text: 'Sign in with an authenticator', tabindex: '-1' }),
        ...field('Email', { name: 'email', type: 'email', autocomplete: 'username', required: true }),
        ...field('Code', { name: 'token', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: '6', autocomplete: 'one-time-code', required: true }),
        element('button', { type: 'submit', text: 'Verify code' })
    ]);
    totpForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitTotp(totpForm);
    });

    const panels = { password: passwordForm, emailCode: emailCodeForm, passkey: passkeyForm, totp: totpForm };
    const enabledMethods = methodOrder();
    if (!enabledMethods.includes(selectedMethod)) selectedMethod = enabledMethods[0];
    const form = panels[selectedMethod] || (googleAvailable ? element('form', { className: 'auth-panel' }, [element('h1', { text: 'Sign in', tabindex: '-1' })]) : null);
    if (!form) {
        root.replaceChildren(element('p', { className: 'auth-panel', text: 'No sign-in methods are available. Contact an administrator.' }));
        return;
    }
    if (enabledMethods.length > 1) {
        const labels = { password: 'Password', emailCode: 'Email code', passkey: 'Passkey', totp: 'Authenticator app' };
        const selector = element('select', { id: 'auth-method', name: 'method' }, enabledMethods.map((method) =>
            element('option', { value: method, text: labels[method] })));
        selector.value = selectedMethod;
        selector.addEventListener('change', () => {
            selectedMethod = selector.value;
            render();
            root.querySelector('#auth-method')?.focus();
        });
        const [heading, ...fields] = form.children;
        form.replaceChildren(heading, element('label', { for: 'auth-method', text: 'Sign-in method' }), selector, ...fields);
    }
    if (googleAvailable) form.append(googleButton(form));
    if (canRegister) form.append(viewSwitch('New here?', 'Create account', 'register'));
    if (form.querySelector('[name="email"]')) form.querySelector('[name="email"]').value = enteredEmail;
    root.replaceChildren(form);
}

try {
    const [methodsResponse, setupResponse] = await Promise.all([fetch('methods'), fetch('setup')]);
    const [methodsData, setupData] = await Promise.all([methodsResponse.json(), setupResponse.json()]);
    if (methodsResponse.ok && methodsData.ok !== false) {
        methods = Array.isArray(methodsData.methods) ? methodsData.methods : methods;
        defaultMethod = methodsData.defaultMethod || defaultMethod;
    }
    if (setupResponse.ok && setupData.ok !== false) setup = { ...setup, ...setupData };
} catch {
}

render();
