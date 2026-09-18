# Optional signup email verification and emailed password reset for UserPersisto: implementation plan

Status: implementation plan, prepared on 18 September 2026 by read-only analysis of AssistOSExplorer `main` at `f913e70264fa5942d351cb47c1d825e0919b8f8e` ("Use the same-path Box workspace in Explorer QA workflows") and Ploinky `master` at `142a92ff4a3ffdb53220ed209ae8df9c2dc46135`. Task tags: planning, authentication, email, browser-e2e, documentation.

This document is the only repository file written by the planning session. No source, test, specification, dependency, runtime configuration, Git ref, credential, stored account or deployment was changed, and no test suite was run because nothing changed. The only request sent to the running deployment was one unauthenticated `GET …/service/auth/setup` (section 3.2). All AssistOSExplorer line numbers refer to the `f913e702` tree.

Provenance. The UserPersisto and EmailAgent source, DS012 and DS013 were read directly. Two read-only sweeps were delegated: a trace of the Ploinky Router (section 8.1) and an inventory of tests and documents that assert today's behaviour (sections 8 and 11.1). Their reports are not taken on trust: every citation from them that appears in this plan was re-read against its file during planning, and all matched. Statements from those reports that were not re-read are not used, except where marked UNVERIFIED.

Baseline warning. The local clone at `~/work/file-parser/AssistOSExplorer` was at `b06b833f`, twenty commits behind `AssistOS-AI/AssistOSExplorer` `main`. The missing commits are exactly the ones this plan builds on (`5838e13b`, `299a13c9`, `310f936d`, `b76f73b3`: account passwords, verified password signup, the initial-administrator password, My Account password management). The analysis therefore read the clean checkout the local deployment runs from, `~/work/testExplorerFresh/.ploinky/repos/AchillesIDE`, whose `HEAD` equals `git ls-remote assistos-ai refs/heads/main`. Section 9 makes a fresh worktree from `assistos-ai/main` the first step. Implementing this plan against `b06b833f` would be wrong: that tree has no password signup at all.

Later the same day (13:10) the shared clone was brought level with the remote: another session committed its OnlyOffice and marketplace edits, rebased onto `f913e702` and pushed `74f12b9c` ("Restrict OnlyOffice to global mode through its manifest"), and the user then had `assistos-ai` fetched so that `assistos-ai/main` is current. Local `main`, `origin/main`, `assistos-ai/main` and the live remote all equalled `74f12b9c`. `git diff --name-only f913e702 74f12b9c` lists six files, none under `userPersistoAgent/`, `emailAgent/`, `tests/smoke/`, `.github/workflows/`, `docs/plans/`, or among DS012, DS013 and the other documents this plan cites, so every line reference below holds at `74f12b9c` as well.

## 1. How to read this plan

| Label | Meaning |
| --- | --- |
| **REQUESTED** | Stated by the user on 18 September 2026 (section 2.1). Supersedes DS012 and DS013 wherever they require a verified mailbox for password signup or exclude an unauthenticated password reset. |
| **OBSERVED** | Read directly in the `f913e702` tree, the running local deployment or Git history during planning. Every such statement carries a path and line. |
| **DECISION** | A technical choice made by this plan, with its reason. Implement as written unless a defect is found. |
| **RATIFY** | A choice with product or security consequences that the user should confirm. Each has a recommended default, so implementation is not blocked; section 4 lists them in one table. |
| **UNVERIFIED** | Reasoned but not confirmed during planning. Each names the check that would confirm it. |

## 2. Requirements and scope

### 2.1 Requested behaviour (REQUESTED)

| ID | Request | Reading adopted by this plan |
| --- | --- | --- |
| R1 | "by default email verification is not required when signing up with email and password" | Email and password signup creates the account and signs the browser in immediately, with an unverified email. "By default" means a policy switch exists and its default is "not required"; switching it on restores today's verified flow unchanged. |
| R2 | "a flow for forgot password … should send a link to the email provided by the user who wants to change the password" | The password screen offers **Forgot password?**. The server emails a single-use link to the account's address. The link opens a page where a new password is chosen. |
| R3 | "I can't sign up with another email address? why? let's address that as well" (screenshot: **Create an account with Google**, "Email registration is not available. Sign in with Google to create an account.") | Explained in section 3.2. It is the designed fail-closed result of missing email delivery, not a logic defect. R1 removes the dependency; section 6.9 adds the administrator-visible diagnostic that is missing today. |

### 2.2 Out of scope

| Item | Reason |
| --- | --- |
| Administrator-set or administrator-reset passwords | DS012 line 36 forbids them; nothing in the request needs them. Consequence recorded in section 13: a deployment without email delivery has no self-service recovery. |
| Recovery codes, security questions, SMS | Not requested. |
| Changing a sign-in email | Still `email_change_unsupported`. |
| A Mailjet template for the reset message | Plain text plus minimal HTML first; a template setting would also have to enter the readiness probe. Deferred. |
| CAPTCHA or proof-of-work on signup | Existing per-source budgets are kept; section 7 records the residual abuse risk. |
| Deleting never-verified accounts | Needs a retention policy decision. Deferred. |
| Auditing other agents that key access on an email address | Flagged in section 13 as a follow-up; not changed here. |

## 3. Evidence

### 3.1 History (OBSERVED)

| Date | Commit | Effect |
| --- | --- | --- |
| 1 Sep | `7cd01937` | Password was the default signup method. |
| 11 Sep | `9d13afae` | Passwordless sign-in; only an administrator password remained. |
| 14 Sep | `c750f2b5` | Every password path removed. |
| 17 Sep | `310f936d` | Per-account passwords and **verified** password signup restored on a new design (`authMethod` credential, scrypt `N=32768`, pending signup staged inside the encrypted attempt). |
| 17 Sep | `b76f73b3` | First administrator may be created with the literal password `admin`, without email delivery, leaving the email unverified. |

### 3.2 Why signing up with another email fails today (R3)

| Step | Evidence (OBSERVED) |
| --- | --- |
| The wizard opens the Google-only screen for an unknown address when `config.signup.email` is false and `config.signup.google` is true. | `userPersistoAgent/public/auth/wizard.js:278-283`, screen at `:864-873`. |
| `signup.email` is `registrationOpen && password enabled && emailAvailable`. | `userPersistoAgent/lib/auth/wizardConfig.mjs:16-19`. |
| The signup routes also refuse outright without delivery. | `userPersistoAgent/service/ssoWizard.mjs:50,121` (`registration_disabled`), `userPersistoAgent/lib/oidc/http.mjs:32,275-277`. |
| `emailAvailable` is a two-second, fail-closed probe of EmailAgent's `email_auth_code_status`; only the exact flag `USERPERSISTO_DEV_BOOTSTRAP=true` bypasses it. | `userPersistoAgent/lib/email-agent-client.mjs:33-61`. |
| That tool answers `available: true` only when the Mailjet key, secret and a valid from-address are saved. | `emailAgent/tools/email_tool.mjs:20-27`, `emailAgent/lib/mailjet.mjs:51-57`. |
| The running local deployment has no saved EmailAgent settings: `~/work/testExplorerFresh/.data/emailAgent/` contains only `mcp-config.json`; `settings.enc.json` does not exist. | Directory listing taken during planning, container `ploinky-box-testexplorerfresh-d8f88a10b6e8` up. |
| The running deployment itself reports the state. `password` is enabled, so a disabled method is ruled out as the cause; only email delivery is missing. | `curl http://127.0.0.1:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/setup` during planning returned `"signup":{"email":false,"google":true}`, `"methods":{"password":true,"emailCode":false,"passkey":true,"totp":true,"google":true}`, `"setupComplete":true`. |
| This is specified behaviour. | `docs/specs/DS012-user-persisto.md:107` ("signup routes that would send mail refuse with `403 registration_disabled` while delivery is unavailable") and `:139`. |

