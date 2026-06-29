const OWNER_PART_RE = /^[A-Za-z0-9._-]+$/;
const MAX_OWNER_LENGTH = 64;

export function normalizeOwnerPart(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    const parts = raw.split(':').filter(Boolean);
    const candidate = parts.length > 1 ? parts[parts.length - 1] : raw;
    const normalized = candidate
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_OWNER_LENGTH);

    return OWNER_PART_RE.test(normalized) ? normalized : '';
}

export function deriveUserKeyOwner(user = {}) {
    const candidates = [
        user.username,
        user.name,
        user.id,
        user.email,
    ];

    for (const candidate of candidates) {
        const owner = normalizeOwnerPart(candidate);
        if (owner) return owner;
    }

    return '';
}

export function managementUserView(managementAuth = {}) {
    const user = managementAuth?.user && typeof managementAuth.user === 'object'
        ? managementAuth.user
        : {};

    return {
        id: String(user.id || ''),
        username: String(user.username || user.name || ''),
        email: String(user.email || ''),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role)) : [],
        keyOwner: deriveUserKeyOwner(user),
    };
}
