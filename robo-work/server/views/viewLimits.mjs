// Named, explicit, positive limits for the filtered-view common part: the grant resolver and the protected-name scan
// that the Node sandbox (bwrap) preparation uses.
//
// Every value below is PROVISIONAL: G5 has not fixed the reviewed limits and the G6 measurements have not been taken.
// Production code receives its limits through parameters; this module only supplies defaults, rejects unknown names
// and rejects any value that is not a positive safe integer.

export const VIEW_LIMITS_ARE_PROVISIONAL = true;

export const VIEW_LIMIT_DEFAULTS = Object.freeze({
    // Protected-name scan of a grant root before it is bound (server/sandbox/protectedScan.mjs): entries visited, masks
    // produced and directory depth. Exceeding any of them refuses the grant.
    maxScanEntries: 200000,
    maxMasks: 4096,
    maxScanDepth: 64,
    // One path component, in UTF-8 bytes (NAME_MAX on the backing file systems of interest).
    maxComponentBytes: 255,
    // Grant resolver.
    maxGrantPathBytes: 1024,
    maxGrantPathDepth: 32
});

export function resolveViewLimits(overrides = {}) {
    if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new TypeError('Limits must be an object');
    }
    const limits = { ...VIEW_LIMIT_DEFAULTS };
    for (const [name, value] of Object.entries(overrides)) {
        if (!Object.hasOwn(VIEW_LIMIT_DEFAULTS, name)) throw new TypeError(`Unknown limit: ${name}`);
        limits[name] = value;
    }
    for (const [name, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Limit ${name} must be a positive integer`);
    }
    return Object.freeze(limits);
}