Conclusion. The first account was created through a path that needs no mail (Google, or the `admin` first-run exception). Every later email signup needs a delivered code, and no mail provider is configured, so only Google registration is offered. Nothing tells the administrator why. Two workarounds exist today without any code change: save Mailjet credentials in Explorer → Settings → Email Agent, or for local development only set `USERPERSISTO_DEV_BOOTSTRAP=true` for `userPersistoAgent`, which writes codes to the agent log labelled `DEVELOPMENT email code` (`userPersistoAgent/lib/auth/emailAttempts.mjs:385-390`).

### 3.3 Current contracts this plan reverses (OBSERVED)

| Contract | Location |
| --- | --- |
| "There is no … unauthenticated password reset." | `docs/specs/DS012-user-persisto.md:14`; also `:325`, `:339`; `docs/specs/DS013-oauth-oidc.md:84,213`; `userPersistoAgent/lib/auth/passwordManagement.mjs:12-14`. |
| Password signup needs delivery and creates the account with `emailVerified: true`. | DS012 `:87`, `:99`, `:107`; `userPersistoAgent/lib/auth/signup.mjs:201`. |
| "Password, passkey and TOTP sign-in … can be set up only once the account has a verified sign-in mailbox." | DS012 `:267`, `:269`; `userPersistoAgent/lib/auth/operationGrants.mjs:57-62`; UI gate `userPersistoAgent/public/dashboard/enrollment.js:225,270,274`. |
| "A user who forgot a password signs in with another method … recovery for a user with no other usable method remains deferred." | DS012 `:325`; also `:169` ("general recovery … remain deferred"). |
| Review decision D2 of the previous plan: "No administrator-set passwords and no new unauthenticated reset feature." | `docs/plans/email-first-account-authentication-plan-review.md:33`. R2 reopens the second half of D2 on the user's instruction; the first half stands. |

The same review's technical findings still bind new code and are applied in section 6. Their identifiers belong to that review and are unrelated to requests R1 to R3 of this plan: budgets, policy and the live parent are rechecked after the lock is held and before the KDF (review finding R3); a single-use authority is validated before hashing and consumed exactly once inside the serialized commit, with a concurrency test (review finding R9); well-formed Unicode is an encoding requirement wherever a password is created (review finding R10); and every command block sets its own working directory (review finding R8).

### 3.4 Existing seams reused (OBSERVED)

| Need | Seam | Location |
| --- | --- | --- |
| Create an account with an unverified email, its credential, the setup record, a browser-bound completion and the SSO handoff in one commit | `loginWithInitialPassword` creation branch | `userPersistoAgent/lib/auth/initialPassword.mjs:37-63` |
| Browser-bound completion tombstone for lost-response replay | `prepareInitialPasswordCompletion` (method hard-coded) | `userPersistoAgent/lib/auth/emailAttempts.mjs:446-460` |
| Signup eligibility (method enabled, registration open, address unowned) | `assertSignupAllowed` | `userPersistoAgent/lib/auth/signup.mjs:57-63` |
| Creation rules and bounded KDF outside store locks with re-admission checks | `validateNewPassword`, `hashSecret(..., { validateAdmission })` | `userPersistoAgent/lib/auth/userPassword.mjs:66-83`, `signup.mjs:111-115` |
| Replace a password and revoke sessions in one commit | `setAccountPassword` step 4 | `userPersistoAgent/lib/auth/passwordManagement.mjs:68-94`, `lib/auth/generation.mjs:10-16` |
| Hash-only, single-use, expiring bearer record | operation grants in `authChallenge` | `userPersistoAgent/lib/auth/operationGrants.mjs:39-41,140-174,225-242`; index `lib/schema.mjs:40` |
| Marking a mailbox verified inside a commit | `completeContactVerification` | `userPersistoAgent/lib/auth/contactVerification.mjs:77-84` |
| Trusted public origin and service prefix of the current request | `expectedOrigin`, `forwardedServicePath`, `assertSameOrigin`, `rateSourceOf` | `userPersistoAgent/lib/auth/browserBinding.mjs:32-70` |
| Origin membership (loopback, explicit, verified Router origins), re-checked on every read of a live login request | `assertRedirectUriAllowed` inside `getLoginRequest` | `userPersistoAgent/lib/policy.mjs:301-319`, `lib/sso.mjs:39-46` |
| Send budgets per address and per source | `spendSendBudgets`, `consumeMemoryBudget` | `userPersistoAgent/lib/auth/emailAttempts.mjs:72-113` |
| Durable failure throttle, cleared on success | `throttle.mjs` | `userPersistoAgent/lib/auth/throttle.mjs:8-38` |
| Honest delivery outcome and the development log fallback | `deliverCode`, `developmentLogFallback` | `userPersistoAgent/lib/auth/emailAttempts.mjs:375-390` |
| Address-digest email log | `createEmailLog` | `userPersistoAgent/lib/auth/emailAttempts.mjs:359-367` |
| Public static pages and parentless JSON under one guest wildcard | manifest route, `serveStatic` | `userPersistoAgent/manifest.json:37-38`, `service/index.mjs:85-135` |

## 4. Choices to ratify (RATIFY)

Implementation proceeds with the recommended default unless the user says otherwise.

| ID | Question | Recommended default | Why |
| --- | --- | --- | --- |
| Q1 | Policy field and default | `signupEmailVerificationRequired`, boolean, default `false`; environment override `USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED`. | Mirrors `selfRegistrationEnabled` and its override (`lib/policy.mjs:24-28,140-142`). |
| Q2 | Upgraded deployments | The stored policy has no such field, so every existing deployment, including QA and production, switches to unverified signup on upgrade. Recommended: keep the requested default, and set the override to `true` in the QA and production workflows, which are internet-facing. With the override those hosts behave exactly as they do today, including "email sign-up unavailable" wherever mail is not configured; whether they have Mailjet settings was not checked. | DS012 `:111` states there is no stored-policy migration, and the user told the previous review "We don't care about migration. We don't have any accounts registered." (`email-first-account-authentication-plan-review.md:7`), so no migration is planned. Internet-facing hosts are where squatting and bulk signup matter (section 7). Note that `tests/smoke/lib/deploy-qa-userpersisto.test.mjs:146` asserts the QA configuration block sets none of `USERPERSISTO_DEV_BOOTSTRAP`, `USERPERSISTO_AUTH_METHODS` or `USERPERSISTO_SELF_REGISTRATION_ENABLED`; the new name does not match that pattern, but adding it goes against that test's stated intent ("without changing other auth settings") and must be a deliberate, reviewed edit of the workflow and the test together. The user decides. |
| Q3 | What an unverified account may do | Sign in with its password, change that password, verify its email from My Account, link Google with the password as proof. Not: email-code login, passkey or TOTP enrollment. | Keeps the property that an unverified account can hold nothing except a password, which a reset replaces (section 7, T1). Matches the initial administrator today (DS012 `:26`). |
| Q4 | Who may request a reset link | Only an active account that already has an enabled, usable password, while `password` is enabled and delivery is available. | Any account without a password has a verified mailbox or Google and can set one from My Account. Narrowest authority. |
| Q5 | Reset to an unverified address | Yes, the link goes to the address on file whether or not it was verified, and completing the reset marks it verified. | This is the literal request. Following an emailed link proves mailbox control exactly as an emailed code does. It is also the only way a real owner reclaims a squatted address. |
| Q6 | After a reset | The user is not signed in. Every session is revoked (`authGeneration` advances). The page links to the normal sign-in. | The reset page has no live parent; DS012 `:30` requires one for every sign-in. Revocation evicts anyone who held the old password. |
| Q7 | Reset response honesty | Uniform `200` for unknown, blocked and password-less accounts; `502 delivery_failed` on a known provider failure for an eligible account. | `discover` already discloses existence and `methods.password` (DS012 `:105`), so nothing new leaks, and DS012 requires honest delivery reporting. |
| Q8 | The `admin` first-run exception | Unchanged. | Still needed when an operator requires verification through the environment before any account exists. |

