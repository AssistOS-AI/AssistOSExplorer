# Discovery-Provisioned Agent Keys + Prefix Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a Ploinky agent's `api_keys` row at discovery time (not on first request), make agent keys non-revocable but limit-editable, and remove the `ploinky:`/`ploinky/` prefix from stored provider/model identifiers.

**Architecture:** Re-key the `api_keys` table on `subject_id` (dropping `key_hash`) so the discovery reconciler can create a key row using only the subject id it already has — the per-request Ed25519 signature stays the security gate. The reconciler then upserts an agent key alongside each provider/model, the management API blocks revoke for `subject_type='agent'`, the dashboard exposes the full limit set, and `providerKeyFor`/`modelKeyFor` return unprefixed identifiers. Everything keys off `subject_id` and row `metadata`, never the bearer-token hash or the name prefix.

**Tech Stack:** Node.js ES modules, embedded `node:sqlite` (via `src/db/sqlite-db.mjs`), `node:test` with `--experimental-test-module-mocks`, Alpine.js dashboard (`src/dashboard/`).

**Spec:** `soul-gateway/docs/superpowers/specs/2026-06-19-ploinky-agent-keys-at-discovery-design.md`

## Global Constraints

- ES modules with `import` / `export`. Four-space indent for JS, two-space for JSON/YAML.
- No database migration. Edit `src/db/schema/sqlite-current.sql` directly; the DB is recreated fresh.
- No AI/coding-agent attribution in commits, code comments, or docs. Plain conventional-commit messages. Do NOT add `Co-Authored-By` or tool-signature footers (the repo's `CLAUDE.md` overrides any global default that says otherwise).
- Run from `soul-gateway/`. Test commands: `npm run test:unit`, or a single file with `node --experimental-test-module-mocks --test src/test/unit/<file>.test.mjs`.
- Keep changes scoped to `soul-gateway/`. Do not touch sibling repos or `node_modules/`.
- The provider/inference boundary is untouched by this work (no upstream-inference code changes).
- Default signed-subject limits stay `rpm_limit = 60`, `tpm_limit = 100000` (the schema column DEFAULTs and the DAO defaults must agree).

---

### Task 1: Make `api_keys` subject-keyed (schema + DAO + auth)

Re-key the table on `subject_id`, drop `key_hash`, replace the hash-keyed upsert with a subject-keyed one, and switch request auth to look up by `subject_id`. This is one atomic deliverable: the suite only goes green when schema, DAO, and auth move together.

**Files:**
- Modify: `src/db/schema/sqlite-current.sql` (api_keys table, lines 21-49)
- Modify: `src/db/sqlite-db.mjs:44-47` (`BLOB_COLUMNS`)
- Modify: `src/db/dao/api-keys-dao.mjs` (full create/upsert/findByHash rework)
- Modify: `src/runtime/security/api-key-auth.mjs` (auth step 6 + remove pepper/hash)
- Test: `src/test/integration/sqlite-dao.test.mjs:33-60`
- Test: `src/test/unit/dao-queries.test.mjs:9-25`
- Test: `src/test/unit/embedded-auth.test.mjs:430-446`
- Test: `src/test/unit/security.test.mjs` (imports + the `hashApiKey`/`derivePepper` describe blocks, lines 13-14 and 136-185)
- Test: `src/test/unit/public-api-models.test.mjs:157-189` (`createApiKeyPool` mock)

**Interfaces:**
- Produces: `upsertSignedSubjectKey(pool, { subjectId, subjectType, label?, rpmLimit?, tpmLimit? }) -> Promise<row>` in `api-keys-dao.mjs` — finds the row by `subject_id`, inserts one (with a derived `key_hint` and default limits) if absent, returns the existing/created row. Never overwrites an existing row's columns.
- Produces: `create(pool, { id?, label, keyHint, subjectId, subjectType, source?, status?, rpmLimit?, tpmLimit?, dailyBudgetUsd?, monthlyBudgetUsd?, expiresAt?, metadata? }) -> Promise<row>` — same as before minus `keyHash`.
- Removes: `findByHash`, `createSignedSubjectKeyRecord` (api-keys-dao), `hashApiKey`, `derivePepper`, `buildKeyHint` (api-key-auth).
- Consumes (later tasks): Task 3 calls `upsertSignedSubjectKey`; Task 4 calls `findById` + `revoke`.

- [ ] **Step 1: Update the DAO/auth tests to the new contract (red first)**

In `src/test/unit/dao-queries.test.mjs`, replace the api-keys-dao expected list (lines 12-20) with:

```javascript
        const expected = [
            'create',
            'upsertSignedSubjectKey',
            'findById',
            'findBySubjectId',
            'list',
            'update',
            'revoke',
            'updateLastUsed',
        ];
```

In `src/test/integration/sqlite-dao.test.mjs`, replace the api-keys block (lines 33-60) with:

```javascript
            const key = await apiKeysDao.create(db, {
                label: 'agent:proxies/soul-gateway',
                keyHint: 'agent:...way',
                subjectId: 'agent:proxies/soul-gateway',
                subjectType: 'agent',
                metadata: { purpose: 'integration' },
            });
            assert.ok(key.id, 'api key id generated');
            assert.equal(key.metadata.purpose, 'integration');
            assert.equal(key.subject_id, 'agent:proxies/soul-gateway');
            assert.equal(key.subject_type, 'agent');
            assert.equal(key.source, 'signed-subject');

            // Lookup is by subject_id, not a key hash.
            const found = await apiKeysDao.findBySubjectId(
                db,
                'agent:proxies/soul-gateway'
            );
            assert.equal(found.id, key.id);

            // upsertSignedSubjectKey is idempotent on subject_id: a second
            // call for the same subject returns the existing logical row.
            const again = await apiKeysDao.upsertSignedSubjectKey(db, {
                subjectId: 'agent:proxies/soul-gateway',
                subjectType: 'agent',
            });
            assert.equal(again.id, key.id, 'same subject re-reads one logical row');
```

In `src/test/unit/embedded-auth.test.mjs`, change the column assertions (lines 441-444) so `key_hash` is gone:

```javascript
            assert.equal(names.includes('key_ciphertext'), false);
            assert.equal(names.includes('key_iv'), false);
            assert.equal(names.includes('key_auth_tag'), false);
            assert.equal(names.includes('key_hash'), false);
```

In `src/test/unit/security.test.mjs`, remove `hashApiKey,` and `derivePepper,` from the import block (lines 13-14) and delete the entire `describe('hashApiKey', ...)` and `describe('derivePepper', ...)` blocks (lines 136-185).

In `src/test/unit/public-api-models.test.mjs`, replace `createApiKeyPool` (lines 157-189) with:

```javascript
function createApiKeyPool() {
    // Signed-subject upsert: first lookup (by subject_id) misses, the INSERT
    // creates the row, and subsequent lookups return it. Column order matches
    // the new api_keys INSERT in api-keys-dao.create() (no key_hash).
    let subjectRow = null;
    return {
        async query(sql, params) {
            if (sql.includes('WHERE subject_id = $1')) {
                return { rows: subjectRow ? [subjectRow] : [] };
            }
            if (sql.includes('INSERT INTO api_keys')) {
                subjectRow = {
                    id: params[12],
                    label: params[0],
                    subject_id: params[1],
                    subject_type: params[2],
                    source: params[3],
                    key_hint: params[4],
                    rpm_limit: params[5],
                    tpm_limit: params[6],
                    daily_budget_usd: params[7],
                    monthly_budget_usd: params[8],
                    expires_at: params[9],
                    status: params[10],
                    metadata: params[11],
                };
                return { rows: [subjectRow] };
            }
            return { rows: [] };
        },
    };
}
```

- [ ] **Step 2: Run the affected tests to confirm they fail**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/dao-queries.test.mjs src/test/integration/sqlite-dao.test.mjs src/test/unit/security.test.mjs
```
Expected: FAIL — `upsertSignedSubjectKey`/`findBySubjectId` missing exports, `create` still requires `keyHash` semantics, and `hashApiKey`/`derivePepper` import errors.

- [ ] **Step 3: Drop `key_hash` from the schema**

In `src/db/schema/sqlite-current.sql`, replace the comment + table (lines 21-49) so there is no `key_hash` column and the comment no longer claims an HMAC hash is stored:

```sql
-- ── api_keys ────────────────────────────────────────────────────────
-- Signed-subject-only. Rows are deterministic, server-derived records for a
-- Ploinky-signed subject (agent:<repo>/<agent> or user:<userId>), keyed
-- uniquely by subject_id. Agent rows are provisioned at Ploinky discovery;
-- user rows are created on the first valid signed request. No key material is
-- stored: the bearer token is `<subjectId>|<ed25519-signature>` and is
-- verified against the Ploinky public key on every request.
CREATE TABLE IF NOT EXISTS api_keys (
    id                    TEXT PRIMARY KEY,
    label                 TEXT NOT NULL,
    subject_id            TEXT NOT NULL UNIQUE,
    subject_type          TEXT NOT NULL CHECK (subject_type IN ('agent', 'user')),
    source                TEXT NOT NULL DEFAULT 'signed-subject' CHECK (source = 'signed-subject'),
    key_hint              TEXT NOT NULL,
    rpm_limit             INTEGER NOT NULL DEFAULT 60 CHECK (rpm_limit > 0),
    tpm_limit             INTEGER NOT NULL DEFAULT 100000 CHECK (tpm_limit > 0),
    daily_budget_usd      REAL,
    monthly_budget_usd    REAL,
    expires_at            TEXT,
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    last_used_at          TEXT,
    metadata              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    revoked_at            TEXT,
    CHECK (daily_budget_usd IS NULL OR daily_budget_usd >= 0),
    CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0)
);
```

Leave the two indexes (lines 51-52) unchanged.

In `src/db/sqlite-db.mjs`, remove `'key_hash',` from `BLOB_COLUMNS` (line 45) so it reads:

```javascript
const BLOB_COLUMNS = new Set([
    'secret_ciphertext', 'secret_iv', 'secret_auth_tag',
]);
```

- [ ] **Step 4: Rewrite the DAO**

In `src/db/dao/api-keys-dao.mjs`, update the file docstring to drop the "HMAC key_hash" language, then replace `create`, `createSignedSubjectKeyRecord`, and `findByHash` (lines 16-158) with `create`, `upsertSignedSubjectKey`, a `buildKeyHint` helper, and `isUniqueConstraintError` (keep `findBySubjectId`, `findById`, `list`, `update`, `revoke`, `updateLastUsed` as they are):

```javascript
/**
 * Insert a signed-subject api_keys row. No key material is stored; the row is
 * the deterministic record for a subject, keyed uniquely by subject_id.
 */
