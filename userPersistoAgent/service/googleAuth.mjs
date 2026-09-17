import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createGoogleProtocol, googleError, requireGoogleConfiguration } from '../lib/auth/google.mjs';
import { createGoogleTransaction, readGoogleTransaction, transitionGoogleTransaction, prepareGoogleTransactionTransition } from '../lib/auth/googleTransactions.mjs';
import { inspectGoogleIdentity, completeGoogleIdentity, mailboxVersion } from '../lib/externalIdentities.mjs';
import { getLoginRequest, issueAuthCodeLocked } from '../lib/sso.mjs';
import { serialize } from '../lib/serial.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';
import { authGenerationOf, getUserById } from '../lib/users.mjs';
import { completeGoogleReauthentication, googleReauthenticationAccount } from '../lib/auth/operationGrants.mjs';
import { loginVerify as verifyTotp } from '../lib/auth/totp.mjs';
import { loginOptions, loginVerify } from '../lib/auth/passkey.mjs';
import { verifyAdministratorPassword } from '../lib/auth/adminPassword.mjs';
import { hashCode, codeHashMatches } from '../lib/auth/email-code.mjs';
import { assertEmailVerifyBudget, deliverCode, developmentLogFallback, recordEmailVerifyFailure } from '../lib/auth/emailAttempts.mjs';
import { rateSourceOf } from '../lib/auth/browserBinding.mjs';
import { sendAuthCode } from '../lib/email-agent-client.mjs';
import { page, escapeHtml as esc } from '../lib/oidc/views.mjs';
import { readOidcDocument } from '../lib/oidc/adapter.mjs';
import { getClientMetadata } from '../lib/oidc/clients.mjs';

const ROOT = '/service/auth/google';
const HANDLE = /^[a-f0-9]{64}$/;
const CODE_COOLDOWN_MS = 60_000;
const MAX_CODE_FAILURES = 5;
const MAX_CODE_SENDS = 5;
const METHOD_LABELS = { emailCode: 'an email code', passkey: 'a passkey', totp: 'an authenticator code', adminPassword: 'the administrator password' };
const same = (a, b) => {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && timingSafeEqual(left, right);
};
function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(body));
}
function html(res, title, content, status = 200, redirectUri = '') {
    // Chromium checks a form's complete redirect chain. This is the retained,
    // currently validated OIDC client callback, never a browser-supplied target.
    const callbackOrigin = redirectUri ? ` ${new URL(redirectUri).origin}` : '';
    // Native form POSTs need their same-origin Origin header. Callback redirects
    // still use no-referrer; these resumed pages contain no OAuth response code.
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
        'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'${callbackOrigin}; frame-ancestors 'none'; base-uri 'none'` });
    res.end(page(title, content));
}
function redirect(res, location) {
    if (!location.startsWith('/') || location.startsWith('//')) throw googleError();
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
}
function servicePath(config) { return config.redirect.pathname.slice(0, -'auth/google/callback'.length); }
function cookieName(handle, config) { return `${config.redirect.protocol === 'https:' ? '__Secure-' : ''}up_google_${handle}`; }
function cookie(req, handle, config) {
    const values = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName(handle, config)}=`));
    return values.length === 1 ? values[0].slice(values[0].indexOf('=') + 1) : '';
}
function setProof(res, handle, config, value, expiresAt) {
    const header = `${cookieName(handle, config)}=${value}; Path=${servicePath(config)}; HttpOnly; SameSite=Lax; Max-Age=${value ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0}${config.redirect.protocol === 'https:' ? '; Secure' : ''}`;
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), header]);
}

