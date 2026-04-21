import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as auditLogsDao from '../dao/audit-logs-dao.mjs';
import * as middlewaresDao from '../dao/middlewares-dao.mjs';
import { encrypt } from '../../runtime/security/encryption.mjs';
import { hashApiKey } from '../../runtime/security/api-key-auth.mjs';
import { PROVIDER_PRESETS } from '../../runtime/providers/provider-presets.mjs';
import { OAuthCredentialStore } from '../../runtime/providers/oauth/credential-store.mjs';
import { decryptLegacyBlobWithKeys } from './main-branch-crypto.mjs';

const PRESETS_BY_KEY = new Map(
    PROVIDER_PRESETS.map((preset) => [preset.key, preset])
);

const SEARCH_PROVIDER_KEYS = new Set([
    'search',
    'tavily',
    'brave',
    'exa',
    'serper',
    'jina',
    'duckduckgo',
    'searxng',
    'gemini_search',
]);

const SEARCH_PROVIDER_HOSTS = new Map([
    ['api.tavily.com', 'tavily'],
    ['api.search.brave.com', 'brave'],
    ['api.exa.ai', 'exa'],
    ['google.serper.dev', 'serper'],
    ['s.jina.ai', 'jina'],
    ['html.duckduckgo.com', 'duckduckgo'],
    ['api.duckduckgo.com', 'duckduckgo'],
    ['generativelanguage.googleapis.com', 'gemini_search'],
]);

