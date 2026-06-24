# Design Spec — Admin-Created User API Keys (Soul Gateway)

- **Date:** 2026-06-24
- **Status:** Design approved (brainstorming) — pending implementation plan
- **Repos touched:** `proxies/soul-gateway` (management route + dashboard + DS specs + tests). **`ploinky`: no change** — the router mint endpoint is reused as-is.

## Summary

Revive the ability to **create Soul Gateway API keys from the (admin-only) dashboard**, the modern signed-subject way. An admin provisions named, revocable **user keys** of the form `user:<owner>:<name>`. The key is **minted by the router** (the existing `POST /api/router/identity/user-api-key` endpoint, signing with the Ed25519 private key the gateway never holds) and verified by signature; **the gateway stores only a policy row** (limits/budget/status/label), never key material. Agent keys are unchanged (discovery-provisioned, non-revocable).

This restores the feature that was intentionally removed during the June 2026 migration from opaque "workspace API keys" to signed-subject auth — but on the new architecture rather than the old gateway-generated-secret model.

## Background — current behavior (Observed)

All citations verified by direct read on the `subject-identity-decoupling` branch.

- The old manual-create feature (gateway-generated opaque `sk-soul-…`, hashed+encrypted, returned once) was removed during the signed-subject migration: `be7ec98` (signed-subject Ed25519 auth), `708a8fc` (disable manual create → 405), `78fe6bd` (drop `key_hash`), `68f4ac6` (drop dashboard create UI), `02204aa` (remove server create). The accompanying design `docs/superpowers/specs/2026-06-19-ploinky-agent-keys-at-discovery-design.md` **deliberately kept user keys** ("User keys keep their current lazy-create + revoke behavior"; user-key behavior beyond that was "out of scope", not removed).
- `api_keys` is signed-subject-only today (`src/db/schema/sqlite-current.sql`): `id`, `label`, `subject_id` (UNIQUE), `subject_type CHECK IN ('agent','user')`, `source CHECK (source = 'signed-subject')`, `key_hint`, `rpm_limit`, `tpm_limit`, `daily_budget_usd`, `monthly_budget_usd`, `expires_at`, `status CHECK IN ('active','revoked')`, `last_used_at`, `metadata`, timestamps. **No key material columns** (`key_hash`/`key_ciphertext` dropped in `78fe6bd`).
- The verifier (`src/runtime/security/api-key-auth.mjs`) accepts `agent:` and `user:` signed-subject keys, verifies the Ed25519 signature against `PLOINKY_AGENT_API_PUBLIC_KEY`, and find-or-creates the row keyed on `subject_id` (`upsertSignedSubjectKey`).
- `src/management/keys-route.mjs` exposes list / get / PATCH (limits/budget/expiry/label) / revoke / reset-daily-budget / spend. Revoke is **allowed for user keys**, blocked (409) for agent keys.
- The router mint endpoint `POST /api/router/identity/user-api-key` (ploinky) mints `user:<requestedUserId>` for an authenticated admin session; `requestedUserId` is honored only when the caller is an admin. The `user:` validator alphabet `[A-Za-z0-9._:-]+` already permits the embedded `:` of a `user:<owner>:<name>` subject.
- **Gap:** there is no UI/endpoint to create + provision a user key; a user row only appears lazily on first authentication, and there is no "create" affordance.

## Decisions (locked during brainstorming)

| # | Decision |
|---|---|
| 1 | **Admin-only**, behind the already admin-gated dashboard (`/management/*` are `admin(...)`-wrapped). |
| 2 | **Multiple named keys per identity**: subject `user:<owner>:<name>`. |
| 3 | **Path 1** — router-signed, deterministic, **no key material stored at the gateway**. (Path 2, gateway-generated opaque keys, rejected.) |
| 4 | **Approach A** — the dashboard orchestrates: reuse the router mint endpoint (unchanged) + add one gateway endpoint that provisions the policy row. |
| 5 | **Provision-then-mint** ordering (reserve/validate the row first, then mint for display). |
| 6 | **Revoked subject ids are permanently burned**; rotation = revoke + create under a new name. |
| 7 | **v1 is show-once** (no later re-reveal feature). |
| 8 | **ploinky unchanged** (router endpoint reused). |

