import { createHmac, timingSafeEqual } from 'node:crypto';
import { getOidcProvider } from './provider.mjs';
import { getOrCreateOidcKeys } from './secrets.mjs';
import { getClientMetadata } from './clients.mjs';
import PersistoOidcAdapter from './adapter.mjs';
import { OIDC_SERVICE_PATH, oidcIssuer } from './config.mjs';
import { page, escapeHtml as esc } from './views.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { serialize } from '../serial.mjs';
import { isAuthMethodEnabled } from '../policy.mjs';
import { authGenerationOf, getUserById } from '../users.mjs';
import { loginVerify as verifyTotp } from '../auth/totp.mjs';
import { loginOptions as passkeyOptions, loginVerify as verifyPasskey } from '../auth/passkey.mjs';
import { attemptStatus, cancelSignIn, completeEmailSignIn, discoverAccount, startEmailSignIn } from '../auth/signIn.mjs';
import { readAttempt } from '../auth/emailAttempts.mjs';
import { completeAdministratorPassword } from '../auth/adminPassword.mjs';
import { wizardConfiguration } from '../auth/wizardConfig.mjs';
import { ensureBrowserProof, rateSourceOf, readBrowserProof } from '../auth/browserBinding.mjs';
import { getEmailAuthCodeStatus, sendAuthCode } from '../email-agent-client.mjs';
import { cancelGoogleTransactionForParent } from '../../service/googleAuth.mjs';

// OIDC adapter for the shared wizard. JSON actions return wizard state; every
// credential completion is a native form POST that ends in the engine's
// interactionFinished redirect, so the browser keeps the cookie-bound flow.
const JSON_ACTIONS = new Set(['attempt', 'attempt-cancel', 'discover', 'email-start', 'passkey-options']);
const NATIVE_ACTIONS = new Set(['email-verify', 'totp', 'passkey-verify', 'admin-login']);
const METHOD_FOR_ACTION = {
    'email-start': 'emailCode', 'email-verify': 'emailCode', totp: 'totp', 'passkey-options': 'passkey', 'passkey-verify': 'passkey',
};
const NOTICES = new Set(['google-cancelled', 'google-denied', 'google-unavailable']);
const FAILURE_MESSAGES = {
    account_exists: 'An account already uses this email. Sign in instead.',
    registration_disabled: 'Registration is not available.',
    code_invalid: 'Unable to sign in. That code is not correct.',
    code_expired: 'Unable to sign in. That code expired; request a new code.',
    too_many_attempts: 'Unable to sign in. Too many incorrect codes; start again.',
    rate_limited: 'Unable to sign in. Too many attempts; wait and try again.',
    attempt_invalid: 'Unable to sign in. Start again.',
    admin_password_unavailable: 'Administrator sign-in is not available.',
};

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
        'Content-Security-Policy': `default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'` });
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

function field(body, name, max) {
    const value = body[name];
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > max) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request', statusCode: 400 });
    return value;
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

function servicePath(issuer) {
    return issuer.pathname.slice(0, -'oidc'.length);
}

function authAsset(issuer, name) {
    return `${issuer.origin}${servicePath(issuer)}auth/${name}`;
}