export async function create(
    pool,
    {
        id,
        label,
        keyHint,
        subjectId,
        subjectType,
        source = 'signed-subject',
        status = 'active',
        rpmLimit = 60,
        tpmLimit = 100000,
        dailyBudgetUsd = null,
        monthlyBudgetUsd = null,
        expiresAt = null,
        metadata = {},
    }
) {
    const rowId = id || randomUUID();
    const { rows } = await pool.query(
        `INSERT INTO ${TABLE}
       (label, subject_id, subject_type, source, key_hint,
        rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
        expires_at, status, metadata, id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
        [
            label,
            subjectId,
            subjectType,
            source,
            keyHint,
            rpmLimit,
            tpmLimit,
            dailyBudgetUsd,
            monthlyBudgetUsd,
            expiresAt,
            status,
            JSON.stringify(metadata),
            rowId,
        ]
    );
    return rows[0];
}

/**
 * Find-or-create the signed-subject row for a subject, keyed on subject_id.
 *
 * - If a row already exists, return it UNCHANGED (operator-edited limits and
 *   budgets are never overwritten by a later discovery pass or request).
 * - Otherwise insert one with a derived key_hint and default limits.
 * - On a concurrent first-use race, the loser re-reads the winner's row via the
 *   subject_id UNIQUE index.
 *
 * Revocation semantics (enforced by callers, see api-key-auth.mjs):
 *   - A revoked row is never reactivated here.
 *   - Deleting the row permits recreation on the next valid signed request.
 */
export async function upsertSignedSubjectKey(
    pool,
    {
        subjectId,
        subjectType,
        label = subjectId,
        rpmLimit = 60,
        tpmLimit = 100000,
    }
) {
    const existing = await findBySubjectId(pool, subjectId);
    if (existing) return existing;
    try {
        return await create(pool, {
            label,
            keyHint: buildKeyHint(subjectId),
            subjectId,
            subjectType,
            source: 'signed-subject',
            status: 'active',
            rpmLimit,
            tpmLimit,
            metadata: { subjectId, subjectType, source: 'signed-subject' },
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        return await findBySubjectId(pool, subjectId);
    }
}

/** Short, non-secret display hint derived from the subject id. */
function buildKeyHint(value) {
    const str = String(value || '');
    if (str.length <= 12) return str;
    return `${str.slice(0, 8)}...${str.slice(-4)}`;
}

/**
 * Detect a SQLite UNIQUE-constraint violation surfaced by node:sqlite
 * (ERR_SQLITE_ERROR / "UNIQUE constraint failed" / extended code 2067).
 */
export function isUniqueConstraintError(error) {
    if (!error) return false;
    const message = String(error.message || '');
    const code = String(error.code || '');
    return (
        /UNIQUE constraint failed/i.test(message) ||
        /SQLITE_CONSTRAINT/i.test(code) ||
        /SQLITE_CONSTRAINT/i.test(message) ||
        error.errcode === 2067 ||
        error.errcode === 1555 ||
        error.errcode === 19
    );
}
```

- [ ] **Step 5: Switch request auth to subject-id upsert**

In `src/runtime/security/api-key-auth.mjs`:

Remove the `createHmac` import usage for hashing — change line 29 to:
```javascript
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
```
Remove the now-unused `ensureEncryptionKey` import (line 31) if nothing else in the file uses it (it is only used by `derivePepper`).

Replace step 6 (lines 97-108) with a subject-keyed upsert:
```javascript
    // 6. Find-or-create the deterministic row for this subject, keyed on
    //    subject_id. The signature check above is the security gate; no key
    //    material is hashed or stored.
    const row = await apiKeysDao.upsertSignedSubjectKey(appCtx.pool, {
        subjectId,
        subjectType,
    });
```

Delete `hashApiKey` (lines 268-277), `derivePepper` (lines 279-295), and `buildKeyHint` (lines 297-301), plus the `SIGNED_SUBJECT_DEFAULT_RPM_LIMIT`/`SIGNED_SUBJECT_DEFAULT_TPM_LIMIT` constants (lines 54-55) — the DAO now owns the defaults. Leave parsing, classification, and Ed25519 verification (steps 1-5) and the revoked/expiry/last-used handling (steps 7-9) unchanged.

- [ ] **Step 6: Run the full unit suite to verify green**

Run:
```bash
npm run test:unit
```
Expected: PASS (all files). If `embedded-auth` still references `API_KEY_HASH_PEPPER` in `makeEnv`, that is harmless — the value is simply unused now.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema/sqlite-current.sql src/db/sqlite-db.mjs src/db/dao/api-keys-dao.mjs src/runtime/security/api-key-auth.mjs src/test/unit/dao-queries.test.mjs src/test/integration/sqlite-dao.test.mjs src/test/unit/embedded-auth.test.mjs src/test/unit/security.test.mjs src/test/unit/public-api-models.test.mjs
git commit -m "refactor(api-keys): key signed-subject rows on subject_id, drop key_hash"
```

---

### Task 2: Drop the `ploinky:`/`ploinky/` prefix from discovered provider/model keys

Make `providerKeyFor`/`modelKeyFor` return unprefixed identifiers. Routing, loop guard, tier seeding, and stale-disable all key off `metadata` (verified in the spec), so only these two functions and their test expectations change. The provider `display_name` (`Ploinky agent <subjectId>`) is intentionally left unchanged — only the key prefix is removed.

**Files:**
- Modify: `src/ploinky/reconcile-agents.mjs:11-12` (doc), `:65-77` (`providerKeyFor`, `modelKeyFor`)
- Test: `src/test/unit/reconcile-agents.test.mjs` (literal `ploinky/...` keys)

**Interfaces:**
- Produces: `providerKeyFor(subjectId) -> subjectId` (e.g. `agent:demo/echo`); `modelKeyFor(repo, agent) -> "<repo>/<agent>"` (e.g. `demo/echo`).

- [ ] **Step 1: Update the reconcile tests to expect unprefixed keys (red first)**

In `src/test/unit/reconcile-agents.test.mjs`, change every literal `'ploinky/demo/echo'` to `'demo/echo'` (assertions at lines 219, 585, 618, 628, 635, 668) and the seeded `model_key` literals `'ploinky/old/gone'` → `'old/gone'` (line 344) and `'ploinky/demo/echo'` → `'demo/echo'` (line 505). Leave `providerKeyFor(...)`/`modelKeyFor(...)` call sites alone (they auto-update) and leave `display_name` assertions (`'Ploinky agent agent:demo/echo'`, e.g. line 212) unchanged.

- [ ] **Step 2: Run the reconcile test to confirm it fails**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/reconcile-agents.test.mjs
```
Expected: FAIL — e.g. `model.model_key` is still `ploinky/demo/echo`, and the re-enable test reports `created` instead of `updated` because the seed key no longer matches `modelKeyFor`.

- [ ] **Step 3: Remove the prefix in the reconciler**

In `src/ploinky/reconcile-agents.mjs`, replace `providerKeyFor` and `modelKeyFor` (lines 60-77) with:

```javascript
/**
 * Stable provider key for a discovered agent: the subject id itself.
 * @param {string} subjectId
 * @returns {string}
 */
export function providerKeyFor(subjectId) {
    return subjectId;
}

/**
 * Stable model key for a discovered agent: `<repo>/<agent>`.
 * @param {string} repo
 * @param {string} agent
 * @returns {string}
 */
export function modelKeyFor(repo, agent) {
    return `${repo}/${agent}`;
}
```

Update the file-header comment (lines 11-12) to describe the new scheme:
```javascript
 * Each discovered agent maps to exactly one provider (stable key
 * `<subjectId>`) and one model (stable id `<repo>/<agent>`).
```

- [ ] **Step 4: Run the reconcile test to verify green**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/reconcile-agents.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ploinky/reconcile-agents.mjs src/test/unit/reconcile-agents.test.mjs
git commit -m "feat(ploinky): drop ploinky prefix from discovered provider/model keys"
```

---

### Task 3: Provision an agent `api_keys` row during discovery

Add the api-keys DAO to the reconciler and upsert a `subject_type='agent'` key per discovered agent. The key upsert must not affect the `changed`/refresh flag or the provider/model tally, and stale agents keep their key row.

**Files:**
- Modify: `src/ploinky/reconcile-agents.mjs` (imports, `DEFAULT_DAOS`, per-agent loop)
- Test: `src/test/unit/reconcile-agents.test.mjs` (add fake api-keys DAO + cases)

**Interfaces:**
- Consumes: `apiKeysDao.upsertSignedSubjectKey(pool, { subjectId, subjectType })` from Task 1.
- Produces: `DEFAULT_DAOS` now includes `apiKeysDao`; `reconcilePloinkyAgentRecords` upserts one agent key per non-self discovered agent.

- [ ] **Step 1: Add a fake api-keys DAO and wire it into existing reconcile tests**

In `src/test/unit/reconcile-agents.test.mjs`, add this helper after `makeFakeModelsDao` (after line 159):

```javascript
function makeFakeApiKeysDao(seed = []) {
    const bySubject = new Map(); // subject_id -> row
    for (const r of seed) bySubject.set(r.subject_id, r);
    return {
        bySubject,
        async findBySubjectId(_pool, subjectId) {
            return bySubject.get(subjectId) || null;
        },
        async upsertSignedSubjectKey(_pool, { subjectId, subjectType }) {
            const existing = bySubject.get(subjectId);
            if (existing) return existing;
            const row = {
                id: randomUUID(),
                subject_id: subjectId,
                subject_type: subjectType,
                source: 'signed-subject',
                status: 'active',
                rpm_limit: 60,
                tpm_limit: 100000,
            };
            bySubject.set(subjectId, row);
            return row;
        },
    };
}
```

Then add `apiKeysDao: makeFakeApiKeysDao()` to every `daos:` object passed to the reconciler in the `describe('reconcilePloinkyAgentRecords (fake daos)', ...)` block. There are seven call sites — the `daos:` objects at lines 196-197, 234-237, 247, 288, 370, 421, and 467 — plus the shared `const daos = { ... }` at line 247 and the re-enable test at line 527. For the shared `daos` at line 247, change it to:

```javascript
        const daos = {
            providersDao: providersFake,
            modelsDao: modelsFake,
            apiKeysDao: makeFakeApiKeysDao(),
        };
```

For each inline `daos: { providersDao: ..., modelsDao: ... }`, add `apiKeysDao: makeFakeApiKeysDao(),` as a third entry.

- [ ] **Step 2: Add the new provisioning test cases (red first)**

Append these tests inside the `describe('reconcilePloinkyAgentRecords (fake daos)', ...)` block (before its closing `})` at line 536):

```javascript
    it('provisions one agent api_keys row per discovered agent', async () => {
        const apiKeysFake = makeFakeApiKeysDao();
        const summary = await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: true, agents: [agent()] },
            daos: {
                providersDao: makeFakeProvidersDao(),
                modelsDao: makeFakeModelsDao(),
                apiKeysDao: apiKeysFake,
            },
            refresh: spyRefresh(),
        });

        // The key upsert must not change the provider/model tally.
        assert.equal(summary.created, 2);

        const key = await apiKeysFake.findBySubjectId(null, 'agent:demo/echo');
        assert.ok(key, 'agent key provisioned at discovery');
        assert.equal(key.subject_type, 'agent');
        assert.equal(key.status, 'active');
    });

    it('does not overwrite an operator-edited agent key on a later pass', async () => {
        const apiKeysFake = makeFakeApiKeysDao([
            {
                id: 'key-1',
                subject_id: 'agent:demo/echo',
                subject_type: 'agent',
                source: 'signed-subject',
                status: 'active',
                rpm_limit: 5, // operator-tightened
                tpm_limit: 100000,
            },
        ]);
        await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            discovery: { complete: true, agents: [agent()] },
            daos: {
                providersDao: makeFakeProvidersDao(),
                modelsDao: makeFakeModelsDao(),
                apiKeysDao: apiKeysFake,
            },
            refresh: spyRefresh(),
        });

        const key = await apiKeysFake.findBySubjectId(null, 'agent:demo/echo');
        assert.equal(key.rpm_limit, 5, 'edited limit preserved');
    });

    it('keeps the key row for an agent that is no longer discovered', async () => {
        const apiKeysFake = makeFakeApiKeysDao([
            {
                id: 'key-gone',
                subject_id: 'agent:old/gone',
                subject_type: 'agent',
                source: 'signed-subject',
                status: 'active',
                rpm_limit: 60,
                tpm_limit: 100000,
            },
        ]);
        await reconcilePloinkyAgentRecords({
            appCtx: makeAppCtx(),
            // Complete discovery without agent:old/gone.
            discovery: { complete: true, agents: [agent()] },
            daos: {
                providersDao: makeFakeProvidersDao(),
                modelsDao: makeFakeModelsDao(),
                apiKeysDao: apiKeysFake,
            },
            refresh: spyRefresh(),
        });

        const key = await apiKeysFake.findBySubjectId(null, 'agent:old/gone');
        assert.ok(key, 'stale agent key is preserved');
        assert.equal(key.status, 'active');
    });
