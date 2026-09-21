/**
 * First-start free model defaults against real SQLite, with dummy
 * credentials and no network.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import { decrypt, ensureEncryptionKey } from '../../runtime/security/encryption.mjs';
import {
    FREE_BASELINE_MODELS,
    FREE_DEFAULTS_BOOTSTRAP_KEY,
    FREE_PROVIDER_KEY,
    FREE_TIER_SPECS,
    freeModelKey,
    installFreeModelDefaults,
} from '../../bootstrap/free-model-defaults.mjs';
import { upsertProviderApiKeyAccount } from '../../runtime/providers/api-key-account.mjs';
import { bootstrapInitialTagTiersOnce } from '../../bootstrap/reconcile-tag-tiers.mjs';
import { BUNDLED_OPENROUTER_FREE_KEY } from '../../bootstrap/free-provider-credential.mjs';
import { isGeneralChatModelId } from '../../runtime/providers/free-model-policy.mjs';

const ALL_TIERS = 'fast,code,plan,write,deep,ultra,web-assist';
const DUMMY_KEY = 'sk-or-v1-dummy-test-credential-0000000000';
let dir;
let pool;

async function openPool(file = 'gateway.sqlite3') {
    const sqlitePath = join(dir, file);
    const db = await openDatabase({ SQLITE_PATH: sqlitePath });
    await initializeSchema(db);
    return db;
}

function appCtxFor(db, env = {}) {
    const fullEnv = {
        ENCRYPTION_KEY: '5'.repeat(64),
        FREE_MODELS_ENABLED: true,
        LLM_DEFAULT_TIERS: ALL_TIERS,
        OPENROUTER_API_KEY: null,
        ...env,
    };
    return {
        pool: db,
        config: { env: fullEnv },
        services: { encryptionKey: ensureEncryptionKey(fullEnv) },
        log: { info() {}, warn() {} },
    };
}

async function count(db, sql, params = []) {
    const { rows } = await db.query(sql, params);
    return Number(Object.values(rows[0])[0]);
}

async function tierChildren(db, tierKey) {
    const { rows } = await db.query(
        `SELECT child.model_key, child.provider_model_id, child.enabled AS child_enabled,
                child.capabilities, mc.priority, mc.settings
           FROM models tier
           JOIN model_children mc ON mc.parent_model_id = tier.id
           JOIN models child ON child.id = mc.child_model_id
          WHERE tier.model_key = $1
          ORDER BY mc.priority`,
        [tierKey]
    );
    return rows;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'soul-free-defaults-'));
    pool = await openPool();
});

afterEach(async () => {
    await pool?.end?.().catch(() => {});
    await rm(dir, { recursive: true, force: true });
});

describe('first-start free defaults', () => {
    it('installs the provider, encrypted account, baseline models, all seven tiers, and the marker', async () => {
        const summary = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(summary.status, 'installed');
        assert.deepEqual(summary.tiersCreated, ALL_TIERS.split(','));

        const { rows: [provider] } = await pool.query('SELECT * FROM providers WHERE provider_key = $1', [FREE_PROVIDER_KEY]);
        assert.equal(provider.adapter_key, 'openai-api');
        assert.equal(provider.base_url, 'https://openrouter.ai/api/v1');
        assert.equal(provider.settings.free_only, true);
        assert.equal(provider.settings.discovery_path, '/models/user');

        const { rows: [account] } = await pool.query('SELECT * FROM provider_accounts WHERE provider_id = $1', [provider.id]);
        assert.equal(account.status, 'active');
        const key = ensureEncryptionKey({ ENCRYPTION_KEY: '5'.repeat(64) });
        assert.equal(decrypt(account.secret_ciphertext, account.secret_iv, account.secret_auth_tag, key), DUMMY_KEY);
        assert.notEqual(account.secret_hint, DUMMY_KEY);

        assert.equal(
            await count(pool, 'SELECT COUNT(*) FROM models WHERE provider_id = $1 AND enabled = 1', [provider.id]),
            FREE_BASELINE_MODELS.length
        );
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM gateway_bootstrap_state WHERE bootstrap_key = $1', [FREE_DEFAULTS_BOOTSTRAP_KEY]), 1);
    });

    it('never stores the credential in plaintext in the database file', async () => {
        await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        await pool.end();
        const bytes = await readFile(join(dir, 'gateway.sqlite3'));
        const wal = await readFile(join(dir, 'gateway.sqlite3-wal')).catch(() => Buffer.alloc(0));
        assert.equal(Buffer.concat([bytes, wal]).includes(Buffer.from(DUMMY_KEY)), false);
        pool = null;
    });

    it('uses the bundled free key by default and OPENROUTER_API_KEY when supplied', async () => {
        const key = ensureEncryptionKey({ ENCRYPTION_KEY: '5'.repeat(64) });
        await installFreeModelDefaults({ appCtx: appCtxFor(pool) });
        let { rows: [account] } = await pool.query('SELECT * FROM provider_accounts');
        assert.equal(decrypt(account.secret_ciphertext, account.secret_iv, account.secret_auth_tag, key), BUNDLED_OPENROUTER_FREE_KEY);
        assert.equal(account.metadata.bundled, true);
        assert.match(account.metadata.expiresAt, /^2027-03-20T/);

        const other = await openPool('override.sqlite3');
        await installFreeModelDefaults({ appCtx: appCtxFor(other, { OPENROUTER_API_KEY: DUMMY_KEY }) });
        ({ rows: [account] } = await other.query('SELECT * FROM provider_accounts'));
        assert.equal(decrypt(account.secret_ciphertext, account.secret_iv, account.secret_auth_tag, key), DUMMY_KEY);
        assert.equal(account.metadata.bundled, false);
        await other.end();
    });

    it('is idempotent and serializes two concurrent installs in one process', async () => {
        const appCtx = appCtxFor(pool);
        const results = await Promise.all([
            installFreeModelDefaults({ appCtx, apiKey: DUMMY_KEY }),
            installFreeModelDefaults({ appCtx, apiKey: DUMMY_KEY }),
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), ['already-complete', 'installed']);
        const again = await installFreeModelDefaults({ appCtx, apiKey: DUMMY_KEY });
        assert.equal(again.status, 'already-complete');
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM providers'), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM provider_accounts'), 1);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 7);
    });

    it('rolls back completely when interrupted, and a restart completes the install', async () => {
        const appCtx = appCtxFor(pool);
        await assert.rejects(
            installFreeModelDefaults({
                appCtx,
                apiKey: DUMMY_KEY,
                beforeCommit: async () => { throw new Error('simulated crash before commit'); },
            }),
            /simulated crash/
        );
        for (const table of ['providers', 'provider_accounts', 'models', 'model_children', 'gateway_bootstrap_state']) {
            assert.equal(await count(pool, `SELECT COUNT(*) FROM ${table}`), 0, table);
        }
        // A real restart on the same, already existing database file.
        await pool.end();
        pool = await openPool();
        const summary = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(summary.status, 'installed');
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 7);
    });

    it('does nothing and writes no marker when disabled, so enabling later still installs', async () => {
        const disabled = await installFreeModelDefaults({ appCtx: appCtxFor(pool, { FREE_MODELS_ENABLED: false }) });
        assert.equal(disabled.status, 'disabled');
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM providers'), 0);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM gateway_bootstrap_state'), 0);
        const enabled = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(enabled.status, 'installed');
    });

    it('never resurrects records an administrator disabled or deleted when the install runs again', async () => {
        await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        await pool.query("UPDATE provider_accounts SET status = 'disabled'");
        await pool.query("DELETE FROM models WHERE model_key = 'ultra'");
        await pool.query("UPDATE models SET enabled = 0 WHERE model_key = $1", [freeModelKey('nex-agi/nex-n2.5-mini:free')]);
        const { rows: before } = await pool.query("SELECT mc.child_model_id, mc.priority FROM model_children mc JOIN models t ON t.id = mc.parent_model_id WHERE t.model_key = 'fast' ORDER BY mc.priority");
        await pool.query("UPDATE model_children SET priority = priority + 10 WHERE parent_model_id = (SELECT id FROM models WHERE model_key = 'fast')");

        const summary = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(summary.status, 'already-complete');
        assert.equal(await count(pool, "SELECT COUNT(*) FROM provider_accounts WHERE status = 'disabled'"), 1);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE model_key = 'ultra'"), 0);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM models WHERE model_key = $1 AND enabled = 0', [freeModelKey('nex-agi/nex-n2.5-mini:free')]), 1);
        const { rows: after } = await pool.query("SELECT mc.priority FROM model_children mc JOIN models t ON t.id = mc.parent_model_id WHERE t.model_key = 'fast' ORDER BY mc.priority");
        assert.deepEqual(after.map((row) => row.priority), before.map((row) => row.priority + 10));
    });
});

describe('administrator records created while the defaults are disabled', () => {
    it('keeps an administrator tier and alias and creates only the missing tiers', async () => {
        const disabled = await installFreeModelDefaults({ appCtx: appCtxFor(pool, { FREE_MODELS_ENABLED: false }) });
        assert.equal(disabled.status, 'disabled');
        const target = randomUUID();
        const providerId = randomUUID();
        await pool.query(
            "INSERT INTO providers (id, provider_key, display_name, kind, adapter_key, auth_strategy, base_url) VALUES ($1, 'mine', 'Mine', 'external_api', 'openai-api', 'api_key', 'https://example.invalid/v1')",
            [providerId]
        );
        await pool.query(
            "INSERT INTO models (id, model_key, display_name, provider_id, provider_model_id) VALUES ($1, 'mine/model', 'model', $2, 'model')",
            [target, providerId]
        );
        const adminTier = randomUUID();
        await pool.query("INSERT INTO models (id, model_key, display_name, strategy_kind) VALUES ($1, 'code', 'code', 'cascade')", [adminTier]);
        await pool.query('INSERT INTO model_children (id, parent_model_id, child_model_id, priority) VALUES ($1, $2, $3, 1)', [randomUUID(), adminTier, target]);
        await pool.query("INSERT INTO model_aliases (id, alias, model_id) VALUES ($1, 'write', $2)", [randomUUID(), target]);

        const summary = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(summary.status, 'installed');
        assert.deepEqual(summary.tiersKept.sort(), ['code', 'write']);
        assert.deepEqual(summary.tiersCreated.sort(), ['deep', 'fast', 'plan', 'ultra', 'web-assist']);
        assert.deepEqual((await tierChildren(pool, 'code')).map((row) => row.model_key), ['mine/model']);
    });

    it('does not add rows or credentials to an administrator provider with the same key', async () => {
        const providerId = randomUUID();
        await pool.query(
            "INSERT INTO providers (id, provider_key, display_name, kind, adapter_key, auth_strategy, base_url) VALUES ($1, $2, 'Mine', 'external_api', 'openai-api', 'api_key', 'https://openrouter.ai/api/v1')",
            [providerId, FREE_PROVIDER_KEY]
        );
        const summary = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(summary.providerCreated, false);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM provider_accounts'), 0);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM models WHERE provider_id = $1', [providerId]), 0);
        // That provider has no enabled model, so no tier can have a child:
        // no empty cascade is created, and every tier stays pending.
        assert.deepEqual(summary.tiersCreated, []);
        assert.deepEqual(summary.tiersPending, ALL_TIERS.split(','));
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 0);
    });

    it('creates a pending tier on a later start once the free provider has an enabled child', async () => {
        const providerId = randomUUID();
        await pool.query(
            "INSERT INTO providers (id, provider_key, display_name, kind, adapter_key, auth_strategy, base_url) VALUES ($1, $2, 'Mine', 'external_api', 'openai-api', 'api_key', 'https://openrouter.ai/api/v1')",
            [providerId, FREE_PROVIDER_KEY]
        );
        const first = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(first.status, 'installed');
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM gateway_bootstrap_state WHERE bootstrap_key = $1', [FREE_DEFAULTS_BOOTSTRAP_KEY]), 1);

        // Nothing changed: the tiers are still pending and nothing is written.
        const idle = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(idle.status, 'pending');
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 0);

        // The administrator's provider gains one enabled model that `fast`
        // lists first; only the tiers that list it can be created.
        const firstFastChild = FREE_TIER_SPECS.fast.children[0].providerModelId;
        await pool.query(
            "INSERT INTO models (id, model_key, display_name, provider_id, provider_model_id) VALUES ($1, $2, 'mine', $3, $4)",
            [randomUUID(), `mine/${firstFastChild}`, providerId, firstFastChild]
        );
        const later = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(later.status, 'updated');
        const listing = ALL_TIERS.split(',').filter((tier) =>
            FREE_TIER_SPECS[tier].children.some((entry) => entry.providerModelId === firstFastChild));
        assert.ok(listing.includes('fast'));
        assert.deepEqual(later.tiersCreated, listing);
        assert.deepEqual((await tierChildren(pool, 'fast')).map((row) => row.provider_model_id), [firstFastChild]);
        const { rows: [fastTier] } = await pool.query("SELECT max_attempts FROM models WHERE model_key = 'fast'");
        assert.equal(fastTier.max_attempts, 1, 'a cascade never tries more children than it has');
        assert.deepEqual(later.tiersPending.sort(), ALL_TIERS.split(',').filter((tier) => !listing.includes(tier)).sort());

        // A created tier is handled: deleting it keeps it deleted.
        await pool.query("DELETE FROM models WHERE model_key = 'fast'");
        const after = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.ok(['pending', 'updated'].includes(after.status));
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE model_key = 'fast'"), 0);
    });
});

describe('tiers requested after the first start', () => {
    it('creates tiers added to LLM_DEFAULT_TIERS later and never recreates a deleted one', async () => {
        const first = await installFreeModelDefaults({ appCtx: appCtxFor(pool, { LLM_DEFAULT_TIERS: 'fast,code' }), apiKey: DUMMY_KEY });
        assert.equal(first.status, 'installed');
        assert.deepEqual(first.tiersCreated, ['fast', 'code']);
        await pool.query("DELETE FROM models WHERE model_key = 'code'");

        const widened = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(widened.status, 'updated');
        assert.deepEqual(widened.tiersCreated, ['plan', 'write', 'deep', 'ultra', 'web-assist']);
        assert.equal(widened.providerCreated, false, 'the provider step never runs twice');
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM providers'), 1);
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM provider_accounts'), 1);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE model_key = 'code'"), 0);
        for (const tier of widened.tiersCreated) {
            assert.equal((await tierChildren(pool, tier)).length, FREE_TIER_SPECS[tier].children.length, tier);
        }

        const again = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.equal(again.status, 'already-complete');
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 6);
    });

    it('creates the tiers requested after a first start with an empty tier list', async () => {
        const empty = await installFreeModelDefaults({ appCtx: appCtxFor(pool, { LLM_DEFAULT_TIERS: '' }), apiKey: DUMMY_KEY });
        assert.equal(empty.status, 'installed');
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE strategy_kind = 'cascade'"), 0);
        const later = await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        assert.deepEqual(later.tiersCreated, ALL_TIERS.split(','));
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM providers'), 1);
    });
});

describe('tier contracts', () => {
    it('gives every public tier enabled, free, general-chat children with bounded budgets', async () => {
        await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        for (const tier of ALL_TIERS.split(',')) {
            const children = await tierChildren(pool, tier);
            assert.ok(children.length >= 3, `${tier} needs fallbacks`);
            for (const childRow of children) {
                assert.equal(Boolean(childRow.child_enabled), true, `${tier}/${childRow.model_key}`);
                assert.ok(isGeneralChatModelId(childRow.provider_model_id), childRow.provider_model_id);
                assert.notEqual(childRow.provider_model_id, 'openrouter/free');
                assert.ok(childRow.settings.requestTimeoutMs > 0);
                assert.ok(childRow.settings.retryPolicy.firstEventTimeoutMs > 0);
            }
            const { rows: [tierRow] } = await pool.query('SELECT metadata, max_attempts FROM models WHERE model_key = $1', [tier]);
            assert.ok(tierRow.metadata.cascadeBudgetMs > 0);
            assert.ok(tierRow.max_attempts <= children.length);
        }
    });

    it('fits fast inside a 12-second interactive deadline such as editor autocomplete', () => {
        const fast = FREE_TIER_SPECS.fast;
        assert.ok(fast.cascadeBudgetMs < 12_000);
        for (const entry of fast.children) {
            assert.ok(entry.settings.retryPolicy.firstEventTimeoutMs <= 4_000);
            assert.deepEqual(entry.settings.requestParams, { reasoning: { enabled: false } });
        }
    });

    it('serves image input on plan (the shared vision alias) and tools on web-assist', async () => {
        await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        for (const childRow of await tierChildren(pool, 'plan')) {
            assert.equal(childRow.capabilities.supportsVision, true, childRow.model_key);
        }
        for (const childRow of await tierChildren(pool, 'web-assist')) {
            assert.equal(childRow.capabilities.supportsTools, true, childRow.model_key);
        }
    });
});

describe('replacing the bundled key', () => {
    it('clears quota state so the new key is usable immediately', async () => {
        await installFreeModelDefaults({ appCtx: appCtxFor(pool), apiKey: DUMMY_KEY });
        const { rows: [account] } = await pool.query('SELECT id, provider_id FROM provider_accounts');
        await pool.query(
            "UPDATE provider_accounts SET status = 'quota_exhausted', quota_resets_at = '2099-01-01T00:00:00.000Z'"
        );
        const cleared = [];
        const appCtx = appCtxFor(pool);
        appCtx.services.accountPool = { clearExhaustions: (ids) => cleared.push(...ids) };
        await upsertProviderApiKeyAccount({
            appCtx,
            providerId: account.provider_id,
            providerDisplayName: 'OpenRouter',
            apiKey: 'sk-or-v1-replacement-dummy-000000000000',
        });
        const { rows: [after] } = await pool.query('SELECT status, quota_resets_at, metadata FROM provider_accounts');
        assert.equal(after.status, 'active');
        assert.equal(after.quota_resets_at, null);
        assert.equal(after.metadata.bundled, undefined);
        assert.deepEqual(cleared, [account.id]);
    });
});

describe('auto tag tiers bootstrap', () => {
    it('runs once, records a marker, and never rewrites tag tiers an administrator edited', async () => {
        const appCtx = appCtxFor(pool);
        await installFreeModelDefaults({ appCtx, apiKey: DUMMY_KEY });
        const first = await bootstrapInitialTagTiersOnce({ appCtx });
        assert.equal(first.status, 'installed');
        const freeTier = (await pool.query("SELECT id FROM models WHERE model_key = 'free'")).rows[0];
        assert.ok(freeTier, 'auto tag tier created');
        assert.ok(await count(pool, 'SELECT COUNT(*) FROM model_children WHERE parent_model_id = $1', [freeTier.id]) > 0);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM models WHERE model_key = 'fast' AND strategy_kind = 'cascade'"), 1);
        assert.equal((await tierChildren(pool, 'fast'))[0].provider_model_id, FREE_TIER_SPECS.fast.children[0].providerModelId);

        await pool.query('DELETE FROM model_children WHERE parent_model_id = $1', [freeTier.id]);
        const second = await bootstrapInitialTagTiersOnce({ appCtx });
        assert.equal(second.status, 'already-complete');
        assert.equal(await count(pool, 'SELECT COUNT(*) FROM model_children WHERE parent_model_id = $1', [freeTier.id]), 0);
    });

    it('runs again after a start that stopped before writing its marker', async () => {
        const appCtx = appCtxFor(pool);
        await installFreeModelDefaults({ appCtx, apiKey: DUMMY_KEY });
        const first = await bootstrapInitialTagTiersOnce({ appCtx });
        assert.equal(first.status, 'installed');
        await pool.query("DELETE FROM gateway_bootstrap_state WHERE bootstrap_key = 'initial-tag-tiers'");
        const retried = await bootstrapInitialTagTiersOnce({ appCtx });
        assert.equal(retried.status, 'installed');
        assert.equal(retried.created, 0, 'idempotent: no duplicate tiers');
    });
});