// The embedded configuration is data only; `<` is escaped so no markup can end
// the script element, and CSP permits only same-origin scripts.
function jsonScript(id, value) {
    return `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
}

async function renderConsent(res, interaction, issuer, csrf, client) {
    const base = `${issuer.href}/interaction/${interaction.uid}`;
    const identity = `<p class="muted">Continue to <strong>${esc(client.client_name || client.client_id)}</strong></p>`;
    const user = await getUserById(interaction.session?.accountId);
    if (!user || user.status !== 'active') throw Object.assign(new Error('login_required'), { statusCode: 401 });
    const labels = { openid: 'Identify your account', profile: 'Read your name and username', email: 'Read your email address and verification status', roles: 'Read your roles', capabilities: 'Read your permissions', offline_access: 'Keep access when you are away', api: 'Access the application API' };
    const scopes = String(interaction.params.scope || '').split(' ').filter(Boolean);
    const permissions = scopes.map((scope) => `<li>${esc(labels[scope] || scope)}</li>`).join('');
    const signedInAs = user.email || user.username || user.displayName || 'your account';
    return html(res, 200, page('Allow access?', `${identity}<p>Signed in as ${esc(signedInAs)}.</p><ul>${permissions}</ul>${form(`${base}/confirm`, csrf, '<button>Allow access</button>')}${form(`${base}/abort`, csrf, '<button class="secondary">Cancel</button>')}`), interaction.params.redirect_uri);
}

// Login prompt: the shared wizard shell. A native-POST failure re-renders it
// with a visible, readable error and only the attempted email (never codes).
async function renderWizard(res, interaction, issuer, csrf, client, { status = 200, failure = null, email = '', notice = '', emailAvailable = false } = {}) {
    const base = `${issuer.href}/interaction/${interaction.uid}`;
    const clientName = client.client_name || client.client_id;
    const hint = interaction.params.screen_hint === 'signup' ? 'signup' : '';
    const config = {
        flow: 'oidc',
        base,
        csrf,
        client: { name: clientName },
        screenHint: hint,
        expiresAt: interaction.exp * 1000,
        notice: NOTICES.has(notice) ? notice : '',
        failure,
        email,
        ...(await wizardConfiguration({ emailAvailable })),
    };
    const message = failure ? `<p class="error" role="alert" data-server-failure>${esc(failure.message)}</p>` : '';
    const body = `<main id="auth_content" class="userpersisto-auth-shell" aria-live="polite">
<section class="auth-panel" data-wizard-fallback><h1 tabindex="-1">${hint ? 'Create your account' : 'Sign in'}</h1><p class="auth-copy">Continue to <strong>${esc(clientName)}</strong></p>${message}<noscript><p>Enable JavaScript to sign in.</p></noscript>
${form(`${base}/abort`, csrf, '<button type="submit" class="secondary">Cancel</button>')}</section>
</main>${jsonScript('userpersisto-wizard-config', config)}<script type="module" src="${esc(authAsset(issuer, 'oidc-main.js'))}"></script>`;
    const document = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${hint ? 'Create your account' : 'Sign in'} · UserPersisto</title><link rel="stylesheet" href="${esc(authAsset(issuer, 'auth.css'))}"><link rel="stylesheet" href="${esc(authAsset(issuer, 'google-button.css'))}"></head><body>${body}</body></html>`;
    return html(res, status, document, interaction.params.redirect_uri);
}

function failureFrom(error) {
    const code = String(error?.code || 'authentication_failed');
    return { code, message: FAILURE_MESSAGES[code] || 'Unable to sign in. Check your details and try again.',
        ...(Number.isSafeInteger(error?.attemptsRemaining) ? { attemptsRemaining: error.attemptsRemaining } : {}),
        ...(Number.isSafeInteger(error?.retryAfter) ? { retryAfter: error.retryAfter } : {}) };
}

function jsonFailure(res, error) {
    const status = Number(error?.statusCode);
    if (!(status >= 400 && status < 500)) throw error;
    return json(res, status, { ok: false, error: String(error.code || 'invalid_request'),
        ...(Number.isSafeInteger(error.retryAfter) ? { retryAfter: error.retryAfter } : {}),
        ...(Number.isSafeInteger(error.attemptsRemaining) ? { attemptsRemaining: error.attemptsRemaining } : {}) });
}