```

Add a real-SQLite assertion inside the existing "writes schema-valid rows" test (after line 590, before the closing of that `it`), importing the DAO at the top of the file (add `import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';` near line 17):

```javascript
            const agentKey = await apiKeysDao.findBySubjectId(
                db,
                'agent:demo/echo'
            );
            assert.ok(agentKey, 'agent api_keys row provisioned during reconcile');
            assert.equal(agentKey.subject_type, 'agent');
            assert.equal(agentKey.status, 'active');
```

- [ ] **Step 3: Run the reconcile test to confirm the new cases fail**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/reconcile-agents.test.mjs
```
Expected: FAIL — `apiKeysFake` has no row yet because the reconciler does not provision keys.

- [ ] **Step 4: Provision keys in the reconciler**

In `src/ploinky/reconcile-agents.mjs`, add the DAO import (after line 35):
```javascript
import * as apiKeysDao from '../db/dao/api-keys-dao.mjs';
```
Add it to `DEFAULT_DAOS` (line 38):
```javascript
const DEFAULT_DAOS = Object.freeze({ providersDao, modelsDao, apiKeysDao });
```
In the per-agent loop, after the `upsertModel` block (after line 320, inside the `for (const agent of agents)` loop), add:
```javascript
        // Provision the agent's signed-subject key row at discovery time so it
        // appears on the Keys page before the agent ever makes a request.
        // Insert-if-missing: never resets operator-edited limits. This does NOT
        // affect the changed/refresh flag — keys are read from the DB at auth
        // time, not from the routing snapshot.
        await daos.apiKeysDao.upsertSignedSubjectKey(pool, {
            subjectId: agent.subjectId,
            subjectType: 'agent',
        });