const ADAPTER_CAPABILITIES = Object.freeze({
    'openai-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'api_key',
        oauthAdapterKey: null,
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: false,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'anthropic-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'api_key',
        oauthAdapterKey: null,
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: true,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'claudeai-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'oauth',
        oauthAdapterKey: 'anthropic-claudeai',
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: true,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'codex-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'oauth',
        oauthAdapterKey: 'openai-codex',
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: false,
        supportsResponsesApi: true,
        providerMode: 'external_api',
    }),
    'copilot-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'oauth',
        oauthAdapterKey: 'github-copilot',
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: false,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'gemini-openai': Object.freeze({
        kind: 'external_api',
        authStrategy: 'oauth',
        oauthAdapterKey: 'google-gemini',
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: false,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'kiro-api': Object.freeze({
        kind: 'external_api',
        authStrategy: 'oauth',
        oauthAdapterKey: 'aws-kiro',
        supportsStreaming: true,
        supportsTools: true,
        supportsMessagesApi: false,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
    'search-builtin': Object.freeze({
        kind: 'search',
        authStrategy: 'api_key',
        oauthAdapterKey: null,
        supportsStreaming: false,
        supportsTools: false,
        supportsMessagesApi: false,
        supportsResponsesApi: false,
        providerMode: 'external_api',
    }),
});

const SPECIAL_PROVIDER_SPECS = Object.freeze({
    anthropic: Object.freeze({
        adapterKey: 'claudeai-api',
        baseUrl: 'https://api.anthropic.com',
    }),
    codex: Object.freeze({
        adapterKey: 'codex-api',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
    }),
    copilot: Object.freeze({
        adapterKey: 'copilot-api',
        baseUrl: 'https://api.githubcopilot.com',
    }),
    gemini: Object.freeze({
        adapterKey: 'gemini-openai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }),
    axiologic_kiro: Object.freeze({
        adapterKey: 'kiro-api',
        baseUrl: 'https://api.kiro.dev',
    }),
    search: Object.freeze({
        adapterKey: 'search-builtin',
        kind: 'search',
        authStrategy: 'none',
        baseUrl: '',
    }),
});

const MIDDLEWARE_KEY_ALIASES = Object.freeze({
    cache: 'response-cache',
    'blacklist-scanner': 'content-blocker',
    'tpm-tracker': 'token-tracker',
});

const HISTORICAL_SOURCE = 'main.call_logs';
const RESPONSE_EXCERPT_CHARS = 240;
const OAUTH_REFRESH_MARGIN_SECONDS = 300;

export async function readMainBranchSourceSnapshot(
    sourcePool,
    { sourceCredentialsDir = null } = {}
) {
    const [providers, apiKeys, models, middlewares, modelMiddlewares] =
        await Promise.all([
            sourcePool.query(`
      SELECT *
      FROM soul_gateway.provider_configs
      ORDER BY name ASC
    `),
            sourcePool.query(`
      SELECT *
      FROM soul_gateway.api_keys
      ORDER BY created_at ASC, id ASC
    `),
            sourcePool.query(`
      SELECT *
      FROM soul_gateway.model_configs
      ORDER BY type ASC, sort_order ASC, name ASC
    `),
            sourcePool.query(`
      SELECT *
      FROM soul_gateway.middlewares
      ORDER BY name ASC
    `),
            sourcePool.query(`
      SELECT mm.*, m.name AS middleware_name
      FROM soul_gateway.model_middlewares mm
      JOIN soul_gateway.middlewares m ON m.id = mm.middleware_id
      ORDER BY mm.sort_order ASC, mm.created_at ASC
    `),
        ]);

    const sourceProviders = cloneSourceRows(providers.rows);
    await attachLegacyManagedProviderData(sourceProviders, {
        sourceCredentialsDir,
    });

    return {
        providers: sourceProviders,
        apiKeys: apiKeys.rows,
        models: models.rows,
        middlewares: middlewares.rows,
        modelMiddlewares: modelMiddlewares.rows,
    };
}

async function attachLegacyManagedProviderData(
    providerRows,
    { sourceCredentialsDir = null } = {}
) {
    for (const row of providerRows || []) {
        if (normalizeText(row?.auth_type) !== 'managed') {
            continue;
        }

        const { accounts, state, error } =
            await readLegacyManagedProviderFiles({
                sourceCredentialsDir,
                providerKey: row.name,
            });

        row.legacy_managed_accounts = accounts;
        row.legacy_managed_state = state;
        row.legacy_managed_accounts_error = error;
    }
}

async function readLegacyManagedProviderFiles({
    sourceCredentialsDir,
    providerKey,
}) {
    if (!sourceCredentialsDir) {
        return {
            accounts: [],
            state: null,
            error:
                'SOURCE_CREDENTIALS_DIR is required to migrate managed provider accounts',
        };
    }

    const providerDir = join(sourceCredentialsDir, providerKey);
    const accountsDir = join(providerDir, 'accounts');
    const statePath = join(providerDir, 'state.json');

    let state = null;
    try {
        state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            return {
                accounts: [],
                state: null,
                error: `Failed reading managed provider state for "${providerKey}": ${err.message}`,
            };
        }
    }

    let files;
    try {
        files = (await readdir(accountsDir))
            .filter(
                (file) =>
                    file.startsWith('account-') && file.endsWith('.json')
            )
            .sort();
    } catch (err) {
        if (err?.code === 'ENOENT') {
            return {
                accounts: [],
                state,
                error: `Managed provider "${providerKey}" has no readable accounts directory at ${accountsDir}`,
            };
        }
        return {
            accounts: [],
            state,
            error: `Failed reading managed provider account list for "${providerKey}": ${err.message}`,
        };
    }

    const accounts = [];
    for (const file of files) {
        const filePath = join(accountsDir, file);
        try {
            const raw = JSON.parse(await readFile(filePath, 'utf8'));
            const index = parseLegacyAccountIndex(file);
            accounts.push({
                ...raw,
                _index:
                    raw?._index != null && Number.isFinite(Number(raw._index))
                        ? Number(raw._index)
                        : index,
                _file_name: file,
                _file_path: filePath,
            });
        } catch (err) {
            return {
                accounts: [],
                state,
                error: `Failed parsing managed provider account file "${filePath}": ${err.message}`,
            };
        }
    }

    if (accounts.length === 0) {
        return {
            accounts,
            state,
            error: `Managed provider "${providerKey}" has no account-*.json files under ${accountsDir}`,
        };
    }

    return { accounts, state, error: null };
}

function parseLegacyAccountIndex(fileName) {
    const match = /^account-(\d+)\.json$/i.exec(fileName || '');
    return match ? Number.parseInt(match[1], 10) : 0;
}

function cloneSourceRows(rows) {
    return (rows || []).map((row) => ({ ...row }));
}

export async function countMainBranchCallLogs(sourcePool) {
    const { rows } = await sourcePool.query(`
    SELECT COUNT(*)::int AS total
    FROM soul_gateway.call_logs
  `);
    return rows[0]?.total || 0;
}

async function listMainBranchCallLogBatch(
    sourcePool,
    { afterStartedAt = null, afterId = null, limit = 500 } = {}
) {
    if (!afterStartedAt || !afterId) {
        const { rows } = await sourcePool.query(
            `
      SELECT *
      FROM soul_gateway.call_logs
      ORDER BY started_at ASC, id ASC
      LIMIT $1
    `,
            [limit]
        );
        return rows;
    }

    const { rows } = await sourcePool.query(
        `
    SELECT *
    FROM soul_gateway.call_logs
    WHERE started_at > $1
       OR (started_at = $1 AND id > $2)
    ORDER BY started_at ASC, id ASC
    LIMIT $3
  `,
        [afterStartedAt, afterId, limit]
    );
    return rows;
}

/**
 * Build a dry-runnable import plan from the source snapshot. The plan
 * contains target payloads plus a human-readable report of warnings.
 */
export function buildMainBranchImportPlan({
    source,
    targetMiddlewareRows,
    sourceEncryptionKey = null,
    targetEncryptionKey,
    targetApiKeyPepper,
    targetCredentialsDir = null,
}) {
    const report = createImportReport(source);
    const middlewareKeyMap =
        buildMiddlewareCompatibilityMap(targetMiddlewareRows);
    const providerPlans = [];
    const directModelPlans = [];
    const cascadeModelPlans = [];
    const apiKeyPlans = [];
    const modelBindingPlans = [];
    const modelAliasPlans = [];

    const providerPlansBySourceId = new Map();
    const providerPlansByKey = new Map();
    for (const providerRow of source.providers) {
        const plan = buildProviderPlan(providerRow, {
            sourceEncryptionKey,
            targetEncryptionKey,
            targetCredentialsDir,
            report,
        });
        if (!plan) continue;
        providerPlans.push(plan);
        providerPlansBySourceId.set(providerRow.id, plan);
        providerPlansByKey.set(providerRow.name, plan);
    }

    for (const modelRow of source.models) {
        if (modelRow.type === 'tier') continue;
        const providerKey = normalizeText(modelRow.provider_key);
        if (!providerKey || providerPlansByKey.has(providerKey)) {
            continue;
        }

        const plan = buildProviderPlan(
            buildImplicitSourceProvider(modelRow),
            {
                sourceEncryptionKey,
                targetEncryptionKey,
                targetCredentialsDir,
                report,
            }
        );
        if (!plan) continue;

        providerPlans.push(plan);
        providerPlansBySourceId.set(plan.sourceId, plan);
        providerPlansByKey.set(plan.sourceName, plan);
    }

    const modelPlansBySourceId = new Map();
    const modelPlansByKey = new Map();
    for (const modelRow of source.models) {
        if (modelRow.type === 'tier') {
            const plan = buildCascadeModelPlan(modelRow, report);
            cascadeModelPlans.push(plan);
            modelPlansBySourceId.set(modelRow.id, plan);
            modelPlansByKey.set(modelRow.name, plan);
            report.counts.cascadeModels += 1;
            continue;
        }

        const providerPlan = modelRow.provider_config_id
            ? providerPlansBySourceId.get(modelRow.provider_config_id)
            : providerPlansByKey.get(modelRow.provider_key);

        if (!providerPlan) {
            addWarning(
                report,
                'model_provider_unresolved',
                `Skipping model "${modelRow.name}" because its provider cannot be resolved`,
                {
                    model: modelRow.name,
                    providerConfigId: modelRow.provider_config_id || null,
                    providerKey: modelRow.provider_key || null,
                }
            );
            continue;
        }

        const plan = buildDirectModelPlan(modelRow, providerPlan, report);
        directModelPlans.push(plan);
        modelPlansBySourceId.set(modelRow.id, plan);
        modelPlansByKey.set(modelRow.name, plan);
        report.counts.directModels += 1;
    }

    for (const cascadePlan of cascadeModelPlans) {
        for (const childRef of cascadePlan.childModelRefs) {
            const childPlan = modelPlansByKey.get(childRef.modelKey);
            if (!childPlan) {
                addWarning(
                    report,
                    'cascade_child_missing',
                    `Tier "${cascadePlan.target.modelKey}" references "${childRef.modelKey}", but no imported model matches that name`,
                    {
                        parentModel: cascadePlan.target.modelKey,
                        childModel: childRef.modelKey,
                    }
                );
                continue;
            }
            childRef.sourceModelId = childPlan.sourceId;
        }
    }

    for (const apiKeyRow of source.apiKeys) {
        apiKeyPlans.push(
            buildApiKeyPlan(apiKeyRow, {
                sourceEncryptionKey,
                targetEncryptionKey,
                targetApiKeyPepper,
                report,
            })
        );
    }

    for (const row of source.modelMiddlewares) {
        const modelPlan = modelPlansBySourceId.get(row.model_config_id);
        if (!modelPlan) {
            addWarning(
                report,
                'middleware_model_unresolved',
                `Skipping middleware "${row.middleware_name}" because its target model was not imported`,
                {
                    modelConfigId: row.model_config_id,
                    middlewareName: row.middleware_name,
                }
            );
            continue;
        }

        const middlewareKey = resolveCompatibleMiddlewareKey(
            row.middleware_name,
            middlewareKeyMap
        );
        if (!middlewareKey) {
            addWarning(
                report,
                'middleware_key_unresolved',
                `Skipping middleware "${row.middleware_name}" because no current middleware key matches it`,
                {
                    model: modelPlan.target.modelKey,
                    middlewareName: row.middleware_name,
                }
            );
            continue;
        }

        modelBindingPlans.push({
            sourceId: row.id,
            sourceModelId: row.model_config_id,
            middlewareName: row.middleware_name,
            targetModelKey: modelPlan.target.modelKey,
            targetModelSourceId: modelPlan.sourceId,
            target: {
                scope: 'model',
                middlewareKey,
                sortOrder: row.sort_order ?? 100,
                enabled: row.is_enabled ?? true,
                settings: row.settings || {},
            },
        });
        report.counts.middlewareBindings += 1;
    }

    const aliasOwners = new Map();
    const existingModelKeys = new Set(modelPlansByKey.keys());

    for (const modelRow of source.models) {
        const modelPlan = modelPlansBySourceId.get(modelRow.id);
        if (!modelPlan) continue;

        const aliases = deriveHistoricalModelAliasCandidates(modelRow);
        for (const alias of aliases) {
            if (!alias || alias === modelPlan.target.modelKey) continue;
            if (existingModelKeys.has(alias)) continue;
            if (!aliasOwners.has(alias)) aliasOwners.set(alias, []);
            aliasOwners.get(alias).push(modelPlan);
        }
    }

    for (const [alias, owners] of aliasOwners) {
        const modelPlan = resolveHistoricalAliasOwner(alias, owners);
        if (!modelPlan) {
            addWarning(
                report,
                'model_alias_collision',
                `Skipping historical alias "${alias}" because it maps to multiple source models`,
                { alias }
            );
            continue;
        }

        modelAliasPlans.push({
            alias,
            targetModelKey: modelPlan.target.modelKey,
            targetModelSourceId: modelPlan.sourceId,
        });
        report.counts.modelAliases += 1;
    }

    return {
        report,
        providerPlans,
        apiKeyPlans,
        directModelPlans,
        cascadeModelPlans,
        modelBindingPlans,
        modelAliasPlans,
    };
}

function buildImplicitSourceProvider(sourceModel) {
    const providerKey = normalizeText(sourceModel?.provider_key) || 'unknown';
    const isSearchProvider = SEARCH_PROVIDER_KEYS.has(providerKey);
    const isManagedProvider =
        !isSearchProvider && !!SPECIAL_PROVIDER_SPECS[providerKey];

    return {
        id: `implicit-provider:${providerKey}`,
        name: providerKey,
        display_name: providerKey,
        protocol: providerKey === 'anthropic' ? 'anthropic' : 'openai',
        base_url: isSearchProvider
            ? ''
            : SPECIAL_PROVIDER_SPECS[providerKey]?.baseUrl || '',
        encrypted_api_key: null,
        key_hint: null,
        billing_type: isSearchProvider
            ? 'search'
            : isManagedProvider
              ? 'subscription'
              : 'api_key',
        auth_type: isSearchProvider
            ? 'internal'
            : isManagedProvider
              ? 'managed'
              : 'api_key',
        is_enabled: true,
        legacy_implicit_provider: true,
    };
}

export function buildMiddlewareCompatibilityMap(targetMiddlewareRows) {
    const map = new Map();
    for (const row of targetMiddlewareRows || []) {
        if (row?.middleware_key) {
            map.set(row.middleware_key, row.middleware_key);
        }
    }
    for (const [legacyKey, currentKey] of Object.entries(
        MIDDLEWARE_KEY_ALIASES
    )) {
        if (map.has(currentKey)) {
            map.set(legacyKey, currentKey);
        }
    }
    return map;
}

export function resolveCompatibleMiddlewareKey(
    sourceMiddlewareName,
    compatibilityMap
) {
    if (!sourceMiddlewareName) return null;
    return compatibilityMap.get(sourceMiddlewareName) || null;
}

export function resolveProviderImportSpec(sourceProvider) {
    const providerKey = normalizeText(sourceProvider?.name);
    const authType = normalizeText(sourceProvider?.auth_type) || 'api_key';
    const protocol = normalizeText(sourceProvider?.protocol) || 'openai';
    const host = extractHostname(sourceProvider?.base_url);

    if (!providerKey) {
        return { warning: 'Provider row is missing its name' };
    }

    const preset = PRESETS_BY_KEY.get(providerKey);
    if (preset && authType !== 'managed') {
        return {
            adapterKey: preset.adapter_key,
            baseUrl:
                normalizeLegacyBaseUrl(
                    sourceProvider?.base_url,
                    preset.adapter_key
                ) || preset.base_url,
            kind: preset.kind,
            authStrategy:
                authType === 'internal'
                    ? 'none'
                    : preset.auth_strategy || 'api_key',
            oauthAdapterKey: preset.oauth_adapter_key || null,
            supportsStreaming: preset.supports_streaming ?? true,
            supportsTools: preset.supports_tools ?? true,
            supportsMessagesApi: false,
            supportsResponsesApi: false,
            providerMode: 'external_api',
        };
    }

    const special = SPECIAL_PROVIDER_SPECS[providerKey];
    if (special) {
        const capabilities =
            ADAPTER_CAPABILITIES[special.adapterKey] ||
            ADAPTER_CAPABILITIES['openai-api'];
        return {
            adapterKey: special.adapterKey,
            baseUrl: special.baseUrl,
            kind: special.kind || capabilities.kind,
            authStrategy: special.authStrategy || capabilities.authStrategy,
            oauthAdapterKey:
                special.oauthAdapterKey || capabilities.oauthAdapterKey,
            supportsStreaming: capabilities.supportsStreaming,
            supportsTools: capabilities.supportsTools,
            supportsMessagesApi: capabilities.supportsMessagesApi,
            supportsResponsesApi: capabilities.supportsResponsesApi,
            providerMode: capabilities.providerMode,
        };
    }

    if (
        SEARCH_PROVIDER_KEYS.has(providerKey) ||
        SEARCH_PROVIDER_HOSTS.has(host) ||
        sourceProvider?.billing_type === 'search'
    ) {
        const capabilities = ADAPTER_CAPABILITIES['search-builtin'];
        return {
            adapterKey: 'search-builtin',
            baseUrl: sourceProvider?.base_url || '',
            kind: capabilities.kind,
            authStrategy: authType === 'internal' ? 'none' : 'api_key',
            oauthAdapterKey: null,
            supportsStreaming: capabilities.supportsStreaming,
            supportsTools: capabilities.supportsTools,
            supportsMessagesApi: capabilities.supportsMessagesApi,
            supportsResponsesApi: capabilities.supportsResponsesApi,
            providerMode: capabilities.providerMode,
        };
    }

    if (authType === 'managed') {
        if (host === 'api.githubcopilot.com') {
            return resolveProviderImportSpec({
                ...sourceProvider,
                name: 'copilot',
            });
        }
        if (host === 'chatgpt.com') {
            return resolveProviderImportSpec({
                ...sourceProvider,
                name: 'codex',
            });
        }
        if (host === 'generativelanguage.googleapis.com') {
            return resolveProviderImportSpec({
                ...sourceProvider,
                name: 'gemini',
            });
        }
        if (host === 'api.anthropic.com' || protocol === 'anthropic') {
            const capabilities = ADAPTER_CAPABILITIES['claudeai-api'];
            return {
                adapterKey: 'claudeai-api',
                baseUrl: 'https://api.anthropic.com',
                kind: capabilities.kind,
                authStrategy: capabilities.authStrategy,
                oauthAdapterKey: capabilities.oauthAdapterKey,
                supportsStreaming: capabilities.supportsStreaming,
                supportsTools: capabilities.supportsTools,
                supportsMessagesApi: capabilities.supportsMessagesApi,
                supportsResponsesApi: capabilities.supportsResponsesApi,
                providerMode: capabilities.providerMode,
            };
        }
        if (providerKey.includes('kiro') || host.endsWith('amazonaws.com')) {
            return resolveProviderImportSpec({
                ...sourceProvider,
                name: 'axiologic_kiro',
            });
        }
    }

    if (protocol === 'anthropic') {
        const capabilities = ADAPTER_CAPABILITIES['anthropic-api'];
        return {
            adapterKey: 'anthropic-api',
            baseUrl: 'https://api.anthropic.com',
            kind: capabilities.kind,
            authStrategy: capabilities.authStrategy,
            oauthAdapterKey: capabilities.oauthAdapterKey,
            supportsStreaming: capabilities.supportsStreaming,
            supportsTools: capabilities.supportsTools,
            supportsMessagesApi: capabilities.supportsMessagesApi,
            supportsResponsesApi: capabilities.supportsResponsesApi,
            providerMode: capabilities.providerMode,
        };
    }

    if (protocol === 'openai') {
        const capabilities = ADAPTER_CAPABILITIES['openai-api'];
        return {
            adapterKey: 'openai-api',
            baseUrl: normalizeLegacyBaseUrl(
                sourceProvider?.base_url,
                'openai-api'
            ),
            kind: capabilities.kind,
            authStrategy:
                authType === 'internal' ? 'none' : capabilities.authStrategy,
            oauthAdapterKey: capabilities.oauthAdapterKey,
            supportsStreaming: capabilities.supportsStreaming,
            supportsTools: capabilities.supportsTools,
            supportsMessagesApi: capabilities.supportsMessagesApi,
            supportsResponsesApi: capabilities.supportsResponsesApi,
            providerMode: capabilities.providerMode,
        };
    }

    return {
        warning: `Provider "${providerKey}" cannot be mapped to a current adapter`,
    };
}

export async function assertTargetSchemaReady(targetPool) {
    const [strategy, children, bindings, auditLogs, sessions] =
        await Promise.all([
            targetPool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'soul_gateway'
          AND table_name = 'models'
          AND column_name = 'strategy_kind'
      ) AS ok
    `),
            targetPool.query(
                `SELECT to_regclass('soul_gateway.model_children') AS regclass`
            ),
            targetPool.query(
                `SELECT to_regclass('soul_gateway.middleware_bindings') AS regclass`
            ),
            targetPool.query(
                `SELECT to_regclass('soul_gateway.audit_logs') AS regclass`
            ),
            targetPool.query(
                `SELECT to_regclass('soul_gateway.sessions') AS regclass`
            ),
        ]);

    if (
        !strategy.rows[0]?.ok ||
        !children.rows[0]?.regclass ||
        !bindings.rows[0]?.regclass ||
        !auditLogs.rows[0]?.regclass ||
        !sessions.rows[0]?.regclass
    ) {
        throw new Error(
            'Target database is not ready for main-branch import. Apply migration 004 and boot the current runtime first.'
        );
    }
}

/**
 * Execute the import. In dry-run mode this only reads source rows and
 * returns the planned report.
 */
export async function importMainBranchData({
    sourcePool,
    targetPool,
    sourceEncryptionKey = null,
    targetEncryptionKey,
    targetApiKeyPepper,
    sourceCredentialsDir = null,
    targetCredentialsDir = null,
    strict = false,
    dryRun = false,
    includeAuditLogs = false,
    callLogBatchSize = 500,
    sessionTimeoutMinutes = 30,
}) {
    await assertTargetSchemaReady(targetPool);

    const source = await readMainBranchSourceSnapshot(sourcePool, {
        sourceCredentialsDir,
    });
    const targetMiddlewares = await middlewaresDao.list(targetPool, {
        limit: 5000,
    });
    const plan = buildMainBranchImportPlan({
        source,
        targetMiddlewareRows: targetMiddlewares,
        sourceEncryptionKey,
        targetEncryptionKey,
        targetApiKeyPepper,
        targetCredentialsDir,
    });

    plan.report.strict = strict;
    plan.report.dryRun = dryRun;
    plan.report.includeAuditLogs = includeAuditLogs;

    if (includeAuditLogs) {
        plan.report.sourceCounts.callLogs =
            await countMainBranchCallLogs(sourcePool);
        if (dryRun) {
            plan.report.counts.auditLogs = plan.report.sourceCounts.callLogs;
        }
    }

    if (strict && plan.report.warnings.length > 0) {
        throw new Error(
            `Import plan contains ${plan.report.warnings.length} warning(s); rerun without --strict or resolve the reported issues first.`
        );
    }

    if (dryRun) {
        return plan.report;
    }

    const providerIdBySourceId = new Map();
    const modelIdBySourceId = new Map();
    const modelIdByKey = new Map();
    const providerIdByModelKey = new Map();
    const apiKeyIdBySourceId = new Map();
    const oauthCredentialStore =
        plan.providerPlans.some((plan) =>
            (plan.accounts || []).some((account) => account.authType === 'oauth')
        ) && targetCredentialsDir
            ? new OAuthCredentialStore({
                  baseDir: targetCredentialsDir,
                  encryptionKey: targetEncryptionKey,
                  log: console,
              })
            : null;

    const client = targetPool.connect ? await targetPool.connect() : targetPool;
    try {
        await client.query('BEGIN');

        for (const providerPlan of plan.providerPlans) {
            const providerRow = await upsertProvider(
                client,
                providerPlan.target
            );
            providerIdBySourceId.set(providerPlan.sourceId, providerRow.id);
            for (const accountPlan of providerPlan.accounts || []) {
                if (accountPlan.authType === 'oauth') {
                    await upsertOAuthProviderAccount(
                        client,
                        providerRow.id,
                        accountPlan,
                        oauthCredentialStore
                    );
                    continue;
                }
                await upsertProviderAccount(client, providerRow.id, accountPlan);
            }
        }

        for (const modelPlan of plan.directModelPlans) {
            const providerId = providerIdBySourceId.get(
                modelPlan.sourceProviderId
            );
            if (!providerId) {
                addWarning(
                    plan.report,
                    'model_provider_write_unresolved',
                    `Skipping model "${modelPlan.target.modelKey}" because its provider was not written`,
                    {
                        model: modelPlan.target.modelKey,
                        sourceProviderId: modelPlan.sourceProviderId,
                    }
                );
                continue;
            }
            const row = await upsertModel(client, {
                ...modelPlan.target,
                providerId,
            });
            modelIdBySourceId.set(modelPlan.sourceId, row.id);
            modelIdByKey.set(modelPlan.target.modelKey, row.id);
            providerIdByModelKey.set(modelPlan.target.modelKey, providerId);
        }

        for (const modelPlan of plan.cascadeModelPlans) {
            const row = await upsertModel(client, modelPlan.target);
            modelIdBySourceId.set(modelPlan.sourceId, row.id);
            modelIdByKey.set(modelPlan.target.modelKey, row.id);
            providerIdByModelKey.set(modelPlan.target.modelKey, null);
        }

        for (const modelPlan of plan.cascadeModelPlans) {
            const parentModelId = modelIdBySourceId.get(modelPlan.sourceId);
            if (!parentModelId) continue;

            const children = [];
            let priority = 1;
            for (const childRef of modelPlan.childModelRefs) {
                const childId = modelIdBySourceId.get(childRef.sourceModelId);
                if (!childId) {
                    addWarning(
                        plan.report,
                        'cascade_child_unresolved',
                        `Skipping child "${childRef.modelKey}" for cascade model "${modelPlan.target.modelKey}" because the child model was not imported`,
                        {
                            parentModel: modelPlan.target.modelKey,
                            childModel: childRef.modelKey,
                        }
                    );
                    continue;
                }
                children.push({
                    childModelId: childId,
                    priority,
                    enabled: true,
                    settings: childRef.settings || {},
                });
                priority += 1;
            }
            await replaceModelChildren(client, parentModelId, children);
        }

        for (const aliasPlan of plan.modelAliasPlans || []) {
            const modelId = modelIdBySourceId.get(aliasPlan.targetModelSourceId);
            if (!modelId) {
                addWarning(
                    plan.report,
                    'model_alias_model_write_unresolved',
                    `Skipping historical alias "${aliasPlan.alias}" because its model was not written`,
                    {
                        alias: aliasPlan.alias,
                        model: aliasPlan.targetModelKey,
                    }
                );
                continue;
            }
            await upsertModelAlias(client, {
                alias: aliasPlan.alias,
                modelId,
            });
            modelIdByKey.set(aliasPlan.alias, modelId);
            providerIdByModelKey.set(
                aliasPlan.alias,
                providerIdByModelKey.get(aliasPlan.targetModelKey) || null
            );
        }

        for (const apiKeyPlan of plan.apiKeyPlans) {
            const row = await upsertApiKey(client, apiKeyPlan.target);
            apiKeyIdBySourceId.set(apiKeyPlan.sourceId, row.id);
        }

        for (const bindingPlan of plan.modelBindingPlans) {
            const modelId = modelIdBySourceId.get(
                bindingPlan.targetModelSourceId
            );
            if (!modelId) {
                addWarning(
                    plan.report,
                    'middleware_binding_model_write_unresolved',
                    `Skipping middleware binding "${bindingPlan.target.middlewareKey}" because its model was not written`,
                    {
                        model: bindingPlan.targetModelKey,
                        middlewareKey: bindingPlan.target.middlewareKey,
                    }
                );
                continue;
            }
            await upsertModelMiddlewareBinding(client, {
                ...bindingPlan.target,
                targetId: modelId,
            });
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        if (targetPool.connect && typeof client.release === 'function') {
            client.release();
        }
    }

    if (includeAuditLogs) {
        await importMainBranchAuditLogs({
            sourcePool,
            targetPool,
            report: plan.report,
            sourceModels: source.models,
            sourceProviders: source.providers,
            apiKeyIdBySourceId,
            modelIdByKey,
            providerIdByModelKey,
            targetEncryptionKey,
            targetApiKeyPepper,
            batchSize: callLogBatchSize,
            sessionTimeoutMinutes,
        });
    }

    return plan.report;
}

function buildProviderPlan(
    sourceProvider,
    { sourceEncryptionKey, targetEncryptionKey, targetCredentialsDir, report }
) {
    const spec = resolveProviderImportSpec(sourceProvider);
    if (spec.warning) {
        addWarning(report, 'provider_unresolved', spec.warning, {
            provider: sourceProvider?.name || null,
            protocol: sourceProvider?.protocol || null,
            authType: sourceProvider?.auth_type || null,
        });
        return null;
    }

    const metadata = compactObject({
        sourceProviderId: sourceProvider.id,
        legacyProtocol: sourceProvider.protocol,
        legacyBillingType: sourceProvider.billing_type,
        legacyAuthType: sourceProvider.auth_type,
    });

    const target = {
        providerKey: sourceProvider.name,
        displayName: sourceProvider.display_name || sourceProvider.name,
        kind: spec.kind,
        adapterKey: spec.adapterKey,
        authStrategy: spec.authStrategy,
        providerMode: spec.providerMode,
        oauthAdapterKey: spec.oauthAdapterKey,
        baseUrl: spec.baseUrl,
        enabled: sourceProvider.is_enabled ?? true,
        supportsStreaming: spec.supportsStreaming,
        supportsTools: spec.supportsTools,
        supportsMessagesApi: spec.supportsMessagesApi,
        supportsResponsesApi: spec.supportsResponsesApi,
        settings: {},
        metadata,
    };

    report.counts.providers += 1;

    const accounts = [];
    if (normalizeText(sourceProvider?.auth_type) === 'managed') {
        const managedPlans = buildManagedProviderAccountPlans(sourceProvider, {
            targetCredentialsDir,
            report,
        });
        accounts.push(...managedPlans);
        report.counts.providerAccounts += managedPlans.length;
    } else if (sourceProvider.encrypted_api_key) {
        if (!hasSourceEncryptionKeys(sourceEncryptionKey)) {
            throw new Error(
                `SOURCE_ENCRYPTION_KEY or SOURCE_ENCRYPTION_KEYS is required to import provider "${sourceProvider.name}"`
            );
        }
        const plaintext = decryptLegacyBlobWithKeys(
            sourceProvider.encrypted_api_key,
            sourceEncryptionKey,
            {
                label: `Provider "${sourceProvider.name}" API key`,
            }
        );
        const encrypted = encrypt(plaintext, targetEncryptionKey);
        const account = {
            accountLabel: `${target.displayName} API Key`,
            authType: 'api_key',
            status: 'active',
            secretCiphertext: encrypted.ciphertext,
            secretIv: encrypted.iv,
            secretAuthTag: encrypted.authTag,
            secretHint:
                sourceProvider.key_hint || buildProviderSecretHint(plaintext),
            metadata: compactObject({
                sourceProviderId: sourceProvider.id,
            }),
        };
        accounts.push(account);
        report.counts.providerAccounts += 1;
    }

    return {
        sourceId: sourceProvider.id,
        sourceName: sourceProvider.name,
        target,
        accounts,
    };
}

function buildManagedProviderAccountPlans(
    sourceProvider,
    { targetCredentialsDir, report }
) {
    if (!targetCredentialsDir) {
        addWarning(
            report,
            'target_credentials_dir_missing',
            `TARGET_CREDENTIALS_DIR or CREDENTIALS_DIR is required to migrate managed provider "${sourceProvider.name}"`,
            {
                provider: sourceProvider.name,
            }
        );
        return [];
    }

    if (sourceProvider.legacy_managed_accounts_error) {
        addWarning(
            report,
            'provider_managed_credentials_missing',
            sourceProvider.legacy_managed_accounts_error,
            {
                provider: sourceProvider.name,
            }
        );
        return [];
    }

    const legacyAccounts = Array.isArray(sourceProvider.legacy_managed_accounts)
        ? sourceProvider.legacy_managed_accounts
        : [];

    if (legacyAccounts.length === 0) {
        addWarning(
            report,
            'provider_managed_credentials_missing',
            `Managed provider "${sourceProvider.name}" has no source account files to import`,
            {
                provider: sourceProvider.name,
            }
        );
        return [];
    }

    const activeIndex =
        sourceProvider.legacy_managed_state?.activeIndex != null
            ? Number(sourceProvider.legacy_managed_state.activeIndex)
            : null;

    return legacyAccounts.map((account, position) =>
        buildManagedProviderAccountPlan(sourceProvider, account, {
            activeIndex,
            position,
        })
    );
}

function buildManagedProviderAccountPlan(
    sourceProvider,
    account,
    { activeIndex = null, position = 0 } = {}
) {
    const index =
        account?._index != null && Number.isFinite(Number(account._index))
            ? Number(account._index)
            : position;
    const externalAccountId =
        normalizeText(account?.email) ||
        normalizeText(account?.profileArn) ||
        `legacy-account-${index}`;
    const accessTokenExpiresAt = normalizeLegacyAccountExpiry(account?.expiresAt);
    const quotaResetsAt = normalizeLegacyQuotaReset(account?.quotaResetAt);
    const accountLabelSource =
        normalizeText(account?.email) ||
        normalizeText(account?.profileArn) ||
        `Account ${index}`;

    return {
        accountLabel: `${sourceProvider.display_name || sourceProvider.name} ${accountLabelSource}`.trim(),
        authType: 'oauth',
        status: account?.quotaExhausted ? 'quota_exhausted' : 'active',
        externalAccountId,
        credentialsPayload: {
            accessToken: account?.accessToken || null,
            refreshToken: account?.refreshToken || null,
            accessTokenExpiresAt,
            refreshTokenExpiresAt: null,
            scope: null,
            tokenType: 'Bearer',
            externalAccountId,
            label: accountLabelSource,
            metadata: compactObject({
                email: account?.email || null,
                profileArn: account?.profileArn || null,
                needsReauth: account?.needsReauth ?? false,
                noRefreshToken: !!account?.noRefreshToken,
                expiryWarning: !!account?.expiryWarning,
                legacyIndex: index,
                legacyFileName: account?._file_name || null,
                legacyWasActive: activeIndex != null ? index === activeIndex : null,
            }),
        },
        accessTokenExpiresAt,
        refreshTokenExpiresAt: null,
        refreshMarginSeconds: OAUTH_REFRESH_MARGIN_SECONDS,
        quotaResetsAt,
        metadata: compactObject({
            email: account?.email || null,
            profileArn: account?.profileArn || null,
            legacyIndex: index,
            legacyNeedsReauth: account?.needsReauth ?? false,
            legacyNoRefreshToken: !!account?.noRefreshToken,
            legacyExpiryWarning: !!account?.expiryWarning,
            legacyQuotaExhausted: !!account?.quotaExhausted,
            legacyWasActive: activeIndex != null ? index === activeIndex : null,
            sourceProviderId: sourceProvider.id,
        }),
    };
}

function normalizeLegacyAccountExpiry(value) {
    if (value == null || value === '') return null;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
        return new Date(asNumber).toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeLegacyQuotaReset(value) {
    if (value == null || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deriveHistoricalModelAliasCandidates(sourceModel) {
    const aliases = new Set();
    const modelKey = normalizeText(sourceModel?.name);
    if (!modelKey) return aliases;

    if (sourceModel?.type === 'tier') {
        if (modelKey.startsWith('axl/')) {
            aliases.add(modelKey.slice('axl/'.length));
        }
        return aliases;
    }

    const bareName = extractBareModelName(modelKey);
    if (bareName) {
        aliases.add(bareName);
    }
    if (!modelKey.startsWith('axl/')) {
        aliases.add(`axl/${modelKey}`);
    }

    const providerModelId = normalizeText(
        sourceModel?.provider_model || sourceModel?.upstream_model || bareName
    );
    if (providerModelId) {
        aliases.add(providerModelId);
    }

    const providerKey = normalizeText(sourceModel?.provider_key);
    if (providerKey === 'copilot' && providerModelId) {
        aliases.add(`copilot-${providerModelId}`);
        if (bareName && bareName !== providerModelId) {
            aliases.add(`copilot-${bareName}`);
        }
    }
    if (providerKey === 'axiologic_kiro') {
        if (providerModelId === 'auto-kiro' || bareName === 'auto') {
            aliases.add('auto-kiro');
        } else {
            if (providerModelId) {
                aliases.add(`kiro-${providerModelId}`);
            }
            if (bareName && bareName !== providerModelId) {
                aliases.add(`kiro-${bareName}`);
            }
        }
    }
    if (providerKey === 'codex' && bareName && bareName !== providerModelId) {
        aliases.add(`codex-${bareName}`);
    }

    aliases.delete(modelKey);
    return aliases;
}

function resolveHistoricalAliasOwner(alias, owners) {
    if (!Array.isArray(owners) || owners.length === 0) return null;
    if (owners.length === 1) return owners[0];

    const scored = owners
        .map((owner) => ({
            owner,
            score: scoreHistoricalAliasOwner(alias, {
                modelKey: owner?.target?.modelKey || null,
                providerKey:
                    owner?.target?.metadata?.legacyProviderKey || null,
                providerModel:
                    owner?.target?.providerModelId || null,
            }),
        }))
        .sort(
            (left, right) =>
                left.score - right.score ||
                String(left.owner?.target?.modelKey || '').localeCompare(
                    String(right.owner?.target?.modelKey || '')
                )
        );

    if (scored.length === 1 || scored[0].score < scored[1].score) {
        return scored[0].owner;
    }
    return null;
}

function scoreHistoricalAliasOwner(alias, { modelKey, providerKey, providerModel }) {
    const normalizedModelKey = normalizeText(modelKey) || '';
    const normalizedProviderKey = normalizeText(providerKey) || '';
    const normalizedProviderModel = normalizeText(providerModel) || '';

    let score = normalizedModelKey.split('/').filter(Boolean).length * 10;
    if (normalizedModelKey.startsWith('axl/')) {
        score += 100;
    }

    const prefixedAlias = parseProviderPrefixedAlias(alias);
    const providerAlias = providerKeyToAliasPrefix(normalizedProviderKey);
    if (
        prefixedAlias &&
        providerAlias &&
        prefixedAlias.providerAlias === providerAlias
    ) {
        if (
            normalizedModelKey ===
            `${providerAlias}/${prefixedAlias.modelPart}`
        ) {
            score -= 80;
        } else if (normalizedProviderModel === prefixedAlias.modelPart) {
            score -= 20;
        }
    }

    if (normalizedProviderModel && alias === normalizedProviderModel) {
        score -= 10;
    }

    return score;
}

function parseProviderPrefixedAlias(alias) {
    const normalized = normalizeText(alias);
    if (!normalized) return null;
    const separatorIdx = normalized.indexOf('-');
    if (separatorIdx <= 0 || separatorIdx === normalized.length - 1) {
        return null;
    }
    return {
        providerAlias: normalized.slice(0, separatorIdx),
        modelPart: normalized.slice(separatorIdx + 1),
    };
}

function providerKeyToAliasPrefix(providerKey) {
    if (providerKey === 'axiologic_kiro') return 'kiro';
    return providerKey || null;
}

function extractBareModelName(modelKey) {
    const slashIdx = modelKey.indexOf('/');
    if (slashIdx === -1) return modelKey;
    return modelKey.slice(slashIdx + 1);
}

function buildHistoricalSourceModelKeyMap(sourceModels) {
    const map = new Map();
    const aliasOwners = new Map();

    for (const row of sourceModels || []) {
        if (row?.name) {
            map.set(row.name, row);
        }
        for (const alias of deriveHistoricalModelAliasCandidates(row)) {
            if (!alias || map.has(alias)) continue;
            if (!aliasOwners.has(alias)) aliasOwners.set(alias, []);
            aliasOwners.get(alias).push(row);
        }
    }

    for (const [alias, owners] of aliasOwners) {
        const owner = resolveHistoricalSourceAliasOwner(alias, owners);
        if (owner && !map.has(alias)) {
            map.set(alias, owner);
        }
    }

    return map;
}

function resolveHistoricalSourceAliasOwner(alias, owners) {
    if (!Array.isArray(owners) || owners.length === 0) return null;
    if (owners.length === 1) return owners[0];

    const scored = owners
        .map((owner) => ({
            owner,
            score: scoreHistoricalAliasOwner(alias, {
                modelKey: owner?.name || null,
                providerKey: owner?.provider_key || null,
                providerModel:
                    normalizeText(owner?.provider_model) ||
                    normalizeText(owner?.upstream_model) ||
                    null,
            }),
        }))
        .sort(
            (left, right) =>
                left.score - right.score ||
                String(left.owner?.name || '').localeCompare(
                    String(right.owner?.name || '')
                )
        );

    if (scored.length === 1 || scored[0].score < scored[1].score) {
        return scored[0].owner;
    }
    return null;
}

function resolveHistoricalModelKey(value, modelIdByKey) {
    const candidate = normalizeText(value);
    if (!candidate) return null;
    if (modelIdByKey.has(candidate)) {
        return candidate;
    }
    return candidate;
}

function buildApiKeyPlan(
    sourceApiKey,
    { sourceEncryptionKey, targetEncryptionKey, targetApiKeyPepper }
) {
    if (!hasSourceEncryptionKeys(sourceEncryptionKey)) {
        throw new Error(
            `SOURCE_ENCRYPTION_KEY or SOURCE_ENCRYPTION_KEYS is required to import API key "${sourceApiKey.id}"`
        );
    }

    const plaintext = decryptLegacyBlobWithKeys(
        sourceApiKey.encrypted_key,
        sourceEncryptionKey,
        {
            label: `API key "${sourceApiKey.id}"`,
        }
    );
    const encrypted = encrypt(plaintext, targetEncryptionKey);

    return {
        sourceId: sourceApiKey.id,
        target: {
            label:
                sourceApiKey.label ||
                `Imported ${sourceApiKey.key_hint || 'API key'}`,
            keyHash: hashApiKey(plaintext, targetApiKeyPepper),
            keyCiphertext: encrypted.ciphertext,
            keyIv: encrypted.iv,
            keyAuthTag: encrypted.authTag,
            keyHint: sourceApiKey.key_hint || buildApiKeyHint(plaintext),
            rpmLimit: sourceApiKey.rpm_limit ?? 60,
            tpmLimit: sourceApiKey.tpm_limit ?? 100000,
            dailyBudgetUsd: sourceApiKey.daily_budget ?? null,
            monthlyBudgetUsd: sourceApiKey.monthly_budget ?? null,
            expiresAt: sourceApiKey.expires_at ?? null,
            status: sourceApiKey.is_revoked ? 'revoked' : 'active',
            lastUsedAt: sourceApiKey.last_used_at ?? null,
            revokedAt: sourceApiKey.is_revoked
                ? (sourceApiKey.last_used_at ?? sourceApiKey.created_at ?? null)
                : null,
            metadata: compactObject({
                sourceApiKeyId: sourceApiKey.id,
                legacyKeyHash: sourceApiKey.key_hash || null,
            }),
        },
    };
}

function buildDirectModelPlan(sourceModel, providerPlan) {
    const pricingMode = resolvePricingMode(sourceModel);
    const providerAdapter = providerPlan.target.adapterKey;
    const target = {
        modelKey: sourceModel.name,
        displayName: sourceModel.display_name || sourceModel.name,
        strategyKind: 'direct',
        providerId: null,
        providerModelId:
            sourceModel.provider_model ||
            sourceModel.upstream_model ||
            sourceModel.name,
        executionKind:
            providerAdapter === 'search-builtin'
                ? 'search_model'
                : 'provider_model',
        enabled: sourceModel.is_enabled ?? true,
        concurrencyLimit: sourceModel.max_concurrency ?? 3,
        queueTimeoutMs: 60000,
        requestTimeoutMs: 120000,
        pricingMode,
        inputPricePerMillion:
            pricingMode === 'token'
                ? numberOrZero(sourceModel.input_price)
                : null,
        outputPricePerMillion:
            pricingMode === 'token'
                ? numberOrZero(sourceModel.output_price)
                : null,
        requestPriceUsd:
            pricingMode === 'request'
                ? numberOrZero(sourceModel.request_cost)
                : null,
        isFree: sourceModel.is_free ?? pricingMode === 'free',
        discoverySource: 'manual',
        metadata: compactObject({
            sourceModelConfigId: sourceModel.id,
            legacyType: sourceModel.type,
            legacyMode: sourceModel.mode,
            legacySortOrder: sourceModel.sort_order,
            legacyContextWindow: sourceModel.context_window,
            legacyUpstreamSource: sourceModel.upstream_source,
            legacyProviderKey: sourceModel.provider_key,
        }),
        tags: sourceModel.tags || [],
        maxAttempts: null,
    };

    return {
        sourceId: sourceModel.id,
        sourceProviderId: providerPlan.sourceId,
        target,
    };
}

function buildCascadeModelPlan(sourceModel, report) {
    const childRefs = [];
    const seen = new Set();
    const orderedChildren = Array.isArray(sourceModel.model_refs)
        ? sourceModel.model_refs
        : [];

    for (const ref of orderedChildren) {
        if (!ref || seen.has(ref)) continue;
        if (ref === sourceModel.name) {
            addWarning(
                report,
                'cascade_self_reference',
                `Skipping self-reference in tier "${sourceModel.name}"`,
                {
                    tier: sourceModel.name,
                }
            );
            continue;
        }
        childRefs.push({
            sourceModelId: null,
            modelKey: ref,
            settings: {},
        });
        seen.add(ref);
    }

    if (
        sourceModel.fallback_model &&
        !seen.has(sourceModel.fallback_model) &&
        sourceModel.fallback_model !== sourceModel.name
    ) {
        childRefs.push({
            sourceModelId: null,
            modelKey: sourceModel.fallback_model,
            settings: { importedFallback: true },
        });
    }

    return {
        sourceId: sourceModel.id,
        target: {
            modelKey: sourceModel.name,
            displayName: sourceModel.display_name || sourceModel.name,
            strategyKind: 'cascade',
            providerId: null,
            providerModelId: null,
            executionKind: null,
            enabled: sourceModel.is_enabled ?? true,
            concurrencyLimit: 3,
            queueTimeoutMs: 60000,
            requestTimeoutMs: 120000,
            pricingMode: 'free',
            inputPricePerMillion: null,
            outputPricePerMillion: null,
            requestPriceUsd: null,
            isFree: true,
            discoverySource: 'manual',
            metadata: compactObject({
                sourceModelConfigId: sourceModel.id,
                legacyType: sourceModel.type,
                legacySortOrder: sourceModel.sort_order,
                legacyFallbackModel: sourceModel.fallback_model || null,
            }),
            tags: sourceModel.tags || [],
            maxAttempts: null,
        },
        childModelRefs: childRefs,
    };
}

async function importMainBranchAuditLogs({
    sourcePool,
    targetPool,
    report,
    sourceModels,
    sourceProviders,
    apiKeyIdBySourceId,
    modelIdByKey,
    providerIdByModelKey,
    targetEncryptionKey,
    targetApiKeyPepper,
    batchSize = 500,
    sessionTimeoutMinutes = 30,
}) {
    if (!report.sourceCounts.callLogs) {
        report.sourceCounts.callLogs =
            await countMainBranchCallLogs(sourcePool);
    }
    if (!report.sourceCounts.callLogs) {
        return;
    }

    const sourceModelByKey = buildHistoricalSourceModelKeyMap(sourceModels);
    const sourceProviderById = new Map(
        (sourceProviders || []).map((row) => [row.id, row])
    );
    const ensuredPartitions = new Set();
    const sessionPlanner = createHistoricalSessionPlanner({
        sessionTimeoutMinutes,
    });

    let afterStartedAt = null;
    let afterId = null;

    const client = targetPool.connect ? await targetPool.connect() : targetPool;
    try {
        while (true) {
            const rows = await listMainBranchCallLogBatch(sourcePool, {
                afterStartedAt,
                afterId,
                limit: batchSize,
            });
            if (rows.length === 0) break;

            for (const row of rows) {
                let targetApiKeyId = apiKeyIdBySourceId.get(row.api_key_id);
                if (!targetApiKeyId) {
                    targetApiKeyId = await ensureHistoricalPlaceholderApiKey(
                        client,
                        {
                            sourceApiKeyId: row.api_key_id || null,
                            apiKeyIdBySourceId,
                            report,
                            targetEncryptionKey,
                            targetApiKeyPepper,
                        }
                    );
                }

                const sessionId = sessionPlanner.observeLog({
                    sourceLog: row,
                    targetApiKeyId,
                });

                await ensureAuditPartition(
                    client,
                    row.started_at,
                    ensuredPartitions
                );
                await upsertAuditLog(
                    client,
                    buildHistoricalAuditLog({
                        sourceLog: row,
                        targetApiKeyId,
                        targetSessionId: sessionId,
                        sourceModelByKey,
                        sourceProviderById,
                        modelIdByKey,
                        providerIdByModelKey,
                    })
                );
                report.counts.auditLogs += 1;
            }

            const tail = rows[rows.length - 1];
            afterStartedAt = tail.started_at;
            afterId = tail.id;
        }

        const sessions = sessionPlanner.listSessions();
        for (const session of sessions) {
            await upsertHistoricalSession(client, session);
        }
        report.counts.sessions = sessions.length;
    } finally {
        if (targetPool.connect && typeof client.release === 'function') {
            client.release();
        }
    }
}

function createHistoricalSessionPlanner({ sessionTimeoutMinutes = 30 } = {}) {
    const timeoutMs = Math.max(1, Number(sessionTimeoutMinutes) || 30) * 60_000;
    const sessionsById = new Map();
    const implicitStateByGroup = new Map();
    const implicitSequenceByGroup = new Map();

    return {
        observeLog({ sourceLog, targetApiKeyId }) {
            const sourceAgentName = normalizeHistoricalAgentName(
                sourceLog.agent_name
            );
            const startedAt = toDate(sourceLog.started_at);
            const activityAt = toDate(
                sourceLog.completed_at || sourceLog.started_at
            );
            const inputTokens = intOrZero(sourceLog.prompt_tokens);
            const outputTokens = intOrZero(sourceLog.completion_tokens);

            if (sourceLog.session_id) {
                const explicitSessionId = String(sourceLog.session_id);
                const groupKey = `explicit:${targetApiKeyId}:${explicitSessionId}`;
                const sessionId = deterministicUuid(
                    'main-import-session',
                    groupKey,
                    '1'
                );
                const session = ensureHistoricalSession(sessionsById, {
                    id: sessionId,
                    groupKey,
                    groupDisplay: `${sourceAgentName} (${explicitSessionId})`,
                    sequenceNo: 1,
                    apiKeyId: targetApiKeyId,
                    soulId: sourceLog.soul_id || null,
                    agentName: sourceAgentName,
                    explicitSessionId,
                    sourceSessionKind: 'explicit',
                });
                mergeHistoricalSessionStats(session, {
                    startedAt,
                    activityAt,
                    inputTokens,
                    outputTokens,
                    soulId: sourceLog.soul_id || null,
                    agentName: sourceAgentName,
                });
                return sessionId;
            }

            const groupKey = `implicit:${targetApiKeyId}:${sourceAgentName}`;
            let state = implicitStateByGroup.get(groupKey);

            if (
                !state ||
                startedAt.getTime() - state.lastActivityMs > timeoutMs
            ) {
                const sequenceNo =
                    (implicitSequenceByGroup.get(groupKey) || 0) + 1;
                implicitSequenceByGroup.set(groupKey, sequenceNo);

                state = {
                    sessionId: deterministicUuid(
                        'main-import-session',
                        groupKey,
                        String(sequenceNo)
                    ),
                    sequenceNo,
                    lastActivityMs: activityAt.getTime(),
                };
                implicitStateByGroup.set(groupKey, state);

                ensureHistoricalSession(sessionsById, {
                    id: state.sessionId,
                    groupKey,
                    groupDisplay: `${sourceAgentName} #${sequenceNo}`,
                    sequenceNo,
                    apiKeyId: targetApiKeyId,
                    soulId: sourceLog.soul_id || null,
                    agentName: sourceAgentName,
                    explicitSessionId: null,
                    sourceSessionKind: 'implicit',
                });
            } else {
                state.lastActivityMs = Math.max(
                    state.lastActivityMs,
                    activityAt.getTime()
                );
            }

            const session = sessionsById.get(state.sessionId);
            mergeHistoricalSessionStats(session, {
                startedAt,
                activityAt,
                inputTokens,
                outputTokens,
                soulId: sourceLog.soul_id || null,
                agentName: sourceAgentName,
            });
            return state.sessionId;
        },

        listSessions() {
            return [...sessionsById.values()]
                .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
                .map((session) => ({
                    id: session.id,
                    groupKey: session.groupKey,
                    groupDisplay: session.groupDisplay,
                    sequenceNo: session.sequenceNo,
                    apiKeyId: session.apiKeyId,
                    soulId: session.soulId,
                    agentName: session.agentName,
                    explicitSessionId: session.explicitSessionId,
                    status: 'closed',
                    startedAt: session.startedAt.toISOString(),
                    lastActivityAt: session.lastActivityAt.toISOString(),
                    endedAt: session.lastActivityAt.toISOString(),
                    requestCount: session.requestCount,
                    inputTokensTotal: session.inputTokensTotal,
                    outputTokensTotal: session.outputTokensTotal,
                    metadata: compactObject({
                        importedHistorical: true,
                        importSource: HISTORICAL_SOURCE,
                        sourceSessionKind: session.sourceSessionKind,
                    }),
                }));
        },
    };
}

