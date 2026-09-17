# Email-first account sign-up and sign-in for UserPersisto: implementation plan

Status: revised implementation plan. First prepared on 17 September 2026 against AssistOSExplorer `main` at `299a13c9182ad568ca60ebd6d935cbaf5d73a768` ("Unify sign-in form and restrict production to Google"), and revised the same day to address the review in `docs/plans/email-first-account-authentication-plan-review.md` and the user's fresh-installation clarification. Task tags: planning, authentication, routing, bootstrap, browser-e2e, documentation.

Authorization: the user asked for a review and revision cycle followed by a separate implementation session. Implementation of this revised plan is therefore authorized in that separate session once the review records this revision as verified. The session that wrote and revised this plan implemented nothing. Deployment remains stopped: no deployment, restart or redeployment is authorized by this plan, and no live workspace data may be deleted or mutated.

This document is the only file changed by the planning and revision work. No source, test, active specification, dependency, runtime configuration, Git state, credential, stored account or deployment was modified. No test suite, browser run or deployment was executed, and no secret file, credential store or managed shadow checkout under `.ploinky/repos` was read. Commit identifiers and their descriptions come from the task brief; Git commands were not available to this session, so history was not independently re-verified. Source line numbers refer to the working tree inspected on the date above.

## 1. How to read this plan

Every statement carries one of four standings. There are no open decisions awaiting approval.

| Label | Meaning |
| --- | --- |
| **APPROVED** | Stated by the user as the authoritative flow (section 2.1). Supersedes DS012, DS013 and DS002 wherever they describe passwordless-only accounts, the inline administrator password or Google-only production. |
| **SCOPE** | The user's later clarification that this is a fresh installation (section 2.2). It removes migration, recovery and compatibility work. |
| **REVIEW** | A technical decision made by the plan review (finding IDs R1 to R10 and directions D1 to D11, section 3). These are review decisions, not statements attributed to the user. |
| **RESOLVED** | A routine technical choice made by this plan (parameters, module boundaries, record shapes, limits). Implement as written unless a defect is found. |

## 2. Requirements and scope

### 2.1 Approved flow (APPROVED)

| ID | Requirement |
| --- | --- |
| A1 | Initial screen: a **Sign in with Google** button, below it an **Email** field, below it a **Next** button. No password field on this screen and no separate administrator sign-in button. |
| A2 | After **Next**, discover whether the email has an active registered account. |
| A3 | Registered account: show a password field, a **Try another way** action and a **Log in** button. The password is that individual user's own account password, never a shared administrator password. |
| A4 | **Try another way** opens an alternative-method selection containing email code, passkey and TOTP. Presentation of unavailable methods is decided explicitly. No mandatory MFA is introduced. Google stays on the first screen. |
| A5 | Unknown email: show a **Sign up** step; **Sign up** opens a new screen with **Password** and **Confirm password**, followed by the account-creation action. |
| A6 | Email verification precedes activation: Email, Sign up, Password plus Confirm password, emailed verification code, then automatic sign-in after successful verification. Registration stays pending until verification succeeds. Offer **Resend code** and **Change email**; do not ask for the password again unnecessarily. |
| A7 | Existing users normally log in with their password; the signup email verification is not an extra challenge on every password login. |
| A8 | Google signup may skip the local email code when Google is authoritative for the email (Gmail or an appropriately verified Workspace). A third-party Google email needs the existing ownership proof; `email_verified` alone is not necessarily sufficient. Preserve verified issuer and subject binding, explicit collision-link consent, owner and role semantics, and local identity stability. |
| A9 | The same flow is used in PROD and non-PROD under the normal authentication policy. The PROD-present Google-only restriction is removed and not retained in any form. |
| A10 | The original brief limited the task to planning and review. The user's latest instruction is a review and revision cycle followed by a separate implementation session, so implementation of this revised plan is authorized there. The stopped local deployment is not resumed, and nothing in this plan authorizes a deployment. |

### 2.2 Fresh-installation scope (SCOPE)

The user clarified after the first review: "We don't care about migration. We don't have any accounts registered." The work targets a fresh installation with no existing accounts.

| Excluded by the clarification | Meaning for the implementation |
| --- | --- |
| Migration and cutover | No conversion of users, credentials, policies, attempts or setup records; no startup preflight; no stored-policy migration or migration version. |
| Legacy administrator recovery | No shared or default administrator password, no compatibility bridge, no hidden recovery address or parameter, no recovery endpoint. New public authentication never accepts the old default administrator password. |
| Compatibility readers | One attempt format, one password-verifier profile, no historical password hashes, no dual-version decryption. Unsupported formats are rejected, never converted. |
| Old-release data rollback | No rollback mechanism or data translation. Reverting code is ordinary source control together with a fresh store. |

What the clarification does not change: the first completed verified owner assignment, the restricted `selfRegistered` role for later signups, existing capability routing, Google identity and linking rules, and Ploinky's provider-neutral boundary all stay. It authorizes no deletion of live data and no deployment restart: implementation and tests use isolated temporary stores only, and the retained test workspace data is left untouched.

A store written by an earlier release is outside the supported scope. The new release neither converts nor deletes anything in such a store: an earlier `installation.setup` record still reads as claimed and fails closed (`lib/setup.mjs:15`), earlier attempt records are never looked up under the new namespace and expire through the existing bounded sweep, and an earlier administrator-password verifier setting is simply never read. A developer who wants the new flow uses a new workspace.

### 2.3 Constraints carried from the brief

Email discovery and client-supplied roles are never authority. Ploinky stays provider-neutral and never becomes a credential store. Ploinky's retired core password authentication is not revived. There is no unconditional destructive store reset.

## 3. Review disposition

The review file lists the findings and implementation directions addressed here. R2 and R4 of the first review concerned migration readiness and old-release rollback; the review records them as superseded by the user's clarification, so they are not work items. R9 and R10 come from the review's targeted check of the fresh-install revision and were corrected in place without changing the scope.

| ID | Origin | Disposition | Resolved in |
| --- | --- | --- | --- |
| Fresh-install clarification | User (SCOPE) | Adopted as the controlling scope | Sections 2.2, 5.4, 8.1, 10, 12, 17 |
| R1 | Review, P1 | Resolved: migration, cutover, stored-policy migration, legacy hashes, `productionSuspended` handling, old attempt compatibility, the shared and default administrator verifier, and the hidden recovery screen and endpoints are all removed; the public `admin/login` route and OIDC `admin-login` action are deleted, not hidden | Sections 5.3, 5.4, 6.2 (no recovery screen), 9.2, 9.3, 12, 17 |
| R2 | Review, superseded | Not a work item | Section 2.2 |
| R3 | Review, P1 | Resolved: parent, policy and the per-email budget are rechecked after the per-email lock and immediately before the KDF; failure accounting stays inside the same serialization boundary; queued work is bounded; a burst test proves no KDF runs after exhaustion | Sections 7.4, 7.5, 19.1 |
| R4 | Review, superseded | Not a work item | Section 2.2 |
| R5 | Review, P2 | Resolved: one attempt format with its version, lookup namespace and encryption context defined together; other formats rejected; genuine persistence and restart tests | Sections 8.1, 19.1 |
| R6 | Review, P2 | Resolved: a recoverable send-failed state keeps the staged verifier; failure before staging, after staging, unknown outcome, interrupted delivery and missing staging are distinguished; retry never resubmits or persists the plaintext password | Sections 6.2 (S6), 6.3, 6.6, 8.4, 8.5, 9.2, 19.1 |
| R7 | Review, P2 | Resolved: matching client and server NFKC rules, a separately bounded raw input, no HTML `maxlength` on password inputs, no silent truncation, a 15-character minimum for new passwords, and login that enforces only transport and resource bounds plus a supported stored verifier | Sections 6.2, 7.2, 7.3, 9.4 |
| R8 | Review, P2 | Resolved: commands separated by explicit working directory and supported runtime environment, no Box-marker or invariant workarounds; blocked accounts distinguished from role changes; the two OIDC persistence boundaries stated | Sections 8.6, 13, 19.2 |
| R9 | Review, P2 (targeted check) | Resolved: before hashing, the grant is only read and validated, so a valid grant stays available; it is re-read, revalidated and consumed exactly once in the same serialized commit as the credential write; an already invalid grant keeps the existing invalid-proof rule; a concurrent same-grant test, including two first-set requests with an unchanged `authGeneration`, is required | Sections 14, 19.1, 20 (AC22) |
| R10 | Review, P2 (targeted check) | Resolved: well-formed Unicode is an encoding requirement at creation and at verification, because Node's UTF-8 encoding turns a lone surrogate into U+FFFD; a malformed candidate receives the neutral authentication failure; creation-strength rules, including the minimum length, are still not applied at login; the U+FFFD regression is required | Sections 7.3, 7.4, 19.1, 20 (AC17) |
| D1 | Review direction | No shared or default administrator-password authentication, no bridge, no preflight, no data conversion | Sections 5.4, 12 |
| D2 | Review direction | My Account password set and change is normal credential management with single-use grants; predictable input failures precede grant spending; hashing is bounded; actor, status, mailbox, policy and credential or generation state are revalidated at the commit boundary | Section 14 |
| D3 | Review direction | The password screen is always shown for a registered account; when password sign-in is unavailable the submission is disabled with neutral wording and **Try another way** plus **Back** remain | Sections 6.2 (S2), 9.1 |
| D4 | Review direction | The three alternatives are always shown; unavailable ones are disabled with generic wording; specific explanations only from public policy or local browser capability; no response field distinguishes missing enrollment from blocked status | Sections 6.2 (S3), 9.1 |
| D5 | Review direction | New passwords: 15 to 128 normalized code points, bounded raw input, consistent confirmation, a vetted asynchronous scrypt profile with bounded concurrency, no historical-password compatibility | Sections 7.2, 7.3 |
| D6 | Review direction | The default policy includes `password`; explicit stored and environment restrictions are respected; no migration | Section 10 |
| D7 | Review direction | `PROD` has no authentication, delivery or logging meaning; the existing `USERPERSISTO_DEV_BOOTSTRAP` behavior is preserved unchanged | Section 10 |
| D8 | Review direction | **Sign in with Google** | Sections 5.5, 6.2 |
| D9 | Review direction | Purpose-appropriate signup-verification wording through the existing delivery and template contract | Section 9.6 |
| D10 | Review direction | Existing parent deadlines kept; remaining-time and expiry behavior tested; no Ploinky change | Sections 6.7, 15, 19.1 |
| D11 | Review direction | No historical-hash migration, scrubbing, resurrection or compatibility | Sections 2.2, 7.1 |

## 4. Vocabulary and invariants

| Term | Definition in this plan |
| --- | --- |
| Registered account | A persisted `user` record that owns the normalized email (`getUserByEmail`, `lib/users.mjs:62`). Ownership of the address blocks signup, independent of status. |
| Active registered account | A registered account with `status === 'active'`. Only these can authenticate. |
| Blocked or "deleted" account | Administrative deletion is reversible deactivation to `blocked`. The record still owns its email and cannot authenticate by any method. Its status is never disclosed by the sign-in surface. |
| Pending signup | Encrypted, browser-bound staging data inside an `authAttempt` record. It is not an account: it owns no email, holds no role, claims no installation, cannot produce a session, and is invisible to discovery. |
| Login authenticator | Something that signs an existing account in: the account password, an email code to a verified mailbox, a passkey, TOTP, or a bound Google identity. Governed by `enabledAuthMethods`. |
| Registration email proof | The emailed code that proves mailbox ownership before activation. It is not a login authenticator, never authenticates an existing account, and does not depend on the `emailCode` sign-in method being enabled. |
| Enrollment | Adding or replacing a credential on an already authenticated account after fresh confirmation (My Account). Distinct from authentication. |
| Verified email ownership | A server-verified code delivered to the address, or a Google identity that is authoritative for it. A matching string is never ownership. |
| UI availability and server enforcement | What the wizard renders is advisory. What domain functions accept at start and again at completion under lock is authoritative. Every hidden or disabled control is also refused by the server. |

Invariants for every phase: no email is marked verified without proof; setup ownership derives only from the committed `installation.setup` record and is never reopened; no credential of one account is ever offered for, copied to or accepted for another.

## 5. Evidence: current behavior and removal inventory

### 5.1 Baseline summary

UserPersisto (`AssistOSExplorer/userPersistoAgent`) is the identity authority. One wizard (`public/auth/wizard.js`) serves the Router SSO page through `sso-adapter.js` and the OIDC interaction through `oidc-adapter.js`. Accounts are passwordless: an email code to a verified mailbox, an enrolled passkey or TOTP, or Google. The only password is the shared administrator password (default `admin` on fresh stores, or `USERPERSISTO_ADMIN_PASSWORD`). The presence of `PROD` forces Google-only sign-in. There is no per-user password credential and no pending-signup concept beyond the passwordless registration code.

### 5.2 Existing seams reused unchanged

