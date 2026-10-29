// Named, explicit, positive limits for the S5 filtered-view common part (plan sections 4.1, 5.4 and 5.5).
//
// Every value below is PROVISIONAL: G5 has not fixed the reviewed limits and the G6 measurements have not been taken.
// Production code receives its limits through parameters; this module only supplies defaults, rejects unknown names
// and rejects any value that is not a positive safe integer. The pattern is the one of the S4 module
// `execution/executionLimits.mjs`, copied here so that the two slices do not import each other.

export const VIEW_LIMITS_ARE_PROVISIONAL = true;

export const VIEW_LIMIT_DEFAULTS = Object.freeze({
    // File server (plan section 5.4, "Descriptors"). Derived descriptors only: the /dev/fuse connection and the
    // grant-root descriptor are inherited and are not counted here. G6 records the peak.
    descriptorCap: 1024,
    // Binding chain: the deepest node whose chain the server re-verifies. A deeper node is refused, never trusted.
    maxBindingChainDepth: 128,
    // Subtree scan for hidden descendants before unlink, rmdir and directory rename (decision record DR-1): entries
    // visited before the answer becomes "unknown", which refuses.
    maxDescendantScanEntries: 65536,
    // One path component, in UTF-8 bytes (NAME_MAX on the backing file systems of interest).
    maxComponentBytes: 255,
    // Grant resolver (plan section 4.1).
    maxGrantPathBytes: 1024,
    maxGrantPathDepth: 32,
    // Keeper mount-request frames (plan section 5.5, R4-7). The first inherited slot that carries a grant root.
    // The S4 owner of the keeper spawn layout fixes the real value.
    firstGrantRootSlot: 8,
    maxViewsPerKeeper: 8,
    maxMountFrameBytes: 2048,
    maxMountInFlight: 4,
    maxGrantIdBytes: 32,
    maxMountpointBytes: 512,
    // Descriptors a file server holds beyond its derived ones: three standard streams, /dev/fuse, the grant root.
    fileServerInheritedDescriptors: 5,
    // Margin that RLIMIT_NOFILE must keep above descriptorCap plus the inherited descriptors.
    rlimitHeadroom: 64,
    // Root lease (decision D-S5-6, rootLease.mjs; design question D-S5-13, G5). The supervisor re-verifies the binding of
    // each mounted grant root every rootLeaseRenewMs and renews a lease of rootLeaseTtlMs; the keeper revokes the view when
    // the lease expires. rootRevokeGraceMs separates the keeper's SIGTERM from its SIGKILL of the file server.
    // rootRevokeVerifyMs is the supervisor's margin before it checks, through its own view, that the file server is gone.
    // The renewal interval must be shorter than the lease (resolveViewLimits refuses otherwise).
    rootLeaseRenewMs: 1000,
    rootLeaseTtlMs: 3000,
    rootRevokeGraceMs: 2000,
    rootRevokeVerifyMs: 2000
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
    if (limits.rootLeaseRenewMs >= limits.rootLeaseTtlMs) throw new RangeError('rootLeaseRenewMs must be shorter than rootLeaseTtlMs');
    return Object.freeze(limits);
}