```

Do NOT add keys to `disableStaleRows` and do NOT touch `summary` counters for the key upsert.

- [ ] **Step 5: Run the reconcile test to verify green**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/reconcile-agents.test.mjs
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ploinky/reconcile-agents.mjs src/test/unit/reconcile-agents.test.mjs
git commit -m "feat(ploinky): provision agent api_keys rows during discovery"
```

---

### Task 4: Non-revocable agent keys + remove manual key creation (management API)

Block revoke for `subject_type='agent'` (return 409) and remove the dead manual-create route.

**Files:**
- Modify: `src/management/keys-route.mjs` (`handleRevokeKey`; remove `handleCreateKey`)
- Modify: `src/management/build-routes.mjs:23` (import), `:197` (route)
- Test: `src/test/unit/management.test.mjs` (keys-route block 560-752; router tests 3334-3471)

**Interfaces:**
- Consumes: `keysDao.findById`, `keysDao.revoke` from Task 1.
- Produces: `POST /management/keys/:keyId/revoke` returns 409 for agent keys, 200 for user keys, 404 for unknown. `POST /management/keys` no longer exists.

- [ ] **Step 1: Update the keys-route tests (red first)**

In `src/test/unit/management.test.mjs`:

Remove `handleCreateKey` from the destructured imports (lines 562 and 571) and delete the `it('handleCreateKey returns 405 ...')` test (lines 662-679).

