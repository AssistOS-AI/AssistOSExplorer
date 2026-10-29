// Design questions of the S5 common part. Identifiers are referenced from comments and vector files. An open question is
// not resolved here and the code does not depend on an answer except where a default is stated.
//
// kind: 'product' questions belong to Daniel (they change what a user or robot can do or what R24 covers); 'technical'
// ones are for the implementation owners and reviewers. The classification is the code reviewer's of candidate 315c8f67.
// status: 'open', or 'decided' with `decision` naming where the decision is recorded.
const PRODUCT = new Set(['D-S5-6', 'D-S5-10']);
const DECIDED = new Map([
    ['D-S5-6', 'plan §16, Decisions recorded 2026-10-28: exclusion covers the grant root and its outside ancestors. Implemented as '
        + 'grant.verifyBinding (grantResolver.mjs), the root lease (rootLease.mjs) and revokeRoot (viewEngine.mjs); instantaneous '
        + 'revocation is not promised.'],
    ['D-S5-10', 'plan §16, Decisions recorded 2026-10-28: DR-1 refusal, both sides of an exchange checked (operationPolicy.mjs DR-1).']
]);

export const DESIGN_QUESTIONS = Object.freeze([
    ['D-S5-1', 'Keep the default-ignorable layer of the grant-name predicate (protectedNames.mjs)? It only adds refusals, but it makes the Rust fold depend on a Unicode property table and goes beyond "the name fold is Ploinky\'s".'],
    ['D-S5-2', 'Is the target string of a symlink an operand name that the policy must check (decision record DR-6)? Currently not checked.'],
    ['D-S5-3', 'A backing rename of an ancestor to an ORDINARY name also cuts off the old node, because the binding cannot be proven under its recorded name. Accept the availability cost, or add a bounded re-resolution? Since D-S5-6 the same rule revokes a live view when the grant root or an outside ancestor is renamed to an ordinary name (risk K1 of the S5 decisions delta); an answer here would change that too.'],
    ['D-S5-4', 'What does the kernel get as a reply to a create whose post-check fails after the effect took place? The engine reports the true outcome (created, no node handed out); the FUSE reply shape is for the glue owner.'],
    ['D-S5-5', 'The errno mapping. errnoHint values in the policy are provisional hints; only "absent is ENOENT" is asserted.'],
    ['D-S5-6', 'Renaming the grant root, or an ancestor outside it, into a protected location after admission (review (4), risk table).'],
    ['D-S5-7', 'The reviewed extended-attribute set. The plan does not name it; the default is empty, so every xattr operation is refused.'],
    ['D-S5-8', 'Minimum depth of a managed-source skill grant: this slice requires a repository directory below .ploinky/repos, never the whole tree.'],
    ['D-S5-9', 'firstGrantRootSlot and the execution/GUI mountpoint layout under the runtime directory belong to the S4 owner of the keeper spawn layout; the values here are provisional.'],
    ['D-S5-10', 'Decision record DR-1: refuse rmdir and directory rename over hidden descendants, or accept the behaviour as a stated limit like the hard-link limit.'],
    ['D-S5-11', 'Setattr policy through an allow_other view (mode bits including setuid and setgid, ownership, times) is unspecified in the plan.'],
    ['D-S5-12', 'Names are bytes on Linux. A name that is not valid UTF-8 cannot fold to a protected name in this model; the Rust fold must state how it treats such names.'],
    ['D-S5-13', 'The root-lease timing values (rootLeaseRenewMs, rootLeaseTtlMs, rootRevokeGraceMs, rootRevokeVerifyMs in viewLimits.mjs) are provisional; G5 fixes them from measured supervisor pauses and verification cost.']
].map(([id, text]) => Object.freeze({
    id, kind: PRODUCT.has(id) ? 'product' : 'technical', status: DECIDED.has(id) ? 'decided' : 'open', decision: DECIDED.get(id) ?? null, text
})));