## 5. Target experience

### 5.1 Screens

| ID | Screen | Change |
| --- | --- | --- |
| S1 | **Sign in** (email, **Next**) | None. |
| S2 | **Enter your password** | Adds **Forgot password?** below **Log in** when the password is usable for this account and `config.passwordReset` is true. Absent otherwise; no disabled control, no reason text. |
| S4 | **Create an account?** | Now reached whenever registration is open and `password` is enabled, unless verification is required and delivery is unavailable. |
| S5 | **Create your password** | When verification is not required, adds the line "No email verification is needed now. You can verify your email later from My Account." and **Create account** signs the user in directly. |
| S6 | Six-digit verification | Only when verification is required. Unchanged. |
| S7 | **Reset your password** (new, in the wizard) | Read-only email, "We will email a link to choose a new password.", **Send reset link**, **Back**. |
| S8 | **Check your email** (new, in the wizard) | "If *email* can reset its password here, a link is on its way. It expires in 30 minutes.", **Send again** with a 60-second counter, **Back to sign in**. |
| P1 | **Choose a new password** (new standalone page `reset.html`) | Read-only email (`autocomplete="username"`), **New password**, **Confirm new password** (`autocomplete="new-password"`, no `maxlength`), hint, **Change password**. |
| P2 | **Password changed** | "Your password was changed. Every session was signed out." and **Sign in**. |
| P3 | **This link is not valid** | "This reset link is invalid or has expired. Request a new one from the sign-in page." and **Go to sign in**. One message for unknown, expired, used and superseded links. |
| G1 | **Create an account with Google** | Reached only when `password` is disabled, or verification is required and delivery is unavailable. |

### 5.2 Transitions

| From | Event | To |
| --- | --- | --- |
| S1 | Unknown address, `signup.email` true | S4 → S5 |
| S5 | **Create account**, `signup.verification = "none"` | Account created and signed in (SSO callback, or OIDC consent) |
| S5 | **Create account**, `signup.verification = "required"` | S6, as today |
| S5 | `409 signup_verification_required` (policy changed after the page loaded) | Reload configuration, S5 with "Email verification is now required. Choose your password again to continue." |
| S5 | `account_exists` | **Log in instead?**, as today |
| S2 | **Forgot password?** | S7 → S8 |
| S8 | `502 delivery_failed` | S7 with "We could not send the email. Try again later." |
| Email link | Valid token | P1 → P2 |
| Email link | Anything else | P3 |
| P1 | `invalid_password`, `password_mismatch`, `rate_limited` | P1 with the message; the link stays usable |

## 6. Design

### 6.1 Policy (DECISION)

| Element | Change |
| --- | --- |
| `POLICY_FIELDS`, `DEFAULT_POLICY`, `normalizePolicy` (`lib/policy.mjs:11,24-28,88-103`) | Add `signupEmailVerificationRequired`; normalised as `input.signupEmailVerificationRequired === true`, default `false`. |
| `applyEnvironment`, `environmentPolicyOverrides` (`:134-149`) | `USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED`, parsed like the self-registration override: a non-empty value, `true` case-insensitively means required. |
| Manifest (`manifest.json:98` neighbourhood) | Declare the variable, `{ "required": false }`. |
| Tool schema (`mcp-config.json:484-498`, `additionalProperties: false`) | Add the boolean property to `userpersisto_auth_policy_set`. |
| Dashboard endpoint (`service/dashboard.mjs:53-56`) | Add the field to `policy/set`. |
| Read-only metadata (`lib/policy.mjs:13-23`, `tools/registry.mjs:217-228`) | `policy/get` additionally returns `emailDeliveryAvailable`; it joins `READ_ONLY_POLICY_FIELDS`, so echoing it back is refused with `read_only_policy_field`. |

Saving `true` while delivery is unavailable is allowed, because administrators keep their access; the policy page warns instead (section 6.9).

### 6.2 Wizard configuration (DECISION)

`wizardConfiguration` (`lib/auth/wizardConfig.mjs:10-39`) becomes:

| Field | Value |
| --- | --- |
| `signup.email` | Registration open, and `password` enabled, and either verification is not required or email delivery is available. |
| `signup.verification` | `"required"` or `"none"` |
| `passwordReset` | `password enabled && emailAvailable` |

Everything stays advisory; each operation is authorised again by the server. `GET /service/auth/setup` (`service/index.mjs:125-130`) inherits the fields.

### 6.3 Direct signup (DECISION)

New `createSignupAccount` in `lib/auth/signup.mjs`, modelled on `initialPassword.mjs:37-63`. The verified operations (`startSignup`, `resendSignup`, `changeSignupEmail`, `completeSignup`) are untouched and stay reachable whatever the policy says, so every existing verified-signup test keeps its meaning and the wizard simply chooses by configuration.

This choice is what contains the test impact. The shared fixture `signUpWithPassword` (`tests/helpers/setup.mjs:45-53`) drives `startSignup` and `completeSignup` with an injected transport and is used by 21 test files; because those functions and their delivery rules do not change, neither does the fixture nor its callers. Direct signup gets a sibling fixture, `signUpDirect`. Making `startSignup` itself create the account was rejected for exactly this reason, and because it would silently change what "a staged signup" means in the pending-signup lifecycle (DS012 `:85-99`).

1. Normalise the email (`invalid_email`), then `validateNewPassword({ password, passwordConfirmation, email })`. Input refusals leave nothing durable.
2. Validate the live parent.
3. Replay: if this browser's attempt is `completed` with `completion.method === 'passwordSignup'` and the same email, return `replayCompletion`. This recovers a lost response exactly as the first-run exception does.
4. Read-only precheck under the persistence scope: verification not required, otherwise `409 signup_verification_required`; `assertSignupAllowed(email)`; attempt not completed.
5. Spend the per-source signup KDF budget (10 per source, 100 shared, per 15 minutes; `signup.mjs:38-39`), then hash outside every store lock with step 4 as `validateAdmission`.
6. Under `serializePersisted('users')`, repeat step 4, then `prepareNewAccount({ email, emailVerified: false, method: 'passwordSignup' })`, the completion stage and, for SSO, `prepareHandoff()`.
7. One `commitStagedPersistence`: the user and role links, the setup record when first, `stagePasswordCredential`, the handoff, the completion tombstone and the audit `auth.password.register` with reason `<flow>:unverified`.

`prepareInitialPasswordCompletion` is generalised to `prepareDirectCompletion({ parent, browserProof, email, method })`, accepting `initialPassword` and `passwordSignup`; the first-run caller passes its method explicitly.

The setup decision is unchanged: on an unclaimed installation the first direct signup becomes the administrator with `method: 'passwordSignup'`, which is already a valid setup method (`lib/setup.mjs:7`). Its authority equals the existing `admin` exception, so no new exposure is created.

### 6.4 Unverified accounts (DECISION, Q3)

| Rule | Change |
| --- | --- |
| `password.set` | Allowed when the account has a verified mailbox **or** already owns an enabled password credential. A first password still needs a verified mailbox. |
| `passkey.register`, `totp.enroll` | Unchanged: `verified_email_required`. |
| `contact.verify` | Unchanged; this is how the user verifies later. |
| Email-code login, Google authoritative shortcut | Unchanged; both need a verified mailbox (`lib/auth/signIn.mjs`, `lib/externalIdentities.mjs:63-74`). |

`assertOperationAllowed(user, operation)` is synchronous and sees only the user. Add an asynchronous `assertOperationAllowedFor(store, user, operation)` that reads the password credential only for `password.set` on an unverified account, and use it at the six call sites (`operationGrants.mjs:85,125,181,250`, `passwordManagement.mjs:56,77`). This also removes today's dead end in which the initial administrator cannot change the password until mail is configured. My Account mirrors it: `enrollment.js:225,270,274` allow the Password row when the mailbox is verified or a password is configured.

