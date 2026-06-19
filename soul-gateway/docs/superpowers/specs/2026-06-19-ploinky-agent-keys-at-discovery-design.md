# Design Spec — Discovery-Provisioned Agent Keys + Prefix Removal

- **Date:** 2026-06-19
- **Status:** Approved design; ready for implementation planning
- **Branch:** `soul-gateway-local-integration`
- **Scope:** `soul-gateway/`
- **Type:** Forward-looking change spec. The repo's `docs/specs/` (DS001–DS016) documents
  *current* behavior, so the DS files are updated **after** this lands (see Follow-ups).

## Summary

Three coordinated changes to how Soul Gateway treats Ploinky agents:

1. **Populate the Keys page at discovery, not on first request.** Today an `api_keys`
   row is created lazily the first time an agent's signed bearer token authenticates.
   It will instead be provisioned during the Ploinky agent discovery/reconciliation
   pass, so a discovered agent appears on the Keys page before it ever makes a request.
2. **Agent keys cannot be revoked, but are fully editable** (RPM, TPM, daily/monthly
   budget, expiry). User keys keep their current lazy-create + revoke behavior.
3. **Remove the `ploinky:` / `ploinky/` prefix from the stored provider and model
   identifiers** so the Providers and Models pages — and the public model id clients
   call — are unprefixed.

No database migration and no backwards compatibility: the schema file is edited
directly and the database is recreated fresh.

The enabling insight is to make everything key off `subject_id` and row `metadata`
rather than the bearer-token hash or the name prefix. That lets discovery fully
provision a key row **without** the Ploinky signature (which never reaches Soul
Gateway), and lets the prefix be dropped from stored identifiers without touching
routing.

## Background — current behavior (Observed)

All citations verified by direct read on this branch.

### Discovery / reconciliation

- `reconcilePloinkyAgentRecords()` imports **only** the providers and models DAOs and
  upserts, per discovered agent, one provider row and one model row; it never touches
  `api_keys`. `soul-gateway/src/ploinky/reconcile-agents.mjs:34-38`, `:298-321`.
- Provider key is `ploinky:<subjectId>`; model key is `ploinky/<repo>/<agent>`. These
  two strings are constructed **only** in `providerKeyFor()` / `modelKeyFor()`:
  `soul-gateway/src/ploinky/reconcile-agents.mjs:65-77`. Nothing else in `src/`
  constructs or parses them (verified by grep; other `ploinky/` hits are import paths
  and doc comments).
- "Is this one of ours" and stale-disable decisions key off
  `metadata.discoverySource === 'ploinky-agent-discovery'`, **not** the name prefix:
  `soul-gateway/src/ploinky/reconcile-agents.mjs:100-101`, `:384`, `:402`.
- Stale-disable runs only when `discovery.complete === true` and soft-disables
  (`enabled = false`); rows lacking the marker are never touched:
  `soul-gateway/src/ploinky/reconcile-agents.mjs:325-337`, `:371-419`.

### Key materialization (the "after first usage" behavior)

- The only `INSERT INTO api_keys` is in the DAO `create()`, reached through
  `createSignedSubjectKeyRecord()`: `soul-gateway/src/db/dao/api-keys-dao.mjs:42-66`,
  `:94-129`.
- Its sole caller is request-time auth: after the Ed25519 signature is verified,
  `authenticateApiKey()` computes `keyHash = HMAC(token, pepper)` and upserts the row:
  `soul-gateway/src/runtime/security/api-key-auth.mjs:97-108`. The schema comment
  states rows are "created on first valid signed request":
  `soul-gateway/src/db/schema/sqlite-current.sql:24`.
- The row's identity is `key_hash BLOB NOT NULL UNIQUE`, where
  `token = <subjectId>|<ed25519-signature>`:
  `soul-gateway/src/db/schema/sqlite-current.sql:34`,
  `soul-gateway/src/runtime/security/api-key-auth.mjs:100,275-277`.
