/**
 * First-start free model defaults.
 *
 * A fresh gateway gets a restricted free OpenRouter provider, an encrypted
 * provider account, a verified baseline of free models, and the public
 * compatibility tiers (`fast`, `code`, `plan`, `write`, `deep`, `ultra`,
 * `web-assist`) without any operator setup and without a catalog request at
 * boot.  The later provider catalog refresh updates, adds, or disables
 * models; an offline start still has every tier record.
 *
 * Durability and ownership:
 *
 *   - Everything is written in one `BEGIN IMMEDIATE` transaction together
 *     with a `gateway_bootstrap_state` row.  An interrupted start leaves no
 *     partial records and no marker, so the next start retries; a completed
 *     install never runs again, so providers, accounts, models, or tiers an
 *     administrator later disables, edits, or deletes are never recreated.
 *   - Existing records are never overwritten.  A provider, model, alias, or
 *     tier that an administrator created under a default key (for example
 *     while `FREE_MODELS_ENABLED=false`) is left untouched.
 *   - `FREE_MODELS_ENABLED=false` skips the install without writing the
 *     marker, so enabling it later installs the defaults then.
 *
 * The provider, baseline models, and tiers are defined in
 * `free-model-catalog.mjs`.
 *
 * @module bootstrap/free-model-defaults
 */

import { randomUUID } from 'node:crypto';
import { encrypt } from '../runtime/security/encryption.mjs';
import * as bootstrapStateDao from '../db/dao/bootstrap-state-dao.mjs';
import {
    BUNDLED_OPENROUTER_FREE_KEY,
    BUNDLED_OPENROUTER_FREE_KEY_EXPIRES_AT,
} from './free-provider-credential.mjs';
import {
    FREE_BASELINE_MODELS,
    FREE_PROVIDER_KEY,
    FREE_PROVIDER_SPEC,
    FREE_TIER_SPECS,
    MODEL_RETRY_POLICY,
    freeModelKey,
} from './free-model-catalog.mjs';

export {
    FREE_BASELINE_MODELS,
    FREE_PROVIDER_KEY,
    FREE_PROVIDER_SPEC,
    FREE_TIER_SPECS,
    freeModelKey,
};

export const FREE_DEFAULTS_BOOTSTRAP_KEY = 'free-model-defaults';
export const FREE_DEFAULTS_VERSION = 1;
export const FREE_DEFAULTS_SEEDED_BY = 'free-model-defaults';

function parseTierList(value) {
    return String(value || '')
        .split(',')
        .map((tier) => tier.trim())
        .filter(Boolean);
}