Replace the `it('handleRevokeKey sets row status to revoked ...')` test (lines 716-751) with a user-key success case plus a new agent-key 409 case:

```javascript
    it('handleRevokeKey revokes a user key (status -> revoked)', async () => {
        const userRow = {
            id: 'k-user',
            label: 'user:alice',
            subject_id: 'user:alice',
            subject_type: 'user',
            source: 'signed-subject',
            status: 'active',
            key_hint: 'user:alice',
        };
        const revokedRow = { ...userRow, status: 'revoked' };
        const pool = createMockPool(async (sql) => {
            if (sql.includes('UPDATE') && sql.includes("status = 'revoked'")) {
                return { rows: [revokedRow], rowCount: 1 };
            }
            if (sql.includes('SELECT') && sql.includes('WHERE id = $1')) {
                return { rows: [userRow], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleRevokeKey({
            req: createMockReq(),
            res,
            params: { keyId: 'k-user' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 200);
        const body = parseJsonResponse(res);
        assert.equal(body.key.status, 'revoked');
    });

    it('handleRevokeKey returns 409 for agent keys and issues no UPDATE', async () => {
        const agentRow = {
            id: 'k-agent',
            label: 'agent:demo/echo',
            subject_id: 'agent:demo/echo',
            subject_type: 'agent',
            source: 'signed-subject',
            status: 'active',
            key_hint: 'agent:...echo',
        };
        let updateCalled = false;
        const pool = createMockPool(async (sql) => {
            if (sql.includes('UPDATE')) {
                updateCalled = true;
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes('SELECT') && sql.includes('WHERE id = $1')) {
                return { rows: [agentRow], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        const appCtx = createMockAppCtx({ pool });
        const res = createMockRes();

        await handleRevokeKey({
            req: createMockReq(),
            res,
            params: { keyId: 'k-agent' },
            query: {},
            appCtx,
        });

        assert.equal(res.statusCode, 409);
        const body = parseJsonResponse(res);
        assert.match(body.error.message, /cannot be revoked/i);
        assert.equal(updateCalled, false, 'agent keys must not be UPDATEd');
    });
```

