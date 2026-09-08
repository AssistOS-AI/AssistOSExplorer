import { createHmac, timingSafeEqual } from 'node:crypto';
import { getOidcProvider } from './provider.mjs';
import { getOrCreateOidcKeys } from './secrets.mjs';
import { getClientMetadata } from './clients.mjs';
import PersistoOidcAdapter from './adapter.mjs';
import { OIDC_SERVICE_PATH, oidcIssuer } from './config.mjs';
import { page, escapeHtml as esc } from './views.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { serialize } from '../serial.mjs';
import { getAuthPolicy, isAuthMethodEnabled } from '../policy.mjs';
import { getSetupStatus, registerUser, getUserById } from '../users.mjs';
import { loginWithPassword } from '../auth/password.mjs';
import { startEmailCode, verifyEmailCode } from '../auth/email-code.mjs';
import { loginVerify as verifyTotp } from '../auth/totp.mjs';
import { loginOptions as passkeyOptions, loginVerify as verifyPasskey } from '../auth/passkey.mjs';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}

function html(res, status, body, redirectUri) {
    // Chromium applies form-action to the authorization redirect chain too.
    // The engine has already validated this interaction's exact callback URI.
    const callbackOrigin = redirectUri ? ` ${new URL(redirectUri).origin}` : '';
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'` });
    res.end(body);
}

async function readBody(req) {
    const chunks = [];
    let size = 0;
    let timer;
    try {
        return await Promise.race([
            (async () => {
                for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                    size += chunk.length;
                    if (size > 56 * 1024) throw Object.assign(new Error('invalid_request'), { statusCode: 413 });
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks).toString('utf8');
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('invalid_request'), { statusCode: 408 })), 10_000); }),
        ]);
    } finally { clearTimeout(timer); }
}

function formBody(req) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
        throw Object.assign(new Error('invalid_request'), { statusCode: 415 });
    }
    const params = new URLSearchParams(req.body || '');
    const body = Object.create(null);
    for (const [key, value] of params) {
        if (Object.hasOwn(body, key)) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
        body[key] = value;
    }
    return body;
}

function csrfFor(uid, key) { return createHmac('sha256', key).update(`oidc-interaction:${uid}`).digest('base64url'); }
function same(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && timingSafeEqual(left, right);
}
function form(url, csrf, body) {
    return `<form method="post" action="${esc(url)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${body}</form>`;
}

async function renderInteraction(res, interaction, issuer, csrf, message = '', status = message ? 400 : 200, screenHint = interaction.params.screen_hint) {
    const client = await getClientMetadata(interaction.params.client_id);
    if (!client) return html(res, 400, page('Application unavailable', '<p>Return to the application and start again.</p>'));
    const base = `${issuer.href}/interaction/${interaction.uid}`;
    const identity = `<p class="muted">Continue to <strong>${esc(client.client_name || client.client_id)}</strong></p>`;
    const abort = form(`${base}/abort`, csrf, '<button class="secondary">Cancel</button>');
    if (interaction.prompt.name === 'consent') {
        const user = await getUserById(interaction.session?.accountId);
        if (!user || user.status !== 'active') throw Object.assign(new Error('login_required'), { statusCode: 401 });
        const labels = { openid: 'Identify your account', profile: 'Read your name and username', email: 'Read your email address and verification status', roles: 'Read your roles', capabilities: 'Read your permissions', offline_access: 'Keep access when you are away', api: 'Access the application API' };
        const scopes = String(interaction.params.scope || '').split(' ').filter(Boolean);
        const permissions = scopes.map((scope) => `<li>${esc(labels[scope] || scope)}</li>`).join('');
        return html(res, 200, page('Allow access?', `${identity}<p>Signed in as ${esc(user.email)}.</p><ul>${permissions}</ul>${form(`${base}/confirm`, csrf, '<button>Allow access</button>')}${abort}`), interaction.params.redirect_uri);
    }
    if (interaction.prompt.name !== 'login') throw Object.assign(new Error('interaction_required'), { statusCode: 400 });
    const policy = await getAuthPolicy();
    const enabled = policy.enabledAuthMethods;
    const email = '<label>Email<input type="email" name="email" autocomplete="username" maxlength="254" required></label>';
    const password = '<label>Password<input type="password" name="password" autocomplete="current-password" maxlength="1024" required></label>';
    let forms = '';
    if (enabled.includes('password')) forms += form(`${base}/login`, csrf, `${email}${password}<button>Sign in</button>`);
    if (enabled.includes('emailCode')) forms += `<details${message && status === 200 ? ' open' : ''}><summary>Sign in with an email code</summary>${form(`${base}/email-start`, csrf, `${email}<button>Send code</button>`)}${form(`${base}/email-verify`, csrf, '<label>Email code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><button>Verify code</button>')}</details>`;
    if (enabled.includes('totp')) forms += `<details><summary>Sign in with an authenticator</summary>${form(`${base}/totp`, csrf, `${email}<label>Authenticator code<input name="token" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><button>Verify code</button>`)}</details>`;
    if (enabled.includes('passkey')) forms += `<details><summary>Sign in with a passkey</summary>${form(`${base}/passkey-options`, csrf, `${email}<button data-passkey>Use passkey</button><p data-passkey-error class="error" role="alert"></p>`)}<script src="${esc(issuer.href)}/interaction.js" defer></script></details>`;
    const setup = await getSetupStatus();
    const canRegister = enabled.includes('password') && policy.selfRegistrationEnabled && !setup.needsInitialAdmin;
    const signupFirst = canRegister && screenHint === 'signup';
    if (canRegister) {
        const registration = form(`${base}/register`, csrf, `${email}<label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" maxlength="1024" required></label><button>Create account</button>`);
        forms = signupFirst
            ? `${registration}<details><summary>Already registered? Sign in</summary>${forms}</details>`
            : `${forms}<details><summary>Create an account</summary>${registration}</details>`;
    }
    return html(res, status, page(signupFirst ? 'Create your account' : 'Sign in', `${identity}${message ? `<p class="${status >= 400 ? 'error' : 'muted'}" role="${status >= 400 ? 'alert' : 'status'}">${esc(message)}</p>` : ''}${forms}${abort}`), interaction.params.redirect_uri);
}

