# Soul Gateway Owner Autofill Review Handoff

Date: 2026-06-29

## Purpose

This handoff is for an external review of the Soul Gateway API key owner autofill fix before any further integration action, push, redeploy, or additional commits.

Important current state:

- The candidate implementation already exists as local commits on `main` in this workspace.
- Do not push or deploy from this handoff.
- Do not create new commits during review unless explicitly instructed by the user.
- Review the candidate implementation as a patch range: `f50bde0..b3acaf8`.
- The handoff files themselves are not part of the implementation under review.

## Problem

In the Soul Gateway dashboard, the create user API key owner field was not automatically filled even though the user was already logged into Ploinky as an admin. The user had to manually enter the owner.

Root cause found during investigation:

- Ploinky forwards authenticated user information in `x-ploinky-auth-info`.
- Soul Gateway verifies that router-protected identity in `authenticateRouterAdmin()`.
- The management route wrapper previously called `requireAdmin(...)` but discarded its return value before invoking handlers.
- The dashboard keys page had no server-authoritative current-user endpoint and initialized `createKeyForm.owner` to an empty string.

## Intended Behavior

- The API key owner should be prefilled from the verified Ploinky login user.
- The owner field should remain editable for admins who intentionally mint a key for another owner.
- Soul Gateway must not trust browser-provided identity for owner derivation.
- Key policy and minting formats must remain compatible:
  - Stored subject id: `user:<owner>:<name>`
  - Ploinky mint request `userId`: `<owner>:<name>`

## Candidate Commit Range

Base:

```text
f50bde0 Fix Soul Gateway dashboard metrics
```

Head:

```text
b3acaf8 Add owner autofill implementation plan
```

Implementation commits:

```text
6a204c5 Expose management current user
cd58484 Autofill user key owner
ecbeb25 Document management user owner defaults
b3acaf8 Add owner autofill implementation plan
```

## Files To Review

Backend:

```text
src/management/management-user.mjs
src/management/session-route.mjs
src/management/build-routes.mjs
src/test/unit/management-user.test.mjs
src/test/unit/management.test.mjs
```

Dashboard:

```text
src/dashboard/js/app.mjs
src/test/unit/dashboard-keys-page.test.mjs
```

Docs and plan:

```text
docs/specs/DS012-api-reference.md
docs/specs/DS016-ploinky-agent-mode.md
docs/superpowers/plans/2026-06-29-autofill-user-key-owner.md
```

## Key Implementation Summary

Backend:

- Adds `management-user.mjs`.
- Derives `keyOwner` from verified Ploinky user fields in this order:
  1. `username`
  2. `name`
  3. `id`
  4. `email`
- Normalizes owner parts to `[A-Za-z0-9._-]+`.
- Converts local ids like `local:admin` to `admin`.
- Adds `GET /management/me`, protected by the same admin router auth wrapper.
- Preserves the verified `requireAdmin(...)` result as `ctx.managementAuth`.

Dashboard:

- Adds `currentUser` and `currentOwner` state to `keysPage()`.
- Loads `/management/me` before `/management/keys`.
- Prefills `createKeyForm.owner` with `currentOwner`.
- Falls back to `currentOwner` on submit when owner is empty.
- Keeps admin override behavior because the form owner value wins before the fallback.

Docs:

- DS012 documents `/management/me` and owner derivation.
- DS016 documents that owner derivation is based on verified Ploinky router identity, not browser state.

## Verification Already Run

Focused verification:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node --test src/test/unit/management-user.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
node --test src/test/unit/dashboard-keys-page.test.mjs
```

Observed result:

```text
management-user.test.mjs: 4 pass, 0 fail
management.test.mjs: 102 pass, 0 fail
dashboard-keys-page.test.mjs: 4 pass, 0 fail
```

Full verification:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
npm test
```

Observed result:

```text
1056 pass, 0 fail, 2 skipped
```

Whitespace check:

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git diff --check HEAD~4..HEAD
```

Observed result: no output.

## Prior Review Notes

Automated/subagent review found no Critical or Important issues.

Minor notes worth rechecking:

- There is no explicit dashboard test for admin override where `currentOwner === "admin"` but the form owner is changed to another valid owner before submit.
- Whitespace-only owner input currently fails validation instead of falling back to `currentOwner`, because `'   '` is truthy before trim. Decide whether that is acceptable.

## Suggested Review Commands

```bash
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
git status --short
git diff --stat f50bde0..b3acaf8
git diff f50bde0..b3acaf8
node --test src/test/unit/management-user.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
node --test src/test/unit/dashboard-keys-page.test.mjs
npm test
git diff --check f50bde0..b3acaf8
```

## Review Questions

1. Does the implementation derive owner only from verified Ploinky router auth?
2. Does `/management/me` expose only non-secret current-user data?
3. Does the dashboard keep admin owner override behavior?
4. Are the stored and minted subject formats still compatible?
5. Are the tests sufficient for the critical behavior?
6. Do the docs accurately describe the final contract?
7. Should the minor reviewer notes be fixed before push/deploy?