The existing `it('handleRevokeKey returns 404 for already revoked')` (lines 646-660) still passes: with an all-empty mock, `findById` returns null, so the handler returns 404.

In the router describe block, fix the route-registration expectations:

- In `it('rejects management routes without router admin identity')` (lines 3334-3352), change the matched route from `POST /management/keys` (line 3337) to a still-existing protected write route:
```javascript
        const match = httpRouter.match('POST', '/management/keys/k1/revoke');
        const req = createMockReq({ method: 'POST' });
```
- In `it('matches key management routes')` (lines 3461-3471), delete the `assert.ok(httpRouter.match('POST', '/management/keys'));` line (3466).
- In `it('does not require Soul Gateway CSRF on admin writes ...')` (lines 3425-3459), update the mock so the `findById` SELECT returns a user row, otherwise the new revoke handler 404s before the UPDATE:
```javascript
            pool: createMockPool(async (sql) => {
                if (/UPDATE api_keys/.test(sql)) {
                    return {
                        rows: [{
                            id: keyId,
                            label: 'user:alice',
                            subject_id: 'user:alice',
                            subject_type: 'user',
                            status: 'revoked',
                        }],
                    };
                }
                if (/SELECT/.test(sql) && /WHERE id = \$1/.test(sql)) {
                    return {
                        rows: [{
                            id: keyId,
                            label: 'user:alice',
                            subject_id: 'user:alice',
                            subject_type: 'user',
                            status: 'active',
                        }],
                    };
                }
                return { rows: [], rowCount: 0 };
            }),
```

- [ ] **Step 2: Run the management test to confirm it fails**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
```
Expected: FAIL — `handleCreateKey` import is gone but the handler still exists/route still registered; agent-revoke returns 200 (not 409) because the gate is not implemented.

- [ ] **Step 3: Implement the revoke gate and remove manual create**

In `src/management/keys-route.mjs`, replace `handleRevokeKey` (lines 115-129) with a version that fetches the row first and blocks agent keys:

```javascript
/**
 * POST /management/keys/:keyId/revoke
 *
 * Agent keys (subject_type === 'agent') are provisioned by Ploinky discovery
 * and cannot be revoked; access is governed by limits/budget/expiry instead.
 * User keys may be revoked.
 */