### 6.5 Password reset (DECISION)

New `lib/auth/passwordReset.mjs`.

| Property | Value |
| --- | --- |
| Token | 32 random bytes, base64url (43 characters), format `^[A-Za-z0-9_-]{43}$`. |
| Storage | `authChallenge`: `challengeId = "reset:" + sha256("userpersisto:password-reset:" + token)`, `subject = userId`, `purpose = "password-reset"`, `codeHash = ""`, `expiresAt = now + 30 min`, `correlationId = JSON { email, generation, credentialVersion, flow }`. The token itself is never stored. |
| Live tokens | One per account; issuing deletes the account's earlier `password-reset` records in the same commit. |
| Invalidation | Use, expiry, a newer request, any `authGeneration` change, a credential version change, a different email on the account. Refused, without deletion, while the account is blocked or `password` is disabled. |

`requestPasswordReset({ parent, email, rateSource, validateParent, resetBaseUrl, flow, deliver })`:

1. Normalise the email (`invalid_email`), validate the live parent, require `password` enabled (`auth_method_disabled`) and delivery available (`409 password_reset_unavailable`).
2. `spendSendBudgets(email, rateSource)` for every request, eligible or not, so a probe costs the same as a send.
3. Resolve eligibility (Q4). Ineligible: answer `200` and stop.
4. Under `serializePersisted('users')`, one commit: delete earlier reset records, create the new one, audit `auth.password.reset.request`.
5. Outside every lock, deliver through EmailAgent; apply the development log fallback (`DEVELOPMENT password reset link`) under the exact `USERPERSISTO_DEV_BOOTSTRAP=true` flag; write an `emailLog` row with template `password-reset` and the address digest only.
6. A known provider failure deletes the record just issued and answers `502 delivery_failed`. A transport error (`unknown`) answers `200`.

`resetBaseUrl` is built by the HTTP layer, never from the request body.

| Flow | Origin | Path |
| --- | --- | --- |
| SSO | The origin of the live login request's `redirectUri`. `getLoginRequest` re-validates that callback against the membership rule on every read (`lib/sso.mjs:39-46`), and the wizard is served on that same origin (DS012 `:149`). The route additionally requires it to equal `expectedOrigin(req)` and refuses with `403 invalid_origin` otherwise. | `forwardedServicePath(req)` + `auth/reset.html` |
| OIDC | The configured issuer origin, which the interaction already requires as the request `Origin` (`lib/oidc/http.mjs:236`). | `servicePath(issuer)` + `auth/reset.html` |

The emailed origin is therefore always one the membership rule has just accepted, so a forged forwarded host can never reach an email, and no second managed-origin read is needed.

The link is `<resetBaseUrl>#token=<token>`. A fragment is never sent to a server, so the token stays out of Router and agent access logs and out of `Referer`. The page reads it, removes it from the address bar with `history.replaceState`, and keeps it in memory only.

`inspectPasswordReset({ token, rateSource })` is read-only: it returns `{ email, expiresAt, passwordPolicy }` or `400 reset_link_invalid`, spends a per-source budget first, and consumes nothing.

`completePasswordReset({ token, password, passwordConfirmation, rateSource })` follows the order of `setAccountPassword`:

1. Token format, per-source budget, read-only lookup and validity. Failure is `400 reset_link_invalid`; a stale or expired record found here is deleted.
2. `validateNewPassword` with the account email. Predictable input failures never touch the token.
3. Per-source KDF budget, then hashing outside every store lock, revalidating step 1 on admission.
4. Under `serializePersisted('users')`, revalidate again and commit once: delete every reset record of the account, `stagePasswordCredential`, set `emailVerifiedAt` and `contactEmail` when the mailbox was unverified (the `contactVerification.mjs:77-84` write), `stageCredentialGenerationAdvance`, clear the address's password failure throttle, audit `auth.password.reset`.
5. Answer `200 { ok: true }`. No session, handoff or cookie is issued.

Two concurrent completions with one link both hash, then serialise at step 4; the second finds no record and writes nothing. A reset racing a My Account password change is decided the same way: whichever commits first changes the credential version and generation the other was bound to.

### 6.6 HTTP surfaces (DECISION)

| Surface | Addition | Notes |
| --- | --- | --- |
| Router SSO JSON (`service/ssoWizard.mjs:26-51`) | `/service/auth/signup/create` | In `ROUTES` and `REPLAYABLE`; not in `EMAIL_PROBES` or `SIGNUP_DELIVERY`. Replay guard mirrors `:86-92` with method `passwordSignup` and the submitted email. Response equals `signup/verify`. |
| Router SSO JSON | `/service/auth/password/forgot` | In `ROUTES` and `EMAIL_PROBES`. Body `{ requestId, email }`. |
| OIDC (`lib/oidc/http.mjs:26-32`) | native `signup-create` | Fields `email`, `password`, `passwordConfirmation`; method `password`; `amr: ['pwd']`; failure re-renders with `failure.action = 'signup-create'` and the attempted email (`failureFrom` already carries `reason`, `:164-170`). Two persistence boundaries, as `signup-verify`: a stop between them is recovered by repeating the action (replay) or by logging in. |
| OIDC | JSON `password-forgot` | In `JSON_ACTIONS`; method `password`. |
| Parentless JSON (new `service/passwordReset.mjs`) | `POST /service/auth/password/reset/status`, `POST /service/auth/password/reset` | Dispatched in `handlePost` before the wizard handler (`service/index.mjs:153-154`), because that handler demands a `requestId`. `assertSameOrigin`, JSON object body, the existing 64 KiB bound. No parent, no browser proof, no ambient cookie authority; the token is the only authority, so CSRF has nothing to ride on. |
| Static | `public/auth/reset.html`, `reset-main.js`, `reset.js` | Served by the existing `serveStatic` under the guest wildcard; add `Referrer-Policy: no-referrer` for `reset.html`. An extension-less path would fall back to the wizard shell (`service/index.mjs:102-110`), so the page has a real file name. |

Construction-time test seam: `startService(port, { deliverPasswordReset })`, beside `deliverEmail` and `emailStatus` (`service/index.mjs:281-291`). No request or environment variable selects a transport.

### 6.7 EmailAgent (DECISION)

| Element | Change |
| --- | --- |
| `emailAgent/lib/passwordResetMessage.mjs` (new) | Builds subject "Reset your password", a text part and a minimal HTML part containing the link, the expiry in minutes, and "If you did not ask for this, ignore this message; your password stays unchanged." Validates `resetUrl`: absolute `http` or `https`, no credentials, at most 2048 characters. |
| `emailAgent/tools/email_tool.mjs:13-39` | Handler `email_send_password_reset` → `sendText`; returns `{ providerMessageId, correlationId }`. Never logs the URL. |
| `emailAgent/tools/invocation-context.mjs:33-38` | Add the tool to `internalTools` (agent callers only). |
| `emailAgent/mcp-config.json` | New entry copied from `email_send_auth_code` (`:224-266`), properties `to`, `resetUrl`, `expiresInMinutes`, `correlationId`, `required: ["to", "resetUrl"]`, `additionalProperties: false`, and `"tags": ["internal"]`. The tag is what lets an agent caller through the Router's tool policy (section 8.1); without it every call is denied. |
| Router tool policy | No code change, but an operational rule: the Router learns new tools only when it starts (section 8.1). Upgrading a running workspace therefore needs a Router restart before reset mail can be sent; until then requests fail closed with `delivery_failed`. |
| `userPersistoAgent/lib/email-agent-client.mjs` | `sendPasswordResetEmail`, same result contract as `sendAuthCode` (`:65-88`): an MCP error or a missing `providerMessageId` is a known failure. |
| Readiness | Reuses `email_auth_code_status`; it already proves sender credentials and address, which is all a plain message needs. |

