import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { getEnabledAuthMethods } from '../lib/auth/methods.mjs';
import { createLoginRequest, consumeAuthCode, getSsoUser } from '../lib/sso.mjs';
import { runTool } from '../tools/registry.mjs';
import { listUsers, listRoles, updateUser, setUserRoles, deactivateUser, getUserRoles, getUserById, sanitizeUser, authGenerationOf } from '../lib/users.mjs';
import { requireActiveActor } from '../lib/authorization.mjs';
import { getAuthPolicy, updateAuthPolicy } from '../lib/policy.mjs';
import { handleOidc } from '../lib/oidc/http.mjs';
import { handleDashboard } from './dashboard.mjs';
import { createGoogleAuthHandlers } from './googleAuth.mjs';
import { createSsoWizardHandlers } from './ssoWizard.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { getEmailAuthCodeStatus, sendAuthCode } from '../lib/email-agent-client.mjs';

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

function unsupported(code, message) {
    return Object.assign(new Error(message), { code, statusCode: 400 });
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

async function handleGet(req, res, path, { emailStatus }) {
    if (path === '/service/auth/methods') {
        const emailAvailable = (await emailStatus()).available === true;
        const methods = (await getEnabledAuthMethods()).filter((method) => method !== 'emailCode' || emailAvailable);
        return sendJson(res, 200, {
            ok: true,
            methods,
            defaultMethod: methods[0] || ''
        });
    }
    if (path === '/service/auth/setup') {
        const configuration = await wizardConfiguration({ emailAvailable: (await emailStatus()).available === true });
        const methods = (await getEnabledAuthMethods()).filter((method) => method !== 'emailCode' || configuration.methods.emailCode);
        return sendJson(res, 200, { ok: true, ...configuration, enabledAuthMethods: methods,
            defaultAuthMethod: methods[0] || '', googleAvailable: configuration.methods.google });
    }
    if (path === '/service/auth' || path.startsWith('/service/auth/')) {
        return serveStatic(res, path.replace('/service/', ''));
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

async function handlePost(req, res, path, handlers) {
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
    if (await handlers.wizard.handle(req, res, path, body, sendJson)) return;
    if (path === '/service/runtime/sso-login-request') {
        assertRuntimeSecret(req);
        const request = await createLoginRequest({ redirectUri: body.redirectUri, clientId: body.clientId });
        return sendJson(res, 200, { ok: true, request });
    }
    if (path === '/service/runtime/sso-consume-code') {
        assertRuntimeSecret(req);
        const consumed = await consumeAuthCode({ providerState: body.providerState, code: body.code });
        return sendJson(res, 200, { ok: true, ...consumed, generation: authGenerationOf(consumed.user) });
    }
    if (path === '/service/runtime/sso-user') {
        assertRuntimeSecret(req);
        // Provider sessions carry the account generation they were minted for.
        const described = await getSsoUser(body.userId, { generation: body.generation });
        return sendJson(res, 200, { ok: true, ...described, generation: authGenerationOf(described.user) });
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
            // Accounts come only from the setup decision and verified signup.
            throw unsupported('user_creation_unsupported', 'Accounts are created by signing in; invitations are not available yet.');
        }
        if (path === '/service/runtime/sso-admin-user-update') {
            const patch = {};
            for (const key of ['email', 'username', 'displayName', 'status']) {
                if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
            }
            if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.displayName = body.name;
            if (Object.prototype.hasOwnProperty.call(body, 'password') && body.password !== undefined && body.password !== null && body.password !== '') {
                throw unsupported('password_unsupported', 'Accounts do not have passwords.');
            }
            // Administration addresses the persisted account regardless of its
            // active status; only the SSO projection requires an active account.
            const existing = await getUserById(String(body.userId || ''));
            if (!existing) throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
            let user = Object.keys(patch).length
                ? await updateUser(body.userId, patch, { actorId: actorUserId })
                : sanitizeUser(existing);
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
            return sendJson(res, 200, { ok: true, policy: await updateAuthPolicy(body.policy || {}, { actorId: actorUserId, emailStatus: handlers.emailStatus }) });
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

async function handle(req, res, handlers) {
    const { google } = handlers;
    const url = new URL(req.url || '/', 'http://internal');
    try {
        if (url.pathname === '/service/dashboard' || url.pathname.startsWith('/service/dashboard/')) {
            return await handleDashboard(req, res, url, { sendJson, serveStatic, google, deliverEmail: handlers.deliverEmail, emailStatus: handlers.emailStatus });
        }
        if (await google.handle(req, res)) return;
        if (await handleOidc(req, res, { google, deliverEmail: handlers.deliverEmail, emailStatus: handlers.emailStatus })) return;
        if (req.method === 'GET' || req.method === 'HEAD') {
            if (req.method === 'HEAD') {
                res.writeHead(405, { 'Cache-Control': 'no-store' });
                return res.end();
            }
            return await handleGet(req, res, url.pathname, handlers);
        }
        if (req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        }
        return await handlePost(req, res, url.pathname, handlers);
    } catch (error) {
        const status = Number(error.statusCode) || 500;
        const code = String(error.code || (status < 500 ? error.message : 'internal_error'));
        if (res.headersSent) return void (res.writableEnded || res.end());
        const extra = {};
        if (Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) {
            extra.retryAfter = error.retryAfter;
            res.setHeader('Retry-After', String(error.retryAfter));
        }
        if (Number.isSafeInteger(error.attemptsRemaining)) extra.attemptsRemaining = error.attemptsRemaining;
        sendJson(res, status, { ok: false, error: code, ...extra });
    }
}

// `options.google`, `options.deliverEmail` and `options.emailStatus` are construction-time test seams;
// no environment variable or request can select a provider or mail transport.
export function startService(port, options = {}) {
    const deliverEmail = options.deliverEmail || sendAuthCode;
    const emailStatus = options.emailStatus || (options.deliverEmail ? async () => ({ available: true }) : getEmailAuthCodeStatus);
    const google = createGoogleAuthHandlers({ ...options.google, deliverEmail: options.google?.deliverEmail || deliverEmail });
    const handlers = { google, deliverEmail, emailStatus, wizard: createSsoWizardHandlers({ deliverEmail, emailStatus }) };
    const server = http.createServer((req, res) => handle(req, res, handlers));
    server.listen(port, () => {
        console.log(`[userPersisto] service listening on ${port}`);
    });
    return server;
}