export async function handleRevokeKey(ctx) {
    const { res, params, appCtx } = ctx;
    const { pool } = appCtx;

    const existing = await keysDao.findById(pool, params.keyId);
    if (!existing) {
        sendNotFound(res, 'Key');
        return;
    }
    if (existing.subject_type === 'agent') {
        sendJson(res, 409, {
            error: {
                message:
                    'Agent keys cannot be revoked. Adjust limits, budget, or expiry instead.',
                type: 'conflict',
            },
        });
        return;
    }

    const row = await keysDao.revoke(pool, params.keyId);
    if (!row) {
        sendNotFound(res, 'Key');
        return;
    }

    sendJson(res, 200, { key: stripSensitiveFields(row) });
}
```

Delete `handleCreateKey` entirely (lines 40-61) and update the route-list comment at the top of the file (lines 4-11) to drop the `POST /management/keys` line.

In `src/management/build-routes.mjs`, remove `handleCreateKey,` from the import block (line 23) and delete the route registration (line 197): `httpRouter.add('POST', '/management/keys', admin(handleCreateKey));`.

- [ ] **Step 4: Run the management test to verify green**

Run:
```bash
node --experimental-test-module-mocks --test src/test/unit/management.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Run the full unit suite**

Run:
```bash
npm run test:unit
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/management/keys-route.mjs src/management/build-routes.mjs src/test/unit/management.test.mjs
git commit -m "feat(keys): block revoke for agent keys, remove manual key creation"
```

---

### Task 5: Dashboard Keys page — editable limits, revoke gate, remove create UI

Expose RPM/TPM/daily/monthly/expiry in the edit modal (sending camelCase so the PATCH route actually applies them — the current snake_case `daily_budget_usd` is silently dropped today), hide Revoke for agent keys, show a type badge, and remove the dead Create-Key UI. No automated dashboard tests exist; verification is a syntax check plus a manual smoke test.

**Files:**
- Modify: `src/dashboard/js/app.mjs:2488-2597` (`keysPage()`)
- Modify: `src/dashboard/index.html:4273-4561` (keys page markup)

- [ ] **Step 1: Rewrite the `keysPage()` component**

In `src/dashboard/js/app.mjs`, replace the component state and the `generate`/`create`/`edit`/`saveEdit` methods (lines 2491-2576) so create is gone and edit covers the full limit set. Replace lines 2491-2496 with:

```javascript
        showEdit: false,
        editing: null,
        editForm: {
            label: '',
            rpm_limit: '',
            tpm_limit: '',
            daily_budget_usd: '',
            monthly_budget_usd: '',
            expires_at: '',
        },
```

Delete `generate()` (lines 2532-2540) and `create()` (lines 2542-2555). Replace `edit()` and `saveEdit()` (lines 2557-2576) with:

```javascript
        edit(k) {
            this.editing = k;
            this.editForm = {
                label: k.label || '',
                rpm_limit: k.rpm_limit ?? '',
                tpm_limit: k.tpm_limit ?? '',
                daily_budget_usd: k.daily_budget_usd ?? k.daily_budget ?? '',
                monthly_budget_usd: k.monthly_budget_usd ?? '',
                expires_at: k.expires_at ?? '',
            };
            this.showEdit = true;
        },

        async saveEdit() {
            // The PATCH route accepts camelCase fields; rpm/tpm must stay > 0
            // (schema CHECK), so omit them when blank rather than sending null.
            const payload = { label: this.editForm.label };
            const rpm = Number(this.editForm.rpm_limit);
            const tpm = Number(this.editForm.tpm_limit);
            if (Number.isFinite(rpm) && rpm > 0) payload.rpmLimit = rpm;
            if (Number.isFinite(tpm) && tpm > 0) payload.tpmLimit = tpm;
            payload.dailyBudgetUsd =
                this.editForm.daily_budget_usd === ''
                    ? null
                    : Number(this.editForm.daily_budget_usd);
            payload.monthlyBudgetUsd =
                this.editForm.monthly_budget_usd === ''
                    ? null
                    : Number(this.editForm.monthly_budget_usd);
            payload.expiresAt =
                this.editForm.expires_at === '' ? null : this.editForm.expires_at;
            await api.patch(`/management/keys/${this.editing.id}`, payload);
            this.showEdit = false;
            this.editing = null;
            this.keys = unwrapArray(await api.get('/management/keys'));
        },
```

Keep `init`, `budgetPct`, `remaining`, `_budget`, `revoke`, `resetBudget`, `formatDate` as they are.

- [ ] **Step 2: Update the keys page markup**

In `src/dashboard/index.html`:

Remove the Create-Key button (lines 4283-4288), so the header is just the heading:
```html
                                <div
                                    class="flex justify-between items-center mb-4"
                                >
                                    <h2 class="text-lg font-bold">API Keys</h2>
                                </div>
```

Delete the Create modal `<dialog>` (lines 4290-4361) and the "Show created key" alert (lines 4410-4439).