- **Constraint that drives this design:** at discovery time Soul Gateway knows only the
  `subjectId` (from the discovery response). The Ploinky signature never reaches it
  (DS016), so it **cannot compute `key_hash` at discovery**. But `subject_id` is also
  `UNIQUE` (`sqlite-current.sql:31`) and security comes entirely from the per-request
  Ed25519 verification — not from `key_hash`. Therefore the row can be keyed by
  `subject_id`, and `key_hash` is redundant.

### Schema (`api_keys`)

`soul-gateway/src/db/schema/sqlite-current.sql:28-49`. Columns: `id`, `label`,
`subject_id` (UNIQUE), `subject_type` (`CHECK IN ('agent','user')`), `source`
(`CHECK source = 'signed-subject'`), `key_hash` (BLOB NOT NULL UNIQUE), `key_hint`,
`rpm_limit` (DEFAULT 60), `tpm_limit` (DEFAULT 100000), `daily_budget_usd`,
`monthly_budget_usd`, `expires_at`, `status` (`CHECK IN ('active','revoked')`),
`last_used_at`, `metadata`, `created_at`, `updated_at`, `revoked_at`. There is **no**
`kind` column: agent vs user is only `subject_type`.

### Revoke / edit / management API

- Revoke = `status='revoked'`, guarded by `WHERE ... AND status='active'`:
  `soul-gateway/src/db/dao/api-keys-dao.mjs:207-216`. Enforced at auth time:
  `soul-gateway/src/runtime/security/api-key-auth.mjs:117-120`.
- `GET /management/keys` lists all rows (optional `status` filter only) and strips
  `key_hash`: `soul-gateway/src/management/keys-route.mjs:23-38`, `:171-175`.
- `PATCH /management/keys/:id` already accepts
  `label, rpmLimit, tpmLimit, dailyBudgetUsd, monthlyBudgetUsd, expiresAt, metadata`:
  `soul-gateway/src/management/keys-route.mjs:82-113`.
- `POST /management/keys` (manual create) already returns 405; the dashboard "Create
  Key" UI posts to it and is therefore dead:
  `soul-gateway/src/management/keys-route.mjs:49-61`.
- Dashboard Keys page: `keysPage()` at `soul-gateway/src/dashboard/js/app.mjs:2488-2597`
  (edit form sends only `label` + `daily_budget_usd`, `:2557-2576`); table + per-row
  Edit/Reset/Revoke at `soul-gateway/src/dashboard/index.html:4442-4558`. The page does
  **not** currently reference `subject_type`.

### Prefix consumers are prefix-independent (verified)

- Backend routes via provider `metadata.routeKey` and `provider_model_id` (the
  subjectId), not the model-key prefix:
  `soul-gateway/src/runtime/backends/builtin/ploinky-agent-openai.backend.mjs:102,162,217`.
- Loop guard compares `subjectId`s from metadata/auth, not the model key:
  `soul-gateway/src/runtime/route/agent-model-loop-guard.mjs:46-65`.
- Default-tier seeder matches `metadata.agent` + `metadata.discoverySource`, not the
  model key: `soul-gateway/src/bootstrap/seed-default-tiers.mjs:39-46`.
- `key_hint` is still consumed by audit-log display and the dashboard, so it is kept:
  `soul-gateway/src/db/dao/audit-logs-dao.mjs:281,291`,
  `soul-gateway/src/dashboard/js/app.mjs:459-460,1620`.

## Decisions

1. **Prefix removal is data-level.** Stored `provider_key` becomes `agent:<repo>/<agent>`
   and `model_key` becomes `<repo>/<agent>`. The public model id clients call changes
   accordingly.
2. **Only agent keys lose revoke.** User keys (`subject_type='user'`) keep lazy-create
   and revoke.
3. **A stale agent's key row is kept** (limits preserved). No new disabled-state on
   `api_keys`. The agent's provider/model are disabled by existing stale-disable.
4. **`key_hash` is dropped** (not kept nullable). Lookup is by `subject_id`; the token
   is re-verified cryptographically every request, so `key_hash` adds nothing.

## Design

### A. `api_keys` becomes subject-keyed

**Schema** (`soul-gateway/src/db/schema/sqlite-current.sql`):

- Remove the `key_hash BLOB NOT NULL UNIQUE` column and the now-irrelevant comment about
  the HMAC hash. `subject_id` (already `UNIQUE`) is the lookup key.
