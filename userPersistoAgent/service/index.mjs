import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { loginWithPassword } from '../lib/auth/password.mjs';
import { startEmailCode, verifyEmailCode } from '../lib/auth/email-code.mjs';
import * as passkey from '../lib/auth/passkey.mjs';
import * as totp from '../lib/auth/totp.mjs';
import { getEnabledAuthMethods, getDefaultAuthMethod } from '../lib/auth/methods.mjs';
import { createLoginRequest, issueAuthCode, consumeAuthCode, getSsoUser } from '../lib/sso.mjs';
import { runTool } from '../tools/registry.mjs';
import { getSetupStatus, registerUser, listUsers, listRoles, createUser, updateUser, setUserRoles, deactivateUser, getUserRoles, getUserById, sanitizeUser } from '../lib/users.mjs';
import { requireActiveActor } from '../lib/authorization.mjs';
import { getAuthPolicy, updateAuthPolicy, isAuthMethodEnabled } from '../lib/policy.mjs';
import { setPassword } from '../lib/auth/password.mjs';
import { handleOidc } from '../lib/oidc/http.mjs';
import { handleDashboard } from './dashboard.mjs';
import { createGoogleAuthHandlers } from './googleAuth.mjs';
import { getGoogleStatus } from '../lib/auth/google.mjs';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ttf': 'font/ttf'
};

function assertRuntimeSecret(req) {
    const expected = String(process.env.USERPERSISTO_RUNTIME_SECRET || '');
    const got = String(req.headers['x-userpersisto-runtime-secret'] || '');
    if (!expected) {
        throw Object.assign(new Error('runtime secret is not configured'), { statusCode: 503 });
    }
    const expectedBytes = Buffer.from(expected);
    const gotBytes = Buffer.from(got);
    if (expectedBytes.length !== gotBytes.length || !timingSafeEqual(expectedBytes, gotBytes)) {
        throw Object.assign(new Error('runtime secret required'), { statusCode: 401 });
    }
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) {
            throw Object.assign(new Error('payload too large'), { statusCode: 413 });
        }
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) {
        return {};
    }
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw Object.assign(new Error('invalid JSON body'), { code: 'invalid_json', statusCode: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw Object.assign(new Error('JSON object required'), { code: 'invalid_json', statusCode: 400 });
    }
    return body;
}

function sendJson(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}

function sendAuthenticationFailure(res) {
    return sendJson(res, 401, { ok: false, error: 'authentication_failed' });
}

function providerStateFrom(body) {
    return String(body.requestId || body.providerState || body.state || '').trim();
}

function callbackPayload(issued, state) {
    return {
        ok: true,
        code: issued.code,
        redirectUri: issued.redirectUri,
        state: String(state || '')
    };
}

async function issueCallbackForUser(body, userId) {
    const issued = await issueAuthCode({ providerState: providerStateFrom(body), userId });
    return callbackPayload(issued, body.state);
}

async function serveStatic(res, relPath) {
    const rel = normalize(String(relPath || 'auth/index.html')).replace(/^\/+/, '');
    const staticPath = rel === 'auth' || rel === 'auth/' ? 'auth/index.html' : rel;
    const file = resolve(PUBLIC_DIR, staticPath);
    const allowed = file === PUBLIC_DIR || file.startsWith(`${PUBLIC_DIR}${sep}`);
    if (!allowed) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
    try {
        const data = await readFile(file);
        res.writeHead(200, {
            'Content-Type': MIME[extname(file)] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store'
        });
        res.end(data);
    } catch {
        if (!extname(staticPath) && staticPath.startsWith('auth/')) {
            const data = await readFile(resolve(PUBLIC_DIR, 'auth/index.html'));
            res.writeHead(200, {
                'Content-Type': MIME['.html'],
                'Content-Length': data.length,
                'Cache-Control': 'no-store'
            });
            return res.end(data);
        }
        sendJson(res, 404, { ok: false, error: 'not_found' });
    }
}

