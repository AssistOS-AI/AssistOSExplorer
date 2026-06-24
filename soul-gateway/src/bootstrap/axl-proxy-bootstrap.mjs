/**
 * axl-proxy-bootstrap.mjs — register an upstream AXL Proxy (remote
 * soul-gateway) as a single delegating provider and mirror its /v1/models
 * catalog at startup.
 *
 * Activated only when AXL_PROXY_API_KEY (and AXL_PROXY_BASE_URL) are present
 * (injected by Ploinky from the nearest ancestor .env via the soul-gateway
 * manifest). No-ops cleanly otherwise.
 *
 * Tier precedence: this bootstrap NEVER creates or reassigns the bare
 * fast/plan/deep aliases. seed-default-tiers keeps those on the local
 * default-local-llm; the upstream's own tier entries are mirrored as
 * reachable `axl-proxy/<id>` models via /v1/models, not as local aliases.
 *
 * Provider boundary: discovery uses the openai-api backend's direct
 * GET {base}/models (allowed for discovery). Request-time inference still
 * flows through achillesAgentLib.
 */
import * as providersDaoModule from '../db/dao/providers-dao.mjs';
import { upsertProviderApiKeyAccount } from '../runtime/providers/api-key-account.mjs';
import { autoProvisionModels } from '../runtime/providers/auto-provisioner.mjs';

const PROVIDER_KEY = 'axl-proxy';
const DISPLAY_NAME = 'AXL Proxy';
const ADAPTER_KEY = 'openai-api';
const PROVIDER_KIND = 'external_api';
const AUTH_STRATEGY = 'api_key';
const DISCOVERY_MODE_OFF = 'off';
const REFRESH_REASON = 'axl-proxy-bootstrap';

const DEFAULT_DEPS = Object.freeze({
    providersDao: providersDaoModule,
    upsertProviderApiKeyAccount,
    autoProvisionModels,
});

function normalizeBaseUrl(value) {
    const baseUrl = String(value || '').trim();
    if (!baseUrl) return '';
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeDiscoveryMode(value) {
    const mode = String(value || 'auto').trim().toLowerCase();
    return mode === DISCOVERY_MODE_OFF ? DISCOVERY_MODE_OFF : 'auto';
}

async function ensureProvider({ appCtx, deps, baseUrl }) {
    const { pool, log } = appCtx;
    const existing = await deps.providersDao.findByKey(pool, PROVIDER_KEY);
    if (!existing) {
        const created = await deps.providersDao.create(pool, {
            providerKey: PROVIDER_KEY,
            displayName: DISPLAY_NAME,
            kind: PROVIDER_KIND,
            adapterKey: ADAPTER_KEY,
            authStrategy: AUTH_STRATEGY,
            baseUrl,
            enabled: true,
            supportsStreaming: true,
            supportsTools: true,
            metadata: { remoteGateway: true, bootstrap: PROVIDER_KEY },
        });
        log?.info?.('AXL Proxy provider created', { id: created.id, baseUrl });
        return created;
    }

    const fields = {};
    if (existing.display_name !== DISPLAY_NAME) fields.displayName = DISPLAY_NAME;
    if (existing.kind !== PROVIDER_KIND) fields.kind = PROVIDER_KIND;
    if (existing.adapter_key !== ADAPTER_KEY) fields.adapterKey = ADAPTER_KEY;
    if (existing.auth_strategy !== AUTH_STRATEGY) fields.authStrategy = AUTH_STRATEGY;
    if (existing.base_url !== baseUrl) fields.baseUrl = baseUrl;
    if (existing.enabled !== true) fields.enabled = true;
    if (Object.keys(fields).length === 0) return existing;

    const updated = await deps.providersDao.update(pool, existing.id, fields);
    log?.info?.('AXL Proxy provider reconciled', { id: existing.id, baseUrl });
    return updated || { ...existing, ...fields };
}

/**
 * @param {object} args
 * @param {object} args.appCtx
 * @param {object} [args.deps] injectable { providersDao, upsertProviderApiKeyAccount, autoProvisionModels }
 * @returns {Promise<{ configured: boolean, discovered?: number, provider?: object }>}
 */
export async function bootstrapAxlProxyProvider({ appCtx, deps = DEFAULT_DEPS }) {
    const { config, pool, log } = appCtx;
    const env = config?.env || {};

    if (!pool) return { configured: false };
    if (!env.AXL_PROXY_API_KEY) {
        log?.info?.('AXL_PROXY_API_KEY not set, skipping AXL Proxy bootstrap');
        return { configured: false };
    }

    const baseUrl = normalizeBaseUrl(env.AXL_PROXY_BASE_URL);
    if (!baseUrl) {
        log?.warn?.(
            'AXL_PROXY_API_KEY set but AXL_PROXY_BASE_URL missing; ' +
                'skipping AXL Proxy bootstrap'
        );
        return { configured: false };
    }

    const provider = await ensureProvider({ appCtx, deps, baseUrl });
    await deps.upsertProviderApiKeyAccount({
        appCtx,
        providerId: provider.id,
        providerDisplayName: DISPLAY_NAME,
        apiKey: env.AXL_PROXY_API_KEY,
    });

    if (normalizeDiscoveryMode(env.AXL_PROXY_DISCOVERY_MODE) === DISCOVERY_MODE_OFF) {
        log?.info?.('AXL Proxy model discovery disabled (DISCOVERY_MODE=off)');
        return { configured: true, discovered: 0, provider };
    }

    const result = await deps.autoProvisionModels(appCtx, provider, null, {
        strict: false,
        discoverySource: 'auto_provisioned',
        refreshReason: REFRESH_REASON,
    });
    log?.info?.('AXL Proxy catalog mirrored', {
        provider: PROVIDER_KEY,
        baseUrl,
        discovered: result.discovered,
    });
    return { configured: true, discovered: result.discovered, provider };
}

export default { bootstrapAxlProxyProvider };