A dedicated tool, rather than the existing `email_send_text`, keeps message ownership and the "never log the secret" rule inside EmailAgent, as `email_send_auth_code` does. Both agents ship from one repository, so version skew is limited to a partial restart; a missing tool surfaces as `delivery_failed`.

### 6.8 Limits

| Control | Scope | Limit | Refusal |
| --- | --- | --- | --- |
| Direct signup hashing | Memory, per rate source (shared bucket when absent) | 10 per source, 100 shared, per 15 minutes (existing `signup-kdf-source`) | `rate_limited` |
| Reset requests | Memory, per address and per source (existing send budgets) | 5 per address, 20 per source, 200 shared, per 15 minutes | `rate_limited` with `retryAfter` |
| Reset status and completion | Memory, per source | 20 per source, 300 shared, per 15 minutes | `rate_limited` |
| Reset hashing | Memory, per source | 10 per source, 100 shared, per 15 minutes | `rate_limited` |
| KDF gate | Process (existing) | 2 in flight, 16 queued, 5 s | `rate_limited`, `retryAfter: 5` |

A 256-bit token needs no guess counter; the per-source budget bounds lookups.

"Per source" is real on the SSO and reset routes, which are guest routes and receive the Router's HMAC-partitioned `x-ploinky-rate-source` (section 8.1). OIDC interaction routes are `public`, receive no such header and fall into the shared bucket (`browserBinding.mjs:43-48`), so under OIDC the shared figures are the effective limits and one abusive client can exhaust them for everyone until the window rolls. That exposure exists today for OIDC signup and login; this plan does not widen it, and the reset completion endpoints are never on the OIDC surface.

### 6.9 Administrator diagnostics (DECISION, R3)

| Place | Change |
| --- | --- |
| Authentication policy page (`public/dashboard/authentication.html:40`, `management.mjs:79,195,293`) | Checkbox **Require email verification at sign-up**. A status line driven by `emailDeliveryAvailable`: when false, "Email delivery is not configured. Unavailable: email codes, password reset" and, when verification is required, "email sign-up". Links to Settings → Email Agent. |
| Users page (`management.mjs:415`) | Row meta gains "Email: verified" or "Email: unverified". The list payload already carries `emailVerifiedAt` (`lib/users.mjs:9,19,220`: `sanitizeUser` strips only three private fields), so this is a rendering change. An administrator granting the `user` role can then see whether the address was ever proven. |

## 7. Security analysis

| ID | Threat | Treatment |
| --- | --- | --- |
| T1 | Pre-hijacking: an attacker registers a victim's address, then waits. | The unverified account can hold only a password (section 6.4), so nothing planted survives a reset. A Google arrival for that address must prove the account with its password (`externalIdentities.mjs:63-74`), so there is no silent merge into the attacker's account. The real owner reclaims the address with **Forgot password?**, which verifies the mailbox and revokes every session. Usability gap: an owner who arrives through Google lands on the collision screen, where the only proof offered for an unverified account is its password (`oidc-methods.test.mjs:399-401` pins `eligibleMethods` to `['password']`); the reset link is reachable only by going **Back**, entering the email and opening the password screen. DS012 must describe that path, and offering **Forgot password?** on the collision proof screen is a recommended follow-up (section 13). Residual: without email delivery the owner cannot reclaim the address, and blocking the account does not free it. |
| T2 | Host-header poisoning of the emailed link. | The origin is the live parent's freshly validated callback origin (SSO) or the configured issuer (OIDC), and must equal the Router-set forwarded origin (section 6.5). Nothing from the body or from client-supplied headers contributes. |
| T3 | Token leakage through logs, history or `Referer`. | Fragment transport, `history.replaceState`, `no-referrer`, `no-store`, hash-only storage, 30 minutes, single use, EmailAgent never logs the URL. |
| T4 | Account enumeration through the reset endpoint. | Uniform `200`; the only distinguishable answer (`delivery_failed`) concerns accounts that `discover` already reports as having a password. |
| T5 | Mail bombing a victim. | Five sends per address per 15 minutes, source budgets, one live token. |
| T6 | Old sessions surviving a reset. | `stageCredentialGenerationAdvance` in the same commit: Router sessions end at the next revalidation (30 s by default), stored OIDC artifacts are removed, ID tokens expire within 300 s. |
| T7 | A mistyped address at signup. | The account belongs to whoever receives mail there, once a reset is requested. Accepted consequence of R1 and R2 together; the S5 copy and the My Account prompt encourage verification. |
| T8 | Bulk account creation now that signup is durable without a code. | 100 shared creations per 15 minutes is the ceiling (about 9,600 a day). Every flush rewrites the whole snapshot (DS012 `:317`), so internet-facing hosts should require verification (Q2). |
| T9 | Unclaimed installation. | Unchanged in kind: the `admin` exception already allows a first claim without mail. |
| T10 | Relying parties trusting the address. | The ID token already emits `email_verified: false` for such accounts (`lib/oidc/provider.mjs:23`), and the SSO projection carries `emailVerified` (`lib/authorization.mjs:95`). |

## 8. File-by-file work breakdown

| File | Change |
| --- | --- |
| `userPersistoAgent/lib/policy.mjs` | New field, override, read-only `emailDeliveryAvailable`. |
| `userPersistoAgent/manifest.json` | Declare the override variable. |
| `userPersistoAgent/mcp-config.json` | Policy tool schema and description. |
| `userPersistoAgent/tools/registry.mjs` | `policy_get` returns `emailDeliveryAvailable`. |
| `userPersistoAgent/lib/auth/wizardConfig.mjs` | `signup.verification`, `passwordReset`, new `signup.email` rule. |
| `userPersistoAgent/lib/auth/signup.mjs` | `createSignupAccount`. |
| `userPersistoAgent/lib/auth/emailAttempts.mjs` | `prepareDirectCompletion`. |
| `userPersistoAgent/lib/auth/initialPassword.mjs` | Pass its method to the generalised helper. |
| `userPersistoAgent/lib/auth/operationGrants.mjs`, `passwordManagement.mjs` | `assertOperationAllowedFor`; update the comment at `passwordManagement.mjs:12-14`. |
| `userPersistoAgent/lib/auth/passwordReset.mjs` (new) | Request, inspect, complete. |
| `userPersistoAgent/lib/email-agent-client.mjs` | `sendPasswordResetEmail`. |
| `userPersistoAgent/service/ssoWizard.mjs` | Two routes and the replay guard. |
| `userPersistoAgent/service/passwordReset.mjs` (new), `service/index.mjs` | Parentless routes, seam, response header. |
| `userPersistoAgent/lib/oidc/http.mjs` | `signup-create`, `password-forgot`. |
| `userPersistoAgent/public/auth/wizard.js`, `sso-adapter.js`, `oidc-adapter.js` | `createSignup`, `forgotPassword`, S5 copy, S7, S8, new error copy, `signup-create` branch in `handleInitialFailure`. |
| `userPersistoAgent/public/auth/reset.html`, `reset-main.js`, `reset.js` (new), `auth.css` | The reset page, mountable with injected dependencies like `wizard.js`. |
| `userPersistoAgent/public/dashboard/authentication.html`, `management.mjs`, `enrollment.js`, `service/dashboard.mjs` | Policy checkbox and warning, Users badge, Password row rule, `policy/set` field. |
| `emailAgent/lib/passwordResetMessage.mjs` (new), `tools/email_tool.mjs`, `tools/invocation-context.mjs`, `mcp-config.json` | The new tool. |
| `userPersistoAgent/tests/helpers/setup.mjs` | Add `signUpDirect`; `signUpWithPassword` unchanged. |
| `tests/smoke/lib/auth.mjs` (`signUpThroughUserPersisto`, `:167-190`), its unit tests, `tests/smoke/README.md:56-74` | The helper demands an emailed code today (`requireEmailCodeCommand`, then waits for `input[name="code"]`). After **Create account** it must accept either the code screen or direct completion, and need `SMOKE_EMAIL_CODE_COMMAND` only in the first case. The three headless release gates sign up through this helper, so it belongs to the same change. |
| `userPersistoAgent/tests/browser/wizard-flows.mjs`, `tests/browser/README.md` | Section 11.3; `:170-174` inverts. |
| Other tests and documents | Sections 10 and 11. |
| Ploinky | No source change (section 8.1). Optional inventory regeneration. |

