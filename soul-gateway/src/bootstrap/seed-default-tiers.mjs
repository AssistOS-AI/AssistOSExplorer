import * as modelsDao from '../db/dao/models-dao.mjs';
import * as aliasesDao from '../db/dao/model-aliases-dao.mjs';
import * as modelChildrenDao from '../db/dao/model-children-dao.mjs';
import { performRuntimeRefresh } from '../runtime/registry/runtime-refresh.mjs';

const DISCOVERY_MARKER = 'ploinky-agent-discovery';
const REFRESH_REASON = 'seed-default-tiers';
const MODEL_PAGE_SIZE = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DAOS = Object.freeze({
    modelsDao,
    aliasesDao,
    modelChildrenDao,
});

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

function modelKeyOf(row) {
    return row?.model_key || row?.modelKey || null;
}

function makeAliasTargetModel(aliasRow) {
    if (!aliasRow) return null;
    return {
        id: aliasRow.model_id,
        model_key: aliasRow.model_key,
    };
}

function makeTierMetadata({ alias, defaultAgent, childModel }) {
    return {
        seededBy: REFRESH_REASON,
        defaultAgent,
        childModelKey: modelKeyOf(childModel),
        tierKey: alias,
    };
}

function isSeederOwnedTier(tier, alias) {
    const metadata = readMetadata(tier);
    return (
        metadata.seededBy === REFRESH_REASON &&
        metadata.tierKey === alias
    );
}

function childRefOf(row) {
    return row?.child_model_id || row?.childModelId || null;
}

function isEnabledChild(row) {
    return row?.enabled === true || row?.enabled === 1;
}

function isExpectedSingleChild(children, childModel) {
    if (children.length !== 1) return false;
    const [child] = children;
    return (
        childRefOf(child) === childModel.id &&
        child.priority === 1 &&
        isEnabledChild(child)
    );
}

async function resolveExpectedChildModel({
    pool,
    daos,
    existingAlias,
    existingTier,
    defaultModel,
}) {
    const aliasTarget = makeAliasTargetModel(existingAlias);
    if (aliasTarget) return aliasTarget;

    const childModelKey = readMetadata(existingTier).childModelKey;
    if (typeof childModelKey === 'string' && childModelKey.trim() !== '') {
        const metadataChild = await daos.modelsDao.findByKey(pool, childModelKey);
        if (metadataChild) return metadataChild;
    }

    return defaultModel;
}

async function deleteAliasIfPresent(pool, aliasesDaoImpl, aliasRow, summary) {
    if (!aliasRow) return;
    const deleted = await aliasesDaoImpl.deleteByAlias(pool, aliasRow.alias);
    if (deleted) summary.aliasesDeleted += 1;
}

async function createCascadeTier({
    pool,
    daos,
    alias,
    defaultAgent,
    childModel,
}) {
    const tier = await daos.modelsDao.createCascade(pool, {
        modelKey: alias,
        displayName: alias,
        enabled: true,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        discoverySource: 'manual',
        metadata: makeTierMetadata({ alias, defaultAgent, childModel }),
    });

    await daos.modelChildrenDao.replaceChildren(pool, tier.id, [{
        childModelId: childModel.id,
        priority: 1,
        enabled: true,
    }]);

    return tier;
}

async function ensureCascadeTierChildren({ pool, daos, tier, childModel }) {
    const children = await daos.modelChildrenDao.listForParent(pool, tier.id);
    if (isExpectedSingleChild(children, childModel)) return false;

    await daos.modelChildrenDao.replaceChildren(pool, tier.id, [{
        childModelId: childModel.id,
        priority: 1,
        enabled: true,
    }]);
    return true;
}

export async function seedDefaultTiers({
    appCtx,
    daos = DEFAULT_DAOS,
    refresh = performRuntimeRefresh,
}) {
    const summary = {
        seeded: 0,
        promoted: 0,
        skipped: 0,
        aliasesDeleted: 0,
        refreshed: false,
    };
    const pool = appCtx?.pool;
    if (!pool) return summary;

    const env = appCtx?.config?.env || {};
    const defaultAgent = String(env.LLM_DEFAULT_AGENT || '').trim();
    if (!defaultAgent) return summary;

    const tiers = parseTiers(env.LLM_DEFAULT_TIERS);
    if (tiers.length === 0) return summary;

    const defaultModel = await findDefaultAgentModel(
        pool,
        daos.modelsDao,
        defaultAgent
    );
    if (!defaultModel) {
        appCtx.log?.info?.('seed-default-tiers: default agent not discovered yet', {
            agent: defaultAgent,
        });
        return summary;
    }

    let repaired = false;
    for (const alias of tiers) {
        const existingTier = await daos.modelsDao.findByKey(pool, alias);
        const existingAlias = await daos.aliasesDao.findByAlias(pool, alias);

        if (existingTier) {
            summary.skipped += 1;

            if (existingTier.strategy_kind === 'cascade') {
                if (isSeederOwnedTier(existingTier, alias)) {
                    const childModel = await resolveExpectedChildModel({
                        pool,
                        daos,
                        existingAlias,
                        existingTier,
                        defaultModel,
                    });
                    const mutated = await ensureCascadeTierChildren({
                        pool,
                        daos,
                        tier: existingTier,
                        childModel,
                    });
                    if (mutated) repaired = true;
                }

                await deleteAliasIfPresent(
                    pool,
                    daos.aliasesDao,
                    existingAlias,
                    summary
                );
                continue;
            }

            appCtx.log?.warn?.(
                'seed-default-tiers: model key already exists and is not a cascade tier',
                { alias, strategyKind: existingTier.strategy_kind || 'direct' }
            );
            continue;
        }

        const aliasTarget = makeAliasTargetModel(existingAlias);
        const childModel = aliasTarget || defaultModel;

        await createCascadeTier({
            pool,
            daos,
            alias,
            defaultAgent,
            childModel,
        });

        if (existingAlias) {
            await deleteAliasIfPresent(
                pool,
                daos.aliasesDao,
                existingAlias,
                summary
            );
            summary.promoted += 1;
            appCtx.log?.info?.('seed-default-tiers: promoted alias to cascade tier', {
                alias,
                model: modelKeyOf(childModel),
            });
        } else {
            summary.seeded += 1;
            appCtx.log?.info?.('seed-default-tiers: created cascade tier', {
                alias,
                model: modelKeyOf(childModel),
            });
        }
    }

    if (
        summary.seeded > 0 ||
        summary.promoted > 0 ||
        summary.aliasesDeleted > 0 ||
        repaired
    ) {
        await refresh(appCtx, { snapshot: true, reason: REFRESH_REASON });
        summary.refreshed = true;
    }

    return summary;
}

export default { seedDefaultTiers };