| Seam | Evidence | Reuse |
| --- | --- | --- |
| Browser-bound, encrypted attempt per flow, parent and browser | `lib/auth/emailAttempts.mjs:93` (`attemptKey`), `:157` (`stageSave`), `:266` (`issueChallenge`), `:359` (`checkChallengeCode`), `:388` (`stageChallengeOutcome`), `:398` (`cancelAttempt`) | Pending signup extends this record type; no new store type. |
| `up_browser` proof cookie | `lib/auth/browserBinding.mjs:22` (HttpOnly, SameSite=Strict, service path) | Binds the pending signup and its code to the initiating browser. |
| Serialized setup decision | `lib/setup.mjs:35` (`prepareNewAccount`); lock order parent, then `users`, then persistence scope | The first verified signup claims the administrator. |
| Fail-closed staged commit | `lib/store.mjs:25` (`commitStagedPersistence`), poison at `:33` | Account, role links, setup record, password credential, handoff and tombstone commit in one snapshot. |
| SSO handoff staged with the account and replayed to the same browser | `lib/sso.mjs:51` (`prepareSsoHandoff`), `emailAttempts.mjs:195` (`readCompletion`), `service/ssoWizard.mjs:65` | Automatic sign-in after verification, with lost-response replay. |
| Generation-based revocation | `lib/auth/generation.mjs:10`, `lib/sso.mjs:122` and `:144`, `lib/oidc/adapter.mjs:159` | A password change revokes sessions and OIDC artifacts. |
| Single-use operation grants | `lib/auth/operationGrants.mjs:21`, `:223` | My Account password set and change. |
| Durable throttle record and in-memory budgets | `authThrottle` (`lib/schema.mjs:30`), `emailAttempts.mjs:64` (`consumeMemoryBudget`), `:229` | Password guessing limits. |
| Per-email serialization | `lib/auth/login-attempts.mjs:7` (`withLoginAttemptLock`) | The serialization boundary for password verification and its failure accounting. |
| AES-256-GCM payload protection under the retained settings key | `lib/oidc/secrets.mjs:19`, `:27` | Protects the staged verifier and the stored credential. |
| Google identity resolution, collision proof and mailbox proof | `lib/externalIdentities.mjs:43`, `:62`, `:152`, `:179`; `service/googleAuth.mjs:270` | Kept; the production clause and the administrator proof are removed and a password proof is added. |

### 5.3 PROD-only behavior to remove (A9, D7)

`lib/auth/production.mjs` defines `googleOnlyAuthentication()` (line 3) and `assertLocalAuthenticationAllowed()` (line 7). After this work nothing in UserPersisto reads `PROD`.

| Path and line | Current PROD effect | Required change |
| --- | --- | --- |
| `lib/auth/production.mjs` | Presence switch and local-method guard | Delete the module. |
| `lib/policy.mjs:6`, `:136`, `:146-149`, `:231` | Forces `['google']`, reports `PROD` as an override, treats only Google as usable | Remove; only `USERPERSISTO_AUTH_METHODS` and the stored policy shape the effective list. |
| `lib/auth/signIn.mjs:8`, `:52`, `:79`, `:106` | Refuses discovery and email codes | Remove. |
| `lib/auth/totp.mjs:9`, `:238`, `:266`, `:275`; `lib/auth/passkey.mjs:8`, `:510`, `:552`, `:589` | Refuses TOTP and passkey | Remove. |
| `lib/auth/operationGrants.mjs:15`, `:233` | Only Google-issued grants consumable | Remove the clause. |
| `lib/externalIdentities.mjs:10`, `:66-67` | Authoritative shortcut allowed without the `emailCode` method | Remove the `PROD` alternative (section 11). |
| `lib/auth/wizardConfig.mjs:5`, `:15`; `lib/auth/google.mjs:4`, `:58` | `googleOnly`; `policySource: 'production'` | Remove. |
| `service/ssoWizard.mjs:12`, `:66`, `:78`, `:79`, `:99`; `lib/oidc/http.mjs:18`, `:178`, `:271`; `service/index.mjs:19`, `:118`, `:127` | Replay disabled, local routes refused, email probe skipped, `attempt: null` | Remove. |
| `public/auth/wizard.js:21`, `:193`, `:208`, `:217`, `:223-230`, `:689`, `:692-696` | Google-only rendering and boot branch | Remove. |
| `manifest.json:101-103` | Declares `PROD` | Remove the declaration. |
| `tests/production-auth.test.mjs`, `tests/auth-ui.test.mjs:220-290`, `tests/browser/wizard-flows.mjs:354-495`, `tests/browser/README.md` | Assert Google-only behavior | Replace with parity tests (section 19). |

`USERPERSISTO_DEV_BOOTSTRAP` keeps exactly its current, documented development-only meaning (`lib/email-agent-client.mjs:34`, `lib/auth/emailAttempts.mjs:349`). No new exception of any kind is added.

### 5.4 Administrator password: complete removal (A1, A3, R1, D1)

The shared administrator password disappears as a concept. Nothing is kept as a hidden route, recovery path or re-authentication option.

| Path and line | Removal |
| --- | --- |
| `lib/auth/adminPassword.mjs` | Delete the module: the default `admin`, the `auth.adminPassword.state` verifier and `auth.adminPassword.throttle` settings, production suspension, designated-administrator resolution and the pre-setup creation of the email-less administrator. |
| `lib/auth/password.mjs` | Its only importer is `adminPassword.mjs:5`. Rewrite it in place as the asynchronous account-password KDF primitive (section 7.2). The synchronous functions and the 5 to 1024 rule disappear. |
| `main.mjs:6`, `:84` | Remove the import and the startup synchronization. |
| `service/ssoWizard.mjs:7`, `:35`, `:148-153` | Delete `POST /service/auth/admin/login`. It then answers `404 not_found` like the other retired routes. |
| `lib/oidc/http.mjs:16`, `:27`, `:40`, `:331-337` | Delete `admin-login` from `NATIVE_ACTIONS`, its failure message and its handler. The action then meets the existing `invalid_request` refusal at `:260`. |
| `lib/auth/wizardConfig.mjs:4`, `:24` | Remove the `adminPassword` flag. |
| `lib/auth/operationGrants.mjs:10`, `:22`, `:77`, `:185-186`, `:203-205` | Remove the `adminPassword` re-authentication method. |
| `lib/externalIdentities.mjs:9`, `:18`, `:73`, `:164-165`; `service/googleAuth.mjs:12`, `:26`, `:321`, `:369`, `:378-388` | Remove the administrator-password collision proof, its form, label and verification branch. |
| `lib/policy.mjs:8-9`, `:227`, `:233-236` | Remove `includeAdministratorPassword`, the dynamic import and the header comment. |
| `lib/authorization.mjs:5`, `:87` | Remove the profile method entry. |
| `lib/setup.mjs:7`, `:39`, `:56-57`, `:65`, `:70` | `SETUP_METHODS` becomes `google` and `passwordSignup`; the `contactEmail` and `allowEmptyEmail` parameters of `prepareNewAccount` go, because no caller supplies them. |
| `lib/users.mjs:30-31`, `:83-101`, `:112-115` | Remove `allowEmptyEmail` and the email-less branch (`store.hasUser('')`); every new account has an email. The `contactEmail` field itself stays because contact verification still writes it. |
| `lib/schema.mjs:5-6`, `lib/oidc/provider.mjs:22`, `lib/auth/passkey.mjs:402`, `public/dashboard/main.js:87` | Comments naming the configured-password administrator are corrected. Code that tolerates a missing email is harmless and stays. |
| `public/auth/wizard.js:211-215`, `:232`, `:245-246`, `:555-572`, `:669`; `public/auth/sso-adapter.js:80-82`; `public/auth/oidc-adapter.js:87-89` | Remove the **Admin password** input, `submitAdmin`, administrator error copy, `contactEmail` submission and `adminLogin`. |
| `public/auth/wizard.js:235-239` | Remove the Login/Register switch; the branch comes from discovery (A2). |
| `public/dashboard/enrollment.js:16`, `:110`, `:246`, `:349`, `:354-357`, `:373`; `public/dashboard/main.js:18` | The administrator-password confirmation option is replaced by the account password (section 14). |
| `manifest.json:98-100` | Remove the `USERPERSISTO_ADMIN_PASSWORD` declaration. |
| `tests/auth-password.test.mjs`, `tests/admin-password-restored.test.mjs` | Delete. |
| `tests/helpers/setup.mjs:2`, `:9-30` and every suite using `configureAdministratorPassword`, `clearAdministratorPassword` or `claimAdministrator` (including `registration-http.test.mjs:123`, `wizard-sso-http.test.mjs:225`, `oidc-methods.test.mjs:236`, `:247`, `account-lifecycle-http.test.mjs:171`, `auth-ui.test.mjs:443-522`, `:806`, `runtime-process.test.mjs:190`) | Rewrite on the new fixtures of section 16. |

`password_unsupported` on the provider administration path (`service/index.mjs:206-208`) stays: administrators still cannot set another user's password. My Account contact verification (`lib/auth/contactVerification.mjs`) is deliberately untouched; it applies only to an account without a verified mailbox, which the public flows of this release never create, and removing it is a separate cleanup.

### 5.5 Passwordless wizard behavior that changes

| Current behavior | Evidence | New behavior |
| --- | --- | --- |
| Discovery returns `{ exists, methods: { emailCode, passkey, totp } }` | `lib/auth/signIn.mjs:38-59` | Adds `methods.password`. |
| Login with an existing email opens the method chooser | `wizard.js:278-288`, `:345-370` | Always opens the password screen (D3). |
| Unknown email asks "Create an account?" and sends a registration code directly | `wizard.js:301-316`, `signIn.mjs:64-76` | Sign-up offer, then Password and Confirm password, then the code. |
| A registration code alone creates a passwordless account | `signIn.mjs:122-141` | Removed. `email-code/start` and `email-start` accept only `purpose: 'login'`. |
| `sessionStorage` keeps `{ mode, email }` | `wizard.js:57-70` | Keeps `{ email }` only. |
| Button text **Continue with Google** | `wizard.js:197`, with further occurrences across the wizard and browser tests, `public/auth/google-branding.md`, DS012 and the HTML documentation | **Sign in with Google** (A1, D8); update the branding note, tests and documentation together. |

### 5.6 Historical evidence and reuse limits

The snapshots under `output/account-auth-plan-20260917T090937Z/historical-source/` (state immediately before `9d13afae`) were read as reuse evidence only. Reusable ideas: a dummy hash for unknown users, per-email serialization, and a credential version for link proofs (`lib--auth--password.mjs`). Not reused: `scryptSync` on the event loop, a lockout shared with TOTP, `passwordHash` on the user record, registration without mailbox proof or confirmation, a setup decision based on user count, and routes without parent, origin or browser binding. No historical hash is read, migrated, scrubbed or accepted (D11).

## 6. Target experience

### 6.1 Flow diagram

```text
S1 START:  [Sign in with Google]   Email [________]   [Next]
   | Google                         | Next -> discover(email)
   v                                v
 Google transaction        +--------+---------------------------+
 (linked / collision /     | registered                         | unknown email
  registration, unchanged) v                                    v
   |                 S2 PASSWORD                          S4 SIGN-UP OFFER [Sign up]
   |                 [Password] [Log in]                  (S10 Google only / S11 none open)
   |                 [Try another way] -> S3 METHODS            |
   |                 (submission disabled when                  v
   |                  password sign-in is unavailable)    S5 CREATE PASSWORD
   |                       |             |                [Password][Confirm password][Create account]
   |                       | ok          v                      | verifier staged, code sent
   |                       |       S7 code / S8 passkey         v
   |                       |       / S9 TOTP -> ok        S6 VERIFY EMAIL [Code][Verify]
   |                       v             |                [Resend code][Change email -> S6b][Cancel]
   +-----------------> SIGNED IN <-------+                (send failed: [Send again], same staged password)
                       Router callback or OIDC                  | correct code
                       interactionFinished; capability          v
                       routing decides Explorer or        account + password + role + setup record
                       My Account  <------------------------ commit, then automatic sign-in
 Any screen: parent expiry -> S13.   Late same-email account -> S12 -> S2.
```

### 6.2 Screens

All screens keep the existing structural rules: one focused `h1`, every input has an associated label, errors use `role="alert"`, every transition bumps the wizard epoch so late responses are ignored, and code and password inputs are emptied by every transition. The remaining-time indicator stays on every screen except S13 and S14. Password inputs carry no `maxlength` attribute, because HTML measures it in UTF-16 code units and browsers silently truncate pasted text; limits are validated explicitly instead (section 7.3).