async function interactionRequest(req, res, issuer, provider, match) {
    const [, uid, action = ''] = match;
    return serialize(`oidc-interaction:${uid}`, async () => {
        const interaction = await provider.interactionDetails(req, res);
        if (interaction.uid !== uid || interaction.result) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
        if (!(await getClientMetadata(interaction.params.client_id))) throw Object.assign(new Error('invalid_client'), { statusCode: 400 });
        const { cookieKeys } = await getOrCreateOidcKeys();
        const csrf = csrfFor(uid, cookieKeys[0]);
        if (req.method === 'GET' && !action) return renderInteraction(res, interaction, issuer, csrf);
        if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
        const body = formBody(req);
        if (req.headers.origin !== issuer.origin || !same(body.csrf, csrf)) return json(res, 403, { error: 'invalid_request' });
        const finish = (result, mergeWithLastSubmission = false) => withPersistenceScope(async () => {
            const fresh = await provider.interactionDetails(req, res);
            if (fresh.uid !== uid || fresh.result || !(await getClientMetadata(fresh.params.client_id))) {
                throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
            }
            await provider.interactionFinished(req, res, result, { mergeWithLastSubmission });
        });
        if (action === 'abort') return finish({ error: 'access_denied', error_description: 'The user declined access.' });
        if (action === 'confirm') {
            if (interaction.prompt.name !== 'consent') return json(res, 400, { error: 'invalid_request' });
            return withPersistenceScope(async () => {
                const user = await getUserById(interaction.session?.accountId);
                if (!user || user.status !== 'active') return json(res, 401, { error: 'login_required' });
                let grant = interaction.grantId && await provider.Grant.find(interaction.grantId);
                grant ||= new provider.Grant({ accountId: user.id, clientId: interaction.params.client_id });
                const details = interaction.prompt.details;
                if (details.missingOIDCScope) grant.addOIDCScope(details.missingOIDCScope.join(' '));
                if (details.missingOIDCClaims) grant.addOIDCClaims(details.missingOIDCClaims);
                const grantId = await grant.save();
                return finish({ consent: { grantId } }, true);
            });
        }
        if (interaction.prompt.name !== 'login') return json(res, 400, { error: 'invalid_request' });
        const methods = { login: 'password', register: 'password', 'email-start': 'emailCode', 'email-verify': 'emailCode', totp: 'totp', 'passkey-options': 'passkey', 'passkey-verify': 'passkey' };
        const method = methods[action];
        if (!method || !(await isAuthMethodEnabled(method))) return json(res, 400, { error: 'access_denied' });
        const challengeStore = new PersistoOidcAdapter('LoginChallenge');
        let authenticated;
        try {
            if (action === 'login') authenticated = await loginWithPassword(body.email, body.password);
            if (action === 'register') {
                // The live, browser-bound interaction is checked before account creation.
                const registered = await registerUser({ email: body.email, password: body.password }, { allowInitialAdmin: false });
                authenticated = { ok: true, user: registered.user };
            }
            if (action === 'totp') authenticated = await verifyTotp({ email: body.email, token: body.token });
            if (action === 'email-start') {
                const started = await startEmailCode({ email: body.email, purpose: 'login', correlationId: uid });
                await challengeStore.upsert(uid, { challengeId: started.challengeId, method: 'emailCode' }, 600);
                return renderInteraction(res, interaction, issuer, csrf, 'If this account can sign in, a code has been sent.', 200, 'login');
            }
            if (action === 'email-verify') {
                const stored = await challengeStore.find(uid);
                if (stored?.method === 'emailCode') authenticated = await verifyEmailCode({ challengeId: stored.challengeId, code: body.code });
            }
            if (action === 'passkey-options') {
                const options = await passkeyOptions({ email: body.email, origin: issuer.origin, rpId: issuer.hostname });
                await challengeStore.upsert(uid, { email: body.email, challengeKey: options.challengeKey, method: 'passkey' }, 600);
                return json(res, 200, options);
            }
            if (action === 'passkey-verify') {
                const stored = await challengeStore.find(uid);
                if (stored?.method === 'passkey') authenticated = await verifyPasskey({ email: stored.email,
                    challengeKey: stored.challengeKey, assertion: JSON.parse(body.assertion || '{}'), origin: issuer.origin });
            }
        } catch (error) {
            if (Number(error.statusCode) >= 500 || error.code === 'persistence_unavailable') throw error;
            return renderInteraction(res, interaction, issuer, csrf, action === 'register'
                ? 'Unable to create an account. Check your details and try again.'
                : 'Unable to sign in. Check your details and try again.', 400, action === 'register' ? 'signup' : 'login');
        }
        if (!authenticated?.ok) return renderInteraction(res, interaction, issuer, csrf, 'Unable to sign in. Check your details and try again.', 400, 'login');
        await challengeStore.destroy(uid);
        return finish({ login: { accountId: authenticated.user.id, amr: [method === 'password' ? 'pwd' : method] } });
    });
}