function ensureHistoricalSession(sessionsById, session) {
    let current = sessionsById.get(session.id);
    if (!current) {
        current = {
            ...session,
            requestCount: 0,
            inputTokensTotal: 0,
            outputTokensTotal: 0,
            startedAt: null,
            lastActivityAt: null,
        };
        sessionsById.set(session.id, current);
    }
    return current;
}

function mergeHistoricalSessionStats(
    session,
    { startedAt, activityAt, inputTokens, outputTokens, soulId, agentName }
) {
    session.requestCount += 1;
    session.inputTokensTotal += inputTokens;
    session.outputTokensTotal += outputTokens;
    session.startedAt =
        !session.startedAt || startedAt < session.startedAt
            ? startedAt
            : session.startedAt;
    session.lastActivityAt =
        !session.lastActivityAt || activityAt > session.lastActivityAt
            ? activityAt
            : session.lastActivityAt;
    if (!session.soulId && soulId) session.soulId = soulId;
    if (!session.agentName && agentName) session.agentName = agentName;
}

async function ensureHistoricalPlaceholderApiKey(
    client,
    {
        sourceApiKeyId,
        apiKeyIdBySourceId,
        report,
        targetEncryptionKey,
        targetApiKeyPepper,
    }
) {
    if (apiKeyIdBySourceId.has(sourceApiKeyId)) {
        return apiKeyIdBySourceId.get(sourceApiKeyId);
    }

    const placeholder = buildHistoricalPlaceholderApiKey(sourceApiKeyId, {
        targetEncryptionKey,
        targetApiKeyPepper,
    });
    const row = await upsertApiKey(client, placeholder);

    apiKeyIdBySourceId.set(sourceApiKeyId, row.id);
    report.counts.apiKeys += 1;
    addWarning(
        report,
        'audit_log_api_key_placeholder_created',
        sourceApiKeyId
            ? `Historical call logs referencing missing source API key "${sourceApiKeyId}" were attached to a revoked placeholder API key`
            : 'Historical call logs without a source API key were attached to a revoked placeholder API key',
        {
            sourceApiKeyId,
            placeholderApiKeyId: row.id,
        }
    );
    return row.id;
}