function secretHint(apiKey) {
    return apiKey.length <= 10 ? '********' : `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;
}

async function one(client, sql, params = []) {
    const { rows } = await client.query(sql, params);
    return rows[0] || null;
}

async function insertModel(client, providerId, spec) {
    const id = randomUUID();
    await client.query(
        `INSERT INTO models
           (id, model_key, display_name, provider_id, provider_model_id,
            execution_kind, enabled, pricing_mode, input_price_per_million,
            output_price_per_million, request_price_usd, retry_policy,
            capabilities, tags, is_free, discovery_source, metadata)
         VALUES ($1, $2, $3, $4, $5, 'provider_model', 1, 'free', 0, 0, 0,
                 $6, $7, $8, 1, 'synced', $9)`,
        [
            id,
            freeModelKey(spec.providerModelId),
            spec.displayName,
            providerId,
            spec.providerModelId,
            JSON.stringify(MODEL_RETRY_POLICY),
            JSON.stringify(spec.capabilities),
            JSON.stringify(spec.tags),
            JSON.stringify({ seededBy: FREE_DEFAULTS_SEEDED_BY }),
        ]
    );
    return id;
}

async function insertChildren(client, tierId, children, modelIdsByProviderModelId) {
    let priority = 0;
    for (const entry of children) {
        const childId = modelIdsByProviderModelId.get(entry.providerModelId);
        if (!childId) continue;
        priority += 1;
        await client.query(
            `INSERT INTO model_children
               (id, parent_model_id, child_model_id, priority, enabled, settings)
             VALUES ($1, $2, $3, $4, 1, $5)`,
            [randomUUID(), tierId, childId, priority, JSON.stringify(entry.settings)]
        );
    }
    return priority;
}

/**
 * Install the free provider, account, baseline models, and tiers once.
 *
 * @param {object} args
 * @param {object} args.appCtx  needs `pool`, `services.encryptionKey`,
 *                              `config.env`, optional `log`
 * @param {string} [args.apiKey] credential override (tests)
 * @param {Function} [args.beforeCommit] test hook to simulate interruption
 * @returns {Promise<object>} install summary
 */
export async function installFreeModelDefaults({
    appCtx,
    apiKey = null,
    beforeCommit = null,
} = {}) {
    const pool = appCtx?.pool;
    const env = appCtx?.config?.env || {};
    const summary = {
        status: 'skipped',
        providerCreated: false,
        accountCreated: false,
        modelsCreated: 0,
        tiersCreated: [],
        tiersKept: [],
    };
    if (!pool) return summary;
    if (env.FREE_MODELS_ENABLED === false) {
        summary.status = 'disabled';
        return summary;
    }
    const encryptionKey = appCtx.services?.encryptionKey;
    if (!encryptionKey) {
        throw new Error('free model defaults require the encryption key');
    }
    const credential =
        apiKey || String(env.OPENROUTER_API_KEY || '').trim() || BUNDLED_OPENROUTER_FREE_KEY;
    const bundled = credential === BUNDLED_OPENROUTER_FREE_KEY;
    const requestedTiers = parseTierList(env.LLM_DEFAULT_TIERS).filter((tier) =>
        Object.hasOwn(FREE_TIER_SPECS, tier)
    );

    const client = await pool.connect();
    try {
        await client.query('BEGIN IMMEDIATE');
        const marker = await bootstrapStateDao.isComplete(
            client,
            FREE_DEFAULTS_BOOTSTRAP_KEY
        );
        if (marker) {
            await client.query('COMMIT');
            summary.status = 'already-complete';
            return summary;
        }

        const modelIdsByProviderModelId = new Map();
        const existingProvider = await one(
            client,
            'SELECT id FROM providers WHERE provider_key = $1',
            [FREE_PROVIDER_SPEC.providerKey]
        );
        if (!existingProvider) {
            const providerId = randomUUID();
            await client.query(
                `INSERT INTO providers
                   (id, provider_key, display_name, kind, adapter_key,
                    auth_strategy, base_url, enabled, supports_streaming,
                    supports_tools, settings, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 1, 1, $8, $9)`,
                [
                    providerId,
                    FREE_PROVIDER_SPEC.providerKey,
                    FREE_PROVIDER_SPEC.displayName,
                    FREE_PROVIDER_SPEC.kind,
                    FREE_PROVIDER_SPEC.adapterKey,
                    FREE_PROVIDER_SPEC.authStrategy,
                    FREE_PROVIDER_SPEC.baseUrl,
                    JSON.stringify(FREE_PROVIDER_SPEC.settings),
                    JSON.stringify({ seededBy: FREE_DEFAULTS_SEEDED_BY }),
                ]
            );
            summary.providerCreated = true;

            const encrypted = encrypt(credential, encryptionKey);
            await client.query(
                `INSERT INTO provider_accounts
                   (id, provider_id, account_label, auth_type, status,
                    secret_ciphertext, secret_iv, secret_auth_tag,
                    secret_hint, metadata)
                 VALUES ($1, $2, $3, 'api_key', 'active', $4, $5, $6, $7, $8)`,
                [
                    randomUUID(),
                    providerId,
                    bundled ? 'Bundled free-tier key (shared quota)' : 'OpenRouter API key',
                    encrypted.ciphertext,
                    encrypted.iv,
                    encrypted.authTag,
                    secretHint(credential),
                    JSON.stringify({
                        seededBy: FREE_DEFAULTS_SEEDED_BY,
                        bundled,
                        ...(bundled ? { expiresAt: BUNDLED_OPENROUTER_FREE_KEY_EXPIRES_AT } : {}),
                    }),
                ]
            );
            summary.accountCreated = true;

            for (const spec of FREE_BASELINE_MODELS) {
                const taken = await one(
                    client,
                    'SELECT id FROM models WHERE model_key = $1',
                    [freeModelKey(spec.providerModelId)]
                );
                if (taken) continue;
                const id = await insertModel(client, providerId, spec);
                modelIdsByProviderModelId.set(spec.providerModelId, id);
                summary.modelsCreated += 1;
            }
        } else {
            // An operator-owned provider under this key: reuse its enabled
            // models for tiers, but never add rows or credentials to it.
            const { rows } = await client.query(
                'SELECT id, provider_model_id FROM models WHERE provider_id = $1 AND enabled = 1',
                [existingProvider.id]
            );
            for (const row of rows) {
                modelIdsByProviderModelId.set(row.provider_model_id, row.id);
            }
        }

        for (const tierKey of requestedTiers) {
            const spec = FREE_TIER_SPECS[tierKey];
            const alias = await one(
                client,
                'SELECT id FROM model_aliases WHERE alias = $1',
                [tierKey]
            );
            if (alias) {
                summary.tiersKept.push(tierKey);
                continue;
            }
            const existingTier = await one(
                client,
                'SELECT id FROM models WHERE model_key = $1',
                [tierKey]
            );
            if (existingTier) {
                summary.tiersKept.push(tierKey);
                continue;
            }
            const tierId = randomUUID();
            await client.query(
                `INSERT INTO models
                   (id, model_key, display_name, enabled, strategy_kind,
                    max_attempts, discovery_source, metadata)
                 VALUES ($1, $2, $3, 1, 'cascade', $4, 'manual', $5)`,
                [
                    tierId,
                    tierKey,
                    tierKey,
                    spec.maxAttempts,
                    JSON.stringify({
                        seededBy: FREE_DEFAULTS_SEEDED_BY,
                        tierKey,
                        cascadeBudgetMs: spec.cascadeBudgetMs,
                    }),
                ]
            );
            await insertChildren(client, tierId, spec.children, modelIdsByProviderModelId);
            summary.tiersCreated.push(tierKey);
        }

        await bootstrapStateDao.markComplete(client, {
            bootstrapKey: FREE_DEFAULTS_BOOTSTRAP_KEY,
            version: FREE_DEFAULTS_VERSION,
            metadata: {
                providerCreated: summary.providerCreated,
                bundledCredential: summary.accountCreated ? bundled : null,
                modelsCreated: summary.modelsCreated,
                tiersCreated: summary.tiersCreated,
                tiersKept: summary.tiersKept,
            },
        });
        if (typeof beforeCommit === 'function') await beforeCommit();
        await client.query('COMMIT');
        summary.status = 'installed';
        appCtx.log?.info?.('free model defaults installed', {
            providerCreated: summary.providerCreated,
            modelsCreated: summary.modelsCreated,
            tiersCreated: summary.tiersCreated,
            tiersKept: summary.tiersKept,
            bundledCredential: summary.accountCreated ? bundled : null,
        });
        return summary;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export default {
    FREE_DEFAULTS_BOOTSTRAP_KEY,
    FREE_PROVIDER_KEY,
    FREE_BASELINE_MODELS,
    FREE_TIER_SPECS,
    installFreeModelDefaults,
};