export async function handleOidc(req, res) {
    const path = new URL(req.url, 'http://internal').pathname;
    if (path !== OIDC_SERVICE_PATH && !path.startsWith(`${OIDC_SERVICE_PATH}/`)) return false;
    try {
        const issuer = oidcIssuer();
        if (!issuer) { json(res, 404, { error: 'not_found' }); return true; }
        const provider = await getOidcProvider();
        if (req.method === 'POST') req.body = await readBody(req);
        const original = req.url;
        const suffix = original.slice(OIDC_SERVICE_PATH.length) || '/';
        req.url = suffix;
        req.originalUrl = `${issuer.pathname}${suffix}`;
        req.headers.host = issuer.host;
        req.headers['x-forwarded-host'] = issuer.host;
        req.headers['x-forwarded-proto'] = issuer.protocol.slice(0, -1);
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const interaction = new URL(suffix, issuer.origin).pathname.match(/^\/interaction\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?$/);
        if (interaction) await interactionRequest(req, res, issuer, provider, interaction);
        else if (suffix === '/interaction.js' && req.method === 'GET') {
            const { readFile } = await import('node:fs/promises');
            res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
            res.end(await readFile(new URL('../../public/auth/oidc-interaction.js', import.meta.url)));
        } else {
            // No network-backed provider extensions are enabled. Exclude account,
            // client and grant mutations throughout local token validation/issuance.
            await withPersistenceScope(() => provider.callback()(req, res));
        }
    } catch (error) {
        if ([408, 413].includes(Number(error.statusCode)) && !req.complete) {
            // An abandoned body must release both the socket and the pending
            // async reader after the error response has been flushed.
            if (!res.headersSent) res.setHeader('Connection', 'close');
            res.once('finish', () => req.destroy());
        }
        if (!res.headersSent) json(res, Number(error.statusCode) || 503, { error: Number(error.statusCode) < 500 ? 'invalid_request' : 'temporarily_unavailable' });
        else if (!res.writableEnded) res.end();
    }
    return true;
}
