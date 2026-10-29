// The FUSE settings that the filtered view must use (plan section 5.4, "Kernel caching"; review R4-6), as an exported
// specification and a checker. The Rust file server is checked against it: its glue serialises the INIT reply and the
// reply objects it constructs into the sample shape below, and `findSettingsViolations` must return no violation.
//
// Capability and flag names are the kernel's symbolic names. No numeric bit values are recorded here: the kernel
// headers could not be consulted in this environment, and a guessed bit would let a conformance check pass falsely.
// The Rust check maps its own constants to these names.
//
// Decision D2 (option (a), d2Decision.mjs) forbids the direct-I/O mapping opt-ins permanently: FUSE_DIRECT_IO_ALLOW_MMAP and
// its Linux 6.6 name FUSE_DIRECT_IO_RELAX are forbidden INIT capabilities, like the cache opt-ins. No later decision in
// this slice turns them on.

import { D2_DECISION } from './d2Decision.mjs';

function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

export const FUSE_VIEW_SETTINGS = deepFreeze({
    schema: 'robo-work.fuse-view-settings/1',
    provisional: true,
    // Every positive entry reply (lookup, create, mkdir, mknod, symlink, link) and every readdirplus entry: no cache
    // lifetime, so a name answer is never served from a kernel dentry cache. Attribute lifetime is not constrained
    // ("attribute caching exposes no names and may stay on").
    entry: { entryValid: { secs: 0, nsecs: 0 } },
    // A missing name is answered with an error, or with a zero-node entry whose lifetime is zero. A zero-node entry
    // with a positive lifetime is a negative dentry cache.
    negativeLookup: { allowed: ['error_enoent', 'zero_node_entry_with_zero_ttl'] },
    // READDIRPLUS is off, or every entry it returns has entryValid zero.
    readdirplus: { capabilitiesThatEnableIt: ['FUSE_DO_READDIRPLUS', 'FUSE_READDIRPLUS_AUTO'], mode: 'off_or_zero_ttl' },
    open: {
        requiredFlags: ['FOPEN_DIRECT_IO'],
        forbiddenFlags: ['FOPEN_KEEP_CACHE', 'FOPEN_CACHE_DIR', 'FOPEN_PASSTHROUGH']
    },
    opendir: {
        forbiddenFlags: ['FOPEN_KEEP_CACHE', 'FOPEN_CACHE_DIR', 'FOPEN_PASSTHROUGH']
    },
    // Capabilities the INIT reply must not set. Each lets the kernel serve, cache or skip the server for data or names.
    init: {
        forbiddenCapabilities: [
            'FUSE_WRITEBACK_CACHE',
            'FUSE_PASSTHROUGH',
            'FUSE_CACHE_SYMLINKS',
            'FUSE_NO_OPEN_SUPPORT',
            'FUSE_NO_OPENDIR_SUPPORT',
            'FUSE_AUTO_INVAL_DATA',
            'FUSE_READDIRPLUS_AUTO',
            'FUSE_SPLICE_READ',
            'FUSE_SPLICE_WRITE',
            'FUSE_SPLICE_MOVE',
            // Decision D2 (a): no mmap opt-in. Linux 6.6 named the same opt-in FUSE_DIRECT_IO_RELAX, so both names are listed.
            'FUSE_DIRECT_IO_ALLOW_MMAP',
            'FUSE_DIRECT_IO_RELAX'
        ],
        // ALLOWLIST: an INIT reply may set only these capabilities. A name that is in neither list is a violation
        // (unreviewed_init_capability), so a kernel option that a newer kernel adds, or that the glue spells differently,
        // fails closed until it is reviewed and added here. PROVISIONAL: the reviewed set is not named by the plan and
        // is for the G6 reviewers to confirm; every entry below is a protocol-level option that does not cache data or names.
        permittedCapabilities: [
            'FUSE_ASYNC_READ', 'FUSE_ATOMIC_O_TRUNC', 'FUSE_BIG_WRITES', 'FUSE_DONT_MASK', 'FUSE_POSIX_LOCKS', 'FUSE_FLOCK_LOCKS',
            'FUSE_PARALLEL_DIROPS', 'FUSE_MAX_PAGES', 'FUSE_ABORT_ERROR', 'FUSE_HANDLE_KILLPRIV', 'FUSE_HANDLE_KILLPRIV_V2',
            'FUSE_INIT_EXT', 'FUSE_SETXATTR_EXT', 'FUSE_ASYNC_DIO',
            // Allowed only together with zero-lifetime readdirplus entries (checked below).
            'FUSE_DO_READDIRPLUS'
        ]
    },
    // Data replies are copied, and only after the post-read check; no splice or zero-copy reply sends data before it.
    read: { delivery: 'copy', sentOnlyAfterPostCheck: true },
    mount: { requiredOptions: ['allow_other'], readOnlyGrantRequiresOption: 'ro' },
    d2: D2_DECISION
});

const isTtl = (value) => value !== null && typeof value === 'object'
    && Number.isSafeInteger(value.secs) && value.secs >= 0
    && Number.isSafeInteger(value.nsecs) && value.nsecs >= 0 && value.nsecs < 1_000_000_000;