async function handleGet(req, res, path) {
    if (path === '/service/auth/methods') {
        const methods = await getEnabledAuthMethods();
        return sendJson(res, 200, {
            ok: true,
            methods,
            defaultMethod: await getDefaultAuthMethod()
        });
    }
    if (path === '/service/auth/setup') {
        const methods = await getEnabledAuthMethods();
        return sendJson(res, 200, { ok: true, ...(await getSetupStatus()), enabledAuthMethods: methods,
            defaultAuthMethod: methods[0] || '', googleAvailable: (await getGoogleStatus()).available });
    }
    if (path === '/service/auth' || path.startsWith('/service/auth/')) {
        return serveStatic(res, path.replace('/service/', ''));
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

async function handlePost(req, res, path) {
    if (path === '/service/billing/stripe/webhook') {
        const raw = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 256 * 1024) return sendJson(res, 413, { ok: false });
            raw.push(chunk);
        }
        const { processStripeWebhook } = await import('../lib/billing.mjs');
        const result = await processStripeWebhook({
            rawBody: Buffer.concat(raw).toString('utf8'),
            signatureHeader: String(req.headers['stripe-signature'] || '')
        });
        return sendJson(res, 200, { ok: true, ...result });
    }
    const body = await readJson(req);
    if (path === '/service/auth/register') {
        const setup = await getSetupStatus();
        if (!setup.needsInitialAdmin && !(await isAuthMethodEnabled('password'))) {
            throw Object.assign(new Error('Password registration is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        let registered;
        const issued = await issueAuthCode({
            providerState: providerStateFrom(body),
            resolveUserId: async () => {
                registered = await registerUser({ email: body.email, password: body.password });
                return registered.user.id;
            },
        });
        return sendJson(res, 201, {
            ...callbackPayload(issued, body.state),
            firstUser: registered.firstUser,
        });
    }
    if (path === '/service/auth/password/login') {
        if (!(await isAuthMethodEnabled('password'))) {
            throw Object.assign(new Error('Password authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        const result = await loginWithPassword(body.email, body.password);
        if (!result.ok) {
            return sendAuthenticationFailure(res);
        }
        return sendJson(res, 200, await issueCallbackForUser(body, result.user.id));
    }
    if (path === '/service/auth/email-code/start') {
        const started = await startEmailCode({
            email: body.email,
            purpose: 'login',
            correlationId: providerStateFrom(body),
            createSelfRegistered: false
        });
        return sendJson(res, 200, { ok: true, challengeId: started.challengeId });
    }
    if (path === '/service/auth/email-code/verify') {
        if (!(await isAuthMethodEnabled('emailCode'))) {
            throw Object.assign(new Error('Email-code authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        const result = await verifyEmailCode({ challengeId: body.challengeId, code: body.code, correlationId: providerStateFrom(body) });
        if (!result.ok) {
            return sendAuthenticationFailure(res);
        }
        return sendJson(res, 200, await issueCallbackForUser(body, result.user.id));
    }
    if (path === '/service/auth/passkey/options') {
        if (!(await isAuthMethodEnabled('passkey'))) {
            throw Object.assign(new Error('Passkey authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        const result = await passkey.loginOptions({ email: body.email, origin: body.origin, rpId: body.rpId });
        if (!result.ok) {
            return sendAuthenticationFailure(res);
        }
        return sendJson(res, 200, result);
    }
    if (path === '/service/auth/passkey/verify') {
        if (!(await isAuthMethodEnabled('passkey'))) {
            throw Object.assign(new Error('Passkey authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        const result = await passkey.loginVerify({
            email: body.email,
            assertion: body.assertion,
            challengeKey: body.challengeKey,
            origin: body.origin
        });
        if (!result.ok) {
            return sendAuthenticationFailure(res);
        }
        return sendJson(res, 200, await issueCallbackForUser(body, result.user.id));
    }
    if (path === '/service/auth/totp/setup' || path === '/service/auth/totp/verify') {
        if (!(await isAuthMethodEnabled('totp'))) {
            throw Object.assign(new Error('TOTP authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
        }
        const result = await totp.loginVerify({ email: body.email, token: body.token });
        if (!result.ok) {
            return sendAuthenticationFailure(res);
        }
        return sendJson(res, 200, await issueCallbackForUser(body, result.user.id));
    }
    if (path === '/service/runtime/sso-login-request') {
        assertRuntimeSecret(req);
        const request = await createLoginRequest({ redirectUri: body.redirectUri, clientId: body.clientId });
        return sendJson(res, 200, { ok: true, request });
    }
    if (path === '/service/runtime/sso-consume-code') {
        assertRuntimeSecret(req);
        const consumed = await consumeAuthCode({ providerState: body.providerState, code: body.code });
        return sendJson(res, 200, { ok: true, ...consumed });
    }
    if (path === '/service/runtime/sso-user') {
        assertRuntimeSecret(req);
        const described = await getSsoUser(body.userId);
        return sendJson(res, 200, { ok: true, ...described });
    }
    if (path.startsWith('/service/runtime/sso-admin-')) {
        assertRuntimeSecret(req);
        const actorUserId = String(body.actorUserId || '').trim();
        await requireActiveActor(actorUserId, 'admin.users.manage');
        if (path === '/service/runtime/sso-admin-users-list') {
            return sendJson(res, 200, {
                ok: true,
                ...(await listUsers({
                    start: body.start || 0,
                    pageSize: body.pageSize || 500,
                    search: body.search,
                    excludeOnlyRole: body.excludeOnlyRole,
                    includeRoleCounts: body.includeRoleCounts,
                })),
                availableRoles: (await listRoles()).map((role) => role.name),
            });
        }
        if (path === '/service/runtime/sso-admin-user-create') {
            const user = await createUser({
                email: body.email,
                username: body.username || '',
                displayName: body.name || body.displayName || '',
                password: body.password || '',
                roles: body.roles || ['user'],
                source: 'admin',
                actorId: actorUserId,
            });
            return sendJson(res, 201, { ok: true, user: { ...user, roles: await getUserRoles(user.id) } });
        }
        if (path === '/service/runtime/sso-admin-user-update') {
            const patch = {};
            for (const key of ['email', 'username', 'displayName', 'status']) {
                if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
            }
            if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.displayName = body.name;
            // Administration addresses the persisted account regardless of its
            // active status; only the SSO projection requires an active account.
            const existing = await getUserById(String(body.userId || ''));
            if (!existing) throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
            let user = Object.keys(patch).length
                ? await updateUser(body.userId, patch, { actorId: actorUserId })
                : sanitizeUser(existing);
            if (Object.prototype.hasOwnProperty.call(body, 'password') && body.password) {
                await setPassword({ userId: body.userId, newPassword: body.password, actorId: actorUserId });
            }
            const roles = Object.prototype.hasOwnProperty.call(body, 'roles')
                ? await setUserRoles(body.userId, body.roles, { actorId: actorUserId })
                : await getUserRoles(body.userId);
            return sendJson(res, 200, { ok: true, user: { ...user, roles } });
        }
        if (path === '/service/runtime/sso-admin-user-delete') {
            const user = await deactivateUser(body.userId, { actorId: actorUserId });
            return sendJson(res, 200, { ok: true, user, deleted: true });
        }
        if (path === '/service/runtime/sso-admin-policy-get') {
            return sendJson(res, 200, { ok: true, policy: await getAuthPolicy() });
        }
        if (path === '/service/runtime/sso-admin-policy-update') {
            return sendJson(res, 200, { ok: true, policy: await updateAuthPolicy(body.policy || {}, { actorId: actorUserId }) });
        }
    }
    if (path === '/internal/tool') {
        if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
            return sendJson(res, 404, { ok: false, error: 'not_found' });
        }
        assertRuntimeSecret(req);
        const result = await runTool(body.name, body.arguments || {}, body.context || {});
        return sendJson(res, 200, { ok: true, result });
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

async function handle(req, res, google) {
    const url = new URL(req.url || '/', 'http://internal');
    try {
        if (url.pathname === '/service/dashboard' || url.pathname.startsWith('/service/dashboard/')) {
            return await handleDashboard(req, res, url, { sendJson, serveStatic });
        }
        if (await google.handle(req, res)) return;
        if (await handleOidc(req, res, { google })) return;
        if (req.method === 'GET' || req.method === 'HEAD') {
            if (req.method === 'HEAD') {
                res.writeHead(405, { 'Cache-Control': 'no-store' });
                return res.end();
            }
            return await handleGet(req, res, url.pathname);
        }
        if (req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        }
        return await handlePost(req, res, url.pathname);
    } catch (error) {
        const status = Number(error.statusCode) || 500;
        const code = String(error.code || (status < 500 ? error.message : 'internal_error'));
        sendJson(res, status, { ok: false, error: code });
    }
}

export function startService(port, options = {}) {
    const google = createGoogleAuthHandlers(options.google);
    const server = http.createServer((req, res) => handle(req, res, google));
    server.listen(port, () => {
        console.log(`[userPersisto] service listening on ${port}`);
    });
    return server;
}
