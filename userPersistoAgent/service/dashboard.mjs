import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireActiveActor } from '../lib/authorization.mjs';
import { runTool } from '../tools/registry.mjs';

const PREFIX = '/service/dashboard';
const ASSETS = new Set([
    'index.html', 'main.js', 'dashboard.css', 'enrollment.js', 'enrollment.css',
    'users.html', 'applications.html', 'authentication.html', 'admin.mjs', 'admin.css',
    'management.mjs', 'management.css', 'api.mjs',
]);
const PAGE_CAPABILITIES = new Map([
    ['users.html', 'admin.users.manage'],
    ['applications.html', 'admin.agentSettings.manage'],
    ['authentication.html', 'admin.agentSettings.manage'],
]);
const OPERATIONS = new Map([
    ['auth/passkey/options', 'userpersisto_passkey_registration_options'],
    ['auth/passkey/verify', 'userpersisto_passkey_registration_verify'],
    ['auth/totp/start', 'userpersisto_totp_setup_start'],
    ['auth/totp/verify', 'userpersisto_totp_setup_verify'],
]);
const CLIENT_FIELDS = [
    'client_id', 'client_name', 'redirect_uris', 'post_logout_redirect_uris',
    'token_endpoint_auth_method', 'grant_types', 'response_types', 'scope', 'enabled',
];
const ADMIN_OPERATIONS = new Map([
    ['users/list', { tool: 'userpersisto_user_list', fields: ['start', 'pageSize', 'search', 'excludeOnlyRole', 'includeRoleCounts'] }],
    ['users/create', { tool: 'userpersisto_user_create', fields: ['email', 'username', 'displayName', 'password', 'roles'] }],
    ['users/update', { tool: 'userpersisto_user_update', fields: ['userId', 'email', 'username', 'displayName', 'status'] }],
    ['users/roles', { tool: 'userpersisto_user_roles_update', fields: ['userId', 'roles'] }],
    ['users/password', { tool: 'userpersisto_auth_password_set', fields: ['userId', 'newPassword'], requireUserId: true }],
    ['users/delete', { tool: 'userpersisto_user_update', fields: ['userId'], fixed: { status: 'blocked' } }],
    ['applications/list', { tool: 'userpersisto_oidc_clients_list', fields: ['start', 'pageSize'] }],
    ['applications/create', { tool: 'userpersisto_oidc_client_create', fields: CLIENT_FIELDS }],
    ['applications/update', { tool: 'userpersisto_oidc_client_update', fields: CLIENT_FIELDS }],
    ['applications/delete', { tool: 'userpersisto_oidc_client_delete', fields: ['client_id'] }],
    ['applications/rotate', { tool: 'userpersisto_oidc_client_rotate_secret', fields: ['client_id'] }],
    ['applications/status', { tool: 'userpersisto_oidc_status', fields: [] }],
    ['policy/get', { tool: 'userpersisto_auth_policy_get', fields: [] }],
    ['policy/set', {
        tool: 'userpersisto_auth_policy_set',
        fields: ['enabledAuthMethods', 'selfRegistrationEnabled', 'defaultRegistrationRole', 'allowedRedirectOrigins'],
    }],
    ['google/status', { tool: 'userpersisto_google_status', fields: [] }],
]);

function fail(statusCode, code) {
    throw Object.assign(new Error(code), { statusCode, code });
}

function mutationOrigin(req) {
    const origin = req.headers.origin;
    const protocol = req.headers['x-forwarded-proto'];
    const host = req.headers['x-forwarded-host'];
    if (typeof origin !== 'string' || !['http', 'https'].includes(protocol) || typeof host !== 'string') {
        fail(403, 'invalid_origin');
    }
    const expected = `${protocol}://${host}`;
    try {
        const url = new URL(expected);
        if (url.origin !== expected || origin !== expected || url.username || url.password) {
            fail(403, 'invalid_origin');
        }
    } catch {
        fail(403, 'invalid_origin');
    }
    const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') fail(415, 'json_required');
    return origin;
}

