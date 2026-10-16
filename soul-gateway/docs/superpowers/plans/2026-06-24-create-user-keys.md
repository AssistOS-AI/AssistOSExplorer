# Admin-Created User API Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create named, revocable Soul Gateway **user keys** (`user:<owner>:<name>`) from the dashboard — minted by the router (signed-subject), with the gateway storing only a policy row.

**Architecture:** Approach A from the spec. The dashboard (admin-only) **provisions a policy row** via a new `POST /management/keys` gateway endpoint, then **mints the signed key** via the existing router endpoint `POST /api/router/identity/user-api-key`. The gateway never generates or stores key material; the verifier authenticates the presented `user:<owner>:<name>|<sig>` against the pre-provisioned row. Agent keys and ploinky are unchanged.

**Tech Stack:** Node.js ESM, `node:test` (with `--experimental-test-module-mocks`), SQLite (`api_keys` table), Alpine.js 3 dashboard.

**Spec:** `proxies/soul-gateway/docs/superpowers/specs/2026-06-24-create-user-keys-design.md`

## Global Constraints

- **Path 1 only:** keys are router-signed signed-subject keys; the gateway stores **no key material** (no `key_hash`, no random generation). New code must not import `randomBytes`/`hashApiKey` or write key material.
- **Admin-only:** the new route is registered with the existing `admin(...)` wrapper; the dashboard is already admin-gated.
- **Subject model:** `user:<owner>:<name>`; `owner` and `name` each match `^[A-Za-z0-9._-]+$`. Only `user:` subjects may be provisioned here — reject `agent:`.
- **Burned names:** an existing `subject_id` (active OR revoked) cannot be re-provisioned → 409. Rotation = revoke + new name.
- **Show-once (v1):** the minted key is displayed once; no re-reveal feature.
- **ploinky: no changes.** The router mint endpoint is reused as-is (it already mints `user:<requestedUserId>` for an admin session, and the `user:` validator allows the embedded `:`).
- **4-space JS indent, ESM.** Soul-gateway LLM-inference rule is irrelevant here (no inference paths touched).
- **Commits:** per workspace policy, do NOT commit without explicit user confirmation. The `git commit` steps below are the intended grouping — stage them, but confirm with the user before committing. **Never** add AI/coding-agent attribution to commits, code, comments, or docs.

---

## Review applied (Codex gpt-5.5, xhigh — 2026-06-24)

Verdict **NEEDS REWORK** → all 5 findings independently verified against the code and fixed in this plan. Architecture (router mint contract, cross-surface fetch reaching the router, no stored key material, burned-name rule) was **VERIFIED OK** by the review.

| # | Sev | Fix applied |
|---|---|---|
| F1 | Critical | `submitCreateKey` inspects the provision response **before** minting — `api.post` resolves with the body on 4xx (only throws on 401/403), so a 409/400 must not fall through to `_mintUserKey` (Task 3). |
| F2 | Important | Handler validates with an explicit `USER_KEY_RE = /^user:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/` — `classifySubjectType` under-validates (accepts `user:alice`, `user:a:b:c`). Added malformed-subject tests (Task 2). |
| F3 | Important | Dashboard state/methods live on the **`keysPage()`** component (`app.mjs:2488`), refreshed via its `init()` loader — there is no `loadKeys()` (Task 3). |
| F4 | Important | Task 4 now updates **`DS012-api-reference.md`**, which currently states key mgmt is read-only and `POST /management/keys` → 405. |
| F5 | Minor | Added a route-registration assertion (`httpRouter.match('POST','/management/keys')`) so a forgotten `build-routes` edit fails a test (Task 2). |

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `proxies/soul-gateway/src/db/dao/api-keys-dao.mjs` | Modify (add `provisionUserKey`) | DAO wrapper that inserts a `user:` signed-subject policy row (reuses `create` + `buildKeyHint`); no key material |
| `proxies/soul-gateway/src/management/keys-route.mjs` | Modify (add `handleProvisionUserKey`) | Admin endpoint: validate `user:` subject, provision row, map duplicate→409 |
| `proxies/soul-gateway/src/management/build-routes.mjs` | Modify (import + register) | Register `POST /management/keys` → `admin(handleProvisionUserKey)` |
| `proxies/soul-gateway/src/test/unit/management.test.mjs` | Modify (add cases) | Test 201 / 400 (agent, missing, past-expiry) / 409 (duplicate) |
| `proxies/soul-gateway/src/dashboard/js/app.mjs` | Modify (Alpine state + methods) | "Create user key" form state, `submitCreateKey()`, `_mintUserKey()` |
| `proxies/soul-gateway/src/dashboard/index.html` | Modify (button + modal) | Create-key button + modal + show-once key display |
| `proxies/soul-gateway/docs/specs/DS006-*.md`, `DS007-*.md`, `DS012-api-reference.md`, `DS016-*.md` | Modify | Document admin-created user keys, burned-name rule, rotation; **DS012 currently says key mgmt is read-only / `POST /management/keys` → 405 and must be updated (F4)** |

