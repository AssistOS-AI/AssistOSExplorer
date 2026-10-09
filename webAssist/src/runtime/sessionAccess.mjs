import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { AgenticKnowledgeUnits } from 'achillesAgentLib/AgenticKnowledgeUnits';
import { resolveSiteDataDir } from './akuStore.mjs';

// Caller identity and chat-session ownership for webAssist (DS004, DS015).
//
// The caller is decided only from the Router-signed grant that AgentServer
// verified and placed at `envelope.metadata.invocation`. A session belongs to
// the verified principal that created it; a different principal may continue
// it only with the client-held session secret returned once at creation.

const GUEST_ID_PATTERN = /^user:guest:[A-Za-z0-9-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_SECRET_MAX_LENGTH = 256;
const OWNER_DIR_NAME = 'session-owners';
const OWNER_SCHEMA = 2;
const OWNER_CREATE_ATTEMPTS = 3;
const LISTING_CAPABILITY = 'explorer.access';

// Interactive CLI (manifest `cli`, no grant) and in-process tests only. Its
// sessions are unowned, so over MCP only an admin can read them.
export const LOCAL_OPERATOR_ACCESS = Object.freeze({ kind: 'local-operator' });

export function publicError(message) {
    const error = new Error(message);
    error.webAssistPublic = true;
    return error;
}

function isDebugEnabled() {
    const raw = String(process.env.ACHILLES_DEBUG || '').trim().toLowerCase();
    return Boolean(raw) && !['0', 'false', 'no', 'off'].includes(raw);
}

// Tool error text for stderr. Internal messages may carry absolute storage
// paths, so non-admin callers get a generic message unless debug is enabled.
export function formatToolError(error, access = null) {
    const message = String(error?.message || 'webAssist request failed.');
    if (error?.webAssistPublic === true || access?.admin === true || isDebugEnabled()) {
        return message;
    }
    return 'webAssist request failed.';
}

let invocationAuthModule = null;

async function loadInvocationAuth() {
    if (invocationAuthModule) {
        return invocationAuthModule;
    }
    const candidates = [
        process.env.PLOINKY_INVOCATION_AUTH_MODULE,
        '/Agent/lib/invocation-auth.mjs',
        new URL('../../../shared/invocation-auth.mjs', import.meta.url).href,
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const loaded = await import(candidate);
            if (typeof loaded?.authInfoFromInvocation === 'function') {
                invocationAuthModule = loaded;
                return loaded;
            }
        } catch {
            // Try the next location.
        }
    }
    // Never fall back to an unauthenticated or local-operator caller.
    throw new Error('Unable to load invocation-auth helper.');
}

// Reads only the verified grant. Caller-controlled `input` is never consulted.
export async function authInfoFromEnvelope(envelope) {
    const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
    const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
        return null;
    }
    const { authInfoFromInvocation } = await loadInvocationAuth();
    return authInfoFromInvocation(grant, { invocationToken: '' });
}

function normalizedRoles(actor) {
    return Array.isArray(actor?.roles)
        ? actor.roles.filter((role) => typeof role === 'string').map((role) => role.trim().toLowerCase())
        : [];
}

// Mirrors webmeetAgent/lib/store/accessPolicy.mjs: only a direct (undelegated)
// guest or user actor whose id equals the signed subject is a caller.
export function resolveCallerAccess(authInfo) {
    const invocation = authInfo?.invocation;
    const actor = invocation?.actor;
    if (!actor || typeof actor !== 'object') return null;
    if (invocation.delegation !== null) return null;
    const actorId = typeof actor.id === 'string' ? actor.id : '';
    if (!actorId || actorId !== invocation.subject) return null;
    const roles = normalizedRoles(actor);

    if (actor.kind === 'guest') {
        if (!GUEST_ID_PATTERN.test(actorId) || !roles.includes('guest')) return null;
        return Object.freeze({ kind: 'guest', id: actorId, admin: false, explorerAccess: false });
    }
    if (actor.kind === 'user') {
        if (!/^user:.+/.test(actorId) || !actorId.slice(5).trim()) return null;
        if (authInfo.principalId !== actorId || roles.includes('guest')) return null;
        const admin = roles.includes('admin');
        const capabilities = Array.isArray(actor.capabilities) ? actor.capabilities : [];
        return Object.freeze({ kind: 'user', id: actorId, admin, explorerAccess: admin || capabilities.includes(LISTING_CAPABILITY) });
    }
    return null;
}

export async function callerAccessFromEnvelope(envelope) {
    return resolveCallerAccess(await authInfoFromEnvelope(envelope));
}

export function isValidSessionId(sessionId) {
    return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

export function assertValidSessionId(sessionId) {
    if (!isValidSessionId(sessionId)) {
        throw publicError('Invalid sessionId.');
    }
    return sessionId;
}

export function generateSessionId() {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/\.\d+Z$/, 'Z');
    return `session-${timestamp}-${randomBytes(16).toString('hex')}`;
}

// 32 random bytes, base64url (43 characters). Returned to the client once.
export function generateSessionSecret() {
    return randomBytes(32).toString('base64url');
}

// sha256 over the UTF-8 bytes of the secret text exactly as presented.
export function hashSessionSecret(sessionSecret) {
    return createHash('sha256').update(Buffer.from(String(sessionSecret), 'utf8')).digest('hex');
}