- Keep all other columns, including `key_hint` (audit log + dashboard consume it) and
  `status` (`active`/`revoked`, still used by user keys).
- Remove `key_hash` from any column-handling list in `soul-gateway/src/db/sqlite-db.mjs`
  (it is listed at `:45`).
- No migration. The database is recreated fresh.

**DAO** (`soul-gateway/src/db/dao/api-keys-dao.mjs`):

- Replace the hash-keyed `create()` + `createSignedSubjectKeyRecord()` with a
  subject-keyed idempotent upsert, e.g.:

  ```js
  // INSERT a signed-subject row if none exists for this subject; otherwise
  // return the existing row unchanged. Idempotent via the subject_id UNIQUE index.
  export async function upsertSignedSubjectKey(pool, {
      subjectId,
      subjectType,
      keyHint,
      label = subjectId,
      rpmLimit = SIGNED_SUBJECT_DEFAULT_RPM_LIMIT,
      tpmLimit = SIGNED_SUBJECT_DEFAULT_TPM_LIMIT,
  }) { /* find by subject_id; if absent INSERT; return row */ }
  ```

- The INSERT no longer writes `key_hash`. `create()` loses its `keyHash` parameter and
  the `key_hash` column from the column list.
- **Insert-if-missing semantics are mandatory:** an existing row is returned untouched,
  so operator-edited limits/budgets are never overwritten by a later discovery pass or
  request.
- Remove `findByHash()`. Keep `findBySubjectId()`, `findById()`, `list()`, `update()`,
  `revoke()`, `updateLastUsed()`.
- Default RPM/TPM constants (currently `SIGNED_SUBJECT_DEFAULT_RPM_LIMIT = 60`,
  `SIGNED_SUBJECT_DEFAULT_TPM_LIMIT = 100000` in `api-key-auth.mjs:54-55`) should be a
  single shared source used by both the auth path and the reconciler (export from one
  module and import, or rely on the schema `DEFAULT` values and omit them from the
  INSERT). Pick one and keep it consistent.

**Auth** (`soul-gateway/src/runtime/security/api-key-auth.mjs`):

- Steps 1–5 (extract token, require public key, parse `<subjectId>|<signature>`,
  classify subject, **verify Ed25519 signature**) are unchanged. The signature check
  remains the security gate.
- Step 6 calls `apiKeysDao.upsertSignedSubjectKey(pool, { subjectId, subjectType,
  keyHint: buildKeyHint(subjectId) })` — find-or-create by `subject_id`. No `key_hash`,
  no pepper.
- Steps 7–9 (deny `revoked`, honor `expires_at`, fire-and-forget `last_used_at`,
  return the normalized subject) are unchanged.
- Remove `derivePepper()` and `hashApiKey()` and their call sites in this module
  (they are used only here in `src/`; `encryption.mjs` stays for provider-account
  encryption).

### B. Discovery provisions agent keys (requirement 1)

**Reconciler** (`soul-gateway/src/ploinky/reconcile-agents.mjs`):

- Import the api-keys DAO and, for each discovered agent (after the provider/model
  upsert in the per-agent loop), call
  `upsertSignedSubjectKey(pool, { subjectId: agent.subjectId, subjectType: 'agent',
  keyHint, label: agent.subjectId })`.
- Use **insert-if-missing**, so the ~60s reconcile timer never resets edited limits.
- The key upsert does **not** participate in the `changed` flag and does **not** trigger
  `performRuntimeRefresh`: keys are not part of the routing snapshot; auth reads them
  from the DB directly. (Refresh stays gated on provider/model changes only.)
- **Decision #3:** do **not** add keys to `disableStaleRows`. The seen-key sets and
  stale-disable logic remain providers/models only. A vanished agent keeps its key row.
- Self-subject skip (`PLOINKY_AGENT_ID`) stays — Soul Gateway does not provision a key
  row for itself.

**Fallback path:** an agent whose request arrives before the first discovery pass still
lazy-creates its key through the same `upsertSignedSubjectKey` (subject_type `'agent'`).
A later discovery pass no-ops on it. The lazy path is retained for exactly this reason
and for all user keys.