Source constraints enforced by an existing test: `tests/prod-parity.test.mjs:224-239` scans every non-test source file for a list of retired strings (among them `admin-login`, `admin/login`, `Admin password`, `Administrator password`, `\bPROD\b`) and fails if any UserPersisto MCP tool has `password` in its name or in an input property name. New file names, route names and copy must avoid those strings, and no UserPersisto MCP tool is added: reset is reachable only through the browser endpoints, and the policy property `signupEmailVerificationRequired` does not match. The EmailAgent tool is outside that scan root.

### 8.1 Ploinky

No Ploinky source change is required. The findings below come from a delegated read-only trace of Ploinky `master` at `142a92ff`; every location cited in this table was then re-read against the file during planning and matched. Paths are relative to the Ploinky repository.

| Question | Finding (OBSERVED) | Consequence for this plan |
| --- | --- | --- |
| Do new paths need a manifest or Router entry? | A `/*` entry matches the prefix and everything below it (`cli/server/policy/HttpRouteAccessPath.js:84-90`). | `…/service/auth/reset.html`, `…/password/forgot`, `…/password/reset` and `…/signup/create` are covered by the existing guest wildcard (`userPersistoAgent/manifest.json:37-38`). |
| Can a browser with no cookies use them? | A guest session is minted for any method on a guest route (`cli/server/authHandlers/authContext.js:842-854`); only `public` routes are method-guarded (`cli/server/policy/HttpRouteAccessPolicy.js:87-98`). | The emailed link works in a fresh browser: GET the page, then POST. |
| Does the Router enforce CSRF or Origin on guest POSTs? | No. The browser-mutation proof runs only for `local` and `sso` sessions (`cli/server/RoutingServer.js:668-672`). | The agent's `assertSameOrigin` is the only same-origin check on these routes, exactly as for today's wizard. The reset endpoints carry no ambient authority, so nothing can be forged by a cross-site request that the token holder could not do directly. |
| Can the agent trust the forwarded headers? | Client `forwarded`, `x-forwarded-*` and `x-ploinky-*` are dropped, then `x-forwarded-proto`, `x-forwarded-host` and `x-forwarded-prefix` are written from the route plan (`cli/server/proxy/sanitizeRequestHeaders.js:71-89`); on a published hostname they carry `https` and the public authority (`cli/server/edgeRoutePlan.js:367-384`). | Section 6.5's equality check against the validated parent origin holds on loopback and on public hosts. |
| Is per-source rate limiting available to the parentless endpoints? | `x-ploinky-rate-source` is an HMAC partition of the transport source, emitted only for guest routes; on a public host the source is `cf-connecting-ip` (`cli/server/routerHandlers.js:329-354`). | The limits in section 6.8 are per source on the SSO and reset routes. OIDC routes are `public`, receive no such header and share one bucket, as they do today. |
| Where should **Sign in** on the reset page go? | `/auth/login` accepts only `returnTo`, `prompt` and `agent`; `returnTo` must be a same-site relative path (`cli/server/authHandlers/authRoutes.js:212-214`, `authHandlers/shared.js:94-97`). There is no notice parameter. | P2 links to `/auth/login?returnTo=%2F`. The success message lives on the reset page; the Router shows none. |
| May the agent redirect? | The Router strips agent `Location` headers that point at loopback or private addresses (`tests/unit/proxyHeaders.test.mjs:61-88`). | The reset endpoints answer JSON only; the page navigates. |
| Does the new EmailAgent tool need a Ploinky allow-list entry? | No per-caller allow-list exists. An agent caller may invoke a tool whose `mcp-config.json` tags make it `internal` (`cli/server/policy/McpToolPolicy.js:137-152`). A tool with no persisted policy entry is denied (`:134-135`), and entries are added by `mcpToolPolicy.bootstrap` when the Router starts (`cli/server/RoutingServer.js:1182`), never overwritten. | The new tool entry must carry `"tags": ["internal"]`. On an existing workspace the tool stays denied until the Router next starts; until then resets fail closed as `delivery_failed`. Fresh deployments are unaffected. |
| Does any provider-bridge (`sso_*`) method or Router error mapping change? | The new flows are browser-to-agent HTTP and agent-to-agent MCP; they never pass through `cli/server/auth/genericAuthBridge.js` or `authHandlers/userAdminRoutes.js:48-57`. | None. `password_unsupported` stays mapped for administrator requests. |
| Do Ploinky tests or documents need updating? | `tests/security/authorization/agent-inventory.mjs` is a generated, pinned snapshot that lists EmailAgent's eight tools and UserPersisto's `/service/auth/*` routes; the offline harness checks only self-consistency and fixed agent counts (`tests/security/authorization/inventory-probes.test.mjs:160-171`), so it stays green untouched. No Ploinky document mentions password reset or email verification, and `ploinky/CLAUDE.md:7` excludes the historical specifications from behaviour work. | Optional: regenerate the inventory with `inventory-generate.mjs` and re-pin the AssistOSExplorer revision so the live authorization suite covers the new tool and routes. |

## 9. Phases and ordering

Phases 3 and 4 do not depend on phase 2 and may run in parallel. Each phase ends with its listed commands green before the next begins. Tests are written first in each phase and must fail for the expected reason before the implementation makes them pass.

Six test files in the commands below do not exist yet and are created by the phase that first names them: `tests/signup-policy.test.mjs` (phase 1), `tests/signup-direct.test.mjs` and `tests/signup-direct-http.test.mjs` (phase 2), `tests/password-reset.test.mjs` and `tests/password-reset-http.test.mjs` (phase 5), `tests/password-reset-ui.test.mjs` (phase 6). Every other file named was confirmed present at `f913e702`. `npm test` in each agent runs `node --test tests/*.test.mjs`, so new files join the whole-suite run without further wiring.

| Phase | Content | Depends on | Verification (from `userPersistoAgent/` unless stated) |
| --- | --- | --- | --- |
| 0 | Work from `f913e702` or later in a dedicated worktree, and record a baseline. The clone's `origin` is the retired PloinkyRepos URL, so fetch from `assistos-ai`: `git -C <clone> fetch assistos-ai`, then `git -C <clone> worktree add <workspace>/.worktrees/optional-signup-verification -b feature/optional-signup-verification assistos-ai/main`. Build in the worktree, not in the shared clone: the clone is level with the remote as of 13:10 on the planning day, but other sessions commit, rebase and push from it (one did so during planning), so work there would be rebased under the implementer. This plan file is untracked in the shared clone and is copied into the worktree. | none | `git -C <clone> merge-base --is-ancestor f913e702 HEAD`; `npm test` here and in `emailAgent/`; `npm run test:unit` in `tests/smoke`; record counts. For orientation only: the `b76f73b3` commit message reports 574 UserPersisto and 661 smoke unit tests, and `310f936d` reports 9 EmailAgent tests. The recorded baseline, not these figures, is the reference for later phases. |
| 1 | Policy, wizard configuration, policy tool schema, dashboard field. Tests that build the wizard configuration from a real store and expect today's gating pin `signupEmailVerificationRequired: true` in their fixture; they are kept, not deleted, and a default-policy twin is added beside each (section 11.1). | 0 | `node --test tests/signup-policy.test.mjs tests/registration.test.mjs tests/prod-parity.test.mjs tests/dashboard-admin-http.test.mjs tests/tools.test.mjs` |
| 2 | Direct signup on the domain, SSO and OIDC surfaces. | 1 | `node --test tests/signup-direct.test.mjs tests/signup.test.mjs tests/initial-password.test.mjs tests/store-durability.test.mjs`, then `node --test tests/signup-direct-http.test.mjs tests/signup-http.test.mjs tests/wizard-sso-http.test.mjs tests/oidc-methods.test.mjs` |
| 3 | Password change for unverified accounts. | 0 | `node --test tests/user-password.test.mjs tests/account-lifecycle-http.test.mjs tests/account-enrollment-ui.test.mjs` |
| 4 | EmailAgent tool. | 0 | In `emailAgent/`: `npm test` |
| 5 | Reset domain, parentless routes, SSO and OIDC request surfaces. | 3, 4 | `node --test tests/password-reset.test.mjs tests/password-reset-http.test.mjs tests/email-agent-client.test.mjs tests/oidc-methods.test.mjs` |
| 6 | Wizard, reset page, dashboard UI. | 2, 5 | `node --test tests/auth-ui.test.mjs tests/password-reset-ui.test.mjs tests/dashboard-users-ui.test.mjs tests/account-enrollment-ui.test.mjs` |
| 7 | Specifications and documents (section 10). | 6 | `node --test tests/prod-parity.test.mjs`; manual read of DS012 and DS013 against the code. |
| 8 | Whole suites, real browser, conditional deployment acceptance (section 11). | 7 | `npm test` in both agents; `npm run test:unit` in `tests/smoke`; the browser runner. |

