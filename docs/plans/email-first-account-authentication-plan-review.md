# Email-first account authentication plan review

Reviewed against AssistOSExplorer `299a13c9182ad568ca60ebd6d935cbaf5d73a768` on 17 September 2026. Scope: the initial 840-line plan and the executable authentication, persistence, policy and routing contracts it cites. No implementation or deployment was performed during this review.

## Controlling scope clarification

After the first review, the user explicitly clarified: **“We don’t care about migration. We don’t have any accounts registered.”** The implementation is for a fresh installation with no existing accounts. This supersedes the draft's migration, backward-compatibility, legacy-administrator recovery and old-release rollback requirements. Do not retain those as blockers or implement speculative compatibility mechanisms. This does not authorize deleting any live workspace or restarting deployment; use isolated fresh stores for tests.

Verdict for the initial draft: **revise before implementation**. The approved user flow, browser-bound pending signup, per-user credential ownership, separation of signup proof from email-code login, staged SSO handoff, and preservation of OIDC consent are sound. Resolve the findings below, simplify the plan to the fresh-install scope, then proceed to implementation.

## Findings for revision

| ID | Priority | Initial plan reference | Finding and required correction |
| --- | --- | --- | --- |
| R1 | P1 | Sections 4.4, 5.2 S15, 11, 16.2-16.3, D1/D6/D11 | Remove migration, cutover, stored-policy migration, legacy password hashes, productionSuspended transitions, old-format attempt compatibility, the shared/default administrator verifier, and the hidden recovery=administrator screen/endpoints. There are no existing accounts to preserve or recover. New public authentication must never accept the old default admin password. Remove old public admin/login and OIDC admin-login behavior rather than retaining it as a hidden compatibility route. No old-release data rollback mechanism is required. Keep normal first-verified-owner setup and current roles/capability routing for newly created accounts. |
| R3 | P1 | Sections 6.4 steps 3-7 and 6.5; initial lines 329-334 | The per-email failure budget is checked before acquiring the per-email lock. A burst can have every request observe the same unspent budget and then execute serially after the limit has been reached. Recheck the live parent, policy and per-email budget after acquiring the lock and immediately before KDF work; keep failure accounting inside that same serialization boundary. Source admission can remain outside it. Bound queued work and test more simultaneous requests than the failure limit, proving later requests do not execute the KDF or receive another guess after exhaustion. |
| R5 | P2 | Section 7.1 | In fresh-install scope, choose one coherent new attempt format, lookup namespace and authenticated-encryption context. Reject unsupported old formats; do not implement dual-version decryption or migrate old login/registration attempts. The current attempt key and encryption context contain version information, so define them together and test genuine persistence/restart behavior with the new format. |
| R6 | P2 | Sections 5.3, 7.4 and 8.1; initial lines 217, 375-389 | After startSignup has durably staged a verifier, a delivery failure sends the UI back to password entry with cleared inputs. The verifier is still usable, so this repeats password selection/KDF work unnecessarily and conflicts with A6. Define a recoverable pending-signup delivery-failed state and resend action that retain the staged verifier, preserve counters and remain bounded by the parent. Distinguish failure before staging, failure after staging, unknown delivery outcome and expired/cancelled staging. Verify retry without resubmitting or persisting plaintext password. |
| R7 | P2 | Sections 5.2, 6.3, 6.4 and D5 | The plan allows 128 Unicode code points after normalization but puts maxlength=128 on HTML inputs, whose length is measured in UTF-16 code units. This rejects supported passwords containing supplementary characters and can disagree after normalization. Specify matching client/server normalization and length rules with a separately bounded raw input; avoid silent truncation. Use a 15-character minimum for new single-factor account passwords, since the alternative methods do not constitute mandatory MFA. Login must enforce transport/resource bounds and a supported stored verifier, not retroactively reject a previously valid password if the creation policy is later tightened. |
| R8 | P2 | Sections 18.2 and 12 | Separate test commands by explicit working directory so browser commands do not inherit tests/smoke as cwd. Use the supported AgentLib/runtime environment and existing dependencies; do not require deleting a Box marker or weakening image/runtime invariants to make checks pass. Distinguish blocked accounts (authentication refused) from role changes (identity may authenticate, while current capability routing changes). Clarify OIDC's two persistence boundaries: local account/credential/setup commit followed by interaction completion; it is not one atomic commit with the engine response. The described same-browser lost-response recovery is a valid approach. |

The password-length recommendation follows OWASP's guidance for passwords without mandatory MFA: https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#implement-proper-password-strength-controls . An scrypt timing target is a performance measurement, not permission to lower a vetted work factor to satisfy an arbitrary upper latency number.

The initial review's migration-readiness and old-release rollback findings (R2 and R4) are superseded by the user's fresh-install clarification. They are not work items for this implementation.

## Implementation directions

These directions resolve implementation choices within the approved flow and the user's subsequent instruction to implement after review. They are review decisions, not additional statements attributed to the user.