| ID | Wizard `screen` | Shown when | Content and fields (top to bottom) | Primary action | Secondary actions | Back or Cancel |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | `loading` | Boot, leaving a code screen | Heading only | None | None | None |
| S1 | `start` | Default entry | Heading **Sign in** (OIDC with `screen_hint=signup`: **Create your account**); first-run notice when setup is unclaimed; OIDC "Continue to *application*"; Google notice if any; **Sign in with Google** (rendered only when Google is usable); **Email** (`type=email`, `autocomplete=email`, required); **Next**; inline error | **Next** runs discovery | Google button | OIDC only: **Cancel** submits the `abort` form. No password field, no administrator control, no Login/Register switch. |
| S2 | `password` | Discovery reports a registered account, always | Heading **Enter your password**; read-only email (`autocomplete=username`); **Password** (`type=password`, `autocomplete=current-password`, paste allowed); inline error. When password sign-in is unavailable the input and **Log in** are disabled and one neutral line explains it: "Password sign-in is not available in this workspace." when public policy disables the method, otherwise "Password sign-in is not available for this account here. Choose Try another way." Focus then lands on **Try another way**. Nothing mentions blocking or Google. | **Log in** | **Try another way** opens S3 | **Back** returns to S1 with the email kept |
| S3 | `methods` | **Try another way** | Heading **Try another way**; always the same three entries in this order: **Email me a code**, **Use a passkey**, **Use an authenticator app**. Usable entries are buttons. Unusable entries are disabled with one reason line: "Not available in this workspace." when public policy or configuration disables the method; "Not available in this browser or at this address." when the browser lacks WebAuthn or a secure context; otherwise the generic "Not available for this account." A static line says that sign-in methods are managed from My Account after signing in. When nothing is usable: "If this account uses Google, go back and choose Sign in with Google. Otherwise contact your workspace administrator." | The chosen method | **Use your password** returns to S2 | **Back** to S1 |
| S4 | `signupOffer` | Unknown email and email signup is available | Heading **Create an account?**; "No account uses *email*." | **Sign up** opens S5 | None | **Back** to S1 |
| S5 | `signupPassword` | **Sign up** | Heading **Create your password**; read-only email; **Password** and **Confirm password** (`autocomplete=new-password`); hint "Use at least 15 characters."; inline errors | **Create account** stages the signup and sends the code | None | **Back** to S1 (nothing was staged) |
| S6 | `signupCode` | A signup is staged, or reload with a pending signup | Heading **Enter the 6-digit code sent to *email***; an honest delivery line; text that the account is created only after verification; **Code** (`inputmode=numeric`, `autocomplete=one-time-code`, `maxlength=6`). Send-failed state (delivery `failed` or `pending`, section 6.6): the heading becomes **We could not send the code**, the code input and **Verify** are disabled, the text says the chosen password is kept for this sign-up, and **Send again** is enabled immediately. | **Verify** (or **Send again** in the send-failed state) | **Resend code** with cooldown counter, **Change email** opens S6b | **Cancel** cancels the server attempt, discards the staged verifier and returns to S1 |
| S6b | `signupEmail` | **Change email** | Heading **Change your email**; **Email** prefilled with the pending address; text that the chosen password is kept | **Send code** re-issues for the new address without asking for the password | None | **Back** returns to S6 unchanged |
| S7 | `code` | Email code chosen in S3 | Existing login code screen | **Verify** | **Resend**, **Try another way** returns to S3 and cancels the code | **Cancel** cancels and returns to S1 |
| S8 | `passkey` | Passkey chosen | Existing passkey screen | Browser prompt | **Try again** | **Back** to S3 |
| S9 | `totp` | TOTP chosen | Existing authenticator screen | **Verify** | None | **Back** to S3 |
| S10 | `googleRegistration` | Unknown email, email signup unavailable, Google signup available | Existing text, with **Sign in with Google** | Google | None | **Back** to S1 |
| S11 | `noAccount` | Unknown email and no signup path is open | "No account uses *email*." and, when registration is disabled, "Registration is not available." | None | None | **Back** to S1 |
| S12 | `collision` | `account_exists` at signup start, at an email change, or late at verification | "An account already uses *email*. Log in instead." | **Log in** re-runs discovery and opens S2 | None | **Back** to S1 |
| S13 | `expired` | Parent deadline reached or the server reports an expiry code | Existing text | SSO: **Start again** to `/auth/login?returnTo=…&prompt=login`. OIDC: **Close window**. | None | None |
| S14 | `completing` | A completion was accepted | "Signing you in…" | None | None | None |

### 6.3 Transitions

| From | Event | Server call and guard | To |
| --- | --- | --- | --- |
| S1 | **Next** with an empty or syntactically invalid email | None | S1 with `invalid_email` copy, focus on Email |
| S1 | **Next** | `discover(email)`; spends discovery budgets | S2 when `exists`; S4 when `!exists && signup.email`; S10 when `!exists && !signup.email && signup.google`; S11 otherwise |
| S1 | Google button | `startGoogle()`; a stale start is cancelled with `cancelGoogle` | Dedicated Google page; success leaves the wizard |
| S2 | **Log in** with an empty password | None | S2, "Enter your password." |
| S2 | **Log in** | `passwordLogin({ email, password })`; the value is captured and the input emptied before the request is sent | S14 on success; S2 with neutral error on `authentication_failed`; S2 with wait copy on `rate_limited`; S13 on expiry codes |
| S2 | **Try another way** | None (reuses the discovery result) | S3 |
| S3 | Email me a code | `startEmail({ email, purpose: 'login' })` | S7, or S3 with an inline error |
| S3 | Use a passkey or authenticator | Existing calls | S8 or S9 |
| S4 | **Sign up** | None | S5 |
| S5 | **Create account** with values that differ after normalization | None; the server repeats the check | S5, "The passwords do not match.", Confirm emptied and focused |
| S5 | **Create account** violating the creation policy | Client check with the server-supplied numbers; server `invalid_password` with a reason | S5 with the matching copy |
| S5 | **Create account** | `startSignup({ email, password, passwordConfirmation })`; inputs disabled while in flight and emptied when the response arrives | S6 when staging succeeded with delivery `accepted`, `unknown` or `development-log`; S6 send-failed state when staging succeeded with delivery `failed`; S12 on `account_exists`; S1 with copy on `registration_disabled`; S5 with copy on any other failure before staging (the password must be entered again because nothing was kept) |
| S6 | **Verify** | `verifySignup(code)` | S14 on success; S6 with attempts remaining on `code_invalid`; locked S6 with **Start over** on `too_many_attempts`; S12 on `account_exists`; S1 with copy on `registration_disabled` |
| S6 | **Resend code** or **Send again** | `resendSignup()`; cooldown of 60 seconds except after a failed or interrupted delivery; at most five sends per attempt | S6 or its send-failed state according to the new delivery outcome; every earlier code is invalid; the staged verifier is kept |
| S6 | **Change email** | None | S6b |
| S6b | **Send code** | `changeSignupEmail(email)`; the staged verifier is kept | S6 or its send-failed state for the new address; S12 on `account_exists`; S5 on `signup_restart_required` |
| S6, S7 | **Cancel** | `cancel()` erases challenge, email, purpose and the staged verifier; counters survive | S1 |
| S7 | **Try another way** | `cancel()` | S3 |
| Any | Expiry tick, or `attempt_expired`, `login_request_expired`, `login_request_invalid` | None | S13 |
| S12 | **Log in** | `discover(email)` | S2 |

### 6.4 Validation and error copy

Server codes stay machine-readable; the wizard owns the wording. Passwords are never echoed, stored in browser storage or placed in a URL.

| Code | HTTP | Where | Wizard copy |
| --- | --- | --- | --- |
| `invalid_email` | 400 | S1, S6b | Enter a valid email address. |
| (client) empty password | none | S2 | Enter your password. |
| `password_mismatch` | 400 | S5, My Account | The passwords do not match. |
| `invalid_password`, `reason: too_short` | 400 | S5, My Account | Use at least 15 characters. |
| `invalid_password`, `reason: too_long` | 400 | S5, My Account | Use at most 128 characters. |
| `invalid_password`, `reason: invalid_characters` | 400 | S5, My Account | Remove control characters or unsupported symbols from the password. |
| `invalid_password`, `reason: equals_email` or `too_common` | 400 | S5, My Account | Choose a password that is harder to guess. |
| `authentication_failed` | 401 | S2 | That password is not correct. Try again or choose another way to sign in. |
| `rate_limited`, `resend_too_soon` | 429 with `retryAfter` | Any | Too many attempts. Wait *n* s and try again. |
| `rate_limited`, `reason: send_limit` | 429 | S6, S6b | Too many codes were requested. Start again. (SSO offers **Start again**; OIDC says to restart from the application.) |
| `account_exists` | 409 | S5, S6, S6b | Opens S12 |
| `registration_disabled` | 403 | S5, S6 | Registration is not available. |
| `auth_method_disabled` | 404 | Any method | This sign-in method is not available. |
| `code_invalid` with `attemptsRemaining` | 400 | S6, S7 | That code is not correct. *n* attempts left. |
| `code_expired` | 410 | S6, S7 | That code expired. Request a new code. |
| `too_many_attempts` | 429 | S6, S7 | Too many incorrect codes. Start over. |
| `signup_restart_required` | 409 | S6, S6b | Choose your password again to continue. (returns to S5 with the email kept) |
| `attempt_invalid` | 400 or 409 | Any | This sign-in attempt is no longer available. Start over. |
| `delivery_failed` | 502 | S7 only (login codes keep their current contract) | We could not send the code. Try again later. |
| Origin and topology codes | unchanged | Any | Existing fixed wording |

A wrong password never reveals remaining guesses, whether the account is blocked, or whether it has a password. Blocked accounts, accounts without a password credential and unknown emails submitted directly to the endpoint return the same `authentication_failed` after the same KDF work.

### 6.5 SSO and OIDC differences

| Aspect | Router SSO (`sso-adapter.js`) | OIDC interaction (`oidc-adapter.js`) |
| --- | --- | --- |
| Parent | `ssoLoginRequest`, five minutes (`lib/sso.mjs:10`); lock `sso-request:<id>` | Engine interaction, ten minutes (`lib/oidc/provider.mjs:81`); lock `oidc-interaction:<uid>` |
| Preparatory calls (discover, signup start, resend, change email, email start, passkey options) | Same-origin JSON POST | Form-encoded fetch carrying the interaction CSRF token |
| Credential completions (password login, signup verify, email verify, TOTP, passkey verify) | JSON POST returning `{ code, redirectUri, state }`; the wizard navigates to the Router callback | Native form POST ending in `interactionFinished`; failure re-renders the shell with status 400, a readable error, the attempted email and no secret |
| Completion marker | Single-use handoff code, generation-bound, two minutes | `login: { accountId, authGeneration, amr }`; password login `amr: ['pwd']`; verified signup `amr: ['emailCode']`, the proof presented at completion |
| Persistence at signup completion | One commit contains the account and the handoff | Two boundaries: the local commit, then the engine's interaction result (section 8.6) |
| Application consent | Not applicable | Always a separate explicit step; sign-up and login never approve scopes |
| Cancel on S1 | Not shown | `abort` form |
| Expired | **Start again** | **Close window** |
| `screen_hint=signup` | Not applicable | Changes only the S1 heading; the flow and every server rule are identical |

### 6.6 Delivery states on the verification screen (R6)

The signup operations answer `200` with the public challenge whenever a verifier was durably staged, whatever the delivery outcome; they answer with an error status only when nothing was staged. This differs deliberately from the login code operation, which keeps its `502 delivery_failed` contract.

| `challenge.delivery` | Meaning | Screen | Code accepted | Next send |
| --- | --- | --- | --- | --- |
| `accepted` | The provider accepted the message | S6, "We sent a code to *email*." | Yes | After the 60 second cooldown |
| `unknown` | The transport errored; the message may have been sent | S6, "We tried to send a code to *email*. If it does not arrive, request a new one." | Yes | After the cooldown |
| `development-log` | Development log delivery under the existing `USERPERSISTO_DEV_BOOTSTRAP=true` rule | S6, development copy | Yes | After the cooldown |
| `failed` | Known provider failure after staging | S6 send-failed state | No | Immediately |
| `pending` | Observed by a later request: the delivering request ended without recording an outcome (process stop). Operations for one parent are serialized by the parent lock, so a later request can never observe a delivery that is still in flight. | S6 send-failed state | No | Immediately |

### 6.7 Reload, resume, tabs, Google return and expiry

| Situation | Behavior |
| --- | --- |
| Reload during S6 | `attempt()` reports the challenge with `purpose: 'register'` and `signupPending: true`; the wizard resumes S6 in the state given by its delivery value. If the code expired but the parent is alive, S6 opens with the expiry copy and **Resend code** enabled. The password is never requested again while the staging exists. |
| Reload during S2 or S5 | Returns to S1 with the stored email. Nothing sensitive was stored. |
| UserPersisto restart during a pending signup | The attempt is durable and encrypted; S6 resumes. In-memory budgets reset as today; durable budgets persist. |
| Two tabs on the same parent | They share one attempt. A signup start, resend or email change in one tab issues a new generation and invalidates the other tab's code. A reload of the older tab resumes the current server state. |
| Different parents or browsers, same email | Independent attempts. The first verified completion wins under the `users` lock; the other receives `account_exists`, its staged verifier is erased, and S12 opens. |
| A code from another person's pending signup | Refused: the code hash is keyed by the attempt (flow, parent, browser proof), its generation and the staged verifier ID. It can neither complete the mailbox owner's attempt nor activate the other person's password. |
| Google denied, cancelled or unavailable | Returns to S1 with the existing notice. Leaving S6 always cancels the server attempt, so no pending signup is normally alive when Google starts. |
| Google completes first for the same email | The later signup verification receives `account_exists`. |
| Parent deadlines (D10) | Unchanged: five minutes for SSO, ten for OIDC; a code lives `min(5 minutes, parent deadline)`. The attempt record, challenge and staged verifier share `expiresAt = parent.expiresAt`; nothing survives the parent. The wizard shows the authoritative remaining time and moves to S13 at the deadline. After SSO **Start again** the password is chosen again. |
| Lost response after a successful SSO signup verification | The same browser replays its own unconsumed handoff through `attempt` or `signup/verify`. |
| Lost redirect after a successful OIDC completion | Section 8.6. |

## 7. Account password credential

### 7.1 Schema ownership (RESOLVED)

The credential is an `authMethod` record owned by a new module `lib/auth/userPassword.mjs`. No new Persisto type, index or grouping is needed: `authMethod` already has the unique `key` index and the `authMethods` grouping by `userId` (`lib/schema.mjs:12`, `:39`, `:64`).

| Field | Value |
| --- | --- |
| `key` | `<userId>:password` (one password per account) |
| `userId`, `type`, `enabled` | Immutable local ID, `password`, `true` |
| `credential.hashEncrypted` | `encryptOidcPayload({ hash }, 'userpersisto:password:v1:<userId>')`, where `hash` is the self-describing scrypt string. AES-256-GCM under the retained settings key; the authenticated context binds the record to its owner. |
| `credential.version` | 16 random bytes, hex; rotates only when the password changes |
| `credential.setAt` | ISO timestamp of the last change |

