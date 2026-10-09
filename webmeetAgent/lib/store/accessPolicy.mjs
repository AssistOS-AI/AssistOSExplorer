export function normalizeAuthInfo(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') {
        return {
            id: '',
            username: '',
            email: '',
            principalId: '',
            roles: []
        };
    }
    const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const agent = authInfo.agent && typeof authInfo.agent === 'object' ? authInfo.agent : null;
    return {
        id: String(user.id || '').trim(),
        username: String(user.username || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(agent?.principalId || authInfo.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
}

export function isAdminAuthInfo(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    const roleMatch = normalized.roles.some((role) => String(role || '').trim().toLowerCase() === 'admin');
    if (roleMatch) {
        return true;
    }
    return normalized.username.toLowerCase() === 'admin'
        || normalized.id === 'local:admin'
        || normalized.principalId === 'user:local:admin';
}

// Workspace-wide room listings and the workspace event feed are directory
// reads. They are decided only on the Router-signed actor that
// authInfoFromInvocation copied from an AgentServer-verified grant: a direct
// user whose actor id, subject and principal agree, without delegation. Roles
// are trimmed and lower-cased; guest is excluded on every arm. Usernames, id
// aliases and unsigned user fields grant nothing here.
export const LISTING_CAPABILITY = 'explorer.access';

function verifiedDirectUserActor(authInfo = null) {
    const invocation = authInfo?.invocation;
    const actor = invocation?.actor;
    if (!actor || typeof actor !== 'object' || actor.kind !== 'user') return null;
    const actorId = typeof actor.id === 'string' ? actor.id : '';
    if (!/^user:.+/.test(actorId) || !actorId.slice(5).trim()) return null;
    if (invocation.subject !== actorId || authInfo.principalId !== actorId) return null;
    if (invocation.delegation !== null) return null;
    return actor;
}

function verifiedListingAccess(authInfo = null) {
    const actor = verifiedDirectUserActor(authInfo);
    if (!actor) return { entitled: false, admin: false };
    const roles = Array.isArray(actor.roles)
        ? actor.roles.filter((role) => typeof role === 'string').map((role) => role.trim().toLowerCase())
        : [];
    if (roles.includes('guest')) return { entitled: false, admin: false };
    const admin = roles.includes('admin');
    const capabilities = Array.isArray(actor.capabilities) ? actor.capabilities : [];
    return { entitled: admin || capabilities.includes(LISTING_CAPABILITY), admin };
}

export function isVerifiedListingEntitled(authInfo = null) {
    return verifiedListingAccess(authInfo).entitled;
}

export function isVerifiedAdminAuthInfo(authInfo = null) {
    return verifiedListingAccess(authInfo).admin;
}

export function isGuestAuthInfo(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    return normalized.roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
}

function hasAuthenticatedPrincipal(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    return Boolean(normalized.id || normalized.principalId);
}

export function assertAdminAuthInfo(authInfo = null) {
    if (!isAdminAuthInfo(authInfo)) {
        throw new Error('Access denied: only admin can manage rooms.');
    }
}

export function assertAuthenticatedAuthInfo(authInfo = null) {
    if (!hasAuthenticatedPrincipal(authInfo)) {
        throw new Error('Access denied: authentication is required.');
    }
}

export function getAuthDisplayName(authInfo = null) {
    const user = authInfo && typeof authInfo === 'object'
        ? (authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo)
        : null;
    if (!user) return '';
    return String(user.name || user.username || user.email || '').trim();
}

function getInvocationScopes(authInfo = null) {
    return Array.isArray(authInfo?.invocation?.scope)
        ? authInfo.invocation.scope.map((scope) => String(scope || '').trim()).filter(Boolean)
        : [];
}

export function hasWebmeetRoomScope(authInfo = null, roomId = '') {
    const targetRoomId = String(roomId || '').trim();
    if (!targetRoomId) return false;
    const accepted = new Set([
        `webmeet:room:${targetRoomId}`,
        `public:webmeet:room:${targetRoomId}`
    ]);
    return getInvocationScopes(authInfo).some((scope) => accepted.has(scope));
}

function hasAnyWebmeetRoomScope(authInfo = null) {
    return getInvocationScopes(authInfo).some((scope) => (
        /^webmeet:room:room_[0-9a-fA-F-]{36}$/.test(scope)
        || /^public:webmeet:room:room_[0-9a-fA-F-]{36}$/.test(scope)
    ));
}

export function isMeetingRecordOpen(record) {
    return String(record?.status || '').trim().toLowerCase() !== 'archived'
        && !String(record?.archivedAt || '').trim();
}

export function canViewMeetingRecord(record, authInfo = null) {
    if (!hasAuthenticatedPrincipal(authInfo)) {
        return false;
    }
    if (isGuestAuthInfo(authInfo)) {
        return isMeetingRecordOpen(record) && String(record?.roomType || '').trim() === 'guest';
    }
    const roomId = String(record?.meetingId || record?.roomId || '').trim();
    if (hasAnyWebmeetRoomScope(authInfo) && !hasWebmeetRoomScope(authInfo, roomId)) {
        return false;
    }
    if (!isMeetingRecordOpen(record)) {
        return isAdminAuthInfo(authInfo);
    }
    return true;
}

export function canListMeetingRecord(record, authInfo = null) {
    return Boolean(record)
        && isVerifiedListingEntitled(authInfo)
        && (isMeetingRecordOpen(record) || isVerifiedAdminAuthInfo(authInfo))
        && canViewMeetingRecord(record, authInfo);
}