### C. Agent keys non-revocable, fully editable (requirement 2)

**Route** (`soul-gateway/src/management/keys-route.mjs`):

- `handleRevokeKey`: fetch the row first; if `row.subject_type === 'agent'`, respond
  **409** with a clear message ("Agent keys cannot be revoked; adjust limits, budget,
  or expiry instead."). Otherwise revoke as today. (404 if the key does not exist,
  unchanged.)
- `handleUpdateKey` (PATCH): unchanged — it already accepts rpm/tpm/daily/monthly/expiry
  and applies to both agent and user keys.
- Remove `handleCreateKey` (the 405 stub) and its `POST /management/keys` route
  registration in `soul-gateway/src/management/build-routes.mjs`. Manual creation is gone
  conceptually; keys come from discovery or the lazy path.

**Dashboard** (`soul-gateway/src/dashboard/index.html` keys page ~4442,
`soul-gateway/src/dashboard/js/app.mjs` `keysPage()` ~2488):

- Expand the edit modal + `editForm` to include `rpm_limit`, `tpm_limit`,
  `daily_budget_usd`, `monthly_budget_usd`, and `expires_at` (today it carries only
  `label` + `daily_budget_usd`). `saveEdit()` PATCHes all of them
  (`rpmLimit`, `tpmLimit`, `dailyBudgetUsd`, `monthlyBudgetUsd`, `expiresAt`, `label`),
  coercing empty strings to `null` for the nullable budgets/expiry and to a number for
  the integer limits.
- Gate **Revoke** on `k.subject_type !== 'agent'` (hide or disable the button for agent
  keys). Add a small column/badge showing `subject_type` (Agent / User).
- Remove the dead "Create Key" button + modal and its `create()` handler.

### D. Remove the prefix at the data level (requirement 3)

**Reconciler** (`soul-gateway/src/ploinky/reconcile-agents.mjs`):

- `providerKeyFor(subjectId)` returns `subjectId` (i.e. `agent:<repo>/<agent>`).
- `modelKeyFor(repo, agent)` returns `<repo>/<agent>`.
- Update the file-header doc block that currently documents the `ploinky:` / `ploinky/`
  scheme.
- Everything else is unchanged: the `metadata.discoverySource` marker stays
  `'ploinky-agent-discovery'`; routing, loop guard, tier seeding, and stale-disable all
  key off metadata (verified above). No dashboard change is required for the prefix —
  the pages render the now-clean `provider_key` / `model_key` automatically.

## Data flow (target)

**Discovery → key (new):**

```
reconcile pass (startup + ~60s timer)
  for each discovered agent (subjectId = agent:<repo>/<agent>):
    upsert provider  (provider_key = agent:<repo>/<agent>, metadata.discoverySource marker)
    upsert model     (model_key   = <repo>/<agent>,        metadata.discoverySource marker)
    upsert api_keys  (subject_id  = agent:<repo>/<agent>,  subject_type='agent', status active)  ← new
  stale-disable providers/models only (when complete); keys are NOT disabled
  performRuntimeRefresh only if a provider/model changed
```

**Request → key (changed):**

```
POST /v1/... with Bearer <subjectId>|<signature>
  parse + classify subject
  verify Ed25519 signature against PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY   ← security gate (unchanged)
  upsertSignedSubjectKey by subject_id  → existing row (agent) OR new row (lazy: user / pre-discovery agent)
  deny if status='revoked'; honor expires_at; update last_used_at
  proceed with the row's limits/budgets
```

## Edge cases

- **Agent calls before first discovery:** lazy upsert creates its key (subject_type
  `'agent'`); later discovery no-ops. Same final state.