| Original decision | Direction |
| --- | --- |
| D1 | No shared/default administrator-password authentication and no public legacy recovery bridge. Remove obsolete machinery from the new flow. No migration preflight or data conversion. |
| D2 | Include authenticated My Account password set/change with fresh, single-use operation grants as normal credential management. It is needed for future Google-created accounts that later want a password and for changing a compromised password. No administrator-set passwords and no new unauthenticated reset feature. Validate predictable input failures before spending a grant, bound hashing, then revalidate actor/status/mailbox, effective policy and credential/generation state at the commit boundary. |
| D3 | Keep the approved password screen for registered accounts. If password sign-in is unavailable, explain that neutrally, disable unusable submission and retain Try another way plus Back. Do not disclose blocked status or Google linkage. This also covers accounts created through Google in the new release. |
| D4 | Show the three requested alternatives. Disable unavailable choices with generic wording; give specific browser/policy explanations only when supported by public policy or local browser capability. Do not invent a response field that distinguishes missing enrollment from blocked status. |
| D5 | New passwords: minimum 15 and maximum 128 normalized Unicode code points, with bounded raw input and consistent confirmation rules. Follow R7, retain a vetted asynchronous scrypt profile and bounded concurrency. No historical-password compatibility. |
| D6 | New default policy includes password and the existing methods. Respect explicit current policy/environment restrictions. No stored-policy migration, migration version or rollback translation. |
| D7 | PROD has no special authentication or email-delivery/logging meaning in this change. Remove the Google-only switch. Preserve the existing explicit USERPERSISTO_DEV_BOOTSTRAP behavior and its development-only documentation; do not add a new hidden parity exception. |
| D8 | Use Sign in with Google, as requested. |
| D9 | Include purpose-appropriate signup-verification email wording through the existing delivery/template contract, without a new service or dependency. Do not imply that pending signup is already an active account. |
| D10 | Keep the existing parent deadlines and test actual remaining-time/expiry behavior. No Ploinky scope expansion just to improve the timer. |
| D11 | Drop historical-hash migration, scrubbing, resurrection and compatibility work. |

Revise A10 and the plan status to reflect the latest authorization: the user requested a review/revision cycle followed by an implementation session. Deployment remains stopped. Make the revised plan self-contained and implementation-ready without leaving routine decisions awaiting another approval.

## Revision verification

Completed. The findings and the fresh-install clarification were returned to the original planning session. The rewritten plan and the targeted R9/R10 corrections were checked against the source contracts before implementation launch.

### Targeted check of the fresh-install revision

The rewritten fresh-install plan addresses R1, R3, R5, R6, R7 and R8 in its disposition and substantive sections. The remaining points below are targeted clarifications; they do not reopen migration or require another full rewrite.

| ID | Priority | Revised-plan reference | Required correction |
| --- | --- | --- | --- |
| R9 | P2 | Section 14, Order row | Step 2 calls its grant checks read-only but also says the presented grant is consumed, while step 4 rechecks and consumes it again. Make the valid-grant path unambiguous: read-only validation before hashing, then re-read/revalidate and consume exactly once in the same serialized commit as the credential write. An invalid/expired grant may follow the existing invalid-proof consumption rule, but a valid grant must remain available until the final commit. Add a concurrent-use test proving one grant authorizes at most one password mutation, including two first-set requests while authGeneration has not changed. |
| R10 | P2 | Section 7.3, Well-formedness row | The claim that an ill-formed candidate cannot match is false for Node's UTF-8 encoding: lone surrogates become replacement characters and can collide with a well-formed password containing U+FFFD. Treat well-formed Unicode as an encoding requirement at both creation and verification, returning neutral authentication failure for malformed login input. This is separate from creation-strength policy and does not reapply minimum length at login. Test a legitimate verifier containing a literal replacement character and a candidate with an unpaired surrogate. |

Implementation may begin after these two points are corrected and the final reviewed file hash is recorded below.

### Additional verification evidence

The selected scrypt profile, N=32768 (2^15), r=8, p=3, was checked against the published [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt) on 17 September 2026 and is one of its listed configurations. Keep that explicit profile; there is no need to choose an unverified fallback during implementation. The 64 MiB Node maxmem setting accommodates the profile's allocation overhead.

R10 was also reproduced with Node.js 24.21.0: a well-formed string containing literal U+FFFD and the corresponding ill-formed string containing an unpaired high surrogate produce equal UTF-8 buffers. The verification-side well-formedness check is therefore necessary, independent of the creation-strength policy.

### Final verdict

**Ready for implementation in the authorized fresh-install scope.** R1, R3, R5, R6, R7, R8, R9 and R10 are addressed in the revised plan and its regression matrix; R2 and R4 remain superseded by the user's no-migration clarification. No implementation-blocking plan finding remains. The operator/user flow and security boundaries are concrete; implementation tests still need to establish correctness of the future code.

Reviewed plan SHA-256: `11f0dec5a1ecd8b50bbcf801630323a7d7fd7c667d1fe8499740f0ee44feed36`. Source baseline remains `299a13c9182ad568ca60ebd6d935cbaf5d73a768`. At this handoff only the plan and this review are new repository files; no tracked implementation, runtime configuration or deployed data has changed. Deployment stays stopped.