Replace the Edit modal body's two form-controls (lines 4371-4389) with the full field set:
```html
                                        <div class="form-control">
                                            <label class="label">Label</label
                                            ><input
                                                type="text"
                                                class="input input-bordered"
                                                x-model="editForm.label"
                                            />
                                        </div>
                                        <div class="form-control">
                                            <label class="label">RPM limit</label
                                            ><input
                                                type="number"
                                                min="1"
                                                class="input input-bordered"
                                                x-model="editForm.rpm_limit"
                                            />
                                        </div>
                                        <div class="form-control">
                                            <label class="label">TPM limit</label
                                            ><input
                                                type="number"
                                                min="1"
                                                class="input input-bordered"
                                                x-model="editForm.tpm_limit"
                                            />
                                        </div>
                                        <div class="form-control">
                                            <label class="label"
                                                >Daily Budget ($)</label
                                            ><input
                                                type="number"
                                                step="0.01"
                                                class="input input-bordered"
                                                x-model="editForm.daily_budget_usd"
                                                placeholder="Leave empty for unlimited"
                                            />
                                        </div>
                                        <div class="form-control">
                                            <label class="label"
                                                >Monthly Budget ($)</label
                                            ><input
                                                type="number"
                                                step="0.01"
                                                class="input input-bordered"
                                                x-model="editForm.monthly_budget_usd"
                                                placeholder="Leave empty for unlimited"
                                            />
                                        </div>
                                        <div class="form-control">
                                            <label class="label"
                                                >Expires At (ISO 8601)</label
                                            ><input
                                                type="text"
                                                class="input input-bordered"
                                                x-model="editForm.expires_at"
                                                placeholder="Leave empty for no expiry"
                                            />
                                        </div>
```

Add a Type column header after `<th>Label</th>` (line 4445):
```html
                                                    <th>Label</th>
                                                    <th>Type</th>
```

Add the matching cell after the Label cell (after line 4466):
```html
                                                        <td>
                                                            <span
                                                                class="badge badge-ghost badge-sm"
                                                                x-text="k.subject_type === 'agent' ? 'Agent' : 'User'"
                                                            ></span>
                                                        </td>
```

Replace the Revoke button (lines 4546-4552) so it is hidden for agent keys:
```html
                                                                <button
                                                                    class="btn btn-error btn-xs"
                                                                    x-show="k.subject_type !== 'agent'"
                                                                    :disabled="k.status === 'revoked' || k.is_revoked"
                                                                    @click="revoke(k)"
                                                                >
                                                                    Revoke
                                                                </button>
```

- [ ] **Step 3: Syntax-check the dashboard JS**

Run:
```bash
node --check src/dashboard/js/app.mjs
```
Expected: no output (exit 0). Then confirm no dangling references remain:
```bash
grep -n "showCreate\|newKey\|generate(\|\.create(" src/dashboard/js/app.mjs src/dashboard/index.html || echo "clean"
```
Expected: `clean` (no Create-Key wiring left).

- [ ] **Step 4: Run the full unit suite (no regressions)**

Run:
```bash
npm run test:unit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/js/app.mjs src/dashboard/index.html
git commit -m "feat(dashboard): edit agent key limits, hide revoke for agent keys, drop create UI"
```

- [ ] **Step 6: Manual acceptance verification**

Against a local Ploinky-managed gateway (or a dev run with discovery pointed at a router):
1. Trigger discovery; open the dashboard Keys page. Confirm each discovered agent appears as an **Agent** row with status Active **before** sending any `/v1` request (acceptance #2).
2. Edit an agent key: set RPM and a daily budget; save; reload — confirm the values persist (acceptance #4). Re-run discovery; confirm the values are NOT reset (acceptance #6).
3. Confirm the **Revoke** button is absent on Agent rows and present on any User row (acceptance #3).
4. Open the Providers and Models pages; confirm names have no `ploinky:`/`ploinky/` prefix, and a client call with `model: "<repo>/<agent>"` routes to the agent (acceptance #5).

---

## Self-Review

**Spec coverage:**
- Requirement 1 (populate at discovery) → Task 1 (subject-keyed rows) + Task 3 (reconciler provisions keys). ✓
- Requirement 2 (agent keys non-revocable, editable) → Task 4 (409 gate) + Task 5 (full edit form). ✓
- Requirement 3 (remove prefix, data-level) → Task 2. ✓
- Requirement 4 (no migration) → Task 1 edits the schema file directly; no migration scripts. ✓
- Acceptance criteria 1-6 → mapped to test steps (1: every task's `npm run test:unit`; 2/4/6: Task 3 tests + Task 5 manual; 3: Task 4 tests + Task 5 manual; 5: Task 2 + Task 5 manual). ✓
- Edge cases (lazy fallback for pre-discovery agents; flapping agents keep limits; stale key kept) → covered by `upsertSignedSubjectKey` find-first semantics (Task 1) and Task 3 tests. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion or mock. ✓

**Type/name consistency:** `upsertSignedSubjectKey(pool, { subjectId, subjectType, label?, rpmLimit?, tpmLimit? })` is defined in Task 1 and called identically in Task 3 (auth) and the reconciler. `findBySubjectId` is reused by the DAO, auth, reconciler tests, and the public-api mock. `handleRevokeKey` uses `keysDao.findById` + `keysDao.revoke`, both retained in Task 1. Dashboard `saveEdit` sends camelCase (`rpmLimit`/`tpmLimit`/`dailyBudgetUsd`/`monthlyBudgetUsd`/`expiresAt`) matching `keys-route.mjs` `ALLOWED` fields. ✓

## Post-Implementation Follow-ups (not part of this plan)

Update the current-behavior DS specs once the code lands: DS006 (api_keys schema), DS007 (key lifecycle), DS016 (discovery provisions keys; agent keys non-revocable; unprefixed identifiers).