function buildHistoricalAuditLog({
    sourceLog,
    targetApiKeyId,
    targetSessionId,
    sourceModelByKey,
    sourceProviderById,
    modelIdByKey,
    providerIdByModelKey,
}) {
    const resolvedModelKey = resolveHistoricalModelKey(
        sourceLog.resolved_model,
        modelIdByKey
    );
    const requestedModelKey =
        resolveHistoricalModelKey(sourceLog.requested_model, modelIdByKey) ||
        resolvedModelKey ||
        sourceLog.requested_model ||
        'unknown';
    const sourceModel =
        sourceModelByKey.get(resolvedModelKey) ||
        sourceModelByKey.get(requestedModelKey) ||
        null;
    const sourceProvider = sourceModel?.provider_config_id
        ? sourceProviderById.get(sourceModel.provider_config_id)
        : null;
    const requestFormat = inferLegacyRequestFormat(sourceLog, {
        sourceModel,
        sourceProvider,
    });

    return {
        startedAt: sourceLog.started_at,
        logId: sourceLog.id,
        requestId: String(sourceLog.id),
        requestFormat,
        status: deriveHistoricalAuditStatus(sourceLog),
        apiKeyId: targetApiKeyId,
        soulId: sourceLog.soul_id || null,
        agentName: sourceLog.agent_name || null,
        userAgent: null,
        sessionId: targetSessionId,
        requestedModel: requestedModelKey,
        resolvedModelId: resolvedModelKey
            ? modelIdByKey.get(resolvedModelKey) || null
            : null,
        resolvedProviderId: resolvedModelKey
            ? providerIdByModelKey.get(resolvedModelKey) || null
            : null,
        tierId: null,
        providerAccountId: null,
        httpStatus: sourceLog.status_code ?? null,
        errorType: sourceLog.error_type || null,
        errorMessage: sourceLog.error_message || null,
        retryable: deriveHistoricalRetryable(sourceLog),
        cascaded: Boolean(
            sourceLog.requested_model &&
                sourceLog.resolved_model &&
                sourceLog.requested_model !== sourceLog.resolved_model
        ),
        cacheHit: !!sourceLog.cache_hit,
        blocked: !!sourceLog.blocked_by_blacklist,
        loopDetected: false,
        truncated: !!sourceLog.is_truncated,
        slow: !!sourceLog.is_slow,
        oversized: !!sourceLog.prompt_size_warning,
        streaming: !!sourceLog.is_streaming,
        queueWaitMs: null,
        latencyMs: sourceLog.latency_ms ?? null,
        ttfbMs: sourceLog.ttfb_ms ?? null,
        completedAt: sourceLog.completed_at || null,
        attemptCount: Math.max(1, intOrZero(sourceLog.retry_count) + 1),
        retryTrace: normalizeHistoricalRetryTrace(sourceLog),
        middlewareTrace: normalizeHistoricalMiddlewareTrace(
            sourceLog.middlewares_applied
        ),
        requestHeaders: {},
        requestPayload: buildHistoricalRequestPayload(sourceLog, requestFormat),
        responsePayload: buildHistoricalResponsePayload(sourceLog),
        responseExcerpt: buildHistoricalResponseExcerpt(
            sourceLog.response_content
        ),
        responseFingerprint: null,
        inputTokens: sourceLog.prompt_tokens ?? null,
        outputTokens: sourceLog.completion_tokens ?? null,
        totalTokens: sourceLog.total_tokens ?? null,
        inputCostUsd: numberOrZero(sourceLog.input_cost),
        outputCostUsd: numberOrZero(sourceLog.output_cost),
        totalCostUsd: numberOrZero(sourceLog.total_cost),
        budgetExempt: !!sourceLog.is_free,
        flags: compactObject({
            legacyStopReason: sourceLog.stop_reason || null,
            legacyBlacklistMatch: sourceLog.blacklist_match || null,
            promptHash: sourceLog.prompt_hash || null,
        }),
        metadata: compactObject({
            importedHistorical: true,
            importSource: HISTORICAL_SOURCE,
            sourceLogId: sourceLog.id,
            sourceApiKeyId: sourceLog.api_key_id || null,
            sourceRequestedModel: sourceLog.requested_model || null,
            sourceResolvedModel: sourceLog.resolved_model || null,
            legacyMode: sourceLog.mode || null,
            requestSizeBytes: sourceLog.request_size_bytes ?? null,
            responseSizeBytes: sourceLog.response_size_bytes ?? null,
            blacklistRuleId: sourceLog.blacklist_rule_id || null,
        }),
    };
}