// A stale browser start may finish after the wizard has moved on. Cancel only
// that returned handle, never a newer attempt for the same parent.
export async function cancelGoogleTransactionForParent({ req, handle, flow, parentId }) {
    const config = await requireGoogleConfiguration();
    const proof = { browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint };
    const transaction = await readGoogleTransaction(handle, { ...proof, statuses: ['pending', 'exchanging', 'verified'] });
    const payload = transaction.payload;
    if (payload.flow !== flow || (flow === 'explorer' ? payload.parent.requestId : payload.parent.uid) !== parentId) throw googleError();
    await transitionGoogleTransaction(handle, proof, { from: ['pending', 'exchanging', 'verified'], to: 'cancelled' });
    return { ok: true };
}
function resumePath(payload, handle, config) {
    return payload.flow === 'oidc'
        ? `${servicePath(config)}oidc/interaction/${payload.parent.uid}/google-resume?transaction=${handle}`
        : `${servicePath(config)}auth/google/resume/${handle}`;
}
// Declined or cancelled Google returns to the live wizard for the retained
// parent; an expired parent there offers Start again.
function wizardPath(payload, config, notice) {
    if (payload.flow === 'oidc') return `${servicePath(config)}oidc/interaction/${encodeURIComponent(payload.parent.uid)}?notice=${notice}`;
    const params = new URLSearchParams({ requestId: payload.parent.requestId, state: payload.parent.state, notice });
    return `${servicePath(config)}auth/?${params}`;
}
function actionPath(base, action) {
    const url = new URL(base, 'http://internal');
    return `${url.pathname}/${action}${url.search}`;
}
function form(base, action, csrf, body) {
    return `<form method="post" action="${esc(actionPath(base, action))}"><input type="hidden" name="csrf" value="${esc(csrf)}">${body}</form>`;
}
function input(name, label, attributes = '') {
    return `<label>${label}<input name="${name}" ${attributes} required></label>`;
}
async function readBody(req) {
    let size = 0;
    const chunks = [];
    let timer;
    try {
        const raw = await Promise.race([(async () => {
            for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                size += chunk.length;
                if (size > 56 * 1024) throw googleError('invalid_request', 413);
                chunks.push(chunk);
            }
            return Buffer.concat(chunks).toString('utf8');
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(googleError('invalid_request', 408)), 10_000); })]);
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type === 'application/json') {
            let parsed;
            try { parsed = JSON.parse(raw); } catch { throw googleError(); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw googleError();
            return parsed;
        }
        if (type !== 'application/x-www-form-urlencoded') throw googleError('invalid_request', 415);
        const parsed = Object.create(null);
        for (const [key, value] of new URLSearchParams(raw)) {
            if (Object.hasOwn(parsed, key)) throw googleError();
            parsed[key] = value;
        }
        return parsed;
    } finally { clearTimeout(timer); }
}