function sessionSecretMatches(owner, sessionSecret) {
    if (typeof sessionSecret !== 'string' || !sessionSecret || sessionSecret.length > SESSION_SECRET_MAX_LENGTH) {
        return false;
    }
    if (!SECRET_HASH_PATTERN.test(String(owner?.secretHash || ''))) {
        return false;
    }
    const supplied = Buffer.from(hashSessionSecret(sessionSecret), 'utf8');
    const stored = Buffer.from(owner.secretHash, 'utf8');
    return supplied.length === stored.length && timingSafeEqual(supplied, stored);
}

export function ownsSession(owner, access) {
    return Boolean(owner && access && owner.kind === access.kind && owner.id === access.id);
}

// Principal match OR a matching client-held secret. Admin reads are decided by
// the caller (history allows them; chat reuse does not).
export function canUseSession(owner, access, sessionSecret) {
    if (!owner) return false;
    return ownsSession(owner, access) || sessionSecretMatches(owner, sessionSecret);
}

function ownersDir(siteId, options) {
    return path.join(resolveSiteDataDir(siteId, options), OWNER_DIR_NAME);
}

function validOwnerRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.schema !== OWNER_SCHEMA) return false;
    if (!SECRET_HASH_PATTERN.test(String(record.secretHash || ''))) return false;
    if (record.kind === 'guest') return GUEST_ID_PATTERN.test(String(record.id || ''));
    if (record.kind === 'user') return /^user:.+/.test(String(record.id || '')) && !GUEST_ID_PATTERN.test(record.id);
    return false;
}

// Reads `<site>/session-owners/<sessionId>.json` without following symlinks.
// Any missing, unreadable, symlinked or malformed record is "no owner".
export async function readSessionOwner({ siteId, sessionId }) {
    let handle = null;
    try {
        if (!isValidSessionId(sessionId)) return null;
        const dir = ownersDir(siteId, { allowMissing: true });
        const dirStats = await fs.lstat(dir);
        if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) return null;
        handle = await fs.open(path.join(dir, `${sessionId}.json`), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        if (!(await handle.stat()).isFile()) return null;
        const record = JSON.parse(await handle.readFile('utf8'));
        if (!validOwnerRecord(record)) return null;
        return {
            schema: record.schema,
            kind: record.kind,
            id: record.id,
            secretHash: record.secretHash,
            createdAt: String(record.createdAt || ''),
        };
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

async function ensureOwnersDir(siteId) {
    const siteDir = resolveSiteDataDir(siteId);
    const siteStats = await fs.lstat(siteDir).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
    });
    const akuReady = siteStats && !siteStats.isSymbolicLink() && siteStats.isDirectory()
        && await new AgenticKnowledgeUnits({ rootDir: siteDir, actor: `webassist/${siteId}` }).exists();
    if (!akuReady) {
        throw publicError(`AKU not initialized for site: ${siteId}`);
    }
    const dir = path.join(siteDir, OWNER_DIR_NAME);
    await fs.mkdir(dir, { mode: 0o755 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
    });
    const dirStats = await fs.lstat(dir);
    if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
        throw new Error(`webAssist session owner directory must be a non-symlink directory: ${dir}`);
    }
    return dir;
}

// First writer wins (`wx`); returns false when the record already exists.
export async function createSessionOwner({ siteId, sessionId, access, secretHash }) {
    assertValidSessionId(sessionId);
    if (!access || (access.kind !== 'guest' && access.kind !== 'user') || !access.id) {
        throw new Error('A verified caller is required to own a webAssist session.');
    }
    if (!SECRET_HASH_PATTERN.test(String(secretHash || ''))) {
        throw new Error('A session secret hash is required to own a webAssist session.');
    }
    const dir = await ensureOwnersDir(siteId);
    const record = { schema: OWNER_SCHEMA, kind: access.kind, id: access.id, secretHash, createdAt: new Date().toISOString() };
    try {
        await fs.writeFile(path.join(dir, `${sessionId}.json`), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
}

// Picks the chat session before any context is loaded. A caller-supplied id is
// reused only by its owner or with its secret, and is never claimed: every
// other case creates a new owned session and returns its secret once.
export async function resolveChatSession({ siteId, requestedSessionId = '', sessionSecret, access }) {
    const requested = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
    if (access === LOCAL_OPERATOR_ACCESS) {
        if (requested) assertValidSessionId(requested);
        return { sessionId: requested || generateSessionId(), rotated: false };
    }
    if (!access || (access.kind !== 'guest' && access.kind !== 'user')) {
        throw publicError('Access denied: a verified visitor or user is required.');
    }
    if (requested) {
        assertValidSessionId(requested);
        const owner = await readSessionOwner({ siteId, sessionId: requested });
        if (canUseSession(owner, access, sessionSecret)) {
            return { sessionId: requested, rotated: false };
        }
    }
    for (let attempt = 0; attempt < OWNER_CREATE_ATTEMPTS; attempt += 1) {
        const sessionId = generateSessionId();
        const newSecret = generateSessionSecret();
        if (await createSessionOwner({ siteId, sessionId, access, secretHash: hashSessionSecret(newSecret) })) {
            return { sessionId, rotated: Boolean(requested), sessionSecret: newSecret };
        }
    }
    throw new Error('Unable to allocate a webAssist session.');
}