function buildHistoricalPlaceholderApiKey(
    sourceApiKeyId,
    { targetEncryptionKey, targetApiKeyPepper }
) {
    const sourceToken = sourceApiKeyId == null ? 'null' : String(sourceApiKeyId);
    const digest = createHash('sha256')
        .update(`main-import-missing-api-key:${sourceToken}`)
        .digest('hex');
    const plaintext = `sk-soul-imported-missing-${digest}`;
    const encrypted = encrypt(plaintext, targetEncryptionKey);

    return {
        label:
            sourceApiKeyId == null
                ? 'Imported Missing Legacy API Key'
                : `Imported Missing Legacy API Key ${sourceApiKeyId}`,
        keyHash: hashApiKey(plaintext, targetApiKeyPepper),
        keyCiphertext: encrypted.ciphertext,
        keyIv: encrypted.iv,
        keyAuthTag: encrypted.authTag,
        keyHint: buildApiKeyHint(plaintext),
        rpmLimit: 1,
        tpmLimit: 1,
        dailyBudgetUsd: 0,
        monthlyBudgetUsd: 0,
        expiresAt: null,
        status: 'revoked',
        lastUsedAt: null,
        revokedAt: null,
        metadata: compactObject({
            importedHistoricalPlaceholder: true,
            importSource: HISTORICAL_SOURCE,
            sourceApiKeyId,
        }),
    };
}