export function createGoogleAuthHandlers({ protocol = createGoogleProtocol(), deliverEmail = sendAuthCode } = {}) {
    async function start(req, res, context) {
        const config = await requireGoogleConfiguration();
        if (req.headers.origin !== config.redirect.origin || context.parent.origin !== config.redirect.origin) throw googleError('invalid_request', 403);
        await context.validate();
        const authorization = { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url') };
        await context.validate();
        const current = await requireGoogleConfiguration();
        if (current.fingerprint !== config.fingerprint) throw googleError();
        const proof = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Date.now() + 300_000, context.parent.expiresAt);
        const transaction = await createGoogleTransaction({ state: authorization.state, browserProof: proof, expiresAt, configFingerprint: config.fingerprint,
            payload: { flow: context.flow, mode: config.mode, parent: context.parent, state: authorization.state, verifier: authorization.verifier, nonce: authorization.nonce,
                clientId: config.clientId, redirectUri: config.redirectUri, csrf: randomBytes(32).toString('base64url') } });
        const handle = transaction.handle || transaction.stateHash;
        setProof(res, handle, config, proof, expiresAt);
        const authorizationUrl = new URL(`${servicePath(config)}auth/google/sign-in?transaction=${handle}`, config.redirect.origin).href;
        return json(res, 200, { ok: true, authorizationUrl, transaction: handle });
    }

    async function validateGisParent(payload, config) {
        if (payload.parent.origin !== config.redirect.origin || payload.parent.expiresAt <= Date.now()) throw googleError();
        if (payload.flow === 'explorer') {
            const context = await explorerContext(payload.parent.requestId, payload.parent.state);
            if (context.parent.redirectUri !== payload.parent.redirectUri) throw googleError();
            await context.validate();
        } else if (payload.flow === 'oidc') {
            // OIDC cookies intentionally remain on the OIDC path. The Google
            // browser proof binds this step; the ordinary resume validates the
            // engine's browser cookie before any account or session is issued.
            const parent = await readOidcDocument('Interaction', payload.parent.uid);
            if (!parent || parent.result || parent.prompt?.name !== 'login'
                || parent.params?.client_id !== payload.parent.clientId
                || parent.params?.redirect_uri !== payload.parent.redirectUri
                || !(await getClientMetadata(payload.parent.clientId))) throw googleError();
        } else if (payload.flow === 'reauth') {
            await googleReauthenticationAccount({ userId: payload.parent.userId,
                operation: payload.parent.operation, generation: payload.parent.generation });
        } else throw googleError();
    }

    function gisDestination(payload, handle, config, cancelled = false) {
        if (payload.flow === 'reauth') return `${servicePath(config)}auth/google/confirmation${cancelled ? '?notice=cancelled' : ''}`;
        return cancelled ? wizardPath(payload, config, 'google-cancelled') : resumePath(payload, handle, config);
    }

    async function gisPage(req, res, url) {
        const config = await requireGoogleConfiguration();
        if (config.mode !== 'gis' || url.searchParams.getAll('transaction').length !== 1
            || [...url.searchParams.keys()].some(key => key !== 'transaction')) throw googleError();
        const handle = url.searchParams.get('transaction');
        const transaction = await readGoogleTransaction(handle, {
            browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint, statuses: ['pending'],
        });
        if (transaction.payload.mode !== 'gis') throw googleError();
        await validateGisParent(transaction.payload, config);
        const assetBase = `${servicePath(config)}auth/`;
        const browserConfig = JSON.stringify({
            clientId: config.clientId, nonce: transaction.payload.nonce, transaction: handle,
            credentialUrl: `${assetBase}google/credential`, cancelUrl: `${assetBase}google/cancel`,
            cancelRedirectUrl: gisDestination(transaction.payload, handle, config, true),
            expiresAt: transaction.expiresAt, reauthentication: transaction.payload.flow === 'reauth',
        }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
        // Only this dedicated page loads Google's browser SDK. No credentials
        // or identity tokens are placed in its URL, storage, or response cache.
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Referrer-Policy': config.redirect.protocol === 'http:' ? 'no-referrer-when-downgrade' : 'strict-origin-when-cross-origin',
            'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
            'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; script-src 'self' https://accounts.google.com/gsi/client; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; style-src 'self' https://accounts.google.com/gsi/style; font-src 'self'; img-src 'self' https://*.googleusercontent.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in with Google · UserPersisto</title><link rel="stylesheet" href="${esc(assetBase)}auth.css"></head><body><main class="userpersisto-auth-shell"><section class="auth-panel"><h1>Sign in with Google</h1><p>Continue to your local UserPersisto account.</p><div id="google-sign-in-button"></div><p id="google-sign-in-status" role="status" aria-live="polite">Loading Google sign-in…</p><p id="google-sign-in-timer"></p><button id="google-sign-in-retry" type="button" hidden>Retry</button><button id="google-sign-in-cancel" type="button">Back to sign-in</button></section></main><script id="google-sign-in-config" type="application/json">${browserConfig}</script><script type="module" src="${esc(assetBase)}google-sign-in.mjs"></script></body></html>`);
    }

    async function gisCredential(req, res, cancel = false) {
        const config = await requireGoogleConfiguration();
        if (config.mode !== 'gis' || req.headers.origin !== config.redirect.origin
            || String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw googleError('invalid_request', 403);
        const body = await readBody(req);
        if (Object.keys(body).some(key => !['transaction', ...(cancel ? [] : ['credential'])].includes(key))
            || !HANDLE.test(body.transaction || '')
            || (!cancel && (typeof body.credential !== 'string' || !body.credential || body.credential.length > 16384))) throw googleError();
        const handle = body.transaction;
        const proof = { browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint };
        const transaction = await readGoogleTransaction(handle, { ...proof, statuses: cancel ? ['pending', 'exchanging', 'verified'] : ['pending'] });
        if (transaction.payload.mode !== 'gis') throw googleError();
        if (cancel) {
            await transitionGoogleTransaction(handle, proof, { from: ['pending', 'exchanging', 'verified'], to: 'cancelled' });
            setProof(res, handle, config, '', 0);
            return json(res, 200, { ok: true, redirectUrl: gisDestination(transaction.payload, handle, config, true) });
        }
        await validateGisParent(transaction.payload, config);
        await transitionGoogleTransaction(handle, proof, { from: ['pending'], to: 'exchanging' });
        try {
            const identity = await protocol.verifyCredential(config, body.credential, transaction.payload);
            body.credential = '';
            if ((await requireGoogleConfiguration()).fingerprint !== config.fingerprint) throw googleError();
            await validateGisParent(transaction.payload, config);
            const verified = await transitionGoogleTransaction(handle, proof, {
                from: ['exchanging'], to: 'verified', patch: { identity, state: undefined, nonce: undefined, verifier: undefined },
            });
            return json(res, 200, { ok: true, redirectUrl: gisDestination(verified.payload, handle, config) });
        } catch (error) {
            body.credential = '';
            // Cancellation may have consumed the attempt while key retrieval
            // was pending. It must never be revived by a late verification.
            try { await transitionGoogleTransaction(handle, proof, { from: ['exchanging'], to: 'failed' }); } catch { /* fail closed */ }
            setProof(res, handle, config, '', 0);
            throw error;
        }
    }

    async function startReauthentication(req, res, { userId, operation, origin }) {
        const config = await requireGoogleConfiguration();
        const user = await googleReauthenticationAccount({ userId, operation });
        const generation = authGenerationOf(user);
        return start(req, res, {
            flow: 'reauth',
            parent: { userId, operation, generation, origin, redirectUri: `${config.redirect.origin}${servicePath(config)}dashboard/`, expiresAt: Date.now() + 300_000 },
            validate: () => googleReauthenticationAccount({ userId, operation, generation }),
        });
    }

    async function completeReauthentication(req, res, { userId, operation, handle, cancel = false }) {
        const config = await requireGoogleConfiguration();
        const proof = { browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint };
        const transaction = await readGoogleTransaction(handle, { ...proof, statuses: ['pending', 'exchanging', 'verified'] });
        if (transaction.payload.flow !== 'reauth' || transaction.payload.parent.userId !== userId
            || transaction.payload.parent.operation !== operation) throw googleError('invalid_request', 403);
        if (cancel) {
            await transitionGoogleTransaction(handle, proof, { from: ['pending', 'exchanging', 'verified'], to: 'cancelled' });
            setProof(res, handle, config, '', 0);
            return json(res, 200, { ok: true });
        }
        await googleReauthenticationAccount({ userId, operation, generation: transaction.payload.parent.generation });
        if (transaction.status !== 'verified') return json(res, 200, { ok: true, pending: true });
        const result = await completeGoogleReauthentication({ userId, operation, transaction,
            prepareCompletion: () => prepareGoogleTransactionTransition(handle, proof, { from: 'verified', to: 'consumed' }) });
        setProof(res, handle, config, '', 0);
        return json(res, 200, result);
    }

    async function resume(req, res, context, handle, action = '', body = {}) {
        if (!HANDLE.test(handle || '')) throw googleError();
        return serialize(`google-resume:${handle}`, async () => {
            const config = await requireGoogleConfiguration();
            const proof = { browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint };
            let transaction = await readGoogleTransaction(handle, { ...proof, statuses: ['verified'] });
            let payload = transaction.payload;
            const retained = payload.parent;
            if (payload.flow !== context.flow || retained.origin !== context.parent.origin || retained.redirectUri !== context.parent.redirectUri
                || (payload.flow === 'oidc' ? retained.uid !== context.parent.uid || retained.clientId !== context.parent.clientId : retained.requestId !== context.parent.requestId)) throw googleError();
            await context.validate();
            if (req.method === 'POST' && (req.headers.origin !== config.redirect.origin || !same(body.csrf, payload.csrf))) throw googleError('invalid_request', 403);
            if (req.method !== 'GET' && req.method !== 'POST') throw googleError('invalid_request', 405);
            if (req.method === 'GET' && action) throw googleError('invalid_request', 405);
            const save = async (patch) => {
                transaction = await transitionGoogleTransaction(handle, proof, { from: ['verified'], to: 'verified', patch });
                payload = transaction.payload;
            };
            if (action === 'cancel') {
                // Declining ends only this Google attempt and returns to the wizard.
                await transitionGoogleTransaction(handle, proof, { from: ['verified'], to: 'cancelled' });
                setProof(res, handle, config, '', 0);
                return redirect(res, wizardPath(payload, config, 'google-cancelled'));
            }
            let resolution = await inspectGoogleIdentity(payload.identity, { collisionTarget: payload.collision });
            if (payload.collision && (resolution.kind !== 'collision' || resolution.userId !== payload.collision.userId || resolution.email !== payload.collision.email)) throw googleError();
            if (resolution.kind === 'collision' && !payload.collision) {
                await save({ collision: { userId: resolution.userId, email: resolution.email }, mailboxProof: undefined, emailProof: undefined, linkProof: undefined, linkCode: undefined });
            }
            const base = resumePath(payload, handle, config);
            const cancel = form(base, 'cancel', payload.csrf, `<button class="secondary">${resolution.kind === 'collision' ? 'Don’t link; go back' : 'Cancel'}</button>`);
            const render = (message = '') => {
                let content = message ? `<p role="alert" class="${/sent|verified/i.test(message) ? 'muted' : 'error'}">${esc(message)}</p>` : '';
                if (resolution.kind === 'collision') {
                    const methods = resolution.eligibleMethods;
                    content += `<p>An account for <strong>${esc(resolution.email)}</strong> already exists. To add Google sign-in to it, confirm that the account is yours. Linking does not change the account’s email address, roles or other sign-in methods.</p>`;
                    if (payload.linkProof) {
                        content += `<p>Account confirmed with ${esc(METHOD_LABELS[payload.linkProof.method] || 'your sign-in method')}.</p>${form(base, 'confirm-link', payload.csrf, '<button>Link Google and continue</button>')}`;
                    } else {
                        if (methods.includes('googleAuthoritative')) {
                            content += `<p>Google verified that you control this address.</p>${form(base, 'confirm-link', payload.csrf, '<input type="hidden" name="method" value="googleAuthoritative"><button>Link Google and continue</button>')}`;
                            if (methods.length > 2) content += '<p class="muted">Or confirm with another sign-in method:</p>';
                        }
                        if (methods.includes('emailCode') && !methods.includes('googleAuthoritative')) {
                            content += form(base, 'send-link-code', payload.csrf, `<button>${payload.linkCode ? 'Send a new code' : 'Email me a code'}</button>`);
                            if (payload.linkCode?.delivery && payload.linkCode.delivery !== 'failed') {
                                content += form(base, 'verify-link-code', payload.csrf, `${input('code', 'Email code', 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"')}<button>Verify code</button>`);
                            }
                        }
                        if (methods.includes('totp')) content += form(base, 'authenticate', payload.csrf, `<input type="hidden" name="method" value="totp">${input('token', 'Authenticator code', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button>Confirm with authenticator</button>`);
                        if (methods.includes('passkey')) content += form(base, 'challenge', payload.csrf, '<button data-google-passkey>Confirm with passkey</button>');
                        if (methods.includes('adminPassword')) content += form(base, 'authenticate', payload.csrf, `<input type="hidden" name="method" value="adminPassword">${input('password', 'Administrator password', 'type="password" autocomplete="current-password" maxlength="1024"')}<button>Confirm with administrator password</button>`);
                        if (!methods.length) content += '<p>This account has no sign-in method that can confirm linking. Sign in with your existing method, or contact an administrator.</p>';
                    }
                } else content += `<p>Verify your current mailbox before creating an account.</p>${form(base, 'send-email-proof', payload.csrf, '<button>Send verification code</button>')}${form(base, 'verify-email-proof', payload.csrf, `${input('code', 'Email verification code', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button>Verify and continue</button>`)}`;
                content += `${cancel}<p data-google-error role="alert"></p><script src="${esc(servicePath(config))}auth/google-resume.js" defer></script>`;
                return html(res, resolution.kind === 'collision' ? 'Link your existing account' : 'Verify your email', content, 200,
                    payload.flow === 'oidc' ? retained.redirectUri : '');
            };
            // Mailbox codes for this transaction: bound to its handle, purpose and
            // generation, capped attempts that a resend never resets, and the
            // aggregate per-address budget shared with the wizard's codes.
            const sendCode = async (field, purpose, extra = {}) => {
                const previous = payload[field];
                if (previous?.sentAt > Date.now() - CODE_COOLDOWN_MS && previous.delivery !== 'failed') return render('Please wait before requesting another code.');
                if ((previous?.sends || 0) >= MAX_CODE_SENDS || (previous?.failures || 0) >= MAX_CODE_FAILURES) return render('Too many codes were requested. Start again.');
                const generation = (previous?.generation || 0) + 1;
                const code = String(randomInt(1_000_000)).padStart(6, '0');
                const correlationId = `${purpose}:${handle}`;
                const record = { hash: hashCode(code, `${correlationId}:${generation}`), generation, failures: previous?.failures || 0,
                    sends: (previous?.sends || 0) + 1, sentAt: Date.now(), delivery: 'pending', ...extra };
                await save({ [field]: record });
                const outcome = await deliverCode(deliverEmail, { to: resolution.email, code, correlationId });
                const delivery = developmentLogFallback({ to: resolution.email, code, delivery: outcome.delivery });
                await save({ [field]: { ...record, delivery } });
                if (delivery === 'failed') return render('We could not send the code. Try again later.');
                if (delivery === 'unknown') return render('We could not confirm that the code was sent. If it does not arrive, request a new code after a minute.');
                return render('A code has been sent. Check your inbox.');
            };
            const checkCode = async (field, purpose) => {
                const record = payload[field];
                if (!record?.delivery || record.delivery === 'failed' || record.delivery === 'pending' || record.failures >= MAX_CODE_FAILURES) throw googleError();
                if (record.sentAt < Date.now() - 5 * 60_000) return { ok: false, message: 'That code expired. Request a new code.' };
                try {
                    await assertEmailVerifyBudget(resolution.email);
                } catch (error) {
                    if (error?.code === 'rate_limited') return { ok: false, message: 'Too many attempts. Wait and try again.' };
                    throw error;
                }
                const submitted = typeof body.code === 'string' ? body.code.trim() : '';
                if (!/^\d{6}$/.test(submitted) || !codeHashMatches(submitted, `${purpose}:${handle}:${record.generation}`, record.hash)) {
                    await save({ [field]: { ...record, failures: record.failures + 1 } });
                    await recordEmailVerifyFailure(resolution.email);
                    return { ok: false, message: 'Unable to verify that code.' };
                }
                return { ok: true, record };
            };
            if (['authenticate', 'challenge'].includes(action)) {
                const method = action === 'challenge' ? 'passkey' : body.method;
                if (resolution.kind !== 'collision' || !['passkey', 'totp', 'adminPassword'].includes(method) || !resolution.eligibleMethods.includes(method)) throw googleError();
                let result;
                if (action === 'challenge') {
                    result = await loginOptions({ email: resolution.email, origin: retained.origin, purpose: `google-link:${handle}` });
                    if (!result.ok) throw googleError();
                    await save({ passkeyChallenge: result.challengeKey });
                    return json(res, 200, result);
                }
                if (method === 'totp') result = await verifyTotp({ email: resolution.email, token: body.token }, { includeCredentialProof: true });
                if (method === 'adminPassword') {
                    // Only the designated administrator and current verifier can
                    // authorize a link; the later commit rechecks this proof.
                    try {
                        const verified = await verifyAdministratorPassword({ password: body.password, rateSource: rateSourceOf(req) });
                        result = { ok: true, user: { id: resolution.userId }, credentialVersion: verified.credentialVersion };
                    } catch (error) {
                        if (error?.code === 'rate_limited') return render('Too many attempts. Wait and try again.');
                        result = { ok: false };
                    }
                }
                if (method === 'passkey') {
                    let assertion = body.assertion;
                    try { if (typeof assertion === 'string') assertion = JSON.parse(assertion); } catch { throw googleError(); }
                    result = await loginVerify({ email: resolution.email, assertion,
                        challengeKey: payload.passkeyChallenge, origin: retained.origin, purpose: `google-link:${handle}` }, { includeCredentialProof: true });
                }
                if (!result?.ok || result.user.id !== resolution.userId) return render('Unable to confirm with that credential.');
                await save({ linkProof: { transactionId: handle, userId: resolution.userId, email: resolution.email, method,
                    authenticatedAt: Date.now(), credentialVersion: result.credentialVersion,
                    ...(result.credentialKey ? { credentialKey: result.credentialKey } : {}) }, passkeyChallenge: undefined });
                return render();
            }
            if (action === 'send-link-code') {
                if (resolution.kind !== 'collision' || !resolution.eligibleMethods.includes('emailCode') || payload.linkProof) throw googleError();
                const user = await getUserById(resolution.userId);
                return sendCode('linkCode', 'google-link-email', { mailboxVersion: mailboxVersion(user) });
            }
            if (action === 'verify-link-code') {
                if (resolution.kind !== 'collision' || !resolution.eligibleMethods.includes('emailCode') || payload.linkProof) throw googleError();
                const checked = await checkCode('linkCode', 'google-link-email');
                if (!checked.ok) return render(checked.message);
                await save({ linkCode: undefined, linkProof: { transactionId: handle, userId: resolution.userId, email: resolution.email, method: 'emailCode',
                    authenticatedAt: Date.now(), credentialVersion: checked.record.mailboxVersion } });
                return render('Email verified.');
            }
            if (action === 'send-email-proof') {
                if (resolution.kind !== 'registration' || !resolution.mailboxProofRequired) throw googleError();
                return sendCode('emailProof', 'google-registration-email');
            }
            if (action === 'verify-email-proof') {
                if (resolution.kind !== 'registration' || !resolution.mailboxProofRequired) throw googleError();
                const checked = await checkCode('emailProof', 'google-registration-email');
                if (!checked.ok) return render(checked.message);
                await save({ mailboxProof: { transactionId: handle, email: resolution.email, verifiedAt: Date.now() }, emailProof: undefined });
            }
            if (action === 'confirm-link') {
                if (resolution.kind !== 'collision') throw googleError();
                if (!payload.linkProof && body.method === 'googleAuthoritative' && resolution.eligibleMethods.includes('googleAuthoritative')) {
                    // The narrow shortcut: explicit consent after Google verified an address
                    // it is authoritative for, equal to the current verified mailbox.
                    const now = Date.now();
                    const user = await getUserById(resolution.userId);
                    await save({ linkProof: { transactionId: handle, userId: resolution.userId, email: resolution.email, method: 'googleAuthoritative',
                        authenticatedAt: now, credentialVersion: mailboxVersion(user) } });
                }
                if (!payload.linkProof) throw googleError();
                await save({ linkProof: { ...payload.linkProof, confirmedAt: Date.now() } });
            } else if (action && action !== 'verify-email-proof') throw googleError();
            if (resolution.kind === 'collision' && action !== 'confirm-link') return render();
            if (resolution.kind === 'registration' && resolution.mailboxProofRequired && !payload.mailboxProof) return render();
            const validateParent = async () => {
                if ((await requireGoogleConfiguration()).fingerprint !== config.fingerprint) throw googleError();
                if (transaction.expiresAt <= Date.now()) throw googleError();
                await context.validate();
            };
            const result = await completeGoogleIdentity({ identity: payload.identity, transactionId: handle, collisionTarget: payload.collision, linkProof: payload.linkProof, mailboxProof: payload.mailboxProof,
                validateParent, prepareCompletion: () => prepareGoogleTransactionTransition(handle, proof, { from: ['verified'], to: 'consumed' }) });
            setProof(res, handle, config, '', 0);
            return withPersistenceScope(async () => {
                await validateParent();
                return context.complete(result.user, payload.parent);
            });
        });
    }

    async function explorerContext(requestId, state) {
        const request = await getLoginRequest(requestId);
        const redirectUri = new URL(request.redirectUri);
        const config = await requireGoogleConfiguration();
        if (redirectUri.origin !== config.redirect.origin || redirectUri.pathname !== '/auth/callback' || redirectUri.search || redirectUri.hash
            || typeof state !== 'string' || !state || state.length > 512) throw googleError();
        return { flow: 'explorer', parent: { requestId, state, redirectUri: redirectUri.href, origin: redirectUri.origin, expiresAt: Date.parse(request.expiresAt) },
            validate: async () => {
                const live = await getLoginRequest(requestId);
                if (live.redirectUri !== redirectUri.href) throw googleError();
            } };
    }
    async function handle(req, res) {
        const url = new URL(req.url, 'http://internal');
        if (url.pathname !== ROOT && !url.pathname.startsWith(`${ROOT}/`)) return false;
        try {
            if (url.pathname === `${ROOT}/sign-in` && req.method === 'GET') await gisPage(req, res, url);
            else if ([`${ROOT}/credential`, `${ROOT}/cancel`].includes(url.pathname) && req.method === 'POST') {
                await gisCredential(req, res, url.pathname === `${ROOT}/cancel`);
            } else if (url.pathname === `${ROOT}/confirmation` && req.method === 'GET') {
                const notice = url.searchParams.get('notice');
                const message = notice === 'recent-authentication-required'
                    ? 'Google could not confirm a recent sign-in. Sign in to your Google Account again, then retry from My Account.'
                    : notice === 'cancelled' ? 'Google confirmation was cancelled. Return to My Account to try again.'
                        : notice === 'failed' ? 'Google confirmation failed. Return to My Account to try again.'
                            : 'Google confirmation received. Return to My Account to continue. You may close this window.';
                html(res, 'Account confirmation', `<p>${esc(message)}</p>`);
            } else if (url.pathname === `${ROOT}/start` && req.method === 'POST') {
                const config = await requireGoogleConfiguration();
                if (req.headers.origin !== config.redirect.origin || String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw googleError('invalid_request', 403);
                const body = await readBody(req);
                if (Object.keys(body).some((key) => !['requestId', 'state'].includes(key)) || typeof body.requestId !== 'string' || body.requestId.length > 512) throw googleError();
                await serialize(`sso-request:${body.requestId}`, async () => start(req, res, await explorerContext(body.requestId, body.state)));
            } else {
                const match = url.pathname.match(/^\/service\/auth\/google\/resume\/([a-f0-9]{64})(?:\/([a-z-]+))?$/);
                if (!match) throw googleError('invalid_request', 404);
                const config = await requireGoogleConfiguration();
                const transaction = await readGoogleTransaction(match[1], { browserProof: cookie(req, match[1], config), configFingerprint: config.fingerprint, statuses: ['verified'] });
                if (transaction.payload.flow !== 'explorer') throw googleError();
                const body = req.method === 'POST' ? await readBody(req) : {};
                await serialize(`sso-request:${transaction.payload.parent.requestId}`, async () => {
                    const context = await explorerContext(transaction.payload.parent.requestId, transaction.payload.parent.state);
                    context.complete = async (user, parent) => {
                        const issued = await issueAuthCodeLocked({ providerState: parent.requestId, userId: user.id, generation: authGenerationOf(user) });
                        const location = new URL(issued.redirectUri);
                        location.searchParams.set('code', issued.code);
                        location.searchParams.set('state', parent.state);
                        return redirect(res, `${location.pathname}${location.search}`);
                    };
                    return resume(req, res, context, match[1], match[2] || '', body);
                });
            }
        } catch (error) {
            if ([408, 413].includes(error.statusCode) && !req.complete) {
                res.setHeader('Connection', 'close');
                res.once('finish', () => req.destroy());
            }
            if (!res.headersSent && [`${ROOT}/credential`, `${ROOT}/cancel`].includes(url.pathname)) {
                json(res, Number(error.statusCode) || 503, { ok: false, error: error.code === 'google_recent_authentication_required' ? error.code : 'google_authentication_failed' });
            } else if (!res.headersSent) html(res, 'Unable to continue', '<p>Start sign-in again or use an existing sign-in method. If this continues, contact an administrator.</p>', Number(error.statusCode) || 503);
            else if (!res.writableEnded) res.end();
        }
        return true;
    }
    return { handle, start, resume, startReauthentication, completeReauthentication };
}