## 10. Specification and document updates

| Document | Change |
| --- | --- |
| `docs/specs/DS012-user-persisto.md` | Summary and `:14` (remove "unauthenticated password reset" from the exclusions; state the default). `:22-26` (direct signup claims the installation; the email stays unverified). `:75` (audit actions `auth.password.reset.request`, `auth.password.reset`). `:87-99` (keep as the required-verification lifecycle; add "Direct signup"). `:105-107` (availability rules, `passwordReset`). `:111` (policy field, override, no migration, the upgrade consequence). `:139-141` (S2, S5, S7, S8, the reset page). `:257`, `:263-273` (unverified accounts may change a password). `:277` (a reset advances the generation and verifies the mailbox). `:325`, `:329` (recovery is no longer deferred for accounts with delivery; what remains deferred). `:333-349` (verification contract, section 11.1). New subsection "Password reset by emailed link". |
| `docs/specs/DS013-oauth-oidc.md` | `:82` (actions `signup-create`, `password-forgot`), `:84` (direct signup and its two boundaries), `:209` (required cases), `:213` (scope sentence). |
| `docs/specs/matrix.md:17` | Summary sentence. |
| `docs/architecture.html`, `docs/workspace-operations.html`, `docs/wiki.html` | Signup and recovery wording; the delivery diagnostic. |
| `docs/deploy-skills-explorer.md:124-131` | Ordinary signup no longer needs delivery by default; the QA and production override (Q2). |
| `userPersistoAgent/tests/browser/README.md`, `tests/smoke/README.md` | New flows and fixtures. |

## 11. Verification

### 11.1 Regression matrix

| Area | Cases |
| --- | --- |
| Policy | Default `false`; stored value; environment override wins and is reported; unknown values; `emailDeliveryAvailable` refused on write; schema rejects extra properties. |
| Configuration | `signup.email` true without delivery when not required; false without delivery when required; `passwordReset` follows delivery and the `password` method. |
| Direct signup | No mail sent; `emailVerifiedAt` empty; credential usable at once; exactly `selfRegistered` after setup; first account becomes administrator with `method: 'passwordSignup'`; concurrent direct, verified, Google and `admin` completions yield one administrator; `account_exists`, `registration_disabled`, `auth_method_disabled`, `signup_verification_required`; every creation rule; parent expiry before and after queued hashing; a failure at each staged write leaves no user, credential or setup record after restart; lost-response replay to the same browser only; cross-browser replay refused; budget exhaustion. |
| Verified signup | Every existing case unchanged, with the policy both ways. |
| Unverified account | Password login; email-code login refused; passkey and TOTP `verified_email_required`; password change succeeds and advances the generation; contact verification then unlocks the rest; Google collision offers only the password proof. |
| Reset request | Eligible, unknown, blocked, password-less, `password` disabled, delivery unavailable; uniform body; budgets spent for all; a second request invalidates the first; `delivery_failed` deletes the record; development log only under the exact flag; the link origin equals the validated request origin; a forged forwarded host is refused before any mail. |
| Reset completion | Valid; wrong format; unknown; expired; used; superseded; generation changed; credential changed; account blocked; `password` disabled; input errors keep the link; two concurrent completions write once; mailbox becomes verified; old password refused; failure throttle cleared; Router session `401 session_revoked`; OIDC artifacts gone; no session, cookie or handoff issued; snapshot and logs free of the token and the password. |
| EmailAgent | Agent caller required; user and administrator callers refused; URL validation; nothing logged; tool listed with its schema. |
| UI | S2 link presence rules; S5 copy by mode; direct completion on both adapters; `signup-create` failure re-render; S7, S8, cooldown; reset page states, fragment removal, empty inputs after every transition, `autocomplete`, absent `maxlength`; Users badge; policy checkbox and warning; Password row for an unverified account. |
| Parity | `tests/prod-parity.test.mjs` still proves nothing reads `PROD`. |

#### 11.1.1 Existing assertions that change

From a delegated inventory of the `f913e702` tests; every row below was re-read against its file during planning.

| Location | Asserts today | Becomes |
| --- | --- | --- |
| `userPersistoAgent/tests/dashboard-managed-origins.test.mjs:138` | The policy page saves exactly `allowedRedirectOrigins`, `enabledAuthMethods`, `selfRegistrationEnabled`. | Adds `signupEmailVerificationRequired`. |
| `userPersistoAgent/tests/dashboard-managed-origins.test.mjs:115-119` | Nine read-only policy fields are refused on write. | Adds `emailDeliveryAvailable`. |
| `emailAgent/tests/runtime.test.mjs:145-154` | `tools/list` is exactly eight names. | Nine, with `email_send_password_reset`. |
| `emailAgent/tests/tool-authorization.test.mjs:33-52`, `auth-code-message.test.mjs:28-32` | Agent-only tools and the code tool's schema. | Parallel cases for the new tool and its schema. |
| `userPersistoAgent/tests/oidc-http.test.mjs:200` | Cross-origin POST is refused for eight actions. | Adds `signup-create`, `password-forgot`. |
| `userPersistoAgent/tests/oidc-methods.test.mjs:277-278` | The native-action set and the disabled-method list. | `signup-create` joins the native set; both new actions join the list. |
| `userPersistoAgent/tests/auth-ui.test.mjs:1181-1205` | Request bodies of every SSO adapter action and every OIDC native form. | Adds `createSignup`, `forgotPassword`. |
| `userPersistoAgent/tests/auth-ui.test.mjs:296-309` | Unknown address: **Create an account?**, the Google screen, or **No account found**, by mocked configuration. | Same three outcomes; fixtures gain `signup.verification`, and a default-mode case proves the offer appears without delivery. |
| `userPersistoAgent/tests/prod-parity.test.mjs:100,179` | `signup.email` under each `PROD` value. | Asserted for both policy values. |
| `userPersistoAgent/tests/browser/wizard-flows.mjs:170-174` | With delivery disabled, a second unknown address reaches **Create an account with Google** with no password input and no account. | Under the default policy it reaches **Create an account?** and can sign up; the Google-only expectation moves to a required-mode fixture. |
| `tests/smoke/lib/auth.mjs:167-190` | Signup always ends in an emailed code. | Either outcome (section 8). |

#### 11.1.2 Existing assertions that must stay green, unchanged

These look affected and are not. Each is a guard against implementing the change in the wrong place.