function inferLegacyRequestFormat(sourceLog, { sourceModel, sourceProvider }) {
    const providerKey =
        sourceModel?.provider_key || sourceProvider?.name || null;
    const protocol = sourceProvider?.protocol || null;

    if (
        looksLikeResponsesInput(sourceLog.request_messages) ||
        providerKey === 'codex' ||
        providerKey === 'copilot'
    ) {
        return 'openai_responses';
    }
    if (protocol === 'anthropic' || providerKey === 'anthropic') {
        return 'anthropic_messages';
    }
    return 'openai_chat';
}

function looksLikeResponsesInput(value) {
    if (value == null) return false;
    if (typeof value === 'string') return true;
    if (!Array.isArray(value)) return typeof value === 'object';
    return value.some(
        (entry) => !entry || typeof entry !== 'object' || !('role' in entry)
    );
}

function deriveHistoricalAuditStatus(sourceLog) {
    const httpStatus = intOrZero(sourceLog.status_code);
    const errorType = String(sourceLog.error_type || '').toLowerCase();
    if (httpStatus === 499 || errorType.includes('abort')) {
        return 'aborted';
    }
    if (!sourceLog.error_type && httpStatus >= 200 && httpStatus < 400) {
        return 'succeeded';
    }
    return 'failed';
}

function deriveHistoricalRetryable(sourceLog) {
    const httpStatus = intOrZero(sourceLog.status_code);
    if ([408, 409, 423, 425, 429, 500, 502, 503, 504].includes(httpStatus)) {
        return true;
    }
    const errorType = String(sourceLog.error_type || '').toLowerCase();
    if (/(timeout|rate|unavailable|overload|retry|cooldown)/.test(errorType)) {
        return true;
    }
    return intOrZero(sourceLog.retry_count) > 0;
}

