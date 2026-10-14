const CAPABILITY = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)+$/;
const PRODUCT_ROLES = new Set(['admin', 'user']);

function invalid() {
    return new Error('USERPERSISTO_PRODUCT_PERMISSIONS must contain valid, explicitly configured product permissions.');
}

// Only operator-supplied startup configuration reaches this parser. Browser
// profiles, signup payloads and OIDC client registrations never configure it.
export function productPermissions(value = process.env.USERPERSISTO_PRODUCT_PERMISSIONS) {
    if (value === undefined) return [];
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > 16_384) throw invalid();
        try { value = JSON.parse(value); }
        catch { throw invalid(); }
    }
    if (!Array.isArray(value) || value.length > 100) throw invalid();
    const seen = new Set();
    return value.map(entry => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
            || Object.keys(entry).sort().join(',') !== 'capability,description,roles'
            || typeof entry.capability !== 'string' || entry.capability.length > 128
            || !CAPABILITY.test(entry.capability)
            || /^(admin|selfregistered)[.:-]/.test(entry.capability)
            || typeof entry.description !== 'string' || !entry.description.trim()
            || entry.description.length > 300
            || !Array.isArray(entry.roles) || !entry.roles.length
            || entry.roles.some(role => !PRODUCT_ROLES.has(role))
            || new Set(entry.roles).size !== entry.roles.length
            || seen.has(entry.capability)) throw invalid();
        seen.add(entry.capability);
        return { capability: entry.capability, description: entry.description, scope: 'product', roles: [...entry.roles] };
    });
}
