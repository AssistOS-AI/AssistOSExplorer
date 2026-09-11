import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createGoogleProtocol, googleError, requireGoogleConfiguration, GOOGLE_CALLBACK_PATH } from '../lib/auth/google.mjs';
import { createGoogleTransaction, readGoogleTransaction, transitionGoogleTransaction, prepareGoogleTransactionTransition, hashGoogleState } from '../lib/auth/googleTransactions.mjs';
import { inspectGoogleIdentity, completeGoogleIdentity } from '../lib/externalIdentities.mjs';
import { getLoginRequest, issueAuthCodeLocked } from '../lib/sso.mjs';
import { serialize } from '../lib/serial.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';
import { loginWithPassword } from '../lib/auth/password.mjs';
import { loginVerify as verifyTotp } from '../lib/auth/totp.mjs';
import { loginOptions, loginVerify } from '../lib/auth/passkey.mjs';
import { hashCode, codeHashMatches } from '../lib/auth/email-code.mjs';
import { sendAuthCode } from '../lib/email-agent-client.mjs';
import { page, escapeHtml as esc } from '../lib/oidc/views.mjs';

const ROOT = '/service/auth/google';
const HANDLE = /^[a-f0-9]{64}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
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
function resumePath(payload, handle, config) {
    return payload.flow === 'oidc'
        ? `${servicePath(config)}oidc/interaction/${payload.parent.uid}/google-resume?transaction=${handle}`
        : `${servicePath(config)}auth/google/resume/${handle}`;
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
        const authorization = await protocol.authorization(config);
        await context.validate();
        const current = await requireGoogleConfiguration();
        if (current.fingerprint !== config.fingerprint) throw googleError();
        const proof = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Date.now() + 300_000, context.parent.expiresAt);
        const transaction = await createGoogleTransaction({ state: authorization.state, browserProof: proof, expiresAt, configFingerprint: config.fingerprint,
            payload: { flow: context.flow, parent: context.parent, state: authorization.state, verifier: authorization.verifier, nonce: authorization.nonce,
                clientId: config.clientId, redirectUri: config.redirectUri, csrf: randomBytes(32).toString('base64url') } });
        const handle = transaction.handle || transaction.stateHash;
        setProof(res, handle, config, proof, expiresAt);
        return json(res, 200, { ok: true, authorizationUrl: authorization.url });
    }

    async function callback(req, res, url) {
        const config = await requireGoogleConfiguration();
        for (const key of ['state', 'code', 'error', 'iss']) if (url.searchParams.getAll(key).length > 1) throw googleError();
        const state = url.searchParams.get('state');
        if (!STATE.test(state || '') || (url.searchParams.has('code') === url.searchParams.has('error'))) throw googleError();
        const handle = hashGoogleState(state);
        const proof = { browserProof: cookie(req, handle, config), configFingerprint: config.fingerprint };
        const transaction = await readGoogleTransaction(handle, { ...proof, statuses: ['pending'] });
        if (url.searchParams.has('error')) {
            await transitionGoogleTransaction(handle, proof, { from: ['pending'], to: 'cancelled' });
            setProof(res, handle, config, '', 0);
            return html(res, 'Sign-in cancelled', '<p>Return to the application and start sign-in again.</p>');
        }
        const code = url.searchParams.get('code');
        if (typeof code !== 'string' || !code || code.length > 4096) throw googleError();
        await transitionGoogleTransaction(handle, proof, { from: ['pending'], to: 'exchanging' });
        try {
            const callbackUrl = new URL(config.redirectUri);
            callbackUrl.search = url.search;
            const identity = await protocol.exchange(config, callbackUrl, transaction.payload);
            if ((await requireGoogleConfiguration()).fingerprint !== config.fingerprint) throw googleError();
            const verified = await transitionGoogleTransaction(handle, proof, { from: ['exchanging'], to: 'verified', patch: { identity, state: undefined, nonce: undefined, verifier: undefined } });
            return redirect(res, resumePath(verified.payload, handle, config));
        } catch (error) {
            await transitionGoogleTransaction(handle, proof, { from: ['exchanging'], to: 'failed' });
            setProof(res, handle, config, '', 0);
            throw error;
        }
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
                await transitionGoogleTransaction(handle, proof, { from: ['verified'], to: 'cancelled' });
                setProof(res, handle, config, '', 0);
                return html(res, 'Sign-in cancelled', '<p>Return to the application and start sign-in again.</p>');
            }
            let resolution = await inspectGoogleIdentity(payload.identity, { collisionTarget: payload.collision });
            if (payload.collision && (resolution.kind !== 'collision' || resolution.userId !== payload.collision.userId || resolution.email !== payload.collision.email)) throw googleError();
            if (resolution.kind === 'collision' && !payload.collision) {
                await save({ collision: { userId: resolution.userId, email: resolution.email }, mailboxProof: undefined, emailProof: undefined, linkProof: undefined });
            }
            const base = resumePath(payload, handle, config);
            const cancel = form(base, 'cancel', payload.csrf, '<button class="secondary">Cancel</button>');
            const render = (message = '') => {
                let content = message ? `<p role="alert" class="error">${esc(message)}</p>` : '';
                if (resolution.kind === 'collision') {
                    content += '<p>To link Google, authenticate with an existing password, passkey or authenticator. Email codes and existing sessions cannot authorize linking. Use your existing sign-in or contact an administrator if none is available.</p>';
                    if (payload.linkProof) content += form(base, 'confirm-link', payload.csrf, '<button>Link Google and continue</button>');
                    else for (const method of resolution.eligibleMethods) {
                        if (method === 'password') content += form(base, 'authenticate', payload.csrf, `<input type="hidden" name="method" value="password">${input('password', 'Existing password', 'type="password" autocomplete="current-password" maxlength="1024"')}<button>Authenticate with password</button>`);
                        if (method === 'totp') content += form(base, 'authenticate', payload.csrf, `<input type="hidden" name="method" value="totp">${input('token', 'Authenticator code', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button>Authenticate with code</button>`);
                        if (method === 'passkey') content += form(base, 'challenge', payload.csrf, '<button data-google-passkey>Authenticate with passkey</button>');
                    }
                } else content += `<p>Verify your current mailbox before creating an account.</p>${form(base, 'send-email-proof', payload.csrf, '<button>Send verification code</button>')}${form(base, 'verify-email-proof', payload.csrf, `${input('code', 'Email verification code', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button>Verify and continue</button>`)}`;
                content += `${cancel}<p data-google-error role="alert"></p><script src="${esc(servicePath(config))}auth/google-resume.js" defer></script>`;
                return html(res, resolution.kind === 'collision' ? 'Link your existing account' : 'Verify your email', content, 200,
                    payload.flow === 'oidc' ? retained.redirectUri : '');
            };
            if (['authenticate', 'challenge'].includes(action)) {
                if (resolution.kind !== 'collision' || !resolution.eligibleMethods.includes(action === 'challenge' ? 'passkey' : body.method)) throw googleError();
                let result;
                if (action === 'challenge') {
                    result = await loginOptions({ email: resolution.email, origin: retained.origin, purpose: `google-link:${handle}` });
                    if (!result.ok) throw googleError();
                    await save({ passkeyChallenge: result.challengeKey });
                    return json(res, 200, result);
                }
                if (body.method === 'password') result = await loginWithPassword(resolution.email, body.password, { includeCredentialProof: true });
                if (body.method === 'totp') result = await verifyTotp({ email: resolution.email, token: body.token }, { includeCredentialProof: true });
                if (body.method === 'passkey') {
                    let assertion = body.assertion;
                    try { if (typeof assertion === 'string') assertion = JSON.parse(assertion); } catch { throw googleError(); }
                    result = await loginVerify({ email: resolution.email, assertion,
                        challengeKey: payload.passkeyChallenge, origin: retained.origin, purpose: `google-link:${handle}` }, { includeCredentialProof: true });
                }
                if (!result?.ok || result.user.id !== resolution.userId) return render('Unable to authenticate with that credential.');
                await save({ linkProof: { transactionId: handle, userId: resolution.userId, email: resolution.email, method: body.method,
                    authenticatedAt: Date.now(), credentialVersion: result.credentialVersion,
                    ...(result.credentialKey ? { credentialKey: result.credentialKey } : {}) }, passkeyChallenge: undefined });
                return render();
            }
            if (action === 'send-email-proof') {
                if (resolution.kind !== 'registration' || !resolution.mailboxProofRequired) throw googleError();
                if (payload.emailProof?.sentAt > Date.now() - 60_000) return render('Please wait before requesting another code.');
                const code = String(randomInt(1_000_000)).padStart(6, '0');
                const emailProof = { hash: hashCode(code, `google-registration-email:${handle}`), attempts: 0, sentAt: Date.now(), delivered: false };
                await save({ emailProof });
                const delivery = await deliverEmail({ to: resolution.email, code, correlationId: `google-registration-email:${handle}` }).catch(() => null);
                if (!delivery?.delivered) return render('Email delivery is unavailable. Try again later.');
                await save({ emailProof: { ...emailProof, delivered: true } });
                return render('A verification code has been sent.');
            }
            if (action === 'verify-email-proof') {
                if (resolution.kind !== 'registration' || !resolution.mailboxProofRequired) throw googleError();
                const emailProof = payload.emailProof;
                if (!emailProof?.delivered || emailProof.attempts >= 5) throw googleError();
                await save({ emailProof: { ...emailProof, attempts: emailProof.attempts + 1 } });
                if (!/^\d{6}$/.test(body.code || '') || !codeHashMatches(body.code, `google-registration-email:${handle}`, emailProof.hash)) return render('Unable to verify that code.');
                await save({ mailboxProof: { transactionId: handle, email: resolution.email, verifiedAt: Date.now() }, emailProof: undefined });
            }
            if (action === 'confirm-link') {
                if (resolution.kind !== 'collision' || !payload.linkProof) throw googleError();
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
            if (url.pathname === `${ROOT}/start` && req.method === 'POST') {
                const config = await requireGoogleConfiguration();
                if (req.headers.origin !== config.redirect.origin || String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw googleError('invalid_request', 403);
                const body = await readBody(req);
                if (Object.keys(body).some((key) => !['requestId', 'state'].includes(key)) || typeof body.requestId !== 'string' || body.requestId.length > 512) throw googleError();
                await serialize(`sso-request:${body.requestId}`, async () => start(req, res, await explorerContext(body.requestId, body.state)));
            } else if (url.pathname === GOOGLE_CALLBACK_PATH && req.method === 'GET') await callback(req, res, url);
            else {
                const match = url.pathname.match(/^\/service\/auth\/google\/resume\/([a-f0-9]{64})(?:\/([a-z-]+))?$/);
                if (!match) throw googleError('invalid_request', 404);
                const config = await requireGoogleConfiguration();
                const transaction = await readGoogleTransaction(match[1], { browserProof: cookie(req, match[1], config), configFingerprint: config.fingerprint, statuses: ['verified'] });
                if (transaction.payload.flow !== 'explorer') throw googleError();
                const body = req.method === 'POST' ? await readBody(req) : {};
                await serialize(`sso-request:${transaction.payload.parent.requestId}`, async () => {
                    const context = await explorerContext(transaction.payload.parent.requestId, transaction.payload.parent.state);
                    context.complete = async (user, parent) => {
                        const issued = await issueAuthCodeLocked({ providerState: parent.requestId, userId: user.id });
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
            if (!res.headersSent) html(res, 'Unable to continue', '<p>Start sign-in again or use an existing sign-in method. If this continues, contact an administrator.</p>', Number(error.statusCode) || 503);
            else if (!res.writableEnded) res.end();
        }
        return true;
    }
    return { handle, start, resume };
}