function normalizeHistoricalRetryTrace(sourceLog) {
    if (Array.isArray(sourceLog.retries_detail)) {
        return sourceLog.retries_detail;
    }
    if (
        sourceLog.retries_detail &&
        typeof sourceLog.retries_detail === 'object'
    ) {
        return [sourceLog.retries_detail];
    }
    if (sourceLog.retry_reason) {
        return [{ reason: sourceLog.retry_reason, importedHistorical: true }];
    }
    return [];
}

function normalizeHistoricalMiddlewareTrace(applied) {
    if (!Array.isArray(applied)) return [];
    return applied.filter(Boolean).map((middlewareKey, index) => ({
        middlewareKey,
        phase: 'legacy',
        order: index + 1,
        importedHistorical: true,
    }));
}

function buildHistoricalRequestPayload(sourceLog, requestFormat) {
    const common = {
        model: sourceLog.requested_model || sourceLog.resolved_model || null,
        stream: !!sourceLog.is_streaming,
    };

    if (requestFormat === 'openai_responses') {
        return {
            ...common,
            input: sourceLog.request_messages ?? [],
        };
    }

    return {
        ...common,
        messages: sourceLog.request_messages ?? [],
    };
}

function buildHistoricalResponsePayload(sourceLog) {
    if (!sourceLog.response_content && !sourceLog.stop_reason) {
        return null;
    }
    return compactObject({
        content: sourceLog.response_content || null,
        stopReason: sourceLog.stop_reason || null,
    });
}

function buildHistoricalResponseExcerpt(content) {
    if (!content) return null;
    return String(content).slice(0, RESPONSE_EXCERPT_CHARS);
}

async function ensureAuditPartition(client, startedAt, ensuredPartitions) {
    const date = toDate(startedAt);
    const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    if (ensuredPartitions.has(monthKey)) {
        return;
    }
    await auditLogsDao.ensurePartition(client, date);
    ensuredPartitions.add(monthKey);
}

async function upsertHistoricalSession(client, session) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.sessions
      (id, group_key, group_display, sequence_no, api_key_id,
       soul_id, agent_name, explicit_session_id, status,
       started_at, last_activity_at, ended_at, request_count,
       input_tokens_total, output_tokens_total, metadata)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (id) DO UPDATE SET
      group_key = EXCLUDED.group_key,
      group_display = EXCLUDED.group_display,
      sequence_no = EXCLUDED.sequence_no,
      api_key_id = EXCLUDED.api_key_id,
      soul_id = EXCLUDED.soul_id,
      agent_name = EXCLUDED.agent_name,
      explicit_session_id = EXCLUDED.explicit_session_id,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      last_activity_at = EXCLUDED.last_activity_at,
      ended_at = EXCLUDED.ended_at,
      request_count = EXCLUDED.request_count,
      input_tokens_total = EXCLUDED.input_tokens_total,
      output_tokens_total = EXCLUDED.output_tokens_total,
      metadata = EXCLUDED.metadata
    RETURNING *
  `,
        [
            session.id,
            session.groupKey,
            session.groupDisplay,
            session.sequenceNo,
            session.apiKeyId,
            session.soulId,
            session.agentName,
            session.explicitSessionId,
            session.status,
            session.startedAt,
            session.lastActivityAt,
            session.endedAt,
            session.requestCount,
            session.inputTokensTotal,
            session.outputTokensTotal,
            JSON.stringify(session.metadata || {}),
        ]
    );
    return rows[0];
}

async function upsertAuditLog(client, entry) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.audit_logs
      (started_at, log_id, request_id, request_format, status,
       api_key_id, soul_id, agent_name, user_agent, session_id,
       requested_model, resolved_model_id, resolved_provider_id, tier_id, provider_account_id,
       http_status, error_type, error_message, retryable,
       cascaded, cache_hit, blocked, loop_detected, truncated, slow, oversized, streaming,
       queue_wait_ms, latency_ms, ttfb_ms, completed_at, attempt_count,
       retry_trace, middleware_trace, request_headers, request_payload,
       response_payload, response_excerpt, response_fingerprint,
       input_tokens, output_tokens, total_tokens,
       input_cost_usd, output_cost_usd, total_cost_usd,
       budget_exempt, flags, metadata)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
       $11,$12,$13,$14,$15,
       $16,$17,$18,$19,
       $20,$21,$22,$23,$24,$25,$26,$27,
       $28,$29,$30,$31,$32,
       $33,$34,$35,$36,
       $37,$38,$39,
       $40,$41,$42,
       $43,$44,$45,
       $46,$47,$48)
    ON CONFLICT (started_at, log_id) DO UPDATE SET
      request_id = EXCLUDED.request_id,
      request_format = EXCLUDED.request_format,
      status = EXCLUDED.status,
      api_key_id = EXCLUDED.api_key_id,
      soul_id = EXCLUDED.soul_id,
      agent_name = EXCLUDED.agent_name,
      user_agent = EXCLUDED.user_agent,
      session_id = EXCLUDED.session_id,
      requested_model = EXCLUDED.requested_model,
      resolved_model_id = EXCLUDED.resolved_model_id,
      resolved_provider_id = EXCLUDED.resolved_provider_id,
      tier_id = EXCLUDED.tier_id,
      provider_account_id = EXCLUDED.provider_account_id,
      http_status = EXCLUDED.http_status,
      error_type = EXCLUDED.error_type,
      error_message = EXCLUDED.error_message,
      retryable = EXCLUDED.retryable,
      cascaded = EXCLUDED.cascaded,
      cache_hit = EXCLUDED.cache_hit,
      blocked = EXCLUDED.blocked,
      loop_detected = EXCLUDED.loop_detected,
      truncated = EXCLUDED.truncated,
      slow = EXCLUDED.slow,
      oversized = EXCLUDED.oversized,
      streaming = EXCLUDED.streaming,
      queue_wait_ms = EXCLUDED.queue_wait_ms,
      latency_ms = EXCLUDED.latency_ms,
      ttfb_ms = EXCLUDED.ttfb_ms,
      completed_at = EXCLUDED.completed_at,
      attempt_count = EXCLUDED.attempt_count,
      retry_trace = EXCLUDED.retry_trace,
      middleware_trace = EXCLUDED.middleware_trace,
      request_headers = EXCLUDED.request_headers,
      request_payload = EXCLUDED.request_payload,
      response_payload = EXCLUDED.response_payload,
      response_excerpt = EXCLUDED.response_excerpt,
      response_fingerprint = EXCLUDED.response_fingerprint,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      total_tokens = EXCLUDED.total_tokens,
      input_cost_usd = EXCLUDED.input_cost_usd,
      output_cost_usd = EXCLUDED.output_cost_usd,
      total_cost_usd = EXCLUDED.total_cost_usd,
      budget_exempt = EXCLUDED.budget_exempt,
      flags = EXCLUDED.flags,
      metadata = EXCLUDED.metadata
    RETURNING *
  `,
        [
            entry.startedAt,
            entry.logId,
            entry.requestId,
            entry.requestFormat,
            entry.status,
            entry.apiKeyId,
            entry.soulId,
            entry.agentName,
            entry.userAgent,
            entry.sessionId,
            entry.requestedModel,
            entry.resolvedModelId,
            entry.resolvedProviderId,
            entry.tierId,
            entry.providerAccountId,
            entry.httpStatus,
            entry.errorType,
            entry.errorMessage,
            entry.retryable,
            entry.cascaded,
            entry.cacheHit,
            entry.blocked,
            entry.loopDetected,
            entry.truncated,
            entry.slow,
            entry.oversized,
            entry.streaming,
            entry.queueWaitMs,
            entry.latencyMs,
            entry.ttfbMs,
            entry.completedAt,
            entry.attemptCount,
            JSON.stringify(entry.retryTrace || []),
            JSON.stringify(entry.middlewareTrace || []),
            JSON.stringify(entry.requestHeaders || {}),
            JSON.stringify(entry.requestPayload || {}),
            entry.responsePayload == null
                ? null
                : JSON.stringify(entry.responsePayload),
            entry.responseExcerpt,
            entry.responseFingerprint,
            entry.inputTokens,
            entry.outputTokens,
            entry.totalTokens,
            entry.inputCostUsd,
            entry.outputCostUsd,
            entry.totalCostUsd,
            entry.budgetExempt,
            JSON.stringify(entry.flags || {}),
            JSON.stringify(entry.metadata || {}),
        ]
    );
    return rows[0];
}

function normalizeLegacyBaseUrl(baseUrl, adapterKey) {
    if (!baseUrl) return null;

    if (adapterKey === 'search-builtin') {
        return baseUrl;
    }

    return baseUrl
        .replace(/\/chat\/completions\/?$/i, '')
        .replace(/\/messages\/?$/i, '')
        .replace(/\/responses\/?$/i, '')
        .replace(/\/completions\/?$/i, '');
}

function buildProviderSecretHint(secret) {
    if (!secret) return null;
    return secret.slice(0, 6) + '...' + secret.slice(-4);
}

function buildApiKeyHint(secret) {
    if (!secret) return null;
    return secret.slice(0, 8) + '...' + secret.slice(-4);
}

function hasSourceEncryptionKeys(sourceEncryptionKey) {
    return Array.isArray(sourceEncryptionKey)
        ? sourceEncryptionKey.length > 0
        : !!sourceEncryptionKey;
}

function resolvePricingMode(sourceModel) {
    if (sourceModel.is_free) return 'free';
    if (sourceModel.pricing_type === 'request') return 'request';
    if (sourceModel.pricing_type === 'token') return 'token';
    if (sourceModel.request_cost && numberOrZero(sourceModel.request_cost) > 0)
        return 'request';
    return 'token';
}