The `user.passwordHash` field of releases before `9d13afae` is never read or written; `sanitizeUser` keeps stripping the name (`lib/users.mjs:9`) as defense in depth. `lib/auth/credentialVersion.mjs` gains a `password` branch whose material is `[credential.version, credential.setAt]`.

### 7.2 Hashing (RESOLVED, D5)

| Topic | Choice |
| --- | --- |
| Algorithm and format | Native `node:crypto` scrypt, no new package. `scrypt$N$r$p$salt$hash` with a 16-byte random salt and a 64-byte key. |
| Single supported profile | `N = 32768, r = 8, p = 3`, with an explicit `maxmem` of 64 MiB because the requirement equals Node's 32 MiB default. The profile is one of the equivalent scrypt configurations in OWASP's password-storage guidance; that table was not fetched during planning, so the implementer confirms it against the published list and, if it differs, uses the listed configuration with the smallest memory requirement. |
| Verification | A stored string must parse to exactly the supported profile with the expected salt and key lengths; anything else fails closed as an unsupported verifier. There is no legacy profile, no rehash path and no compatibility reader. The self-describing format lets a future change add a profile deliberately. |
| Execution | Promisified `crypto.scrypt`, never `scryptSync`, and never inside the process-wide persistence scope (`lib/persistence-scope.mjs`) or the `users` lock, which would stall every store access. Comparison uses `timingSafeEqual`. |
| Bounded concurrency | A gate inside `lib/auth/password.mjs`: at most two KDF operations in flight, at most 16 queued, a five second wait limit, then `rate_limited` with `retryAfter: 5`. A saturated gate never counts as a failed guess. |
| Timing | The measured time per hash on the Ploinky Node image is recorded in the change as a performance measurement. It is not a gate: the work factor is never lowered to meet a latency number. If latency is operationally unacceptable, only the concurrency and queue bounds change. |
| Test seams | `setKdfProfileForTests`, `setKdfObserverForTests` and `resetKdfForTests`, in the style of `setStoreFaultInjectorForTests` (`lib/store.mjs:14`). No request or environment variable can select a profile. At least one test runs the real profile and asserts the stored format. |

### 7.3 Input policy (RESOLVED, R7, D5)

One function, `normalizeSecret(raw)`, serves creation and login: it requires a string, bounds the raw input, requires well-formed UTF-16 (`isWellFormed()`), then applies `normalize('NFKC')`. The wizard applies the same rules with the numbers it receives in `passwordPolicy` (section 9.4); the server is authoritative.

| Rule | Creating a password (signup, My Account) | Presenting a password (login, re-authentication, Google link proof) |
| --- | --- | --- |
| Raw input | 1 to 1024 UTF-16 code units; longer input is refused with `invalid_password` (`too_long`), never truncated | 1 to 1024 UTF-16 code units; otherwise `authentication_failed` without a KDF and without spending a failure budget |
| Encoding (R10) | The raw string must be well-formed UTF-16 (`isWellFormed()`), otherwise `invalid_password` (`invalid_characters`) | The same requirement. A candidate with an unpaired surrogate receives the neutral `authentication_failed` without a KDF and without spending a failure budget. Node replaces a lone surrogate with U+FFFD when it encodes the string as UTF-8 for the KDF, so an unchecked malformed candidate could match a legitimate password that contains a literal U+FFFD. This is encoding validation, not a creation-strength rule, and it never reapplies the minimum length at login. |
| Control characters | No control characters (`\p{Cc}`), otherwise `invalid_password` (`invalid_characters`) | Not applied; this is a creation rule |
| Normalization | NFKC | NFKC, the same function |
| Length | 15 to 128 Unicode code points after normalization (`[...normalized].length`) | Not enforced. There is no minimum and no creation maximum, so a later tightening of the creation policy never rejects a previously valid password. Only a fixed resource bound applies: at most 4096 UTF-8 bytes after normalization, otherwise `authentication_failed` without a KDF. |
| Confirmation | `NFKC(password) === NFKC(confirmation)` in the wizard and again on the server | Not applicable |
| Content | Not equal to the email (case-insensitive), not one repeated code point, not in the small frozen list `lib/auth/commonPasswords.mjs` | Not applicable |
| Stored verifier | Not applicable | Must be the supported profile (section 7.2) |

Anything accepted at creation satisfies the presentation rules, because the raw bound and the encoding requirement are identical and 128 code points never exceed 512 UTF-8 bytes. NFKC maps a well-formed string to a well-formed string, so the encoding check on the raw input also covers the normalized value that reaches the KDF. Characters of every class are allowed, there are no composition rules and no periodic expiry, and paste and credential managers work. The 15-character minimum follows the review's reading of OWASP guidance for passwords without mandatory MFA. The wizard uses `isWellFormed` where the browser provides it and otherwise leaves that rule to the server. One documented limitation: after **Change email** the "equals the email" rule cannot be re-evaluated for the new address, because no plaintext exists; the length, character and common-password rules were already applied.

### 7.4 Password verification order (RESOLVED, R3)

`loginWithUserPassword({ parent, email, password, rateSource, validateParent })` and `verifyAccountPassword({ userId, password, rateSource }, { includeCredentialProof })` share one implementation. Lock order is parent, then the per-email login lock, then `users`, then the persistence scope, which matches the existing TOTP path (`lib/auth/totp.mjs:268`).

| Step | Boundary | Action |
| --- | --- | --- |
| 1 | None | Transport and encoding validation: types, the email bound, and the presentation bounds and well-formed encoding of section 7.3. A refusal here is the neutral `authentication_failed`, runs no KDF and spends no failure budget. |
| 2 | None | Source admission: `consumeMemoryBudget('password-source', …)`. The consume is synchronous, so check and spend are atomic on the event loop. Admission may stay outside the lock. |
| 3 | None | Bounded queue: a per-email waiter counter admits at most four requests waiting or running for one address, and at most 64 across all addresses. Excess requests receive `rate_limited` with a short `retryAfter` at once, run no KDF and spend no failure budget. |
| 4 | Per-email lock | Acquire `withLoginAttemptLock(normalizedEmail)`. |
| 5 | Inside the lock, immediately before the KDF | Recheck the live parent (`validateParent`), the effective policy (`password` enabled) and the per-email failure budget (section 7.5). An exhausted budget returns `rate_limited` with `retryAfter`; no KDF runs. For an address without an account the in-memory budget is consumed here, because such an attempt is necessarily a failure. |
| 6 | Inside the lock, outside every store lock | Read the account and credential in a short persistence scope. Select the stored verifier only for an active account with an enabled credential of the supported profile; otherwise the process-wide dummy verifier. Run the KDF through the gate and compare. |
| 7 | Inside the lock, then `serializePersisted('users')` | Re-read the account and credential; require the same `credential.version`, an active account and an unchanged `authGeneration`. On failure, stage the durable failure count and a denied audit in one commit, then throw `authentication_failed`. On success, clear the count and stage an ok audit. |
| 8 | After the function returns | The adapter issues the completion: SSO through `issueAuthCodeLocked` with the verified generation (the pattern at `service/ssoWizard.mjs:146`); OIDC through `finish({ login })`, which rechecks status and generation under the persistence scope. |

Because the budget is rechecked and the failure recorded inside one serialization boundary, a burst can never obtain more evaluations than the limit: every request that runs after the limit was reached observes it in step 5 and leaves before the KDF. Password login stages no attempt tombstone and offers no lost-response replay; a user whose response was lost starts again, as for TOTP and passkey today.

### 7.5 Guessing limits and bounded work (RESOLVED)

| Control | Scope and durability | Limit | Behavior |
| --- | --- | --- | --- |
| Per-email failure budget, account exists | Durable `authThrottle` record keyed by `sha256(['userpersisto:throttle:password-login', email])`; survives restart | 10 failures per 15 minutes; cleared on success | Checked and recorded inside the per-email lock (section 7.4) |
| Per-email failure budget, no account | In-memory | Same numbers | Same client-visible behavior, without durable writes for invented addresses |
| Per-source attempt budget | In-memory, keyed by the Router's trusted `x-ploinky-rate-source` (`lib/auth/browserBinding.mjs:45`); requests without it, including OIDC public-protocol requests, share one bucket | 20 attempts per source and 300 shared per 15 minutes | `rate_limited` |
| Per-email waiters and global waiters | Process | 4 and 64 | `rate_limited`, no KDF, no failure recorded |
| Signup KDF budget | In-memory, per source, consumed before hashing | 10 per source and 100 shared per 15 minutes | `rate_limited` |
| My Account KDF budget | In-memory, per account, consumed before hashing | 5 per 15 minutes | `rate_limited` |
| KDF gate | Process | Section 7.2 | `rate_limited` |
| Existing TOTP lockout counters on the user record | Unchanged | Unchanged | Password failures never touch them, so password guessing cannot lock TOTP sign-in. |

A distributed attacker can keep one address's password login throttled; the account's other methods and Google remain usable. The durable-throttle helpers currently private to `emailAttempts.mjs` (`readThrottle`, `stageEmailFailure`) move to `lib/auth/throttle.mjs` without behavior change so both callers share them.

### 7.6 Security audit

All events go through `recordAudit` with `{ save: false }` inside the owning commit: `auth.password.register`, `auth.password.login` (ok, and denied with the fixed reason `invalid_credentials`), `auth.password.set`, `auth.password.change`. Audit never contains a password, a verifier, a code or a plain email for an unknown address. Denied logins for addresses without an account are not persisted, so invented emails cannot force snapshot rewrites.

### 7.7 Secret handling

A password exists in memory only for the request that carries it. It is never logged (including under `ACHILLES_DEBUG`), returned, written to browser storage, sent through MCP tools or accepted by administrative endpoints. The durable forms are the encrypted scrypt string in the credential and, for at most the parent lifetime, the scrypt string inside the encrypted attempt payload. Tests assert that neither the snapshot nor captured logs contain the plaintext.

## 8. Pending signup lifecycle

### 8.1 One attempt format (RESOLVED, R5)

The version, the lookup namespace and the authenticated-encryption context are defined together and change together. Today all three carry the old version (`emailAttempts.mjs:16`, `:94`, `:98`).

| Element | Value |
| --- | --- |
| `ATTEMPT_VERSION` | `2` |
| Lookup key | `sha256(JSON.stringify(['userpersisto:auth-attempt:v2', flow, parentId, sha256(browserProof)]))` |
| Encryption context | `userpersisto:auth-attempt:2:<attemptKey>` with `encryptOidcPayload` |
| Record | `{ attemptKey, status, expiresAt, version: 2, payload }` |
| Payload | `{ flow, parentId, email, purpose, generation, failures, sends, challenge, account, signup, completion, status }` with `signup: { verifier, verifierId, stagedAt }` or `null`, where `verifier` is the scrypt string and `verifierId` is 16 random bytes |
| Code binding | `hashCode(code, '<attemptKey>:<generation>:<binding>')`, where `binding` is the `verifierId` for a registration and the literal `login` for a login code |

There is exactly one reader. A record whose version is not 2, whose key does not match, or that does not decrypt under this context is refused with `attempt_invalid`. Records of any other format live under a different lookup key, so they are never found, never decrypted and never converted; the existing sweep removes them by `expiresAt` without decoding (`emailAttempts.mjs:116`). `readCompletion` uses the same namespace.

### 8.2 What typing, submitting or requesting a code never does

Entering an email, choosing a password or requesting a code creates no `user`, no role link, no `installation.setup` record, no email reservation, no `authMethod`, no session, no handoff code and no OIDC result. Another browser may start a signup for the same address, Google may register it, and nothing is blocked. Only the locked completion in section 8.6 creates anything.

### 8.3 Binding

A registration code verifies only when all of the following still hold, each rechecked at completion: the same flow and live parent, the same browser proof, the same normalized email, the current generation, and the same staged verifier ID.

### 8.4 Invalidation and delivery outcomes (R6)

| Event | Generation | Challenge | Staged verifier | Counters |
| --- | --- | --- | --- | --- |
| Signup start, or a new start with another password | New | New code | Replaced, new `verifierId` | Kept; `sends` incremented |
| **Resend code** or **Send again** | New | New code; every earlier code invalid; cooldown applies except after `failed` or `pending` | Kept | `sends` incremented |
| **Change email** | New | New code bound to the new address; the old address's code invalid | Kept, so the password is not requested again | `sends` incremented |
| Delivery `failed`, `unknown` or interrupted | Unchanged | Kept with its delivery value | Kept | Unchanged; the send already counted |
| Purpose changes to `login` | New | Replaced | Erased | Kept |
| **Cancel**, **Back** from S6, leaving for S1 | Unchanged | Erased | Erased | Kept |
| Five wrong codes | Unchanged | Erased; attempt locked until the parent expires | Erased | Kept |
| Verified completion | Tombstone | Erased | Erased | Kept |
| Late collision or policy refusal at completion | Unchanged | Erased | Erased | Kept |
| Parent expiry | Record removed on lookup or by the bounded sweep | Gone | Gone | Gone |

Every issued challenge counts toward the five sends per attempt and the per-address and per-source send budgets, whatever its delivery outcome. Retries are therefore bounded by those budgets and by the parent deadline, and the failure counter is never reset by a resend.

### 8.5 Signup start order and failure classification (R6)