No new files; no schema change (the `api_keys` schema already models `subject_type='user'`, `source='signed-subject'`, `status` revoke).

---

## Task 1: DAO `provisionUserKey`

**Files:**
- Modify: `proxies/soul-gateway/src/db/dao/api-keys-dao.mjs`

**Interfaces:**
- Consumes (existing, same file): `create(pool, {...})`, `buildKeyHint(value)`.
- Produces: `provisionUserKey(pool, { subjectId, label?, rpmLimit?, tpmLimit?, dailyBudgetUsd?, monthlyBudgetUsd?, expiresAt? }) → Promise<row>`. Inserts a `subject_type:'user'`, `source:'signed-subject'` row; throws the unique-constraint error (detectable via the existing `isUniqueConstraintError`) when `subject_id` already exists.

- [ ] **Step 1: Write the failing test** (in `src/test/unit/dao-queries.test.mjs` if present, else add a focused test file `src/test/unit/api-keys-dao.test.mjs`). Use a mock pool that captures the INSERT params.

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as keysDao from '../../db/dao/api-keys-dao.mjs';

describe('api-keys-dao provisionUserKey', () => {
    it('inserts a user signed-subject row with a derived key hint and no key material', async () => {
        let captured = null;
        const pool = {
            query: async (sql, params) => {
                captured = { sql, params };
                return { rows: [{ id: 'x', subject_id: 'user:alice:laptop', subject_type: 'user', source: 'signed-subject', status: 'active' }] };
            },
        };
        const row = await keysDao.provisionUserKey(pool, { subjectId: 'user:alice:laptop', label: 'alice/laptop', rpmLimit: 30 });
        assert.equal(row.subject_type, 'user');
        assert.ok(/INSERT INTO api_keys/i.test(captured.sql));
        // No key_hash / key material in the INSERT.
        assert.ok(!/key_hash|key_ciphertext/i.test(captured.sql));
        // subject_id + subject_type present in params.
        assert.ok(captured.params.includes('user:alice:laptop'));
        assert.ok(captured.params.includes('user'));
    });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd proxies/soul-gateway && node --experimental-test-module-mocks --test src/test/unit/api-keys-dao.test.mjs`
Expected: FAIL — `keysDao.provisionUserKey is not a function`.

- [ ] **Step 3: Implement `provisionUserKey`** (add near `upsertSignedSubjectKey` in `api-keys-dao.mjs`; it mirrors that function's row-shaping, but for an explicitly-provisioned user row with limits/budget/expiry):

```javascript
/**
 * Provision a policy row for an admin-created user key. The signed-subject key
 * itself is minted by the router; this records only the subject + limits so the
 * key is listed, limited, and revocable. No key material is stored. Throws the
 * unique-constraint error (see isUniqueConstraintError) if subject_id exists.
 */
export async function provisionUserKey(
    pool,
    {
        subjectId,
        label = subjectId,
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        expiresAt = null,
    }
) {
    return create(pool, {
        label,
        keyHint: buildKeyHint(subjectId),
        subjectId,
        subjectType: 'user',
        source: 'signed-subject',
        status: 'active',
        rpmLimit,
        tpmLimit,
        dailyBudgetUsd,
        monthlyBudgetUsd,
        expiresAt,
        metadata: { subjectId, subjectType: 'user', source: 'signed-subject' },
    });
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd proxies/soul-gateway && node --experimental-test-module-mocks --test src/test/unit/api-keys-dao.test.mjs`
Expected: PASS.

- [ ] **Step 5: Stage (commit on confirmation)**

```bash
git add src/db/dao/api-keys-dao.mjs src/test/unit/api-keys-dao.test.mjs
# commit message (await user confirmation per Global Constraints):
# "Add provisionUserKey DAO helper for admin-created user keys"
```

---

## Task 2: `POST /management/keys` provision endpoint

**Files:**
- Modify: `proxies/soul-gateway/src/management/keys-route.mjs`
- Modify: `proxies/soul-gateway/src/management/build-routes.mjs`
- Test: `proxies/soul-gateway/src/test/unit/management.test.mjs`

**Interfaces:**
- Consumes: `keysDao.provisionUserKey` (Task 1), `keysDao.isUniqueConstraintError` (existing), and the existing `readJsonBody`, `sendJson`, `BadRequestError`, `stripSensitiveFields`. Subject validation uses a **local `USER_KEY_RE` regex** — NOT `classifySubjectType` (it under-validates: accepts `user:alice` and `user:a:b:c`; review finding F2).
- Produces: `handleProvisionUserKey(ctx)` — `ctx = { req, res, params, query, appCtx }`. Returns 201 `{ key }`, 400 on bad subject/missing fields/past expiry, 409 on duplicate subject.

- [ ] **Step 1: Write the failing tests** (add inside the existing `describe('management/keys-route', …)` block in `management.test.mjs`; import the new handler in its `beforeEach` alongside the others):

```javascript
// in beforeEach destructuring add: handleProvisionUserKey
it('handleProvisionUserKey provisions a user key row (201)', async () => {
    const createdRow = {
        id: 'k9', label: 'alice/laptop', subject_id: 'user:alice:laptop',
        subject_type: 'user', source: 'signed-subject', status: 'active',
        key_hint: 'user:...top', rpm_limit: 30,
    };
    const pool = createMockPool(async (sql) =>
        /INSERT INTO api_keys/i.test(sql) ? { rows: [createdRow] } : { rows: [] });
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();
    await handleProvisionUserKey({
        req: createMockReq({ method: 'POST', body: { subjectId: 'user:alice:laptop', label: 'alice/laptop', rpmLimit: 30 } }),
        res, params: {}, query: {}, appCtx,
    });
    assert.equal(res.statusCode, 201);
    const body = parseJsonResponse(res);
    assert.equal(body.key.subject_id, 'user:alice:laptop');
    assert.equal(body.key.subject_type, 'user');
});

it('handleProvisionUserKey rejects non user:<owner>:<name> subjects (400)', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const bad = [
        'agent:proxies/soul-gateway', // agent, not user
        'user:alice',                 // only one part
        'user:alice:laptop:extra',    // three parts
        'user:alice:',                // empty name
        'user::laptop',               // empty owner
        'user:ali/ce:laptop',         // slash
        'user:alice:lap top',         // whitespace
        'user:alice:lap:top',         // colon inside a part
    ];
    for (const subjectId of bad) {
        const res = createMockRes();
        await assert.rejects(
            handleProvisionUserKey({
                req: createMockReq({ method: 'POST', body: { subjectId, label: 'x' } }),
                res, params: {}, query: {}, appCtx,
            }),
            (e) => e.name === 'BadRequestError' || e.statusCode === 400,
            `expected 400 for ${subjectId}`,
        );
    }
});

it('handleProvisionUserKey requires subjectId and label (400)', async () => {
    const pool = createMockPool(async () => ({ rows: [] }));
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();
    await assert.rejects(
        handleProvisionUserKey({
            req: createMockReq({ method: 'POST', body: { subjectId: 'user:alice:laptop' } }),
            res, params: {}, query: {}, appCtx,
        }),
        (e) => e.name === 'BadRequestError' || e.statusCode === 400,
    );
});

it('handleProvisionUserKey maps a duplicate subject to 409', async () => {
    // Throw the unique-constraint error shape isUniqueConstraintError recognizes
    // (confirm matcher at api-keys-dao.mjs:118 and align this error).
    const dupErr = Object.assign(new Error('UNIQUE constraint failed: api_keys.subject_id'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const pool = createMockPool(async (sql) => {
        if (/INSERT INTO api_keys/i.test(sql)) throw dupErr;
        return { rows: [] };
    });
    const appCtx = createMockAppCtx({ pool });
    const res = createMockRes();
    await handleProvisionUserKey({
        req: createMockReq({ method: 'POST', body: { subjectId: 'user:alice:laptop', label: 'alice/laptop' } }),
        res, params: {}, query: {}, appCtx,
    });
    assert.equal(res.statusCode, 409);
});
```

> Before running, open `api-keys-dao.mjs` and confirm what `isUniqueConstraintError` matches (message substring vs `code`); make the `dupErr` in the 409 test match it exactly.

- [ ] **Step 2: Run — verify failure**

Run: `cd proxies/soul-gateway && node --experimental-test-module-mocks --test src/test/unit/management.test.mjs`
Expected: FAIL — `handleProvisionUserKey is not a function` / import undefined.

- [ ] **Step 3: Implement the handler** — add to `keys-route.mjs`. First add a module-level subject validator near the top (no new import — `classifySubjectType` is intentionally NOT used; review finding F2):

```javascript
// Enforce EXACTLY user:<owner>:<name>, each part [A-Za-z0-9._-]+. The verifier's
// classifySubjectType only checks the generic user:<seg> shape and would wrongly
// accept user:alice or user:a:b:c (review finding F2), so validate explicitly.
const USER_KEY_RE = /^user:([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)$/;
```

Then add the handler:

```javascript
/**
 * POST /management/keys
 * Provision a policy row for an admin-created user key. Does NOT mint or store
 * key material — the signed-subject key is minted by the router; this records
 * the subject + limits so the key is listed, limited, and revocable.
 * Only user:<owner>:<name> subjects are accepted (agent rows come from discovery).
 */
export async function handleProvisionUserKey(ctx) {
    const { req, res, appCtx } = ctx;
    const { pool } = appCtx;
    const body = await readJsonBody(req);

    const subjectId = typeof body?.subjectId === 'string' ? body.subjectId.trim() : '';
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!subjectId || !label) {
        throw new BadRequestError('Missing required fields: subjectId and label');
    }

    // Enforce exactly user:<owner>:<name> — rejects agent:* and any non-two-part user id.
    if (!USER_KEY_RE.test(subjectId)) {
        throw new BadRequestError(
            'subjectId must be user:<owner>:<name>, owner and name each matching [A-Za-z0-9._-]+ (no slash, whitespace, or extra segments)',
        );
    }

    if (body.expiresAt) {
        const t = Date.parse(body.expiresAt);
        if (Number.isNaN(t) || t <= Date.now()) {
            throw new BadRequestError('expiresAt must be a future ISO-8601 timestamp');
        }
    }

    try {
        const row = await keysDao.provisionUserKey(pool, {
            subjectId,
            label,
            rpmLimit: body.rpmLimit,
            tpmLimit: body.tpmLimit,
            dailyBudgetUsd: body.dailyBudgetUsd ?? null,
            monthlyBudgetUsd: body.monthlyBudgetUsd ?? null,
            expiresAt: body.expiresAt ?? null,
        });
        sendJson(res, 201, { key: stripSensitiveFields(row) });
    } catch (error) {
        if (keysDao.isUniqueConstraintError(error)) {
            sendJson(res, 409, {
                error: {
                    message: `Key '${subjectId}' already exists. A revoked subject id cannot be reused — choose a different name.`,
                    type: 'conflict',
                },
            });
            return;
        }
        throw error;
    }
}
```

> Note: `body.rpmLimit`/`body.tpmLimit` may be `undefined`; `provisionUserKey`/`create` apply their defaults (60 / 100000) for `undefined`. If `keysDao` is imported as a namespace (`import * as keysDao …`) confirm `provisionUserKey` and `isUniqueConstraintError` are reachable as `keysDao.*` (they are — both are top-level exports of `api-keys-dao.mjs`).

- [ ] **Step 4: Register the route** in `build-routes.mjs` — add `handleProvisionUserKey` to the import block from `'./keys-route.mjs'`, and register it right after the `GET /management/keys` line:

```javascript
httpRouter.add('GET', '/management/keys', admin(handleListKeys));
httpRouter.add('POST', '/management/keys', admin(handleProvisionUserKey));
```

- [ ] **Step 4b: Assert the route is registered (review finding F5)** — extend the existing `it('matches key management routes', …)` test in `management.test.mjs` (it builds `buildManagementRouter(appCtx)` and asserts `httpRouter.match(...)`) with:

```javascript
assert.ok(httpRouter.match('POST', '/management/keys'));
```

The handler-level tests pass even if Step 4's registration is forgotten; this assertion catches that.

- [ ] **Step 5: Run — verify pass**

Run: `cd proxies/soul-gateway && node --experimental-test-module-mocks --test src/test/unit/management.test.mjs`
Expected: PASS (all 4 new cases + existing ones).

- [ ] **Step 6: Full unit gate**

Run: `cd proxies/soul-gateway && npm run test:unit`
Expected: PASS.

- [ ] **Step 7: Stage (commit on confirmation)**

```bash
git add src/management/keys-route.mjs src/management/build-routes.mjs src/test/unit/management.test.mjs
# "Add admin POST /management/keys to provision user-key rows"
```

---

## Task 3: Dashboard "Create user key" UI

**Files:**
- Modify: `proxies/soul-gateway/src/dashboard/js/app.mjs`
- Modify: `proxies/soul-gateway/src/dashboard/index.html`

**Interfaces:**
- Consumes: existing `api.post('/management/keys', body)` and the `keysPage()` component's loader `init()` (`app.mjs:2502`, which sets `this.keys = unwrapArray(await api.get('/management/keys'))`), plus `redirectToPloinkyLogin()`. **NOTE (F1):** `api.post` resolves with the JSON body on 4xx (it only throws on 401/403), so the caller MUST inspect the response.
- Produces (on the **`keysPage()`** component — `app.mjs:2488`, NOT `app()`; review finding F3): `createKeyForm`, `showCreateKey`, `newUserKey`, `createKeyError`, `openCreateKey()`, `submitCreateKey()`, `_mintUserKey(userId)`.

- [ ] **Step 1: Add state + methods to the `keysPage()` component** (`app.mjs:2488` — the Keys tab's Alpine component, NOT `app()`; review finding F3):

```javascript
createKeyForm: { owner: '', name: '', label: '', rpmLimit: '', tpmLimit: '', dailyBudgetUsd: '', monthlyBudgetUsd: '', expiresAt: '' },
showCreateKey: false,
newUserKey: '',
createKeyError: '',

openCreateKey() {
    this.createKeyForm = { owner: '', name: '', label: '', rpmLimit: '', tpmLimit: '', dailyBudgetUsd: '', monthlyBudgetUsd: '', expiresAt: '' };
    this.newUserKey = '';
    this.createKeyError = '';
    this.showCreateKey = true;
},

async submitCreateKey() {
    this.createKeyError = '';
    const owner = this.createKeyForm.owner.trim();
    const name = this.createKeyForm.name.trim();
    const part = /^[A-Za-z0-9._-]+$/;
    if (!part.test(owner) || !part.test(name)) {
        this.createKeyError = 'Owner and name must each be non-empty and use only letters, digits, dot, underscore, or hyphen.';
        return;
    }
    const subjectId = `user:${owner}:${name}`;
    const payload = { subjectId, label: this.createKeyForm.label.trim() || `${owner}/${name}` };
    for (const f of ['rpmLimit', 'tpmLimit', 'dailyBudgetUsd', 'monthlyBudgetUsd']) {
        const v = String(this.createKeyForm[f]).trim();
        if (v !== '') payload[f] = Number(v);
    }
    const expiresAt = String(this.createKeyForm.expiresAt).trim();
    if (expiresAt) payload.expiresAt = expiresAt;

    try {
        // 1) provision the policy row. api.post resolves with the JSON body even on
        //    4xx (it only throws on 401/403), so we MUST inspect it — a 409 duplicate
        //    or 400 returns { error: {...} } and must NOT fall through to mint (F1).
        const provision = await api.post('/management/keys', payload);
        if (provision?.error || !provision?.key) {
            this.createKeyError = provision?.error?.message || 'Could not provision the key row.';
            return;
        }
        // 2) only now mint the signed key via the router (admin browser session)
        this.newUserKey = await this._mintUserKey(`${owner}:${name}`);
        // 3) refresh the list — keysPage() has no loadKeys(); init() reloads this.keys
        await this.init();
    } catch (e) {
        this.createKeyError = e?.message || 'Failed to create key.';
    }
},

async _mintUserKey(userId) {
    const res = await fetch('/api/router/identity/user-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId }),
    });
    if (res.status === 401 || res.status === 403) {
        redirectToPloinkyLogin();
        throw new Error('Ploinky admin session required.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.apiKey) {
        throw new Error(data?.message || 'The router did not return a key.');
    }
    return data.apiKey;
},
```

> **Placement (F3):** these go on the **`keysPage()`** component (`app.mjs:2488`), NOT `app()`. `keysPage()` has no `loadKeys()` — its loader is `init()` (`app.mjs:2502`), so refresh with `await this.init()`. **Mint URL:** the router endpoint is at the **origin root** (`/api/router/...`), so `_mintUserKey` uses a direct `fetch` — NOT `api.post`, which prefixes the `/management` base. **Provision check (F1):** `api.post` resolves (does not throw) on 4xx, so `submitCreateKey` inspects `provision.error`/`provision.key` before minting.

- [ ] **Step 2: Add the button + modal to the Keys page in `index.html`** (model classes/structure on the existing edit-key/provider modal). On the Keys page header add:

```html
<button class="btn btn-primary" @click="openCreateKey()">Create user key</button>
```

And the modal (placed with the other modals; match existing modal wrapper classes):

```html
<div x-show="showCreateKey" x-cloak class="modal-overlay">
  <div class="modal">
    <h3>Create user key</h3>
    <template x-if="!newUserKey">
      <div>
        <label>Owner <input type="text" x-model="createKeyForm.owner" placeholder="alice"></label>
        <label>Key name <input type="text" x-model="createKeyForm.name" placeholder="laptop"></label>
        <label>Label (optional) <input type="text" x-model="createKeyForm.label"></label>
        <label>RPM limit (optional) <input type="number" x-model="createKeyForm.rpmLimit"></label>
        <label>TPM limit (optional) <input type="number" x-model="createKeyForm.tpmLimit"></label>
        <label>Daily budget USD (optional) <input type="number" x-model="createKeyForm.dailyBudgetUsd"></label>
        <label>Monthly budget USD (optional) <input type="number" x-model="createKeyForm.monthlyBudgetUsd"></label>
        <label>Expires at (optional, ISO) <input type="text" x-model="createKeyForm.expiresAt" placeholder="2027-01-01T00:00:00Z"></label>
        <p class="error" x-show="createKeyError" x-text="createKeyError"></p>
        <div class="modal-actions">
          <button class="btn" @click="showCreateKey = false">Cancel</button>
          <button class="btn btn-primary" @click="submitCreateKey()">Create</button>
        </div>
      </div>
    </template>
    <template x-if="newUserKey">
      <div>
        <p><strong>Copy this key now — it will not be shown again.</strong></p>
        <code class="key-reveal" x-text="newUserKey"></code>
        <div class="modal-actions">
          <button class="btn" @click="navigator.clipboard.writeText(newUserKey)">Copy</button>
          <button class="btn btn-primary" @click="showCreateKey = false">Done</button>
        </div>
      </div>
    </template>
  </div>
</div>
```

- [ ] **Step 3: Manual verification (no dashboard unit harness)**

Run the gateway locally (see Task 5 e2e) and confirm: the button opens the modal; creating `alice` / `laptop` shows a `user:alice:laptop|…` key once; the key appears in the Keys list with Revoke enabled; a duplicate name surfaces the 409 message. Capture a screenshot for the PR.

- [ ] **Step 4: Stage (commit on confirmation)**

```bash
git add src/dashboard/js/app.mjs src/dashboard/index.html
# "Add Create user key UI to the soul-gateway dashboard"
```

---

## Task 4: DS spec updates

**Files:**
- Modify: `proxies/soul-gateway/docs/specs/DS006-*.md` (api_keys contract), `DS007-*.md` (key lifecycle), `DS012-api-reference.md` (key-management API — **required, F4**), `DS016-*.md` (ploinky agent mode)

> Confirm the exact DS filenames with `ls proxies/soul-gateway/docs/specs/`. The 2026-06-19 design flagged DS006/DS007/DS016 as the key-lifecycle specs; **DS012 is added by review finding F4**.

- [ ] **Step 1: Document the restored capability** — add to the key-lifecycle DS: admin-created user keys via router mint + gateway provision (`POST /management/keys`); `subject_type='user'`, `source='signed-subject'`, no key material stored; the **burned-name rule** (revoked subject ids cannot be reused; rotation = revoke + new name); user keys are revocable while agent keys remain non-revocable and discovery-provisioned. Add a numbered decision entry referencing this plan + the 2026-06-24 design spec.

- [ ] **Step 1b: Update DS012 (review finding F4)** — `docs/specs/DS012-api-reference.md` (≈ line 114) currently states: *"API key management — the management API exposes read-only key listing and revocation/deletion; manual key creation via `POST /management/keys` returns HTTP 405. … the dashboard does not create raw keys."* Rewrite it: admins **can** create **user** keys via `POST /management/keys` (provisions a policy row for a router-signed `user:<owner>:<name>` key); agent keys remain non-creatable here and non-revocable; the gateway still stores no raw key material.

- [ ] **Step 2: Verify no contradictions** — `rg -n "manual.*creat|405|Create Key|read-only" docs/specs` should no longer describe user-key creation as disabled (agent keys stay non-creatable here).

- [ ] **Step 3: Stage (commit on confirmation)**

```bash
git add docs/specs/
# "Document admin-created user keys in DS specs"
```

---

## Task 5: End-to-end verification (local)

**Files:** none (verification).

- [ ] **Step 1: Fresh local deploy** (reuses the established flow): from `~/work/testExplorerFresh`, with the soul-gateway changes on a pushed branch, `ploinky start explorer --branch=<branch>` (or restart the running gateway). Confirm soul-gateway is ready.

- [ ] **Step 2: Create → authenticate → revoke → deny**

```bash
# As admin in the dashboard: create user key alice/laptop, copy the shown key into $UK
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $UK" \
  http://127.0.0.1:8080/services/soul-gateway/v1/models      # expect 200
# Revoke it from the Keys page, then:
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $UK" \
  http://127.0.0.1:8080/services/soul-gateway/v1/models      # expect 401/403 (revoked)
```
Expected: 200 before revoke, denied after. The key appears in the Keys list; a second create of `alice/laptop` returns the 409 message.

---

## Self-Review

**1. Spec coverage:**
| Spec element | Task |
|---|---|
| Admin-only, behind admin-gated dashboard | Task 2 (`admin(...)` wrapper), Task 3 (dashboard) |
| `user:<owner>:<name>` subject model | Task 2 (validation), Task 3 (form composes it) |
| Path 1, no key material stored | Task 1 (DAO inserts no key material; test asserts it), Global Constraints |
| Approach A: router mint + gateway provision | Task 2 (provision), Task 3 (mint via router fetch) |
| Provision-then-mint ordering | Task 3 `submitCreateKey` (provision then `_mintUserKey`) |
| Burned names → 409; rotation = new name | Task 2 (unique→409), Task 4 (DS) |
| Show-once v1 | Task 3 modal (`newUserKey` shown once, no reveal) |
| Reject `agent:` subjects | Task 2 (`subjectType !== 'user'` → 400) |
| ploinky unchanged | No ploinky task; router endpoint reused |
| Tests (201/400/409) | Task 2 Step 1 |
| DS follow-ups | Task 4 |
| E2E (create→auth→revoke→deny) | Task 5 |

**2. Placeholder scan:** No TBD/TODO. Two explicit "confirm at implementation" notes (the `isUniqueConstraintError` matcher shape; the exact keys-reload method name + DS filenames) are grounding instructions with the exact source location to check — not placeholders for missing logic.

**3. Type/name consistency:** `provisionUserKey` (Task 1) ↔ `keysDao.provisionUserKey` (Task 2) match. `handleProvisionUserKey` consistent across keys-route.mjs + build-routes.mjs + tests. `submitCreateKey`/`_mintUserKey`/`createKeyForm`/`newUserKey` consistent across app.mjs + index.html. Router body field `userId` matches the existing route's `body.userId`. Subject string `user:<owner>:<name>` consistent in DAO/handler/dashboard.