async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) fail(413, 'payload_too_large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function authenticatedActor(req, url, rawBody) {
    if (typeof req.headers['x-ploinky-auth-info'] !== 'string') fail(401, 'authentication_required');
    // Use the same verifier mounted by Ploinky; never accept plain forwarded identity.
    const runtimeRoot = process.env.PLOINKY_AGENT_RUNTIME_ROOT || '/Agent';
    let verify;
    try {
        ({ verifyHttpRouteAuthInfoFromHeaders: verify } = await import(
            pathToFileURL(resolve(runtimeRoot, 'lib/invocationAuth.mjs')).href
        ));
    } catch {
        fail(503, 'authentication_unavailable');
    }
    const verified = verify(req.headers, {
        method: req.method,
        path: url.pathname,
        query: url.search,
        body: rawBody,
    });
    const subject = verified.payload?.sub;
    const actor = verified.payload?.actor;
    if (!verified.ok || actor?.kind !== 'user' || typeof subject !== 'string'
        || !subject.startsWith('user:') || actor.id !== subject || !subject.slice(5).trim()) {
        fail(401, 'authentication_required');
    }
    const userId = subject.slice(5);
    await requireActiveActor(userId);
    return userId;
}

function parseBody(rawBody) {
    let body;
    try {
        body = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch {
        fail(400, 'invalid_json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json');
    return body;
}

export async function handleDashboard(req, res, url, { sendJson, serveStatic }) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    const origin = req.method === 'POST' ? mutationOrigin(req) : '';
    const rawBody = await readBody(req);
    const actorUserId = await authenticatedActor(req, url, rawBody);
    const context = { actorUserId };
    const path = url.pathname.slice(PREFIX.length);
    if (req.method === 'GET') {
        if (path === '') {
            res.writeHead(302, { Location: './dashboard/', 'Cache-Control': 'no-store' });
            return res.end();
        }
        if (path === '/api/profile') {
            const profile = await runTool('userpersisto_profile_get', {}, context);
            return sendJson(res, 200, { ok: true, profile });
        }
        const asset = path === '/' ? 'index.html' : path.slice(1);
        if (ASSETS.has(asset)) {
            const capability = PAGE_CAPABILITIES.get(asset);
            if (capability) await requireActiveActor(actorUserId, capability);
            return serveStatic(res, `dashboard/${asset}`);
        }
    } else {
        const body = parseBody(rawBody);
        if (path === '/api/profile') {
            const args = {};
            for (const key of ['username', 'displayName']) {
                if (!Object.hasOwn(body, key)) continue;
                if (typeof body[key] !== 'string') fail(400, 'invalid_profile');
                args[key] = body[key];
            }
            const profile = await runTool('userpersisto_profile_update', args, context);
            return sendJson(res, 200, { ok: true, profile });
        }
        const adminPath = path.startsWith('/api/admin/') ? path.slice(11) : '';
        const adminOperation = ADMIN_OPERATIONS.get(adminPath);
        if (adminOperation) {
            const capability = adminPath.startsWith('users/') ? 'admin.users.manage' : 'admin.agentSettings.manage';
            await requireActiveActor(actorUserId, capability);
            const args = {};
            for (const field of adminOperation.fields) {
                if (Object.hasOwn(body, field)) args[field] = body[field];
            }
            if (adminOperation.requireUserId && (typeof args.userId !== 'string' || !args.userId.trim())) {
                fail(400, 'user_id_required');
            }
            Object.assign(args, adminOperation.fixed);
            const result = await runTool(adminOperation.tool, args, context);
            return sendJson(res, 200, { ok: true, result });
        }
        const operation = path.startsWith('/api/') ? OPERATIONS.get(path.slice(5)) : null;
        if (operation) {
            // Bind enrollment to the signed actor and actual browser origin, not caller-supplied IDs.
            const args = {
                origin,
                rpId: new URL(origin).hostname,
                attestation: body.attestation,
                challengeKey: body.challengeKey,
                token: body.token,
            };
            const result = await runTool(operation, args, context);
            return sendJson(res, result.ok === false ? 400 : 200, result);
        }
    }
    return sendJson(res, 404, { ok: false, error: 'not_found' });
}