- **Agent flaps in/out:** provider/model toggle enabled/disabled across passes; the key
  row and its operator-edited limits persist (Decision #3).
- **Operator edits an agent key's limits, discovery re-runs:** insert-if-missing means
  the edited row is left untouched.
- **Manual model named exactly `<repo>/<agent>`:** now collides with a discovered model
  (the prefix used to prevent this). Accepted per Decision #1. Reconciler still only
  stale-disables rows carrying the discovery marker, so it will not disable a manual row,
  but `upsertModel`'s `findByKey` would update a same-keyed manual row — operators must
  avoid that name. Documented as an accepted trade-off.
- **`provider_key` now contains a colon** (`agent:<repo>/<agent>`): provider keys are
  treated as opaque unique strings (`findByKey` exact match). Implementer verifies no
  code splits `provider_key` on `:`.

## Out of scope (noted, not changed)

- "Spent Today" on the Keys page shows 0 because `GET /management/keys` does not populate
  `daily_spent` (spend lives in the spend cache, surfaced via
  `GET /management/keys/:id/spend`). Pre-existing; not addressed here.
- User-key behavior other than retaining revoke + lazy-create.

## Test plan (requirement 4 — updated in place, no migration)

- **`reconcile-agents.test.mjs`**: provider/model keys are unprefixed
  (`agent:<repo>/<agent>`, `<repo>/<agent>`); an `api_keys` row is created per discovered
  agent (subject_type `'agent'`, default limits, status active); a second pass preserves
  operator-edited limits; a stale agent (absent from a complete pass) keeps its key row
  while its provider/model are disabled; the key upsert does not force a runtime refresh.
- **Auth tests** (`embedded-auth.test.mjs`, `security.test.mjs`, `bootstrap-auth.test.mjs`):
  lookup/create is by `subject_id`; remove `key_hash`/pepper assertions; lazy user-key
  creation still works; an already-provisioned agent key is reused, not recreated;
  revoked rows still denied; expiry still honored.
- **DAO/schema tests** (`dao-queries.test.mjs`, `sqlite-dao.test.mjs`): `api_keys` has no
  `key_hash`; `upsertSignedSubjectKey` is idempotent on `subject_id`; `update`/`revoke`
  unchanged.
- **`management.test.mjs`**: revoke on an agent key → 409; revoke on a user key → 200;
  PATCH rpm/tpm/daily/monthly on an agent key → 200 and persists; `POST /management/keys`
  route removed.
- **Re-verify** `seed-default-tiers.test.mjs` and `agent-model-loop-guard.test.mjs`
  (metadata-based; should pass) and update any fixtures that hard-code `ploinky/` keys.

## Acceptance criteria (verifiable)

1. `npm run test:unit` passes.
2. After a discovery pass with N agents and **zero** inbound requests,
   `GET /management/keys` returns N rows with `subject_type='agent'` and `status='active'`.
   (Covered by a `reconcile-agents` test asserting the rows exist post-reconcile.)
3. `POST /management/keys/:id/revoke` on an agent key → 409; on a user key → 200.
4. `PATCH /management/keys/:id` with `rpmLimit`/`tpmLimit`/`dailyBudgetUsd`/
   `monthlyBudgetUsd` on an agent key → 200 and the values persist on re-read.
5. `GET /management/providers` and `GET /management/models` return identifiers with no
   `ploinky:` / `ploinky/` prefix; a client request with `model:"<repo>/<agent>"` routes
   to the agent.
6. Re-running discovery after an operator edit does not reset that key's limits/budgets.

## Verification commands

```bash
# from soul-gateway/
npm run test:unit
node --experimental-test-module-mocks --test src/test/unit/reconcile-agents.test.mjs
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
node --experimental-test-module-mocks --test src/test/unit/embedded-auth.test.mjs
```

Manual (local Ploinky-managed gateway): trigger discovery, confirm the Keys page lists
discovered agents before any request; edit an agent key's RPM/budget; confirm Revoke is
hidden for agent keys and present for a user key; confirm Providers/Models pages show
unprefixed names; confirm a `model:"<repo>/<agent>"` call succeeds.

## Follow-ups (after implementation lands)

Update the current-behavior DS specs to match:

- **DS006** — `api_keys` schema (drop `key_hash`; `subject_id` is the lookup key).
- **DS007** — key lifecycle (discovery-provisioned agent keys; non-revocable agent keys;
  editable limits; lazy path retained for user keys).
- **DS016** — Ploinky agent mode (discovery provisions a key row; provider/model
  identifiers are unprefixed; agent keys cannot be revoked).
