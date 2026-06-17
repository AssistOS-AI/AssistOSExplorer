import * as modelsDao from '../db/dao/models-dao.mjs';
import * as aliasesDao from '../db/dao/model-aliases-dao.mjs';
import { performRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';

const DISCOVERY_MARKER = 'ploinky-agent-discovery';
const REFRESH_REASON = 'seed-default-tiers';
const MODEL_PAGE_SIZE = 500;
const DEFAULT_DAOS = Object.freeze({ modelsDao, aliasesDao });

function parseTiers(value) {
    return String(value || '')
        .split(',')
        .map((tier) => tier.trim())
        .filter(Boolean);
}

function readMetadata(row) {
    const metadata = row?.metadata;
    if (!metadata) return {};
    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata);
            return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
                ? parsed
                : {};
        } catch {
            return {};
        }
    }
    return metadata && !Array.isArray(metadata) && typeof metadata === 'object'
        ? metadata
        : {};
}

function isEnabled(model) {
    return model?.enabled === true || model?.enabled === 1;
}

function isDiscoveredDefaultAgentModel(model, defaultAgent) {
    const metadata = readMetadata(model);
    return (
        isEnabled(model) &&
        metadata.discoverySource === DISCOVERY_MARKER &&
        metadata.agent === defaultAgent
    );
}

async function findDefaultAgentModel(pool, dao, defaultAgent) {
    for (let offset = 0; ; offset += MODEL_PAGE_SIZE) {
        const models = await dao.list(pool, {
            enabled: true,
            limit: MODEL_PAGE_SIZE,
            offset,
        });
        const found = models.find((model) => (
            isDiscoveredDefaultAgentModel(model, defaultAgent)
        ));
        if (found) return found;
        if (models.length < MODEL_PAGE_SIZE) return null;
    }
}

export async function seedDefaultTiers({
    appCtx,
    daos = DEFAULT_DAOS,
    refresh = performRuntimeRefresh,
}) {
    const summary = { seeded: 0, skipped: 0, refreshed: false };
    const pool = appCtx?.pool;
    if (!pool) return summary;

    const env = appCtx?.config?.env || {};
    const defaultAgent = String(env.LLM_DEFAULT_AGENT || '').trim();
    if (!defaultAgent) return summary;

    const tiers = parseTiers(env.LLM_DEFAULT_TIERS);
    if (tiers.length === 0) return summary;

    const model = await findDefaultAgentModel(
        pool,
        daos.modelsDao,
        defaultAgent
    );
    if (!model) {
        appCtx.log?.info?.('seed-default-tiers: default agent not discovered yet', {
            agent: defaultAgent,
        });
        return summary;
    }

    for (const alias of tiers) {
        const existing = await daos.aliasesDao.findByAlias(pool, alias);
        if (existing) {
            summary.skipped += 1;
            continue;
        }

        await daos.aliasesDao.create(pool, {
            alias,
            modelId: model.id,
        });
        summary.seeded += 1;
        appCtx.log?.info?.('seed-default-tiers: seeded tier', {
            alias,
            model: model.model_key,
        });
    }

    if (summary.seeded > 0) {
        await refresh(appCtx, { snapshot: true, reason: REFRESH_REASON });
        summary.refreshed = true;
    }

    return summary;
}

export default { seedDefaultTiers };