function extractHostname(baseUrl) {
    if (!baseUrl) return '';
    try {
        return new URL(baseUrl).hostname;
    } catch {
        return '';
    }
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeHistoricalAgentName(value) {
    return normalizeText(value) || 'unknown';
}

function numberOrZero(value) {
    if (value == null || value === '') return 0;
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}

function intOrZero(value) {
    if (value == null || value === '') return 0;
    const num = parseInt(value, 10);
    return Number.isFinite(num) ? num : 0;
}

function toDate(value) {
    return value instanceof Date ? value : new Date(value);
}

function deterministicUuid(...parts) {
    const digest = createHash('sha256')
        .update(parts.map((part) => String(part)).join('\0'))
        .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [
        bytes.subarray(0, 4).toString('hex'),
        bytes.subarray(4, 6).toString('hex'),
        bytes.subarray(6, 8).toString('hex'),
        bytes.subarray(8, 10).toString('hex'),
        bytes.subarray(10, 16).toString('hex'),
    ].join('-');
}

function compactObject(input) {
    const out = {};
    for (const [key, value] of Object.entries(input || {})) {
        if (value !== undefined && value !== null && value !== '') {
            out[key] = value;
        }
    }
    return out;
}

function createImportReport(source) {
    return {
        sourceCounts: {
            providers: source.providers.length,
            apiKeys: source.apiKeys.length,
            models: source.models.length,
            middlewares: source.middlewares.length,
            modelMiddlewares: source.modelMiddlewares.length,
            callLogs: 0,
        },
        counts: {
            providers: 0,
            providerAccounts: 0,
            apiKeys: source.apiKeys.length,
            directModels: 0,
            cascadeModels: 0,
            modelAliases: 0,
            middlewareBindings: 0,
            auditLogs: 0,
            skippedAuditLogs: 0,
            sessions: 0,
        },
        warnings: [],
        dryRun: false,
        strict: false,
        includeAuditLogs: false,
    };
}

function addWarning(report, code, message, details = {}) {
    report.warnings.push({ code, message, details });
}

async function upsertProvider(client, provider) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.providers
      (provider_key, display_name, kind, adapter_key, auth_strategy,
       provider_mode, oauth_adapter_key, base_url, enabled,
       supports_streaming, supports_tools, supports_messages_api, supports_responses_api,
       settings, metadata)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (provider_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      kind = EXCLUDED.kind,
      adapter_key = EXCLUDED.adapter_key,
      auth_strategy = EXCLUDED.auth_strategy,
      provider_mode = EXCLUDED.provider_mode,
      oauth_adapter_key = EXCLUDED.oauth_adapter_key,
      base_url = EXCLUDED.base_url,
      enabled = EXCLUDED.enabled,
      supports_streaming = EXCLUDED.supports_streaming,
      supports_tools = EXCLUDED.supports_tools,
      supports_messages_api = EXCLUDED.supports_messages_api,
      supports_responses_api = EXCLUDED.supports_responses_api,
      settings = EXCLUDED.settings,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `,
        [
            provider.providerKey,
            provider.displayName,
            provider.kind,
            provider.adapterKey,
            provider.authStrategy,
            provider.providerMode,
            provider.oauthAdapterKey,
            provider.baseUrl,
            provider.enabled,
            provider.supportsStreaming,
            provider.supportsTools,
            provider.supportsMessagesApi,
            provider.supportsResponsesApi,
            JSON.stringify(provider.settings || {}),
            JSON.stringify(provider.metadata || {}),
        ]
    );
    return rows[0];
}

async function upsertProviderAccount(client, providerId, account) {
    const { rows: existingRows } = await client.query(
        `
    SELECT *
    FROM soul_gateway.provider_accounts
    WHERE provider_id = $1
      AND auth_type = $2
      AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `,
        [providerId, account.authType]
    );

    if (existingRows[0]) {
        const { rows } = await client.query(
            `
      UPDATE soul_gateway.provider_accounts
      SET account_label = $2,
          status = $3,
          secret_ciphertext = $4,
          secret_iv = $5,
          secret_auth_tag = $6,
          secret_hint = $7,
          metadata = $8,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
            [
                existingRows[0].id,
                account.accountLabel,
                account.status,
                account.secretCiphertext,
                account.secretIv,
                account.secretAuthTag,
                account.secretHint,
                JSON.stringify(account.metadata || {}),
            ]
        );
        return rows[0];
    }

    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.provider_accounts
      (provider_id, account_label, auth_type, status,
       secret_ciphertext, secret_iv, secret_auth_tag, secret_hint, metadata)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `,
        [
            providerId,
            account.accountLabel,
            account.authType,
            account.status,
            account.secretCiphertext,
            account.secretIv,
            account.secretAuthTag,
            account.secretHint,
            JSON.stringify(account.metadata || {}),
        ]
    );
    return rows[0];
}

async function upsertOAuthProviderAccount(
    client,
    providerId,
    account,
    oauthCredentialStore
) {
    if (!oauthCredentialStore) {
        throw new Error(
            `OAuth credential store is required to import managed provider "${providerId}"`
        );
    }

    const { rows: existingRows } = await client.query(
        `
    SELECT *
    FROM soul_gateway.provider_accounts
    WHERE provider_id = $1
      AND auth_type = 'oauth'
      AND deleted_at IS NULL
      AND (
        external_account_id = $2
        OR credentials_path = $3
      )
    ORDER BY created_at ASC
    LIMIT 1
  `,
        [providerId, account.externalAccountId, null]
    );

    const existing = existingRows[0] || null;
    const credentialsPath =
        existing?.credentials_path ||
        (await oauthCredentialStore.allocatePath(
            providerId,
            account.externalAccountId || null,
            account.accountLabel
        ));

    await oauthCredentialStore.write(credentialsPath, account.credentialsPayload);

    const metadata = {
        access_token: account.credentialsPayload?.accessToken || null,
        refresh_token: account.credentialsPayload?.refreshToken || null,
        token_type: account.credentialsPayload?.tokenType || 'Bearer',
        scope: account.credentialsPayload?.scope || null,
        ...(account.metadata || {}),
    };

    if (existing) {
        const { rows } = await client.query(
            `
      UPDATE soul_gateway.provider_accounts
      SET account_label = $2,
          status = $3,
          external_account_id = $4,
          credentials_path = $5,
          access_token_expires_at = $6,
          refresh_token_expires_at = $7,
          refresh_margin_seconds = $8,
          quota_resets_at = $9,
          metadata = $10,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
            [
                existing.id,
                account.accountLabel,
                account.status,
                account.externalAccountId,
                credentialsPath,
                account.accessTokenExpiresAt,
                account.refreshTokenExpiresAt,
                account.refreshMarginSeconds ?? OAUTH_REFRESH_MARGIN_SECONDS,
                account.quotaResetsAt,
                JSON.stringify(metadata),
            ]
        );
        return rows[0];
    }

    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.provider_accounts
      (provider_id, account_label, auth_type, status,
       external_account_id, credentials_path,
       access_token_expires_at, refresh_token_expires_at,
       refresh_margin_seconds, quota_resets_at, metadata)
    VALUES
      ($1,$2,'oauth',$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `,
        [
            providerId,
            account.accountLabel,
            account.status,
            account.externalAccountId,
            credentialsPath,
            account.accessTokenExpiresAt,
            account.refreshTokenExpiresAt,
            account.refreshMarginSeconds ?? OAUTH_REFRESH_MARGIN_SECONDS,
            account.quotaResetsAt,
            JSON.stringify(metadata),
        ]
    );
    return rows[0];
}

async function upsertApiKey(client, key) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.api_keys
      (label, key_hash, key_ciphertext, key_iv, key_auth_tag, key_hint,
       rpm_limit, tpm_limit, daily_budget_usd, monthly_budget_usd,
       expires_at, status, last_used_at, metadata, revoked_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (key_hash) DO UPDATE SET
      label = EXCLUDED.label,
      key_ciphertext = EXCLUDED.key_ciphertext,
      key_iv = EXCLUDED.key_iv,
      key_auth_tag = EXCLUDED.key_auth_tag,
      key_hint = EXCLUDED.key_hint,
      rpm_limit = EXCLUDED.rpm_limit,
      tpm_limit = EXCLUDED.tpm_limit,
      daily_budget_usd = EXCLUDED.daily_budget_usd,
      monthly_budget_usd = EXCLUDED.monthly_budget_usd,
      expires_at = EXCLUDED.expires_at,
      status = EXCLUDED.status,
      last_used_at = EXCLUDED.last_used_at,
      metadata = EXCLUDED.metadata,
      revoked_at = EXCLUDED.revoked_at,
      updated_at = now()
    RETURNING *
  `,
        [
            key.label,
            key.keyHash,
            key.keyCiphertext,
            key.keyIv,
            key.keyAuthTag,
            key.keyHint,
            key.rpmLimit,
            key.tpmLimit,
            key.dailyBudgetUsd,
            key.monthlyBudgetUsd,
            key.expiresAt,
            key.status,
            key.lastUsedAt,
            JSON.stringify(key.metadata || {}),
            key.revokedAt,
        ]
    );
    return rows[0];
}

async function upsertModel(client, model) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.models
      (model_key, display_name, provider_id, provider_model_id, execution_kind,
       enabled, concurrency_limit, queue_timeout_ms, request_timeout_ms,
       pricing_mode, input_price_per_million, output_price_per_million, request_price_usd,
       retry_policy, capabilities, tags, is_free, discovery_source, metadata,
       strategy_kind, max_attempts)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    ON CONFLICT (model_key) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      provider_id = EXCLUDED.provider_id,
      provider_model_id = EXCLUDED.provider_model_id,
      execution_kind = EXCLUDED.execution_kind,
      enabled = EXCLUDED.enabled,
      concurrency_limit = EXCLUDED.concurrency_limit,
      queue_timeout_ms = EXCLUDED.queue_timeout_ms,
      request_timeout_ms = EXCLUDED.request_timeout_ms,
      pricing_mode = EXCLUDED.pricing_mode,
      input_price_per_million = EXCLUDED.input_price_per_million,
      output_price_per_million = EXCLUDED.output_price_per_million,
      request_price_usd = EXCLUDED.request_price_usd,
      retry_policy = EXCLUDED.retry_policy,
      capabilities = EXCLUDED.capabilities,
      tags = EXCLUDED.tags,
      is_free = EXCLUDED.is_free,
      discovery_source = EXCLUDED.discovery_source,
      metadata = EXCLUDED.metadata,
      strategy_kind = EXCLUDED.strategy_kind,
      max_attempts = EXCLUDED.max_attempts,
      updated_at = now()
    RETURNING *
  `,
        [
            model.modelKey,
            model.displayName,
            model.providerId,
            model.providerModelId,
            model.executionKind,
            model.enabled,
            model.concurrencyLimit,
            model.queueTimeoutMs,
            model.requestTimeoutMs,
            model.pricingMode,
            model.inputPricePerMillion,
            model.outputPricePerMillion,
            model.requestPriceUsd,
            JSON.stringify({}),
            JSON.stringify({}),
            model.tags || [],
            model.isFree,
            model.discoverySource,
            JSON.stringify(model.metadata || {}),
            model.strategyKind,
            model.maxAttempts,
        ]
    );
    return rows[0];
}

async function replaceModelChildren(client, parentModelId, children) {
    await client.query(
        `
    DELETE FROM soul_gateway.model_children
    WHERE parent_model_id = $1
  `,
        [parentModelId]
    );

    for (const child of children) {
        await client.query(
            `
      INSERT INTO soul_gateway.model_children
        (parent_model_id, child_model_id, priority, enabled, settings)
      VALUES
        ($1,$2,$3,$4,$5)
    `,
            [
                parentModelId,
                child.childModelId,
                child.priority,
                child.enabled,
                JSON.stringify(child.settings || {}),
            ]
        );
    }
}

async function upsertModelAlias(client, { alias, modelId }) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.model_aliases (alias, model_id)
    VALUES ($1, $2)
    ON CONFLICT (alias) DO UPDATE SET
      model_id = EXCLUDED.model_id
    RETURNING *
  `,
        [alias, modelId]
    );
    return rows[0];
}

async function upsertModelMiddlewareBinding(client, binding) {
    const { rows } = await client.query(
        `
    INSERT INTO soul_gateway.middleware_bindings
      (scope, target_id, middleware_key, sort_order, enabled, settings)
    VALUES
      ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (target_id, middleware_key)
      WHERE scope = 'model'
    DO UPDATE SET
      sort_order = EXCLUDED.sort_order,
      enabled = EXCLUDED.enabled,
      settings = EXCLUDED.settings,
      updated_at = now()
    RETURNING *
  `,
        [
            binding.scope,
            binding.targetId,
            binding.middlewareKey,
            binding.sortOrder,
            binding.enabled,
            JSON.stringify(binding.settings || {}),
        ]
    );
    return rows[0];
}
