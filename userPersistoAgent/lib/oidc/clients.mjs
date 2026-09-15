import { randomBytes } from 'node:crypto';
import { requireActiveActor } from '../authorization.mjs';
import { recordAudit } from '../audit.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import PersistoOidcAdapter, { listOidcDocuments, readOidcDocument, writeOidcDocument, removeOidcDocument, revokeOidcClientArtifacts } from './adapter.mjs';
import { getOrCreateOidcKeys } from './secrets.mjs';

const FIELDS = new Set(['client_id', 'client_name', 'redirect_uris', 'post_logout_redirect_uris', 'token_endpoint_auth_method', 'grant_types', 'response_types', 'scope', 'enabled']);
const SCOPES = new Set(['openid', 'profile', 'email', 'offline_access', 'roles', 'capabilities', 'api']);
const AUTH_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post']);
const GRANTS = new Set(['authorization_code', 'refresh_token', 'client_credentials']);

function clientError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

function invalid(message) {
    return clientError('invalid_client_metadata', message);
}

function validateInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Client metadata must be an object.');
    for (const key of Object.keys(input)) {
        if (!FIELDS.has(key)) throw invalid(`Unsupported client field: ${key}`);
    }
}

function validateClientId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/.test(value)) throw invalid('client_id must be 3–128 letters, digits, dot, underscore, tilde, or dash.');
    return value;
}

function uriList(value, field) {
    if (!Array.isArray(value) || value.length > 20) throw invalid(`${field} must be an array of up to 20 exact URLs.`);
    return [...new Set(value.map((raw) => {
        if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('#') || raw.includes('*') || /%2a/i.test(raw)) throw invalid(`${field} contains an invalid URL.`);
        let url;
        try { url = new URL(raw); } catch { throw invalid(`${field} contains an invalid URL.`); }
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (url.href !== raw || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw invalid(`${field} must contain canonical HTTPS or loopback HTTP URLs without user information or fragments.`);
        return raw;
    }))];
}

function stringList(value, field, allowed) {
    if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== 'string' || !allowed.has(entry))) throw invalid(`${field} contains an unsupported value.`);
    return [...new Set(value)];
}

