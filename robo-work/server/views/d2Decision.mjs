// Decision D2 of the plan (section 16, "Decisions recorded 2026-10-28"): option (a), with exactly its stated residuals.
// This module is the one explicit marker for it. The scope is the R24 rule for handles that were open or mapped before a
// protected rename, and for the grant root and its outside ancestors (D-S5-6, rootLease.mjs).
//
// What the marker records, and nothing more:
//   semantics   what the view engine (viewEngine.mjs) and the Rust file server implement;
//   residuals   what option (a) accepts and does not claim to prevent;
//   forbidden   the kernel opt-ins and weakenings that the decision excludes (fuseSettings.mjs enforces the opt-ins);
//   notClaimed  properties that no test, document or reply may claim;
//   retained    guarantees that the forced-termination residual leaves in force;
//   proof       the gate that qualifies the semantics on a real kernel (G6). Nothing here is Linux or FUSE evidence.

function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

export const D2_DECISION = deepFreeze({
    gate: 'D2',
    option: 'a',
    decided: true,
    recorded: 'plan §16, Decisions recorded 2026-10-28',
    semantics: [
        'Post-read validation: a read returns data only after a check made after the backing read still finds an ordinary binding.',
        'Sticky refusal after an observed protected name: every later server-visible operation on that handle is refused, including new mapping faults.',
        'Truthful outcome for a write that passed its pre-check: a write that took effect is reported as it was, never as refused, during normal service and during the SIGTERM drain of a root revocation.',
        'During a completed SIGTERM drain, the server returns the actual completed backing-write result, including partial writes. It never relabels an effected write as an authorization refusal.',
        'Best-effort page invalidation on detection: the node is queued for invalidation (viewEngine takeInvalidations); the queue is an intent and never a gate.'
    ],
    residuals: [
        'Bytes already delivered to the robot before detection.',
        'Bytes in mappings established before detection.',
        'A backing write that took effect before detection.',
        'Detection only at the next server-visible operation or root-lease verification.',
        // Forced-termination residual, accepted by the coordinator (message 8f3de067) and recorded in plan §16 D2 and §5.4.
        'Forced termination or server loss can leave some or all effects in place despite an error or no reply, including an effect that completed before the reply was lost. The caller\'s mutation outcome is then UNKNOWN; an error is not proof of no mutation.'
    ],
    forbidden: ['FUSE_DIRECT_IO_ALLOW_MMAP', 'FUSE_DIRECT_IO_RELAX', 'cache opt-ins listed in fuseSettings.mjs', 'weaker checks'],
    notClaimed: [
        'atomic exclusion', 'instantaneous revocation', 'tool compatibility before G6',
        'automatic replay based on assumed non-effect', 'rollback', 'new durability guarantee'
    ],
    retained: ['bounded teardown', 'refusal of new operations', 'read checks', 'verified quarantine'],
    proof: 'G6'
});