const isZero = (ttl) => isTtl(ttl) && ttl.secs === 0 && ttl.nsecs === 0;
const isNameList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// Sample shape (all arrays are evidence from the real construction code; an empty required array is no evidence):
//   {
//     init: { capabilities: [names] },
//     entryReplies: [{ entryValid: { secs, nsecs } }],
//     negativeLookupReplies: [{ kind: 'error', errno: 'ENOENT' } | { kind: 'entry', nodeId: 0, entryValid: { secs, nsecs } }],
//     readdirplusEntries: [{ entryValid: { secs, nsecs } }],            (optional)
//     openReplies: [{ openFlags: [names] }],
//     opendirReplies: [{ openFlags: [names] }],
//     readReplies: [{ delivery: 'copy' | 'splice' | 'zero_copy' }],
//     mountOptions: [names], grantAccess: 'read' | 'write'
//   }
// Returns the list of { code, where } violations; empty means the sample meets the specification.
export function findSettingsViolations(sample, spec = FUSE_VIEW_SETTINGS) {
    const violations = [];
    const add = (code, where) => violations.push({ code, where });
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return [{ code: 'sample_malformed', where: 'sample' }];

    const requireList = (name) => {
        if (!Array.isArray(sample[name]) || sample[name].length === 0) {
            add('missing_evidence', name);
            return [];
        }
        return sample[name];
    };

    // INIT
    const capabilities = sample.init && isNameList(sample.init.capabilities) ? sample.init.capabilities : null;
    if (capabilities === null) add('missing_evidence', 'init.capabilities');
    if (!isNameList(spec.init.permittedCapabilities)) add('spec_incomplete', 'init.permittedCapabilities');
    for (const name of capabilities ?? []) {
        if (spec.init.forbiddenCapabilities.includes(name)) add('forbidden_init_capability', `init.capabilities:${name}`);
        else if (isNameList(spec.init.permittedCapabilities) && !spec.init.permittedCapabilities.includes(name)) {
            add('unreviewed_init_capability', `init.capabilities:${name}`);
        }
    }

    // Positive entries
    requireList('entryReplies').forEach((reply, index) => {
        if (!isTtl(reply?.entryValid)) add('entry_ttl_malformed', `entryReplies[${index}]`);
        else if (!isZero(reply.entryValid)) add('entry_ttl_nonzero', `entryReplies[${index}]`);
    });

    // Negative lookups
    requireList('negativeLookupReplies').forEach((reply, index) => {
        const where = `negativeLookupReplies[${index}]`;
        if (reply?.kind === 'error' && reply.errno === 'ENOENT') return;
        if (reply?.kind === 'entry' && reply.nodeId === 0 && isZero(reply.entryValid)) return;
        add(reply?.kind === 'entry' && reply.nodeId === 0 ? 'negative_entry_cached' : 'negative_lookup_malformed', where);
    });

    // READDIRPLUS
    const readdirplusOn = (capabilities ?? []).some((name) => spec.readdirplus.capabilitiesThatEnableIt.includes(name));
    const plusEntries = Array.isArray(sample.readdirplusEntries) ? sample.readdirplusEntries : [];
    if (readdirplusOn && plusEntries.length === 0) add('missing_evidence', 'readdirplusEntries');
    plusEntries.forEach((entry, index) => {
        if (!isZero(entry?.entryValid)) add('readdirplus_ttl_nonzero', `readdirplusEntries[${index}]`);
    });

    // Opens
    requireList('openReplies').forEach((reply, index) => {
        const flags = isNameList(reply?.openFlags) ? reply.openFlags : null;
        const where = `openReplies[${index}]`;
        if (flags === null) { add('open_flags_malformed', where); return; }
        for (const required of spec.open.requiredFlags) if (!flags.includes(required)) add('open_direct_io_missing', where);
        for (const forbidden of spec.open.forbiddenFlags) if (flags.includes(forbidden)) add('forbidden_open_flag', `${where}:${forbidden}`);
    });
    requireList('opendirReplies').forEach((reply, index) => {
        const flags = isNameList(reply?.openFlags) ? reply.openFlags : null;
        const where = `opendirReplies[${index}]`;
        if (flags === null) { add('open_flags_malformed', where); return; }
        for (const forbidden of spec.opendir.forbiddenFlags) if (flags.includes(forbidden)) add('forbidden_opendir_flag', `${where}:${forbidden}`);
    });

    // Data delivery
    requireList('readReplies').forEach((reply, index) => {
        if (reply?.delivery !== spec.read.delivery) add('data_delivery_not_copy', `readReplies[${index}]`);
    });

    // Mount
    const options = isNameList(sample.mountOptions) ? sample.mountOptions : null;
    if (options === null) add('missing_evidence', 'mountOptions');
    for (const required of spec.mount.requiredOptions) if (options && !options.includes(required)) add('mount_option_missing', `mountOptions:${required}`);
    if (sample.grantAccess !== 'read' && sample.grantAccess !== 'write') add('grant_access_malformed', 'grantAccess');
    else if (sample.grantAccess === 'read' && options && !options.includes(spec.mount.readOnlyGrantRequiresOption)) add('read_only_grant_not_ro', 'mountOptions');

    return violations;
}