| Step | Action |
| --- | --- |
| 1 | Transport validation, then confirmation equality and the creation policy (section 7.3). Cheap refusals come first. |
| 2 | Validate the live parent. |
| 3 | Read-only precheck: `password` enabled, registration open (unclaimed setup or `selfRegistrationEnabled`), email delivery available, the address unowned, the attempt neither locked nor completed. |
| 4 | Consume the per-source signup KDF budget, then hash through the gate, outside every store lock. |
| 5 | `issueChallenge` with the staging: the authoritative rechecks, the send budgets and the durable staging happen under the persistence scope. The challenge is stored with delivery `pending`. |
| 6 | Deliver outside the store locks with `purpose: 'signup-verification'` (section 9.6), then `recordDelivery`. |
| 7 | Answer `200` with the public challenge, whatever the delivery outcome. |

| Phase of failure | Examples | Durable state | Response | Wizard |
| --- | --- | --- | --- | --- |
| Before staging | Validation, `account_exists`, `registration_disabled`, `auth_method_disabled`, budgets, a saturated KDF gate, `persistence_unavailable` | None | Error status | S5, S12 or S1; the password is entered again because nothing was kept |
| After staging, known delivery failure | Provider rejection | Verifier and challenge with `failed` | `200` | S6 send-failed state; **Send again** at once |
| After staging, unknown outcome | Transport error | `unknown` | `200` | S6; the code is accepted if it arrives |
| After staging, interrupted | Process stop before the outcome was recorded | `pending` | None reached the browser | Reload opens the S6 send-failed state |
| Staging no longer exists | Cancel, five wrong codes, purpose change | None | `signup_restart_required` 409 | S5 with the email kept |
| Generation superseded during delivery | Another tab acted | The newer generation | `attempt_invalid` 409 | Reload resumes the current state |
| Parent expired | Deadline | Removed | Expiry codes | S13 |

A retry never resubmits the plaintext password and never persists it: **Send again**, **Resend code** and **Change email** carry no password field, and exactly one KDF runs per chosen password.

### 8.6 Completion and persistence boundaries (R8)

`completeSignup({ parent, browserProof, code, validateParent, prepareHandoff })` runs under `serializePersisted('users')` inside the adapter's parent lock.

| Order | Step |
| --- | --- |
| 1 | `validateParent()`; `checkChallengeCode` with the verifier-bound context. A completed attempt takes the existing replay branch. |
| 2 | Recheck policy (`password` enabled) and registration availability. A refusal consumes the proof and erases the verifier. |
| 3 | Recheck uniqueness. An existing owner yields `account_exists`; the registration proof never authenticates or modifies that account, and the verifier is erased. |
| 4 | `prepareNewAccount({ email, emailVerified: true, method: 'passwordSignup' })`. Unclaimed gives `admin` and stages `installation.setup` with `method: 'passwordSignup'`; claimed requires `selfRegistrationEnabled` and gives exactly `selfRegistered`. |
| 5 | `prepareHandoff()` for SSO. |
| 6 | One `commitStagedPersistence`: the user, role links, the setup record when first, the password credential (the staged scrypt string wrapped for its owner), the completion tombstone without the verifier, the audit event, and for SSO the handoff code with the consumed login request. |
| 7 | SSO returns the handoff. OIDC calls `finish({ login })`. The user is signed in without another prompt (A6). |

SSO has one persistence boundary: account and handoff are the same commit, and a lost response is replayed to the same browser and parent only. OIDC has two boundaries and must not be described as one atomic commit with the engine response. The first is the local commit of step 6. The second is `finish()`, where the engine persists the interaction result through the OIDC adapter under the persistence scope and answers with the redirect (`lib/oidc/http.mjs:232-244`). A stop between them leaves a complete active account and a completed attempt but no interaction result. Recovery is same-browser: a repeated `signup-verify` reaches the completed branch of `checkChallengeCode`, the account's status and generation are rechecked, and `finish` runs again; after the second boundary a GET on the interaction follows the committed result (`lib/oidc/http.mjs:182-188`). Otherwise the user simply logs in with the chosen password.

A failure while staging poisons the store (`lib/store.mjs:33`), so no partial owner, credential or setup record can be published by a later flush, and a restart reopens the last valid snapshot. A failure after the rename but before the directory fsync may leave the complete, unacknowledged account; a fresh attempt then sees `account_exists` and the user logs in. A failed downstream handoff never reissues a consumed result.

### 8.7 Concurrency

Concurrent completions for one address, concurrent first completions by password signup and Google, and concurrent role or status changes all meet at the `users` lock. Exactly one administrator is created on an unclaimed installation; every loser re-reads the committed setup record and takes the ordinary path or fails with `account_exists` or `registration_disabled`.

## 9. Interfaces

### 9.1 Domain functions

| Module and function | Contract |
| --- | --- |
| `lib/auth/signIn.mjs` `discoverAccount` | Returns `{ exists, methods: { password, emailCode, passkey, totp } }` and nothing else. `exists` is true for any record owning the address. `methods.password` is true only for an active account with an enabled credential while policy allows `password`. A blocked account reports every method false, exactly as today; no field distinguishes a missing enrollment from blocked status, and Google linkage, roles, identifiers, counts and timestamps are never exposed. Pending signups are invisible. Discovery is advisory and never authority. |
| `lib/auth/signIn.mjs` `startEmailSignIn`, `completeEmailSignIn` | Login only. `purpose: 'register'` is `invalid_request`, and the registration branch (`:122-141`) is removed. |
| `lib/auth/signup.mjs` (new) | `startSignup`, `resendSignup`, `changeSignupEmail`, `completeSignup` as in section 8. |
| `lib/auth/emailAttempts.mjs` | The format of section 8.1. `issueChallenge` accepts a new `signup` staging or retains the existing one for resend and email change, skips the cooldown after a `failed` or `pending` delivery, and throws `signup_restart_required` when a registration has no staged verifier. `publicChallenge` reports `resendAt = now` for `failed` and `pending`. `describeAttempt` adds `signupPending`. `stageChallengeOutcome` and `cancelAttempt` always erase `signup`. `deliverCode` forwards an optional `purpose`. |
| `lib/auth/password.mjs` (rewritten) | `hashSecret`, `verifySecret`, the KDF gate and the test seams of section 7.2. |
| `lib/auth/userPassword.mjs` (new) | `PASSWORD_POLICY`, `normalizeSecret`, `validateNewPassword`, `stagePasswordCredential`, `readPasswordCredential`, `loginWithUserPassword`, `verifyAccountPassword`, `assertPasswordProof`. |
| `lib/auth/throttle.mjs` (new) | Durable throttle helpers shared with `emailAttempts.mjs`. |
| `lib/auth/wizardConfig.mjs` | Section 9.4. |
| `lib/policy.mjs` | Section 10. |

### 9.2 Router SSO HTTP surface

All routes are `POST` under `/service/auth/`, are listed in `ROUTES` (`service/ssoWizard.mjs:26`), require a JSON object body (`invalid_json` otherwise; 64 KiB, `service/index.mjs:46`), pass `assertSameOrigin`, require `requestId`, run inside `serialize('sso-request:<requestId>')` and validate the live parent first. The manifest's guest wildcard `…/service/auth/*` already admits them; guest admission grants no authority. Errors keep the shape `{ ok: false, error, retryAfter?, attemptsRemaining?, reason? }`. The email-availability probe list at `service/ssoWizard.mjs:79` gains the three signup routes that send mail.

| Route | Request body | Success response | Notable errors |
| --- | --- | --- | --- |
| `attempt` | `{ requestId, state }` | `{ ok, expiresAt, …wizardConfiguration, attempt }`; sets `up_browser` | Parent errors; lost-response replay returns `{ completed: true, handoff }` |
| `discover` | `{ requestId, email }` | `{ ok, exists, methods }` | `invalid_email`, `rate_limited` |
| `password/login` (new) | `{ requestId, state, email, password }` | `{ ok, code, redirectUri, state }` | `authentication_failed` 401, `rate_limited` 429, `auth_method_disabled` 404 |
| `signup/start` (new) | `{ requestId, email, password, passwordConfirmation }` | `{ ok, challenge }` for every delivery outcome once staged; sets `up_browser` | Before staging only: `invalid_email`, `password_mismatch`, `invalid_password`, `account_exists` 409, `registration_disabled` 403, `auth_method_disabled` 404, `rate_limited` 429 |
| `signup/resend` (new) | `{ requestId }` | `{ ok, challenge }` | `resend_too_soon`, `rate_limited` (with `reason: send_limit` at the cap), `signup_restart_required` 409, `attempt_invalid` |
| `signup/email` (new) | `{ requestId, email }` | `{ ok, challenge }` | `invalid_email`, `account_exists`, `signup_restart_required`, `rate_limited` |
| `signup/verify` (new) | `{ requestId, state, code }` | `{ ok, code, redirectUri, state, created: true, initialAdministrator }` or `{ …, replayed: true }` | `code_invalid`, `code_expired`, `too_many_attempts`, `account_exists`, `registration_disabled`, `attempt_invalid` |
| `email-code/start` | `{ requestId, email, purpose: 'login', resend? }` | unchanged | `invalid_request` for `purpose: 'register'` |
| `email-code/verify`, `passkey/options`, `passkey/verify`, `totp/verify`, `google/start` | unchanged | unchanged | unchanged |
| `attempt/cancel` | unchanged | unchanged | Also erases a staged signup |
| `admin/login`, `register`, `totp/setup` | retired | `404 not_found` | The test at `tests/registration-http.test.mjs:40` asserts these three and stops asserting `password/login`. |

### 9.3 OIDC interaction actions

Actions are form-encoded POSTs to `/service/oidc/interaction/<uid>/<action>` that require the interaction cookie, the exact issuer `Origin`, the CSRF token (`lib/oidc/http.mjs:230`), a 56 KiB body limit and a ten second read deadline. `JSON_ACTIONS` gains `signup-start`, `signup-resend` and `signup-email`. `NATIVE_ACTIONS` gains `password-login` and `signup-verify` and loses `admin-login`. `METHOD_FOR_ACTION` maps `password-login` and every `signup-*` action to `password`. A native failure re-renders the wizard with status 400, `failure: { action, code, message }` and the attempted email; the wizard opens S2 for `password-login` and S6 for `signup-verify`, both with empty secret inputs. `FAILURE_MESSAGES` gains the new codes. Because the signup actions answer `200` for every post-staging delivery outcome, the OIDC wizard receives the same delivery information as SSO.

### 9.4 Wizard configuration and adapter contract

`wizardConfiguration` returns `{ setupComplete, registration, signup: { email, google }, methods: { password, emailCode, passkey, totp, google }, passwordPolicy: { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' } }`. `signup.email` is true when registration is open, `password` is enabled and email delivery is available; it does not require the `emailCode` sign-in method. `registration` stays as `signup.email || signup.google` for consumers such as the deployment check that reads `/service/auth/setup`. The `googleOnly` and `adminPassword` fields no longer exist.

| Adapter member | SSO | OIDC |
| --- | --- | --- |
| `passwordLogin({ email, password })` | POST `password/login` | `{ action: 'password-login', fields: { email, password } }`, submitted only after the wizard accepts the current epoch |
| `startSignup({ email, password, passwordConfirmation })` | POST `signup/start` | fetch `signup-start` |
| `resendSignup()`, `changeSignupEmail(email)` | POST `signup/resend`, `signup/email` | fetch `signup-resend`, `signup-email` |
| `verifySignup(code)` | POST `signup/verify` | `{ action: 'signup-verify', fields: { code } }` |
| Removed | `adminLogin` and the `mode` concept | Same |

### 9.5 Guards and limits

| Guard | Rule |
| --- | --- |
| Same origin | SSO: `assertSameOrigin` compares `Origin` with the Router-overwritten forwarded scheme and authority. OIDC: exact issuer origin plus CSRF. Dashboard: exact origin, `application/json`, signed Router invocation. |
| Browser binding | Signup and email-code attempts require the `up_browser` proof; a copied code or URL in another browser fails. |
| Parent | Every operation validates the live parent before work and again inside the locked completion. SSO handoff codes stay single-use and generation-bound; OIDC results are rechecked by `finish`. |
| Field bounds | `requestId` 128, `state` 512, `email` 320 at transport and 254 in the domain, `password` and `passwordConfirmation` 1024 UTF-16 code units, `code` 16. Duplicate form keys are rejected as today. |
| Authority | Discovery output, wizard state, client-supplied roles, `screen_hint` and URL parameters never grant or select authority. |

### 9.6 Verification email wording (D9)

The existing contract is kept: UserPersisto calls EmailAgent's `email_send_auth_code` through `sendAuthCode` (`lib/email-agent-client.mjs:63`). One optional argument is added, with no new service or dependency.

| Element | Change |
| --- | --- |
| `emailAgent/mcp-config.json:234-254` | The input schema gains the optional `purpose` with the single allowed value `signup-verification`; `additionalProperties` stays false. |
| `emailAgent/tools/email_tool.mjs:30-36` | With that purpose and no template: subject "Verify your email to finish creating your account" and text "Use this code to verify your email address: *code*. Your account is created only after you enter this code on the sign-up page. If you did not start a sign-up, ignore this message. Never share this code." With a configured template, `variables` becomes `{ code, purpose }` so the operator's template can branch. Without a purpose the current generic message is unchanged. |
| `lib/email-agent-client.mjs:63-87`, `lib/auth/emailAttempts.mjs:339` | `sendAuthCode` and `deliverCode` forward `purpose` only when set. |

The wording never implies that an account already exists. Both agents ship from the same repository, so the schema and its caller change together.

## 10. Authentication policy and PROD