function normalizeMetadata(input, existing) {
    validateInput(input);
    const clientId = validateClientId(input.client_id ?? existing?.metadata.client_id ?? `client_${randomBytes(18).toString('base64url')}`);
    if (existing && clientId !== existing.metadata.client_id) throw invalid('client_id cannot be changed.');
    const prior = existing?.metadata || {};
    const authMethod = input.token_endpoint_auth_method ?? prior.token_endpoint_auth_method ?? 'client_secret_basic';
    if (!AUTH_METHODS.has(authMethod)) throw invalid('Unsupported token_endpoint_auth_method.');
    // Changing public/confidential identity requires a new client and new consent.
    if (existing && (authMethod === 'none') !== (prior.token_endpoint_auth_method === 'none')) throw invalid('Create a new client to change between public and confidential authentication.');
    const grantTypes = stringList(input.grant_types ?? prior.grant_types ?? ['authorization_code'], 'grant_types', GRANTS);
    const human = grantTypes.includes('authorization_code');
    const machine = grantTypes.includes('client_credentials');
    if (grantTypes.includes('refresh_token') && !human) throw invalid('refresh_token requires authorization_code.');
    if (machine && human) throw invalid('Use separate clients for browser and client_credentials grants.');
    if (machine && authMethod === 'none') throw invalid('client_credentials requires a confidential client.');
    const scope = input.scope ?? prior.scope ?? (machine ? 'api' : 'openid profile email');
    if (typeof scope !== 'string' || !scope.trim() || scope.length > 256) throw invalid('scope must be a nonempty space-separated string.');
    const scopes = [...new Set(scope.trim().split(/\s+/))];
    if (scopes.some((value) => !SCOPES.has(value))) throw invalid('Unsupported scope.');
    if (machine && scopes.some((value) => value !== 'api')) throw invalid('client_credentials clients may only request api scope.');
    if (scopes.includes('offline_access') && !grantTypes.includes('refresh_token')) throw invalid('offline_access requires refresh_token.');
    const redirects = uriList(input.redirect_uris ?? prior.redirect_uris ?? [], 'redirect_uris');
    const logoutRedirects = uriList(input.post_logout_redirect_uris ?? prior.post_logout_redirect_uris ?? [], 'post_logout_redirect_uris');
    if (human && !redirects.length) throw invalid('authorization_code requires at least one redirect_uri.');
    if (!human && (redirects.length || logoutRedirects.length)) throw invalid('client_credentials clients do not use redirect URIs.');
    const responseTypes = human ? ['code'] : [];
    if (input.response_types !== undefined && (!Array.isArray(input.response_types) || JSON.stringify(input.response_types) !== JSON.stringify(responseTypes))) throw invalid('Only the code response type is supported for browser clients.');
    const clientName = input.client_name ?? prior.client_name ?? clientId;
    if (typeof clientName !== 'string' || !clientName.trim() || clientName.length > 200 || /[\u0000-\u001f\u007f]/.test(clientName)) throw invalid('client_name must contain 1–200 printable characters.');
    const enabled = input.enabled ?? existing?.enabled ?? true;
    if (typeof enabled !== 'boolean') throw invalid('enabled must be a boolean.');
    return {
        metadata: {
            client_id: clientId,
            client_name: clientName.trim(),
            application_type: 'web',
            subject_type: 'public',
            redirect_uris: redirects,
            post_logout_redirect_uris: logoutRedirects,
            token_endpoint_auth_method: authMethod,
            grant_types: grantTypes,
            response_types: responseTypes,
            scope: scopes.join(' '),
            id_token_signed_response_alg: 'RS256',
            ...(prior.client_secret ? { client_secret: prior.client_secret } : {}),
            ...(prior.client_secret_expires_at === 0 ? { client_secret_expires_at: 0 } : {}),
        },
        enabled,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

function view(document) {
    const { client_secret, ...metadata } = document.metadata;
    return { ...metadata, enabled: document.enabled, createdAt: document.createdAt, updatedAt: document.updatedAt };
}

async function requireClient(clientId) {
    validateClientId(clientId);
    const client = await readOidcDocument('Client', clientId);
    if (!client) throw clientError('oidc_client_not_found', 'OIDC client was not found.', 404);
    return client;
}

async function requireAdmin(actorId) {
    await requireActiveActor(actorId, 'admin.agentSettings.manage');
}

export function getClientMetadata(clientId) {
    return new PersistoOidcAdapter('Client').find(clientId);
}

export async function listOidcClients({ start = 0, pageSize = 50 } = {}, { actorId } = {}) {
    return withPersistenceScope(async () => {
        await requireAdmin(actorId);
        if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw invalid('start must be nonnegative and pageSize must be 1–500.');
        const documents = await listOidcDocuments('Client');
        documents.sort((left, right) => left.metadata.client_id.localeCompare(right.metadata.client_id));
        const items = documents.slice(start, start + pageSize).map(view);
        return { items, total: documents.length, hasMore: start + items.length < documents.length, start, pageSize };
    });
}

export async function createOidcClient(input, { actorId } = {}) {
    return withPersistenceScope(async () => {
        await requireAdmin(actorId);
        const document = normalizeMetadata(input);
        const clientId = document.metadata.client_id;
        if (await readOidcDocument('Client', clientId)) throw clientError('oidc_client_exists', 'OIDC client_id is already registered.', 409);
        await getOrCreateOidcKeys();
        let secret;
        if (document.metadata.token_endpoint_auth_method !== 'none') {
            secret = randomBytes(32).toString('base64url');
            document.metadata.client_secret = secret;
            document.metadata.client_secret_expires_at = 0;
        }
        await writeOidcDocument('Client', clientId, document, undefined, { persist: false });
        await recordAudit({ actorId, action: 'oidc.client.create', target: clientId });
        return { client: view(document), ...(secret ? { client_secret: secret } : {}) };
    });
}

export async function updateOidcClient(clientId, patch, { actorId } = {}) {
    return withPersistenceScope(async () => {
        await requireAdmin(actorId);
        const prior = await requireClient(clientId);
        const document = normalizeMetadata(patch, prior);
        await writeOidcDocument('Client', clientId, document, undefined, { persist: false });
        // Metadata edits invalidate old consent, redirects, scopes, and tokens.
        await revokeOidcClientArtifacts(clientId, { persist: false });
        await recordAudit({ actorId, action: 'oidc.client.update', target: clientId });
        return { client: view(document) };
    });
}

export async function deleteOidcClient(clientId, { actorId } = {}) {
    return withPersistenceScope(async () => {
        await requireAdmin(actorId);
        await requireClient(clientId);
        await revokeOidcClientArtifacts(clientId, { persist: false });
        await removeOidcDocument('Client', clientId, { persist: false });
        await recordAudit({ actorId, action: 'oidc.client.delete', target: clientId });
        return { ok: true, client_id: clientId };
    });
}

export async function rotateOidcClientSecret(clientId, { actorId } = {}) {
    return withPersistenceScope(async () => {
        await requireAdmin(actorId);
        const document = await requireClient(clientId);
        if (document.metadata.token_endpoint_auth_method === 'none') throw invalid('Public clients do not have a client secret.');
        const secret = randomBytes(32).toString('base64url');
        document.metadata.client_secret = secret;
        document.metadata.client_secret_expires_at = 0;
        document.updatedAt = new Date().toISOString();
        await writeOidcDocument('Client', clientId, document, undefined, { persist: false });
        await revokeOidcClientArtifacts(clientId, { persist: false });
        await recordAudit({ actorId, action: 'oidc.client.rotate_secret', target: clientId });
        return { client: view(document), client_secret: secret };
    });
}

export async function getOidcStatus({ actorId } = {}) {
    await requireAdmin(actorId);
    const issuer = process.env.USERPERSISTO_OIDC_ISSUER || '';
    return { enabled: Boolean(issuer), issuer, discoveryUrl: issuer ? `${issuer}/.well-known/openid-configuration` : '' };
}