| Location | Asserts | Why it stays |
| --- | --- | --- |
| `userPersistoAgent/tests/email-readiness.test.mjs:86-89` | Without delivery, `signup/start`, `signup/resend` and `signup/email` answer `403 registration_disabled`. | Those routes remain the verified flow and still need mail. Direct signup is a different route. |
| `userPersistoAgent/tests/registration-http.test.mjs:101`, `wizard-sso-http.test.mjs:191` | No account exists before the code is verified. | True of the verified flow, which is untouched. |
| `userPersistoAgent/tests/registration.test.mjs:90`, `signup.test.mjs:523`, `initial-password.test.mjs:130-134` | An account created through `signUpWithPassword` has `emailVerifiedAt` set. | The fixture stays on the verified path (section 6.3). |
| `userPersistoAgent/tests/account-lifecycle-http.test.mjs:304-309` | An unverified account **without a password** is refused `password.set` with `verified_email_required`. | A first password still needs a verified mailbox (section 6.4). The new success case, an unverified account that already has a password, is added beside it. |
| `userPersistoAgent/tests/account-lifecycle-http.test.mjs:103-106` | An unverified account is refused `totp.enroll` and `passkey.register`. | Unchanged by design; this is the property threat T1 relies on. |
| `userPersistoAgent/tests/dashboard-users-ui.test.mjs:140-153` | The Users page offers no create-user form and no password reset. | Administrator-side reset stays absent; the new flow is self-service only. |
| `userPersistoAgent/tests/oidc-methods.test.mjs:399-401` | An unverified account's Google collision offers only the password proof. | Unchanged; now the common case. |

### 11.2 Reproducible commands

The environment follows `docs/plans/email-first-account-authentication-plan.md` section 19.2. A missing runtime, dependency or browser is reported as BLOCKED, never as a pass.

```sh
export WORKSPACE=/absolute/path/to/workspace   # contains AssistOSExplorer/ and ploinky/
export PLOINKY_ROOT="$WORKSPACE/ploinky"
export PLOINKY_AGENT_RUNTIME_ROOT="$WORKSPACE/ploinky/Agent"
export PLOINKY_AGENTLIB_DIR=/absolute/path/to/shared/achillesAgentLib
```

```sh
cd "$WORKSPACE/AssistOSExplorer/userPersistoAgent"
npm ci --ignore-scripts        # only when node_modules is absent
npm test
```

```sh
cd "$WORKSPACE/AssistOSExplorer/emailAgent"
npm test
```

```sh
cd "$WORKSPACE/AssistOSExplorer/tests/smoke"
npm run test:unit
```

```sh
cd "$WORKSPACE/AssistOSExplorer"
WIZARD_BROWSER_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  node userPersistoAgent/tests/browser/wizard-flows.mjs
```

### 11.3 Real-browser coverage to add to `wizard-flows.mjs`

| Surface | Checks |
| --- | --- |
| SSO | With no mail transport: S1 → S4 → S5 → signed in, no code screen; the second account lands on My Account with "Email: unverified" visible to the administrator. With a captured transport: **Forgot password?** → the captured link opens P1 in a fresh browser context with no cookies → P2 → the old password fails, the new one works, the first context's session ends. A used link shows P3. The address bar holds no token after load. |
| OIDC popup | Native `signup-create` carries the `up_browser` proof and finishes the interaction; a refused submission re-renders S5 with the email and empty inputs; `password-forgot` answers in the popup. |
| Required mode | With the override set, the run matches today's verified flow. |

### 11.4 End-to-end acceptance on a fresh local deployment

Only when the user asks for a deployment. On a fresh `testExplorerFresh` workspace with no EmailAgent settings: claim the installation, sign up a second address with a password and no code, observe the unverified badge, change that password from My Account. Then, with `USERPERSISTO_DEV_BOOTSTRAP=true`, request a reset, take the link labelled `DEVELOPMENT password reset link` from the agent log, complete it, and confirm the earlier session is refused within the revalidation interval. Real Mailjet delivery is a separate check and is BLOCKED without credentials.

Both repositories are on `main` and `master`, so the `ploinky-proxy` acceptance gate does not bind this change. If the work is ever carried on a `ploinky-proxy` branch, the fresh deployment and the three headless gates in `ploinky/CLAUDE.md` become mandatory.

## 12. Acceptance checklist

| # | Criterion | Proof |
| --- | --- | --- |
| 1 | With no mail provider and default policy, an unknown address can sign up with a password and is signed in. | `tests/signup-direct-http.test.mjs`; browser run. |
| 2 | That account has an empty `emailVerifiedAt`, role `selfRegistered`, and `email_verified: false` in OIDC claims. | `tests/signup-direct.test.mjs`, `tests/oidc-methods.test.mjs`. |
| 3 | With the policy or the override requiring verification, behaviour equals `f913e702`. | Existing signup suites green with the override set. |
| 4 | **Forgot password?** appears only when usable, and the emailed link changes the password once. | `tests/auth-ui.test.mjs`, `tests/password-reset-http.test.mjs`. |
| 5 | A reset revokes sessions, verifies the mailbox and never signs anyone in. | `tests/password-reset.test.mjs`. |
| 6 | The token is absent from the snapshot, the logs, the email log and every request line. | Snapshot and log scans in `tests/password-reset.test.mjs`. |
| 7 | A forged forwarded host never reaches an email. | `tests/password-reset-http.test.mjs`. |
| 8 | An unverified account can change its password and cannot enroll a passkey or TOTP. | `tests/account-lifecycle-http.test.mjs`. |
| 9 | Administrators see why email features are unavailable and which accounts are unverified. | `tests/dashboard-users-ui.test.mjs`, policy page test. |
| 10 | DS012 and DS013 describe the shipped behaviour. | Review against section 10. |
| 11 | `npm test` is green in both agents and `npm run test:unit` in `tests/smoke`. | Command output with counts. |

## 13. Remaining risks and deferrals

| Item | Note |
| --- | --- |
| No recovery without email delivery | The motivating deployment has no mail provider, so **Forgot password?** is absent there. The development log fallback covers local work only. An administrator-issued reset link would close the gap but reverses DS012 `:36`; it needs its own decision. |
| Squatted address without delivery | Blocking keeps the address taken. A purge of never-verified accounts, or an authoritative-Google takeover of a never-verified account, would address it. Deferred. |
| Email-keyed authorisation in other agents | `dpuAgent/lib/dpu-store-internal/identity-acl.mjs:87` and `permissions-manifest.mjs:303` carry the user's email as an identity hint. UNVERIFIED whether any grant is matched on email alone; the projection exposes `emailVerified`, so such a consumer can require it. gitAgent prefers `user:<id>` (`gitAgent/lib/secret-store-client.mjs:202-213`). Audit separately. |
| Reset link from the Google collision screen | Threat T1's usability gap. Offering **Forgot password?** on the collision proof screen when the only eligible proof is a password would let a Google arrival reclaim a squatted address without backing out. Recommended follow-up; it touches `service/googleAuth.mjs` and the GIS page, which this plan otherwise leaves alone. |
| Router restart on upgrade | A running workspace does not learn the new EmailAgent tool until its Router restarts (section 8.1). Password reset fails closed with `delivery_failed` until then. Direct signup is unaffected. State this in the deployment notes. |
| Upgrade changes behaviour silently | Q2. Put the override in the QA and production workflows near `deploy-explorer-qa.yml:1994-1999` if verified signup should remain there. |
| Reset message template | Deferred with its readiness rule. |

## 14. References

| Source | Use |
| --- | --- |
| `docs/specs/DS012-user-persisto.md`, `docs/specs/DS013-oauth-oidc.md` at `f913e702` | Contracts reversed and extended. |
| `docs/plans/email-first-account-authentication-plan.md` and its two reviews | House conventions, reproducible commands, prior review findings. |
| OWASP Forgot Password Cheat Sheet | Uniform responses, single-use short-lived tokens, no automatic sign-in, session invalidation. |
| Sudhodanan and Paverd, "Pre-hijacked Accounts" (USENIX Security 2022) | Threat T1 and the rule that an unverified account must not hold credentials that survive recovery. |