| Topic | Change |
| --- | --- |
| Methods | `AUTH_METHODS` (`lib/policy.mjs:10`) gains `password`. `DEFAULT_POLICY.enabledAuthMethods` becomes `['password', 'emailCode', 'passkey', 'totp', 'google']`. |
| Explicit restrictions (D6) | A stored policy and `USERPERSISTO_AUTH_METHODS` are respected as they are: a list without `password` deliberately disables password signup and login. There is no stored-policy migration, no migration version and no rollback translation. `password` is no longer reported as a retired method in the environment parser (`lib/policy.mjs:49-71`). |
| Administrator guard | `usableSignInMethods` (`lib/policy.mjs:227`) counts `password` for an active account with an enabled credential and loses the `PROD` and administrator-password clauses. `assertAdministratorMethodRemains` is otherwise unchanged. |
| Disabling `password` | Affects new authentication only: password login and signup are refused at start and again at completion, including a signup started earlier. Existing sessions are untouched, as for every other method today. |
| Registration | `selfRegistrationEnabled` keeps its meaning; `registration_role_must_be_restricted` keeps failing closed; no configurable registration role. |
| `PROD` (A9, D7) | No authentication, email-delivery or logging meaning. The module, every consumer and the manifest declaration are removed (section 5.3). `USERPERSISTO_DEV_BOOTSTRAP` keeps its current behavior and its development-only documentation. |
| Policy page | `public/dashboard/management.mjs:75` and `authentication.html` gain a **Password** checkbox; `environmentOverrides` no longer lists `PROD`. |

## 11. Google and combined local credentials

| Case | Behavior |
| --- | --- |
| Returning linked identity | Unchanged: resolved by verified issuer and case-sensitive subject to the immutable local owner; email changes at Google are never copied; a blocked or missing owner denies without an email fallback. |
| New identity, authoritative email (Gmail, or Workspace `hd` equal to the email domain) | Unchanged: Google verifies the mailbox, the setup decision applies, no local code is sent (A8). The account has no password until one is set in My Account; S2 then shows the neutral unavailable state (D3). |
| New identity, third-party email | Unchanged: the `google-registration-email` proof inside the Google transaction is required before any user or email is staged. `email_verified` alone is not sufficient. |
| Collision with a local account | Unchanged principles: no email-only automatic merge, fresh proof of the exact account, explicit **Link Google and continue**, server-retained target, mailbox version and credential version rechecked at confirmation. |
| Collision proofs | `LINK_METHODS` (`lib/externalIdentities.mjs:18`) gains `password` and loses `adminPassword`. `eligibleMethods` adds `password` when policy allows it and the credential is enabled. The resume page's `authenticate` action (`service/googleAuth.mjs:367`) accepts `method=password` and calls `verifyAccountPassword` with `includeCredentialProof`, under the same lock, budgets and KDF gate as login. The proof retains `credentialKey` and `credentialVersion('password', …)`; a password change or a generation change invalidates it. |
| Authoritative shortcut | Offered only when Google is authoritative for the address, it equals the account's current verified sign-in mailbox, and the `emailCode` method is enabled. The shortcut is a mailbox-control proof, appropriate exactly where mailbox control already signs the account in. The former `PROD` alternative is removed. |
| Accounts with both a password and Google | Either works independently. Google never sets, reveals or changes the local password; setting a password never alters the binding. |
| Policy disables Google | Unchanged: pending Google completions are refused in the locked completion; the fingerprint and deadline are rechecked. |
| Pending signup and Google for the same address | Independent until commit; the first commit wins and the other sees `account_exists` or the collision page. |

## 12. Fresh-installation scope and first administrator

The first completed verified signup or the first completed Google sign-in claims the single administrator through the unchanged setup decision; every later account requires `selfRegistrationEnabled` and receives exactly `selfRegistered`. After sign-in the existing capability routing applies: accounts without `explorer.access` land on My Account, and an administrator grants Explorer by assigning the `user` role.

No account is seeded and no credential ships with the product. A fresh installation therefore needs a working proof channel before anyone can claim it: on `http://localhost:8080` the shared public Google client works without configuration; elsewhere the operator configures Google or EmailAgent delivery before first sign-in, or uses the documented development log delivery on a trusted development host. This belongs in the first-run documentation and in DS012's operational note. Until an administrator exists, the installation stays on a trusted network, as DS012 already requires.

Nothing in this work migrates, converts, recovers or deletes data (section 2.2). Implementation and tests create temporary stores (`mkdtemp`) and remove only those.

## 13. Credential changes, re-authentication and sessions

| Event | `authGeneration` | Effect on new authentication | Effect on already authenticated sessions |
| --- | --- | --- | --- |
| Verified signup | New account at 0 | Signed in through the staged handoff or the interaction result | None |
| First password set on an account without one | Unchanged: nothing is replaced, the rule already used for adding a mailbox and for a first authenticator | Password login becomes available | None |
| Password change | Advances in the same commit | Pending email login challenges, completed email retries, operation grants, staged TOTP setups, passkey challenges, Google link proofs and SSO handoffs bound to the old generation are refused | Stored OIDC sessions, grants, access and refresh tokens, authorization codes and completed login or consent interactions are deleted in that commit. Router sessions end at their next revalidation (30 seconds by default). Self-contained ID tokens live until expiry (at most 300 seconds). |
| A method is disabled, registration closes, or email delivery stops | Unchanged | Refused at start and rechecked in every locked completion; a pending signup ends with `registration_disabled` or `auth_method_disabled` and its verifier is erased | Unaffected; policy governs new authentication |
| Account blocked | Unchanged | Authentication is refused for every method, at start and at completion, with the neutral failure | The next Router revalidation refuses the session (`user_not_active`), OIDC activity checks fail, and no new tokens are issued |
| Roles or role permissions changed | Unchanged | The identity still authenticates normally | The next revalidation returns the current roles and capabilities, so capability routing changes: losing `explorer.access` redirects HTML navigation to My Account and denies protected calls; gaining it opens Explorer. No credential or session is revoked. |
| `PROD` set or removed | Unchanged | None | None |

Pending signups have no account and therefore no account generation; the attempt generation and verifier ID play that role. Re-authentication grants stay single-use, operation-bound, generation-bound and valid for five minutes.

## 14. My Account password management (REVIEW, D2)

Setting and changing the account password is normal credential management. It serves accounts created through Google that later want a password, and it is the way to replace a compromised password. There are no administrator-set passwords and no unauthenticated reset feature.

| Element | Design |
| --- | --- |
| Operation | `password.set` joins `GRANT_OPERATIONS`; it requires a verified sign-in mailbox (`verified_email_required`), like passkey and TOTP. |
| Confirmation | Any currently usable re-authentication method. `password` joins `REAUTH_METHODS`, verified by `verifyAccountPassword` under the rules of section 7.4 and rechecked at issue time with `assertPasswordProof`. This lets a password-only account confirm operations when email delivery is unavailable, and makes changing a password require the current one or another fresh proof. |
| Endpoint | `POST api/auth/password/set` with `{ grant, password, passwordConfirmation }`. Exact origin, JSON, 64 KiB, signed Router actor. Handled directly in `service/dashboard.mjs` beside re-authentication, never through the tool registry, so no MCP caller can relay a password. |
| Order (R9) | 1. Validate confirmation and the creation policy; these predictable failures never touch the grant. 2. Read-only checks before any KDF: active actor, verified mailbox, `password` enabled, and the grant, which is only looked up and validated through `stageGrantConsumption` (`lib/auth/operationGrants.mjs:223`) without calling its `consume`. A valid grant therefore stays available and unchanged. A missing or foreign grant is refused with `operation_grant_required` without touching anything, and a grant of this account that is already invalid (expired, another operation, an older generation) follows the existing invalid-proof rule: it is deleted and the request refused, exactly as `consumeOperationGrant` does today (`:244-252`). No refused request runs a KDF. 3. Consume the per-account KDF budget and hash through the gate, outside every store lock. Because a valid grant is still unspent here, this budget is what bounds repeated hashing with one grant. 4. Under `serializePersisted('users')`, re-read the grant and revalidate it together with the actor's status, the verified mailbox, the effective policy, the grant's generation against the current `authGeneration`, and the current credential state. Then one staged commit deletes the grant and writes the credential, so a valid grant is consumed exactly once and only together with the mutation it authorizes. A replacement advances the generation in that commit; a first set does not. Two requests presenting the same valid grant may both pass step 2 and both hash, but they serialize here: the first commit deletes the grant, and the second re-reads it, finds none and is refused with `operation_grant_required` without writing anything, even though a first set leaves `authGeneration` unchanged. A refusal at this boundary for any other reason writes no credential and deletes the grant under the same existing rule. |
| Audit | `auth.password.set` or `auth.password.change`. |
| Interface | A **Password** row in `public/dashboard/enrollment.js` with **Set a password** or **Change password**, two inputs without `maxlength`, the rules of section 7.3, emptied on every transition, cancellation and page exit. After a change the page reports that every session was signed out. The confirmation form's password option is labelled **Password**. |
| Profile | `authMethods` gains `{ type: 'password', name: 'Password' }`; `enrollments.password` reports `{ configured }` only. No hash, version or timestamp is exposed. |
| Forgotten password | A user signs in with another method through **Try another way** or Google and then changes the password. Recovery for a user with no other usable method stays deferred, as DS012 and DS013 already state. |

## 15. Style, dependencies and Ploinky

The work follows DS001: ES modules, `.mjs` on the server and the existing `.js` browser modules, `async` and `await`, four-space JavaScript, two-space JSON, trailing commas in multi-line literals, camelCase files beside related logic, native Node facilities first, durable state outside process memory, English comments, and safe generic failures outside `ACHILLES_DEBUG`. The wizard remains the framework-free `createElement` and `replaceChildren` module it is today.

No new package, framework or build step is needed. Hashing, encryption, randomness, constant-time comparison, Unicode normalization and well-formedness checks are native (the agent requires Node 22 or later, `package.json:6`). `jose`, `oidc-provider` and `openid-client` keep their pinned versions.

Ploinky needs no change and none is made. The Router already delegates login to the provider's page, keeps its own state and browser proof, consumes a single-use handoff, revalidates sessions by generation, supplies the trusted rate-source partition, admits `…/service/auth/*` as guest transport and `…/service/oidc/*` as a public protocol, and applies capability routing after sign-in. New routes fall under the existing manifest wildcards. Keeping credentials, hashing, throttling and pending signups inside UserPersisto is what keeps Ploinky provider-neutral. The five-minute login window on both sides (`lib/sso.mjs:10`, `ploinky/cli/server/auth/genericAuthBridge.js:131`) is kept as it is (D10); this plan does not expand Ploinky's scope.

## 16. File-by-file work breakdown

Paths are under `AssistOSExplorer/userPersistoAgent/` unless stated.

| File | Change |
| --- | --- |
| `lib/auth/production.mjs`, `lib/auth/adminPassword.mjs` | Delete. |
| `lib/auth/password.mjs` | Rewrite: asynchronous KDF primitive, single profile, gate, test seams. |
| `lib/auth/userPassword.mjs`, `lib/auth/commonPasswords.mjs`, `lib/auth/throttle.mjs`, `lib/auth/signup.mjs` | New (sections 7, 8). |
| `lib/auth/emailAttempts.mjs` | Version 2 format, namespace and context; `signup` staging; verifier-bound code context; delivery rules for `failed` and `pending`; `signupPending`; erasure rules; `purpose` forwarding; throttle extraction. |
| `lib/auth/signIn.mjs` | `methods.password`; login-only email codes; registration branch and production assertions removed. |
| `lib/auth/credentialVersion.mjs` | `password` branch. |
| `lib/auth/wizardConfig.mjs` | New configuration shape. |
| `lib/auth/operationGrants.mjs` | `password.set` operation; `password` re-authentication; administrator and production clauses removed. |
| `lib/auth/totp.mjs`, `lib/auth/passkey.mjs`, `lib/auth/google.mjs` | Production references removed. |
| `lib/policy.mjs` | `password` method, default list, administrator guard; production and administrator-password clauses removed. |
| `lib/setup.mjs`, `lib/users.mjs`, `lib/schema.mjs` | `passwordSignup` method; email-less account allowances and stale comments removed (section 5.4). |
| `lib/externalIdentities.mjs`, `service/googleAuth.mjs` | Password link proof; administrator proof and production clause removed. |
| `lib/authorization.mjs` | Profile method and enrollment summary for `password`; administrator entry removed. |
| `lib/email-agent-client.mjs` | `purpose` forwarding. |
| `service/ssoWizard.mjs`, `lib/oidc/http.mjs`, `service/index.mjs` | New routes and actions; retired administrator route and action; production removal; configuration fields. |
| `service/dashboard.mjs` | `api/auth/password/set`; password field bound for re-authentication. |
| `main.mjs` | Administrator-password synchronization removed; startup order otherwise unchanged. |
| `public/auth/wizard.js`, `sso-adapter.js`, `oidc-adapter.js`, `auth.css`, `google-branding.md` | Screens S0 to S14, transitions, copy, delivery states, `{ email }` storage, removals, styles, button wording. |
| `public/dashboard/enrollment.js`, `enrollment.css`, `main.js`, `management.mjs`, `authentication.html` | Password row, labels and policy checkbox; administrator labels removed. |
| `manifest.json` | `PROD` and `USERPERSISTO_ADMIN_PASSWORD` declarations removed. No route change. |
| `tests/helpers/setup.mjs` | Replace the administrator-password and passwordless-registration helpers with `signUpWithPassword(email, options)`, which drives the real signup operations against a live SSO parent with a construction-time delivery capture (the first call claims the administrator), a login-only `signInWithEmailCode`, and `resetAuthLimitsForTests` covering the new budgets and KDF seams. A Google-created account remains the fixture for an account without a password. |
| `tests/*` | Section 19. Every suite using the removed helpers moves to the new fixtures. |
| `AssistOSExplorer/emailAgent/mcp-config.json`, `emailAgent/tools/email_tool.mjs`, `emailAgent/tests/runtime.test.mjs` | Optional `purpose` argument, wording, schema validation cases. |
| `AssistOSExplorer/tests/smoke/lib/auth.mjs`, `config.mjs`, their unit tests, `specs/80-explorer-qa-acceptance.spec.mjs`, `README.md` | The shared sign-in helper follows S1, then S2, and reaches email code or TOTP through **Try another way**; signing up goes through S4 to S6 with a password generated for the run or supplied by configuration; `password` becomes an accepted `signInMethod`. The three release gates authenticate through this helper, so it changes in the same release as the wizard. |

