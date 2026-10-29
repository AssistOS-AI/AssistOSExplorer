//! Decision D2 of the plan (section 16, "Decisions recorded 2026-10-28"): option (a), with exactly its stated
//! residuals, including the forced-termination residual (coordinator message 8f3de067). The Rust copy of the marker in
//! `robo-work/server/views/d2Decision.mjs` (S5 r5); the strings are identical so that a test can compare them.
//!
//! What the file server implements (engine.rs): post-read validation; sticky refusal after an observed protected name,
//! including new mapping faults; truthful outcomes for writes that passed their pre-check, also during the SIGTERM drain
//! of a root revocation; best-effort page invalidation as an intent queue only. Nothing here is Linux or FUSE evidence:
//! G6 qualifies the semantics on a real kernel.

pub struct D2Decision {
    pub gate: &'static str,
    pub option: &'static str,
    pub decided: bool,
    pub recorded: &'static str,
    pub semantics: &'static [&'static str],
    pub residuals: &'static [&'static str],
    pub forbidden: &'static [&'static str],
    pub not_claimed: &'static [&'static str],
    pub retained: &'static [&'static str],
    pub proof: &'static str,
}

pub const D2_DECISION: D2Decision = D2Decision {
    gate: "D2",
    option: "a",
    decided: true,
    recorded: "plan §16, Decisions recorded 2026-10-28",
    semantics: &[
        "Post-read validation: a read returns data only after a check made after the backing read still finds an ordinary binding.",
        "Sticky refusal after an observed protected name: every later server-visible operation on that handle is refused, including new mapping faults.",
        "Truthful outcome for a write that passed its pre-check: a write that took effect is reported as it was, never as refused, during normal service and during the SIGTERM drain of a root revocation.",
        "During a completed SIGTERM drain, the server returns the actual completed backing-write result, including partial writes. It never relabels an effected write as an authorization refusal.",
        "Best-effort page invalidation on detection: the node is queued for invalidation (viewEngine takeInvalidations); the queue is an intent and never a gate.",
    ],
    residuals: &[
        "Bytes already delivered to the robot before detection.",
        "Bytes in mappings established before detection.",
        "A backing write that took effect before detection.",
        "Detection only at the next server-visible operation or root-lease verification.",
        "Forced termination or server loss can leave some or all effects in place despite an error or no reply, including an effect that completed before the reply was lost. The caller's mutation outcome is then UNKNOWN; an error is not proof of no mutation.",
    ],
    forbidden: &["FUSE_DIRECT_IO_ALLOW_MMAP", "FUSE_DIRECT_IO_RELAX", "cache opt-ins listed in fuseSettings.mjs", "weaker checks"],
    not_claimed: &[
        "atomic exclusion",
        "instantaneous revocation",
        "tool compatibility before G6",
        "automatic replay based on assumed non-effect",
        "rollback",
        "new durability guarantee",
    ],
    retained: &["bounded teardown", "refusal of new operations", "read checks", "verified quarantine"],
    proof: "G6",
};
