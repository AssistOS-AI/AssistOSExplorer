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
 *     partial records and no marker, so the next start retries.  The
 *     provider, account, and baseline models are installed at most once.
 *   - The marker records every tier the install has handled: created, or
 *     kept because a record already held its name.  A handled tier is never
 *     created again, so tiers an administrator later disables, edits, or
 *     deletes stay that way.  A tier with no usable child is not created
 *     and stays pending, and a tier added to `LLM_DEFAULT_TIERS` after the
 *     first start is pending too: a later start creates a pending tier once
 *     the free provider has an enabled model among its children.
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

function stringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
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

/**
 * Create the free provider, its encrypted account, and the baseline models.
 *
 * @returns {Promise<Map<string, string>>} model id by provider model id
 */
async function installProvider(client, { credential, bundled, encryptionKey, summary }) {
    const modelIdsByProviderModelId = new Map();
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
    return modelIdsByProviderModelId;
}

/**
 * The enabled models a provider stored under the free provider key has now:
 * an administrator's provider under that key before the first install, or
 * the installed one on a later start. Rows are never added to it here.
 *
 * @returns {Promise<Map<string, string>>} model id by provider model id
 */
async function enabledFreeProviderModels(client, providerId) {
    const modelIdsByProviderModelId = new Map();
    if (!providerId) return modelIdsByProviderModelId;
    const { rows } = await client.query(
        'SELECT id, provider_model_id FROM models WHERE provider_id = $1 AND enabled = 1',
        [providerId]
    );
    for (const row of rows) {
        modelIdsByProviderModelId.set(row.provider_model_id, row.id);
    }
    return modelIdsByProviderModelId;
}

/**
 * Create one tier with the children it can have now. A tier whose children
 * are all unavailable is not created: an empty cascade would answer every
 * request with `tier_exhausted` and, being handled, would never be filled.
 *
 * @returns {Promise<'created'|'kept'|'pending'>}
 */
async function installTier(client, tierKey, modelIdsByProviderModelId) {
    const alias = await one(
        client,
        'SELECT id FROM model_aliases WHERE alias = $1',
        [tierKey]
    );
    if (alias) return 'kept';
    const existingTier = await one(
        client,
        'SELECT id FROM models WHERE model_key = $1',
        [tierKey]
    );
    if (existingTier) return 'kept';

    const spec = FREE_TIER_SPECS[tierKey];
    const children = spec.children.filter((entry) =>
        modelIdsByProviderModelId.has(entry.providerModelId)
    );
    if (children.length === 0) return 'pending';

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
            Math.min(spec.maxAttempts, children.length),
            JSON.stringify({
                seededBy: FREE_DEFAULTS_SEEDED_BY,
                tierKey,
                cascadeBudgetMs: spec.cascadeBudgetMs,
            }),
        ]
    );
    let priority = 0;
    for (const entry of children) {
        priority += 1;
        await client.query(
            `INSERT INTO model_children
               (id, parent_model_id, child_model_id, priority, enabled, settings)
             VALUES ($1, $2, $3, $4, 1, $5)`,
            [
                randomUUID(),
                tierId,
                modelIdsByProviderModelId.get(entry.providerModelId),
                priority,
                JSON.stringify(entry.settings),
            ]
        );
    }
    return 'created';
}

/**
 * Install the free provider, account, and baseline models once, and every
 * requested tier that is not handled yet.
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
        tiersPending: [],
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
        const marker = await bootstrapStateDao.getState(
            client,
            FREE_DEFAULTS_BOOTSTRAP_KEY
        );
        const previouslyCreated = stringList(marker?.metadata?.tiersCreated);
        const previouslyKept = stringList(marker?.metadata?.tiersKept);
        const handled = new Set([...previouslyCreated, ...previouslyKept]);
        const unhandledTiers = requestedTiers.filter((tier) => !handled.has(tier));
        if (marker && unhandledTiers.length === 0) {
            await client.query('COMMIT');
            summary.status = 'already-complete';
            return summary;
        }

        const existingProvider = await one(
            client,
            'SELECT id FROM providers WHERE provider_key = $1',
            [FREE_PROVIDER_SPEC.providerKey]
        );
        const modelIdsByProviderModelId =
            marker || existingProvider
                ? await enabledFreeProviderModels(client, existingProvider?.id)
                : await installProvider(client, {
                    credential,
                    bundled,
                    encryptionKey,
                    summary,
                });

        for (const tierKey of unhandledTiers) {
            const outcome = await installTier(client, tierKey, modelIdsByProviderModelId);
            if (outcome === 'created') summary.tiersCreated.push(tierKey);
            else if (outcome === 'kept') summary.tiersKept.push(tierKey);
            else summary.tiersPending.push(tierKey);
        }

        const progressed = summary.tiersCreated.length + summary.tiersKept.length > 0;
        if (!marker) {
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
        } else if (progressed) {
            await bootstrapStateDao.updateMetadata(client, FREE_DEFAULTS_BOOTSTRAP_KEY, {
                ...marker.metadata,
                tiersCreated: [...previouslyCreated, ...summary.tiersCreated],
                tiersKept: [...previouslyKept, ...summary.tiersKept],
            });
        }
        if (typeof beforeCommit === 'function') await beforeCommit();
        await client.query('COMMIT');
        summary.status = marker ? (progressed ? 'updated' : 'pending') : 'installed';
        const details = {
            providerCreated: summary.providerCreated,
            modelsCreated: summary.modelsCreated,
            tiersCreated: summary.tiersCreated,
            tiersKept: summary.tiersKept,
            tiersPending: summary.tiersPending,
            bundledCredential: summary.accountCreated ? bundled : null,
        };
        if (summary.status !== 'pending') {
            appCtx.log?.info?.('free model defaults installed', details);
        }
        if (summary.tiersPending.length > 0) {
            appCtx.log?.warn?.(
                'free model default tiers pending: no enabled free provider model among their children',
                { tiersPending: summary.tiersPending }
            );
        }
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