## 17. Phases and ordering

Each phase leaves the agent suite green and is independently reviewable. Server enforcement lands before any control that exposes it. There is no migration phase and no rollback mechanism: reverting is ordinary source control together with a fresh store, and an administrator can disable the `password` method by policy at any time without touching the other methods.

| Phase | Content | Depends on | Exit evidence |
| --- | --- | --- | --- |
| 1 | Remove the `PROD` switch and the whole administrator-password machinery (sections 5.3, 5.4). Fixtures that needed an administrator use the existing first verified email registration for now. Parity tests replace the production tests. | None | No production or administrator-password symbol remains in source (`googleOnly`, `production.mjs`, `productionSuspended`, `adminPassword`, `admin-login`, `admin/login` searched); suite green. |
| 2 | KDF primitive, input policy, credential storage, `credentialVersion`, throttle extraction, the `password` policy method. No route uses them yet. | 1 | Primitive, policy and secrecy tests; recorded hash time. |
| 3 | Attempt format 2, pending signup and completion, `passwordSignup` setup method, EmailAgent `purpose`. Fixtures move to `signUpWithPassword`; passwordless registration is removed. | 2 | Lifecycle, delivery-state, persistence and restart, fault-injection and concurrency tests. |
| 4 | Password verification with the order of section 7.4, SSO routes, OIDC actions, configuration shape. | 2, 3 | HTTP and OIDC protocol tests, including the burst test. |
| 5 | Wizard and adapters: screens, transitions, copy, accessibility, button wording. | 3, 4 | Wizard unit tests and the real wizard with the real service. |
| 6 | Google password link proof and shortcut rule. | 2, 4 | Google domain and HTTP tests. |
| 7 | My Account password set and change; `password` re-authentication. | 2, 4 | Dashboard HTTP and enrollment interface tests. |
| 8 | Smoke helper and its unit tests; opt-in browser runners. | 5 | Runner output and screenshots under `.ploinky/test-artifacts/`. |
| 9 | DS012, DS013, DS002 and the HTML documentation, kept in step with each behavior change and closed with a consistency pass. | All | Documentation review. |
| 10 | Conditional acceptance (section 19.4), only when the user explicitly requests deployment or E2E validation. | All | Gate evidence. |

## 18. Documentation and specification updates for the implementation

None of these files is changed by this plan. DS rules require them to change together with the behavior.

| Document | Update |
| --- | --- |
| `docs/specs/DS012-user-persisto.md` | Summary and introduction (accounts have passwords; no shared administrator password); installation setup methods (`google`, `passwordSignup`); remove the *Administrator password* section; new sections for the account password credential, input policy, guessing limits and the pending signup lifecycle with its delivery states; rewrite *The sign-in wizard*; authentication policy without `PROD`; Google linking proofs; the account dashboard API table and re-authentication methods; *Credential changes and sessions* with the blocked and role-change distinction; the first-run proof-channel note; compatibility scope and deferrals; verification contract. |
| `docs/specs/DS013-oauth-oidc.md` | Interaction actions, `amr` values, the two persistence boundaries of signup completion, removal of the production paragraph and the administrator action, the opening form description, setup examples, and the deferral list (ordinary password login now exists; recovery stays deferred). |
| `docs/specs/DS002-ploinky-runtime.md` | Remove the `PROD` paragraph and the "ordinary accounts are passwordless" sentence; keep every Ploinky invariant. |
| `docs/specs/matrix.md` | Refresh the DS012 and DS013 summaries. |
| `docs/workspace-operations.html`, `docs/architecture.html`, `docs/wiki.html` | Sign-in description, first-run claim guidance, removal of the `ploinky var PROD` and administrator-password guidance. |
| `docs/deploy-skills-explorer.md`, `tests/smoke/README.md` | First-administrator claim steps and automated sign-in through the new screens. |
| `userPersistoAgent/tests/browser/README.md`, `public/auth/google-branding.md` | Runner descriptions; button wording. |
| EmailAgent documentation | The optional `purpose` argument and the template variable. |

## 19. Verification

The existing suite was reported at 520 passing tests. Those results say nothing about the behavior in this plan, and a large part of them assert the opposite (no ordinary password routes, the inline administrator field, Google-only production). Controlled Google fixtures use signed test tokens through the production verifier and are never real-provider acceptance. Every test uses an isolated temporary store.

### 19.1 Regression matrix

| Area | Test file (new or changed) | Cases that must exist |
| --- | --- | --- |
| KDF and input policy | `tests/user-password.test.mjs` (new) | The real profile's stored format; asynchronous execution outside the persistence scope; any other profile or malformed string fails closed; gate saturation; creation bounds in code points after NFKC, including supplementary-plane characters that exceed 128 UTF-16 units yet are valid, and inputs that change length under normalization; raw bound refused without truncation; ill-formed and control characters; confirmation equality after normalization; email-equal, repeated and common refusals; presentation accepts a short or over-policy password if its verifier matches, and enforces only the raw bound, the byte bound and well-formed encoding; R10 regression: with a legitimate verifier created from a password that contains a literal U+FFFD, a candidate carrying an unpaired surrogate in that position is refused with the neutral `authentication_failed`, runs no KDF (observed through the KDF seam) and spends no failure budget, while the genuine password still verifies and no minimum length is applied at login; the snapshot and captured logs never contain the plaintext; a credential decrypts only under its owner's context. |
| Password verification and budgets | `tests/user-password.test.mjs`, `tests/password-login-http.test.mjs` (new) | Success; wrong password; unknown email, blocked account and account without a password return the same code after a KDF; R3 burst: more simultaneous requests than the failure limit for one address, observed through the KDF seam, prove that excess waiters are refused without a KDF, that the number of KDF evaluations never exceeds the limit, and that after exhaustion further requests, including one with the correct password, receive `rate_limited` without a KDF; the durable budget survives a store restart and clears on success; per-source and shared budgets; an untrusted rate-source header shares one bucket; policy disabled; parent expiring between queueing and the KDF; credential or generation change between KDF and commit; audit content; TOTP counters untouched. |
| Attempt format | `tests/signup.test.mjs` (new), `tests/auth-email-code.test.mjs` | Version, namespace and context agree; a record of any other version or context is refused; a record written under the former namespace is never found or decrypted and is removed by the sweep; a pending signup and a pending login code both survive a genuine store shutdown and reopen from disk and then complete. |
| Pending signup | `tests/signup.test.mjs` | Typing, staging and code requests create no user, role, setup record, reservation, handoff or session; the verifier is stored only encrypted; binding to parent, browser, email, generation and verifier; another attempt's code never completes and never activates its password; resend cooldown, send cap and generation; email change keeps the verifier and invalidates the old address's code; a new password invalidates the previous code; cancel, five failures and expiry erase the verifier. |
| Delivery retry (R6) | `tests/signup.test.mjs`, `tests/signup-http.test.mjs` (new) | A delivery that fails after staging answers `200` with `failed`; **Send again** works immediately and needs no password; exactly one KDF ran across the retries; no plaintext is persisted; the account later logs in with the originally chosen password; `unknown` keeps the code usable; an interrupted `pending` delivery resumes as send-failed after a restart; failures before staging keep nothing; missing staging answers `signup_restart_required`; the send cap and budgets bound the retries; the parent deadline ends them. |
| Completion | `tests/signup.test.mjs`, `tests/registration.test.mjs`, `tests/store-durability.test.mjs` | The first verified signup becomes the only administrator with `method: 'passwordSignup'`; later signups get exactly `selfRegistered` and no Explorer access; registration closed mid-flow; late collision erases the verifier and never touches the existing account; concurrent same-email completions; concurrent first completions by signup and Google; fault injection while staging leaves no user, credential or setup record after restart; SSO lost-response replay only to the same browser and parent. |
| SSO HTTP | `tests/signup-http.test.mjs`, `tests/registration-http.test.mjs`, `tests/wizard-sso-http.test.mjs` | Request and response shapes; `invalid_json`; oversized fields; foreign and `null` origin; dead and expired parents, including a parent expiring during S5 and S6; `up_browser` attributes; `email-code/start` with `purpose: 'register'` refused; `admin/login`, `register` and `totp/setup` answer 404; the real wizard and adapter complete signup and password login against the real service. |
| OIDC | `tests/oidc-methods.test.mjs`, `tests/oidc-http.test.mjs` | CSRF and origin on every new action; native `password-login` and `signup-verify`; `admin-login` refused; `amr`; failure re-render without secrets and on the right screen; separate consent; the two persistence boundaries, including a simulated stop between the local commit and `interactionFinished` followed by the same-browser resume; the first administrator through the interaction; generation revocation after a password change. |
| Policy and PROD parity | `tests/prod-parity.test.mjs` (replaces `production-auth.test.mjs`), `tests/registration.test.mjs`, `tests/email-readiness.test.mjs` | Default list with `password`; the assertion at `tests/registration.test.mjs:87`, which today expects `enabledAuthMethods: ['password']` to fail with `invalid_auth_method`, is reversed; stored and environment restrictions without `password` are respected; the administrator guard counts `password`; identical configuration, policy, endpoints and wizard state with `PROD` absent, empty, `false` and `true`; `USERPERSISTO_DEV_BOOTSTRAP` behaves as before in both cases. |
| Removal | `tests/registration-http.test.mjs`, `tests/runtime-process.test.mjs`, a source-search assertion | No administrator-password route, action, configuration field, re-authentication method, link proof or manifest variable; an unclaimed store cannot be claimed by any password; startup no longer synchronizes a verifier. |
| Google | `tests/google-identities.test.mjs`, `tests/google-http.test.mjs`, `tests/google-gis-http.test.mjs` | Password link proof accepted, and invalidated by a password change; administrator proof gone; the authoritative shortcut only with `emailCode` enabled and never from `PROD`; third-party mailbox proof unchanged; stable IDs, roles and bindings; blocked owner; a pending signup racing a Google registration. |
| My Account | `tests/dashboard-http.test.mjs`, `tests/account-enrollment-ui.test.mjs`, `tests/account-lifecycle-http.test.mjs`, `tests/tools.test.mjs` | Predictable input failures leave a valid grant unspent and still usable; no KDF without a valid grant; a missing or foreign grant is refused untouched and an already invalid grant of the account follows the existing deletion rule; R9 concurrency: two simultaneous first-set requests presenting the same valid grant, while `authGeneration` is unchanged, produce exactly one credential write and one `operation_grant_required`, and the same holds for two simultaneous change requests; a grant consumed by the commit cannot authorize any later mutation; the grant is generation-bound; commit-boundary revalidation of status, mailbox, policy and generation; a first set keeps the generation, a change advances it and revokes sessions, OIDC state and grants; `verified_email_required`; `password` re-authentication; inputs emptied; no MCP tool accepts a password; the profile exposes no secret. |
| Sessions | `tests/account-lifecycle-http.test.mjs`, `tests/sso.test.mjs` | A blocked account is refused at authentication and at the next revalidation; a role change leaves authentication working and changes the returned capabilities. |
| Wizard | `tests/auth-ui.test.mjs` | S1 order and the absence of password, administrator and mode controls; every transition of section 6.3; S2 for every registered account, with disabled submission and neutral copy when password sign-in is unavailable; S3 always lists three entries with the generic, policy and browser reasons; no password input has `maxlength`; supplementary-character passwords pass the client check; mismatch and policy copy; wrong-password copy and emptied input; the five delivery states; resend and change email without a password prompt; reload resume; stale responses ignored; the countdown and expiry (D10); collision; storage holds only the email; labels, focus and `role="alert"`; both real adapters' request shapes and native submissions. |
| EmailAgent | `emailAgent/tests/runtime.test.mjs` | `purpose` accepted only with the allowed value; unknown properties still refused; the signup wording and the template variable; the generic message unchanged without a purpose. |
| Runtime | `tests/runtime.test.mjs`, `tests/runtime-process.test.mjs` | Startup without the administrator synchronization; a graceful restart retains owner, credentials and a pending signup. |
| Smoke helpers | `AssistOSExplorer/tests/smoke/lib/auth-navigation.test.mjs`, `config.test.mjs`, `auth.test.mjs` | The helper signs in with a password, with an email code through S3 and with TOTP through S3, and signs up through S4 to S6 without claiming an unclaimed installation by accident. |

### 19.2 Reproducible commands (R8)

Each block sets its own working directory, so no command inherits another block's directory. The suites use the supported runtime inputs that the test helpers already resolve: `PLOINKY_AGENT_RUNTIME_ROOT` for the Ploinky `Agent` tree (`tests/helpers/router-fixture.mjs:7-13`, `tests/runtime-process.test.mjs:15-16`), `PLOINKY_ROOT` for the Ploinky checkout (`tests/helpers/managedRouterRuntime.mjs:22-35`) and `PLOINKY_AGENTLIB_DIR` for the shared AgentLib (`tests/browser/README.md`). Dependencies are the ones already declared in each package's lockfile. If a required runtime, dependency or browser is unavailable on the host, the check is reported as BLOCKED; image markers, runtime invariants and source mounts are never altered to obtain a pass. A failure that reproduces on the unmodified baseline for an environmental reason is recorded as such with its evidence.