async function interactionRequest(req, res, issuer, provider, match, { google, deliverEmail, emailStatus }) {
    const [, uid, action = '', subaction = ''] = match;
    if (subaction && action !== 'google-resume') throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
    const emailAvailable = (await emailStatus()).available === true;
    return serialize(`oidc-interaction:${uid}`, async () => {
        const interaction = await provider.interactionDetails(req, res);
        if (interaction.uid !== uid) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
        if (interaction.result) {
            // The committed result survives a lost redirect: the same
            // cookie-bound browser continues to the engine's resume endpoint.
            if (req.method === 'GET' && !action && typeof interaction.returnTo === 'string' && interaction.returnTo.startsWith(issuer.href)) {
                res.writeHead(303, { Location: interaction.returnTo, 'Cache-Control': 'no-store' });
                return res.end();
            }
            throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
        }
        const client = await getClientMetadata(interaction.params.client_id);
        if (!client) throw Object.assign(new Error('invalid_client'), { statusCode: 400 });
        const validateParent = async () => {
            const fresh = await provider.interactionDetails(req, res);
            if (fresh.uid !== uid || fresh.result || fresh.prompt.name !== 'login' || fresh.params.client_id !== interaction.params.client_id
                || fresh.params.redirect_uri !== interaction.params.redirect_uri || !(await getClientMetadata(fresh.params.client_id))) {
                throw Object.assign(new Error('invalid_request'), { code: 'attempt_expired', statusCode: 410 });
            }
        };
        const parent = { flow: 'oidc', id: uid, expiresAt: interaction.exp * 1000 };
        const googleContext = {
            flow: 'oidc',
            parent: { uid, clientId: interaction.params.client_id, redirectUri: interaction.params.redirect_uri,
                origin: issuer.origin, expiresAt: interaction.exp * 1000 },
            validate: validateParent,
            complete: (user) => withPersistenceScope(async () => {
                await validateParent();
                const active = await getUserById(user.id);
                if (!active || active.status !== 'active' || authGenerationOf(active) !== authGenerationOf(user)) {
                    throw Object.assign(new Error('login_required'), { statusCode: 401 });
                }
                await provider.interactionFinished(req, res, { login: { accountId: user.id, authGeneration: authGenerationOf(user), amr: ['federated'], provider: 'google' } }, { mergeWithLastSubmission: false });
            }),
        };
        if (action === 'google-resume') {
            const params = new URL(req.url, issuer.origin).searchParams;
            if (params.getAll('transaction').length !== 1) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
            return google.resume(req, res, googleContext, params.get('transaction'), subaction, req.method === 'POST' ? formBody(req) : {});
        }
        const { cookieKeys } = await getOrCreateOidcKeys();
        const csrf = csrfFor(uid, cookieKeys[0]);
        if (req.method === 'GET' && !action) {
            if (interaction.prompt.name === 'consent') return renderConsent(res, interaction, issuer, csrf, client);
            if (interaction.prompt.name !== 'login') throw Object.assign(new Error('interaction_required'), { statusCode: 400 });
            const notices = new URL(req.url, issuer.origin).searchParams.getAll('notice');
            return renderWizard(res, interaction, issuer, csrf, client, { notice: notices.length === 1 ? notices[0] : '', emailAvailable });
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
        const body = formBody(req);
        if (req.headers.origin !== issuer.origin || !same(body.csrf, csrf)) return json(res, 403, { error: 'invalid_request' });
        if (action === 'google') return google.start(req, res, googleContext);
        const finish = (result, mergeWithLastSubmission = false) => withPersistenceScope(async () => {
            const fresh = await provider.interactionDetails(req, res);
            if (fresh.uid !== uid || fresh.result || !(await getClientMetadata(fresh.params.client_id))) {
                throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
            }
            if (result.login) {
                const active = await getUserById(result.login.accountId);
                if (!active || active.status !== 'active' || result.login.authGeneration !== authGenerationOf(active)) {
                    throw Object.assign(new Error('login_required'), { statusCode: 401 });
                }
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
        if (interaction.prompt.name !== 'login' || (!JSON_ACTIONS.has(action) && !NATIVE_ACTIONS.has(action))) return json(res, 400, { error: 'invalid_request' });
        const method = METHOD_FOR_ACTION[action];
        if (method && !(await isAuthMethodEnabled(method))) return json(res, 400, { error: 'access_denied' });
        const rateSource = rateSourceOf(req);
        const cookie = { path: servicePath(issuer), secure: issuer.protocol === 'https:' };
        const challengeStore = new PersistoOidcAdapter('LoginChallenge');
        if (JSON_ACTIONS.has(action)) {
            try {
                if (action === 'attempt') {
                    const browserProof = ensureBrowserProof(req, res, cookie);
                    return json(res, 200, { ok: true, expiresAt: parent.expiresAt, ...(await wizardConfiguration({ emailAvailable })), attempt: await attemptStatus({ parent, browserProof }) });
                }
                if (action === 'attempt-cancel') {
                    if (body.googleTransaction !== undefined) {
                        await cancelGoogleTransactionForParent({ req, handle: field(body, 'googleTransaction', 128), flow: 'oidc', parentId: uid });
                        return json(res, 200, { ok: true, status: 'cancelled' });
                    }
                    const browserProof = readBrowserProof(req);
                    await challengeStore.destroy(uid);
                    return json(res, 200, { ok: true, ...(browserProof ? await cancelSignIn({ parent, browserProof }) : { status: 'cancelled' }) });
                }
                if (action === 'discover') {
                    return json(res, 200, { ok: true, ...(await discoverAccount({ parent, email: field(body, 'email', 320), rateSource, validateParent, emailAvailable })) });
                }
                if (action === 'email-start') {
                    if (!emailAvailable) throw Object.assign(new Error('auth_method_disabled'), { code: 'auth_method_disabled', statusCode: 404 });
                    const browserProof = ensureBrowserProof(req, res, cookie);
                    const started = await startEmailSignIn({ parent, browserProof, email: field(body, 'email', 320), purpose: field(body, 'purpose', 16),
                        resend: body.resend === 'true', rateSource, validateParent, deliver: deliverEmail });
                    return json(res, 200, { ok: true, ...started });
                }
                // passkey-options: retain the email and challenge server-side for this interaction.
                const email = field(body, 'email', 320);
                const options = await passkeyOptions({ email, origin: issuer.origin, rpId: issuer.hostname, purpose: `oidc-login:${uid}` });
                if (!options.ok) return json(res, 401, { ok: false, error: 'authentication_failed' });
                await challengeStore.upsert(uid, { email, challengeKey: options.challengeKey, method: 'passkey' }, 600);
                return json(res, 200, options);
            } catch (error) {
                return jsonFailure(res, error);
            }
        }
        let authenticated;
        let amr;
        let attemptedEmail = '';
        try {
            if (action === 'email-verify') {
                const browserProof = readBrowserProof(req);
                if (!browserProof) throw Object.assign(new Error('attempt_invalid'), { code: 'attempt_invalid', statusCode: 400 });
                // A failed completion re-renders the wizard naming this attempt's address.
                attemptedEmail = (await readAttempt({ parent, browserProof }).catch(() => null))?.email || '';
                const result = await completeEmailSignIn({ parent, browserProof, code: field(body, 'code', 16), validateParent });
                authenticated = { ok: true, user: result.user };
                amr = ['emailCode'];
            }
            if (action === 'totp') {
                attemptedEmail = field(body, 'email', 320);
                authenticated = await verifyTotp({ email: attemptedEmail, token: field(body, 'token', 16) });
                amr = ['totp'];
            }
            if (action === 'passkey-verify') {
                const stored = await challengeStore.find(uid);
                let assertion;
                try { assertion = JSON.parse(field(body, 'assertion', 16 * 1024) || '{}'); } catch { assertion = null; }
                if (stored?.method === 'passkey' && assertion) {
                    attemptedEmail = stored.email;
                    authenticated = await verifyPasskey({ email: stored.email, challengeKey: stored.challengeKey, assertion,
                        origin: issuer.origin, purpose: `oidc-login:${uid}` });
                }
                amr = ['passkey'];
            }
            if (action === 'admin-login') {
                const result = await completeAdministratorPassword({ password: field(body, 'password', 4096), rateSource,
                    contactEmail: field(body, 'contactEmail', 320), validateParent });
                authenticated = { ok: true, user: result.user };
                amr = ['pwd'];
            }
        } catch (error) {
            if (!(Number(error.statusCode) >= 400 && Number(error.statusCode) < 500) || error.code === 'persistence_unavailable') throw error;
            return renderWizard(res, interaction, issuer, csrf, client, { status: 400, failure: { ...failureFrom(error), action }, email: attemptedEmail, emailAvailable });
        }
        if (!authenticated?.ok) {
            return renderWizard(res, interaction, issuer, csrf, client, { status: 400, failure: { ...failureFrom({ code: 'authentication_failed' }), action }, email: attemptedEmail, emailAvailable });
        }
        await challengeStore.destroy(uid);
        return finish({ login: { accountId: authenticated.user.id, authGeneration: authGenerationOf(authenticated.user), amr } });
    });
}

export async function handleOidc(req, res, { google, deliverEmail = sendAuthCode, emailStatus = getEmailAuthCodeStatus } = {}) {
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
        const interaction = new URL(suffix, issuer.origin).pathname.match(/^\/interaction\/([A-Za-z0-9_-]+)(?:\/([a-z-]+))?(?:\/([a-z-]+))?$/);
        if (interaction) await interactionRequest(req, res, issuer, provider, interaction, { google, deliverEmail, emailStatus });
        else {
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
