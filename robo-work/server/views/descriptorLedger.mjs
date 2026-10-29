// Descriptor-cap accounting of one file server (plan section 5.4, "Descriptors").
//
// The server inherits exactly two descriptors beyond its standard streams (the /dev/fuse connection and the grant
// root). Every further descriptor, for a node or for an open file or directory, is derived from the grant root and is
// counted here. At the cap the server refuses the NEW lookup or open explicitly (EMFILE). It never evicts a live node,
// never closes a descriptor on behalf of another request, and a refusal changes nothing.
//
// Descriptors that a verification opens only for a moment (a binding-chain re-check implemented with openat instead of
// fstatat) are counted too, through withTransient, and a verification that cannot get one refuses: it never fails open.

import { resolveViewLimits } from './viewLimits.mjs';

export const CAP_REFUSAL = Object.freeze({ ok: false, code: 'descriptor_cap', errnoHint: 'EMFILE' });

export function createDescriptorLedger({ cap }) {
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new TypeError('The descriptor cap must be a positive integer');
    let nextToken = 1;
    const live = new Map();
    let peak = 0;
    let refusals = 0;

    function acquire(kind) {
        if (typeof kind !== 'string' || kind === '') throw new TypeError('A descriptor needs a kind');
        if (live.size >= cap) {
            refusals += 1;
            return CAP_REFUSAL;
        }
        const token = nextToken;
        nextToken += 1;
        live.set(token, kind);
        peak = Math.max(peak, live.size);
        return Object.freeze({ ok: true, token });
    }

    function release(token) {
        if (!live.delete(token)) throw new Error('Unknown or already released descriptor');
    }

    // Runs `work` with a counted transient descriptor, released on every path. Returns the CAP_REFUSAL without running
    // `work` when the cap is reached.
    function withTransient(kind, work) {
        const grant = acquire(kind);
        if (!grant.ok) return grant;
        try {
            return { ok: true, value: work() };
        } finally {
            release(grant.token);
        }
    }

    return Object.freeze({
        acquire,
        release,
        withTransient,
        inUse: () => live.size,
        kinds: () => {
            const counts = {};
            for (const kind of live.values()) counts[kind] = (counts[kind] ?? 0) + 1;
            return counts;
        },
        stats: () => ({ cap, inUse: live.size, peak, refusals })
    });
}

// The cap must sit below RLIMIT_NOFILE with room for the inherited descriptors and a margin. Returns null when the
// pair is acceptable, otherwise a code.
export function descriptorCapProblem({ cap, rlimitNofile }, limitOverrides = {}) {
    const limits = resolveViewLimits(limitOverrides);
    if (!Number.isSafeInteger(cap) || cap <= 0) return 'cap_not_positive';
    if (!Number.isSafeInteger(rlimitNofile) || rlimitNofile <= 0) return 'rlimit_not_positive';
    if (cap + limits.fileServerInheritedDescriptors + limits.rlimitHeadroom > rlimitNofile) return 'cap_not_below_rlimit';
    return null;
}