```sh
export WORKSPACE=/absolute/path/to/workspace   # contains AssistOSExplorer/ and ploinky/
export PLOINKY_ROOT="$WORKSPACE/ploinky"
export PLOINKY_AGENT_RUNTIME_ROOT="$WORKSPACE/ploinky/Agent"
export PLOINKY_AGENTLIB_DIR=/absolute/path/to/shared/achillesAgentLib
```

```sh
# UserPersisto: narrow suites first, then the whole agent suite
cd "$WORKSPACE/AssistOSExplorer/userPersistoAgent"
npm ci --ignore-scripts        # only when node_modules is absent; installs the locked dependencies
node --test tests/user-password.test.mjs
node --test tests/signup.test.mjs tests/registration.test.mjs tests/store-durability.test.mjs tests/auth-email-code.test.mjs
node --test tests/prod-parity.test.mjs
node --test tests/signup-http.test.mjs tests/password-login-http.test.mjs tests/registration-http.test.mjs tests/wizard-sso-http.test.mjs
node --test tests/oidc-methods.test.mjs tests/oidc-http.test.mjs
node --test tests/google-identities.test.mjs tests/google-http.test.mjs tests/google-gis-http.test.mjs
node --test tests/auth-ui.test.mjs tests/account-enrollment-ui.test.mjs tests/dashboard-http.test.mjs tests/account-lifecycle-http.test.mjs
npm test
```

```sh
# EmailAgent
cd "$WORKSPACE/AssistOSExplorer/emailAgent"
npm test
```

```sh
# Smoke helper unit tests
cd "$WORKSPACE/AssistOSExplorer/tests/smoke"
npm run test:unit
```

```sh
# Opt-in real-browser runners (never part of npm test); run from the repository root
cd "$WORKSPACE/AssistOSExplorer"
WIZARD_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/wizard-flows.mjs
GOOGLE_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/google-resume.mjs
```

### 19.3 Real-browser coverage required from `wizard-flows.mjs`

| Surface | Checks |
| --- | --- |
| SSO | S1 order and absent controls; signup through S4, S5 and S6 with a captured code; mismatch, a short password and a valid password containing supplementary-plane characters; a first delivery failure followed by **Send again** without re-entering the password; wrong code then right code; resend after the cooldown; change email without a password prompt; automatic sign-in; the first signup claims the administrator and the second receives `selfRegistered` and lands on My Account; password login; wrong password; **Try another way** to an email code; S2 disabled state for a Google-created account; reload during S6; two tabs; the countdown and expiry with **Start again**; password inputs have the correct `autocomplete`, no `maxlength`, and are empty after every transition; screenshots are taken before any secret is typed. |
| OIDC popup on a different site | Native `password-login` and `signup-verify` carry the HttpOnly, SameSite=Strict `up_browser` proof; failures re-render with a visible error; separate consent; `screen_hint=signup` heading. |
| Parity | The same run with `PROD` present produces the same screens and outcomes. |
| Google | Denial returns to S1 with the notice; controlled sign-in completes; collision linking with a password proof in `google-resume.mjs`. |

### 19.4 Conditional deployment acceptance

Implementation is authorized; deployment is not. Deployment remains stopped, and no deployment, restart or E2E run may be inferred from this plan. When the user explicitly requests one, the following apply.

| Gate | Requirement |
| --- | --- |
| Agent suites | Green as above on the exact candidate revision. |
| Fresh local Explorer deployment | The procedure in `ploinky/CLAUDE.md`: pinned candidate revisions, the dedicated fresh fixture, the literal `ploinky start explorer`, full graph readiness and identity proofs. |
| Three headless gates | The OnlyOffice confidential document, Copilot folder launch and WebMeet two-account gates, each finishing `1 passed` with zero skips and retries. They authenticate through the updated smoke helper, so helper changes are part of the candidate. |
| `ploinky-proxy` | Any change on that branch of any repository stays incomplete until the exact candidate revisions pass the deployment and the three gates. This plan requires no Ploinky change. |
| Authentication acceptance on the deployed origin | The first administrator claimed by verified signup; a second account lands on My Account; password login; email code through **Try another way**; Google sign-in with a real account on a registered origin; identical behavior where `PROD` is set. |
| Real providers | Real email delivery and real Google acceptance are separate checks. Unavailable Cloudflare, TURN, mail or Google prerequisites are reported as BLOCKED, never as a pass. |
| Production | `skills.axiologic.dev` is touched only when the user selects it. |

## 20. Acceptance checklist

| ID | Criterion | Evidence |
| --- | --- | --- |
| AC1 | S1 shows **Sign in with Google**, **Email**, **Next** in that order, and no password field, administrator control or mode switch, on SSO and OIDC. | Wizard and browser tests |
| AC2 | **Next** branches only on server discovery; discovery never grants authority and exposes only existence and usable method types. | Domain and HTTP tests |
| AC3 | Every registered account sees **Password**, **Try another way** and **Log in**; an unavailable password disables submission with neutral wording; blocked status and Google linkage are never disclosed. | Wizard and login tests |
| AC4 | **Try another way** always lists email code, passkey and TOTP with generic, policy or browser reasons; any single method signs in; nothing is mandatory. | Wizard tests |
| AC5 | An unknown email reaches **Sign up**, then **Password** and **Confirm password**, then the emailed code, then automatic sign-in. | Browser and HTTP tests |
| AC6 | Before the correct code, no account, role, ownership claim, email reservation or session exists. | Signup tests |
| AC7 | Resend, send-again after a failed delivery, and change email never ask for the password again, run no second KDF, persist no plaintext, and invalidate every earlier code. | Signup and wizard tests |
| AC8 | A code from another person's pending signup cannot complete the mailbox owner's attempt or activate the other person's password. | Signup tests |
| AC9 | Password login never sends an email code; signup verification is not repeated at login. | Login tests |
| AC10 | The first completed verified signup or Google sign-in creates exactly one administrator; later signups receive exactly `selfRegistered`; users without `explorer.access` land on My Account. | Registration and browser tests |
| AC11 | Google registration, authoritative and third-party rules, collision consent, fresh proof and stable subjects behave as specified; no email-only merge exists. | Google tests |
| AC12 | With `PROD` present, absent, empty or false-looking, configuration, policy, endpoints and screens are identical; nothing reads `PROD`. | Parity tests and source search |
| AC13 | No shared or default administrator password exists anywhere: no route, action, screen, recovery parameter, configuration flag, confirmation method, link proof or manifest variable. | Removal tests and source search |
| AC14 | One attempt format exists; other formats are refused and never converted; pending work survives a genuine restart. | Attempt-format tests |
| AC15 | Passwords are hashed asynchronously with the single vetted profile, stored encrypted and owner-bound, and absent from snapshots, logs, responses, browser storage and MCP tools. | Primitive and secrecy tests |
| AC16 | A burst larger than the failure limit never receives more KDF evaluations than the limit; after exhaustion no request, including a correct password, runs the KDF; responses are identical for unknown, blocked and password-less accounts. | Burst and login tests |
| AC17 | New passwords follow the 15 to 128 normalized code point rule with a bounded raw input on client and server alike, without truncation; login enforces only transport and resource bounds, well-formed encoding and a supported verifier, so a candidate with an unpaired surrogate never matches a password containing U+FFFD and no creation-strength rule is applied at login. | Policy tests |
| AC18 | A password change advances the generation and revokes Router sessions, OIDC state, grants and bound proofs; a first set does not; blocking refuses authentication while a role change only alters capability routing. | Lifecycle tests |
| AC19 | OIDC signup completion is documented and tested as two persistence boundaries with same-browser recovery. | OIDC tests, DS013 |
| AC20 | No new dependency; Ploinky unchanged; no migration, recovery or rollback code; no live data deleted; DS012, DS013, DS002 and the HTML documentation updated with the behavior. | Review |
| AC21 | When requested, the conditional gates of section 19.4 pass on the exact candidate revisions. | Gate evidence |
| AC22 | One operation grant authorizes at most one password mutation: a valid grant survives pre-KDF refusals unspent, is consumed exactly once in the commit that writes the credential, and two concurrent requests with the same grant, including two first-set requests with an unchanged `authGeneration`, yield one write and one refusal. | My Account tests |

## 21. Resolved choices and remaining risks

### 21.1 Resolved choices

| Topic | Resolution | Origin |
| --- | --- | --- |
| Migration, cutover, compatibility, rollback, administrator recovery | None of them is built | User (SCOPE) |
| Shared and default administrator password | Removed completely; no bridge, no hidden route | Review R1, D1 |
| My Account password set and change; `password` as a confirmation method | In scope, with the order of section 14; a valid grant is consumed exactly once, atomically with the credential write | Review D2, R9 |
| Registered account without a usable password | The password screen is still shown, with disabled submission and neutral wording | Review D3 |
| Unavailable alternatives | Always listed; disabled with generic wording; specific reasons only from public policy or browser capability | Review D4 |
| Password rule for new passwords | 15 to 128 normalized code points, raw input at most 1024 UTF-16 code units, NFKC on client and server, no `maxlength`, no truncation | Review R7, D5 |
| Login bounds | Transport and resource bounds, well-formed encoding, and a supported verifier; creation-strength rules are never applied at login | Review R7, R10 |
| KDF | One vetted asynchronous scrypt profile, bounded concurrency, measurement recorded but never used to lower the work factor | Review D5, this plan |
| Verification order and budgets | Recheck inside the per-email lock before the KDF; bounded waiters | Review R3 |
| Attempt format | Version 2 with its own namespace and context; a single reader | Review R5 |
| Delivery failure after staging | Recoverable send-failed state that keeps the verifier | Review R6 |
| Default policy and restrictions | `password` in the default list; explicit restrictions respected; no migration | Review D6 |
| `PROD` | No meaning; `USERPERSISTO_DEV_BOOTSTRAP` unchanged | User (A9), Review D7 |
| Google button wording | **Sign in with Google** | User (A1), Review D8 |
| Verification email wording | Optional `purpose` on the existing tool | Review D9 |
| Parent deadlines | Unchanged; expiry behavior tested | Review D10 |
| Historical password hashes | Ignored entirely | Review D11 |
| Setup method name, `amr` for verified signup, limits and constants, module boundaries | As written in sections 7 to 9 | This plan (RESOLVED) |

Password recovery without any other method, administrator-driven password reset, mandatory MFA, general email replacement, Google unlinking and role-policy changes are not part of this work and stay deferred.

### 21.2 Remaining risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| K1 | A fresh installation without Google, email delivery or development log delivery cannot be claimed, and EmailAgent settings need an administrator. | Document the first-run order (section 12); localhost works through the shared Google client; deployment workflows configure a proof channel before first sign-in. |
| K2 | Removing Google-only enforcement widens the production sign-in surface. | This is the approved outcome (A9); administrators can still restrict methods by policy. |
| K3 | The five-minute SSO parent is tight for choosing a password and receiving mail. | Reload resume, resend without a password prompt, send-failed recovery, tested expiry behavior (D10). |
| K4 | Email code through **Try another way** lets mailbox control sign in to a password account. | Approved design (A4); administrators may disable the `emailCode` sign-in method without affecting signup verification, because the registration proof is separate. |
| K5 | A victim can be persuaded to relay a signup code to an attacker's browser. | Browser binding defeats interception but not persuasion; the purpose-specific wording (section 9.6) warns against sharing. |
| K6 | An attacker can exhaust the per-address send budget or throttle one address's password login. | Bounded and temporary; other methods remain; the same class as limits accepted today. |
| K7 | KDF cost becomes a CPU or memory denial of service. | Budgets before hashing, bounded waiters, the KDF gate, explicit `maxmem`. |
| K8 | The settings key now also protects password credentials. | Already required for TOTP secrets and OIDC keys; backups keep the key and the snapshot together. |
| K9 | Discovery reveals existence and method types. | Accepted in DS012; discovery budgets stay; no Google linkage, roles, identifiers or blocked status are exposed. |
| K10 | Many suites depend on the removed fixtures. | Phase order keeps a working administrator fixture at every step (section 17); one new helper drives the real signup. |
| K11 | Release gates break if the smoke helper is not updated with the wizard. | Same-release requirement in sections 16 and 19.4. |
| K12 | The scrypt profile was taken from guidance that was not fetched during planning. | Deterministic confirmation rule in section 7.2. |

## 22. References

Source-grounded details come from the repository files cited inline. The following guidance was named in the task brief or the review as already inspected; it was not fetched by the planning session and is cited for orientation only.

| Reference | Relevance |
| --- | --- |
| OWASP Authentication Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html (the review cites its password-strength section for the 15-character minimum without mandatory MFA) | Password length, generic failure messages, throttling trade-offs, re-authentication for sensitive changes. |
| OWASP Email Validation and Verification Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Email_Validation_and_Verification_Cheat_Sheet.html | Ownership proof before activation, single-use time-limited codes. |
| Google, Verify the Google ID token on your server side, https://developers.google.com/identity/gsi/web/guides/verify-google-id-token | Issuer, audience, subject as the stable key, hosted-domain handling. |
| `docs/plans/email-first-account-authentication-plan-review.md` | Findings R1 to R10 and directions D1 to D11 addressed in section 3. |
| `docs/specs/DS001-coding-style.md`, `DS002-ploinky-runtime.md`, `DS012-user-persisto.md`, `DS013-oauth-oidc.md`; `ploinky/CLAUDE.md` | Local contracts superseded or preserved as stated above, and the conditional acceptance gate. |
