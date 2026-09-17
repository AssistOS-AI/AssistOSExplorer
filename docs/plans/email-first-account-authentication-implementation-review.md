# Email-first account authentication implementation review

Reviewed on 2026-09-17 against the uncommitted implementation based on `299a13c9182ad568ca60ebd6d935cbaf5d73a768` and the [implementation plan](email-first-account-authentication-plan.md).

The implementation targets fresh installations with no account migration. Both PROD and non-PROD use Google or Email → Next, followed by an existing account's password or alternatives, or password signup with email verification before activation. No shared administrator password or separate administrator sign-in is retained.

## Findings and fixes

All confirmed findings below are resolved and covered by regression checks.

| Finding | Correction | Verification |
| --- | --- | --- |
| Password login could complete after password authentication was disabled during hashing. | Recheck the live parent and current password policy in the final serialized completion, before recording success. | Pause a valid KDF, change policy or expire the parent, then require refusal with no successful audit or handoff. |
| Work waiting for a global KDF slot used stale admission checks; Google password proofs also omitted their retained-parent validator. | Revalidate immediately after slot admission for login, signup and password management. Pass the retained Google transaction and parent validator into password verification. | Occupy both slots, invalidate the waiting request's parent, policy or operation grant, and verify that no expensive evaluation begins; expire a Google parent during active verification and require refusal. |
| Changing the signup email could make the selected password equal to that address. | Keep an optional encrypted scrypt comparison verifier for email-shaped passwords. Refuse matching addresses case-insensitively without changing the pending challenge or asking for plaintext again. Charge each comparison and additional hash to the source budget. | Exact and mixed-case matches fail; another address succeeds with the original password. Persistence contains no plaintext or fast password digest, and budgets count the work. |
| TOTP and passkey Google-link proofs remained usable after a password change. | Bind every local credential proof to the account generation and recheck it at linking. Missing generations fail closed. | Domain and HTTP tests retain real proofs, change the password, and require refusal without creating a binding; fresh proofs still work. |
| OIDC method-policy failures returned raw JSON for native form submissions and bypassed pending-signup cleanup. | Preserve JSON errors for preparatory actions; re-render native failures in the wizard. Code completions reach their domain validation and consume valid proofs refused by policy, erasing signup staging. | Native password failure renders a usable page; disabled-method signup completion leaves no verifier or usable proof. |
| A lost signup, resend or change-email response could require another password or display obsolete server state. | Read the same bound attempt after an ambiguous failure, recover its current email and challenge, or offer a read-only retry when status is unavailable. | Fake-DOM and real HTTP/Chromium checks lose responses after server commits and resume without another password or hash. |
| Back during signup creation or email change could abandon a mutation while leaving pending server state or the wrong displayed email. | Disable and guard Back while either mutation is running, restoring it after a correctable refusal. | Delayed adapters and real browser requests cannot navigate back during either mutation. |
| Verification, resend and email-change controls could overlap and discard a successful handoff. | Serialize signup-screen mutations, including countdown handling, while keeping explicit Cancel available. | Delayed verification cannot trigger resend; a delayed resend after cancellation cannot restore the abandoned screen. |
| The EmailAgent runtime fixture dropped the caller's shared dependency loader. | Forward configured `NODE_OPTIONS` to the child runtime while retaining the fixture's explicit environment. | The real AgentServer starts and executes authenticated MCP calls, including signup purpose validation. |
| The Router-consumer inventory omitted the existing managed-origin reader. | Add a narrow disposition identifying its delegation to the mounted authenticated runtime-origin helper. Keep the inventory scan and other dispositions intact. | The complete Router-consumer safety suite passes. |
| QA readiness still described a passwordless wizard and omitted password availability. | Update email-first wording and include password in the readiness report; update executable workflow fixtures. | Workflow tests execute the public verification block, check password reporting, and prove that readiness never submits login or signup. |

The optional comparison verifier is a deliberate refinement to the original plan's one-hash signup assumption. Ordinary passwords still require one creation hash. Only mixed-case email-shaped passwords need a second, separately budgeted hash; lowercase email-shaped passwords reuse their primary verifier. Resending a code never hashes a password again.

DS012, DS013, the architecture page and browser regression documentation describe the final behavior.

## Validation

| Check | Result |
| --- | --- |
| Complete UserPersisto suite | 554 passed, 0 failed, 0 skipped |
| Complete smoke unit suite | 661 passed, 0 failed, 0 skipped |
| Complete EmailAgent suite, including the real MCP runtime fixture | 9 passed, 0 failed, 0 skipped |
| Chromium email-first wizard | Passed on separate fresh installations with PROD absent and set, including injected response loss, mutation controls, actual resend cooldown, two tabs, password login, email-code alternatives, Google and native OIDC consent |
| Chromium Google collision linking | Passed with password and a virtual passkey, using the real local service and OIDC engine |
| Chromium My Account | Passed Google confirmation, first-password setup, password change and login with only the changed password |
| Whitespace/error check | `git diff --check` passed |

The tests used Node 24.21.0, Chromium 149.0.7827.55 and the existing shared runtime dependencies. They used temporary stores, loopback services, captured email delivery and controlled signed Google credentials. No dependencies were installed and no deployment was started.

Final wizard screenshots are retained under `.ploinky/test-artifacts/userpersisto-wizard/20260917123226-31330d/`; password-management screenshots are under `.ploinky/test-artifacts/google-enrollment/1789648284207/`. Secret inputs are masked.

## Remaining acceptance boundaries

There are no outstanding confirmed review findings. Real Google accounts, real email delivery, physical passkeys, non-Chromium browsers and deployed Router acceptance were not exercised by this review. Deployment remained stopped throughout the review. Validation completed before the implementation and fixes were committed.