## Design

### A. Subject model

Keys are `user:<owner>:<name>` (e.g. `user:alice:laptop`), stored with `subject_type='user'`, `source='signed-subject'`. `owner` and `name` are each validated against `^[A-Za-z0-9._-]+$` (the `:` is the structural separator we insert; excluding `:` from the parts keeps the subject cleanly parseable for display). The composed subject id matches the existing `user:` validator. Because signed-subject keys are deterministic (a pure function of `subjectId` + the router signing key):

- **A revoked subject id is burned** — re-provisioning the same `owner:name` would re-mint identical bytes that hit the revoked row and stay denied. The provision endpoint therefore rejects any already-existing `subject_id`.
- **Rotation = revoke the old key + create a new name** (`alice:laptop` → `alice:laptop2`). There is no in-place rotation.

### B. Gateway: `POST /management/keys` (admin) — provision a user-key row

New handler `handleProvisionUserKey` in `src/management/keys-route.mjs`, registered as `admin(handleProvisionUserKey)` in `src/management/build-routes.mjs`.

Request body: `{ subjectId, label, rpmLimit?, tpmLimit?, dailyBudgetUsd?, monthlyBudgetUsd?, expiresAt? }`.

Behavior:
1. Validate `subjectId` is a well-formed `user:<owner>:<name>` (reject `agent:` — agent rows come only from discovery — and reject malformed/empty/charset-violating ids) → **400** on failure.
2. Reject a past `expiresAt` → **400**.
3. Insert via the existing `keysDao.create({ subjectId, subjectType:'user', source:'signed-subject', label, keyHint: buildKeyHint(subjectId), rpmLimit, tpmLimit, dailyBudgetUsd, monthlyBudgetUsd, expiresAt, status:'active' })`. **No key material** is written (none exists in the schema).
4. `subject_id` is UNIQUE — if the row already exists (active **or** revoked) → **409** (enforces the burned-name rule).
5. Return **201** with the created row via `stripSensitiveFields`.

This endpoint **does not mint or return a key** — it only records policy. It is the user-key analogue of the discovery-provisioning path that already exists for agent rows. No schema change, no DAO change, no verifier change.

### C. Dashboard UX (Keys page, admin-only)

Add a **"Create user key"** button to the Keys page that opens a modal: **owner** (required), **key name** (required), optional **rpm/tpm limits**, **daily/monthly budget**, **expiry**, and an auto-suggested **label** (default `<owner>/<name>`). On submit (**provision-then-mint**):

1. `POST /management/keys` (gateway) with `{ subjectId: "user:<owner>:<name>", label, limits… }` — validates and reserves the row; a **409** surfaces "that owner/name is already used — pick another."
2. `POST /api/router/identity/user-api-key` `{ userId: "<owner>:<name>" }` (router; same origin, admin session) — returns the signed `apiKey`.
3. Display the `apiKey` **once** in a copy box with a "store it now — it won't be shown again" warning.

List/edit/revoke reuse the existing UI (user keys already render with Revoke enabled; agent keys keep Revoke hidden). The dashboard never persists the key.

### D. Runtime data flow

```text
Create (admin):
  dashboard form
    → POST /management/keys (gateway)   provision row (subject_id, label, limits); 409 if exists
    → POST /api/router/identity/user-api-key (router, admin session)   mint user:<owner>:<name>|<sig>
    → show key once

Later use (key holder):
  Authorization: Bearer user:<owner>:<name>|<sig>
    → verifier checks Ed25519 sig vs PLOINKY_AGENT_API_PUBLIC_KEY, classifies 'user'
    → finds the pre-provisioned row by subject_id (reused, not recreated)
    → enforces status (revoked → denied), expires_at, rpm/tpm/budget
```

### E. Revoke / rotate

Reuse the existing `POST /management/keys/:id/revoke` (already permits user keys). Revoke sets `status='revoked'`; the verifier denies revoked rows and never reactivates. Rotation is **revoke + create a new name** (the old subject id stays as a denied audit row). The UI messaging makes the burned-name rule explicit.

### F. Unchanged

Verifier, `api_keys` schema, DAO `create`, the router mint endpoint, list/PATCH/revoke routes, and all agent-key behavior. The only new code is the provision endpoint + its route registration + the dashboard UI (+ tests + DS updates).

## Edge cases

- **Provision succeeds, mint fails** (rare; router transient error): the policy row exists but no key was shown. The row is still valid — the deterministic key can be re-minted via the endpoint, or the admin can revoke the row and create a new name. v1 surfaces the error and leaves the row; no automatic rollback.
- **Duplicate subject id** (active or revoked): 409 from provision; the mint step is never reached.
- **`agent:` subject submitted**: 400 (admins cannot provision agent rows).
- **Charset / empty `owner` or `name`**: 400.
- **Past `expiresAt`**: 400.
- **Holder presents the key before any management action**: the existing lazy find-or-create still works; pre-provisioning just means the row (and limits) already exist.

## Out of scope

- Re-reveal / re-mint of an existing key from the dashboard (v1 is show-once; lost key → revoke + new name).
- Self-service (non-admin) key creation.
- Bulk creation, key search, CSV export.
- The pre-existing "Spent Today shows 0 on the list" issue (spend is surfaced via `GET /management/keys/:id/spend`).
- Any change to agent-key provisioning or the router signing/rotation model.

## Test plan

- **`src/test/unit/management.test.mjs`**: `POST /management/keys` provisions a `user:` row → **201** (subject_type `'user'`, source `'signed-subject'`, status `'active'`, limits persisted, no key material); duplicate subject → **409**; `agent:` subject → **400**; malformed subject / past expiry → **400**; the provisioned row appears in `GET /management/keys`; `PATCH` limits → **200**; `POST /…/revoke` on the user key → **200**.
- **Verifier reuse** (`embedded-auth.test.mjs` / `security.test.mjs`): a signed `user:<owner>:<name>` key authenticates against the pre-provisioned row (row reused, not recreated); a revoked user row denies.
- **Local e2e** (testExplorerFresh): admin creates `user:alice:laptop` → presents `user:alice:laptop|<sig>` to `/services/soul-gateway/v1/models` → **200**; revoke it → subsequent call **denied**; the Keys page lists it with Revoke enabled.

## Acceptance criteria (verifiable)

1. `cd proxies/soul-gateway && npm test` passes, including the new `management.test.mjs` cases.
2. `POST /management/keys` with a valid `user:<owner>:<name>` body → 201 and the row is listed by `GET /management/keys`; a second identical request → 409.
3. `POST /management/keys` with an `agent:` subject → 400.
4. A `user:<owner>:<name>` key minted via `POST /api/router/identity/user-api-key` authenticates to the gateway and is bound to the provisioned row's limits; revoking the row denies subsequent calls.
5. The dashboard Keys page shows "Create user key" (admin), and the created key is displayed exactly once.
6. No key material is stored: `rg -i "key_hash|key_ciphertext|randomBytes|hashApiKey" src/management/keys-route.mjs` → no matches in the new handler.

## Verification commands

```bash
# from proxies/soul-gateway/
npm test
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
```

Manual (local Ploinky-managed gateway in testExplorerFresh): open the dashboard as admin → Create user key (`alice` / `laptop`, set an rpm limit) → copy the shown key → `curl -H "Authorization: Bearer <key>" .../services/soul-gateway/v1/models` returns 200 → revoke from the Keys page → the same curl is denied.

## Follow-ups (after implementation lands)

Update the soul-gateway DS specs the 2026-06-19 design flagged, to document admin-created user keys:
- The **key-lifecycle DS** (`DS007`, and `DS006` for the `api_keys` contract): admin-provisioned user keys via router mint + gateway provision; burned-name rule; rotation = new name.
- **`DS016`** (Ploinky agent mode): note that user keys are admin-creatable through the dashboard while agent keys remain discovery-provisioned and non-revocable.
