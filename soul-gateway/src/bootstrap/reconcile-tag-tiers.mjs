import * as modelsDao from '../db/dao/models-dao.mjs';
import * as modelChildrenDao from '../db/dao/model-children-dao.mjs';
import { PREDEFINED_MODEL_TAGS } from '../runtime/policy/model-metadata-classifier.mjs';

const DISCOVERY_MARKER = 'ploinky-agent-discovery';
const REFRESH_REASON = 'tag-tier-bootstrap';
const MODEL_PAGE_SIZE = 500;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DAOS = Object.freeze({
    modelsDao,
    modelChildrenDao,
});

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

function readTags(row) {
    const tags = row?.tags;
    if (Array.isArray(tags)) return tags;
    if (typeof tags === 'string') {
        try {
            const parsed = JSON.parse(tags);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function isEnabled(row) {
    return row?.enabled === true || row?.enabled === 1;
}

function isDirectModel(row) {
    return (row?.strategy_kind || row?.strategyKind || 'direct') === 'direct';
}

function isCascadeModel(row) {
    return (row?.strategy_kind || row?.strategyKind) === 'cascade';
}

function modelKeyOf(row) {
    return row?.model_key || row?.modelKey || null;
}

async function listAllModels(pool, dao) {
    const rows = [];
    for (let offset = 0; ; offset += MODEL_PAGE_SIZE) {
        const page = await dao.list(pool, {
            limit: MODEL_PAGE_SIZE,
            offset,
        });
        rows.push(...page);
        if (page.length < MODEL_PAGE_SIZE) return rows;
    }
}

function findDefaultAgentModel(rows, defaultAgent) {
    if (!defaultAgent) return null;
    return rows.find((row) => {
        const metadata = readMetadata(row);
        return (
            isEnabled(row) &&
            isDirectModel(row) &&
            metadata.discoverySource === DISCOVERY_MARKER &&
            metadata.agent === defaultAgent
        );
    }) || null;
}

function makeChildren(models) {
    return models.map((model, index) => ({
        childModelId: model.id,
        priority: index + 1,
        enabled: true,
    }));
}

function makeTierMetadata(tag) {
    return {
        seededBy: REFRESH_REASON,
        tagKey: tag,
        autoTagTier: true,
    };
}

function childIdsMatch(existingChildren, expectedModels) {
    if (existingChildren.length !== expectedModels.length) return false;
    for (let i = 0; i < expectedModels.length; i++) {
        const child = existingChildren[i];
        if (child.child_model_id !== expectedModels[i].id) return false;
        if (child.enabled !== true && child.enabled !== 1) return false;
        if (child.priority !== i + 1) return false;
    }
    return true;
}

function isFallbackOnly(children, defaultModel) {
    return (
        defaultModel &&
        children.length === 1 &&
        children[0].child_model_id === defaultModel.id
    );
}

function childModelIds(children) {
    return new Set(children.map((child) => child.child_model_id));
}

async function loadTagTiers(pool, dao, tagSet) {
    const allModels = await listAllModels(pool, dao);
    const tiers = new Map();
    for (const row of allModels) {
        const key = modelKeyOf(row);
        if (tagSet.has(key) && isCascadeModel(row)) {
            tiers.set(key, row);
        }
    }
    return { allModels, tiers };
}

async function ensureTagTiers({ pool, dao, existingModels, tagSet, summary }) {
    const existingByKey = new Map(
        existingModels.map((row) => [modelKeyOf(row), row])
    );
    const tiers = [];

    for (const tag of tagSet) {
        const existing = existingByKey.get(tag) || null;
        if (existing) {
            if (isCascadeModel(existing)) {
                tiers.push(existing);
            } else {
                summary.skippedConflicts += 1;
            }
            continue;
        }

        const tier = await dao.createCascade(pool, {
            modelKey: tag,
            displayName: tag,
            enabled: true,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            discoverySource: 'manual',
            metadata: makeTierMetadata(tag),
        });
        if (!tier) continue;
        existingByKey.set(tag, tier);
        tiers.push(tier);
        summary.created += 1;
    }

    return tiers;
}

export async function bootstrapInitialTagTiers({
    appCtx,
    daos = DEFAULT_DAOS,
} = {}) {
    const summary = {
        scanned: 0,
        created: 0,
        updated: 0,
        fallbackUsed: 0,
        empty: 0,
        skippedConflicts: 0,
    };
    const pool = appCtx?.pool;
    if (!pool) return summary;

    const allModels = await listAllModels(pool, daos.modelsDao);
    const defaultAgent = String(
        appCtx?.config?.env?.LLM_DEFAULT_AGENT || ''
    ).trim();
    const defaultModel = findDefaultAgentModel(allModels, defaultAgent);
    const tagSet = new Set(PREDEFINED_MODEL_TAGS);
    const tiers = await ensureTagTiers({
        pool,
        dao: daos.modelsDao,
        existingModels: allModels,
        tagSet,
        summary,
    });
    const directEnabledModels = allModels.filter((row) => (
        isEnabled(row) && isDirectModel(row)
    ));

    for (const tier of tiers) {
        const tag = modelKeyOf(tier);
        summary.scanned += 1;

        const taggedModels = directEnabledModels.filter((model) => (
            model.id !== defaultModel?.id && readTags(model).includes(tag)
        ));
        const expectedModels =
            taggedModels.length > 0
                ? taggedModels
                : (defaultModel ? [defaultModel] : []);

        if (taggedModels.length === 0 && defaultModel) {
            summary.fallbackUsed += 1;
        }
        if (expectedModels.length === 0) {
            summary.empty += 1;
        }

        const existingChildren = await daos.modelChildrenDao.listForParent(
            pool,
            tier.id
        );
        if (childIdsMatch(existingChildren, expectedModels)) {
            continue;
        }

        await daos.modelChildrenDao.replaceChildren(
            pool,
            tier.id,
            makeChildren(expectedModels)
        );
        summary.updated += 1;
        appCtx.log?.info?.('initial tag-tier bootstrapped', {
            tier: tag,
            children: expectedModels.map(modelKeyOf),
        });
    }

    return summary;
}

export async function appendNewModelsToTagTiers({
    appCtx,
    models = [],
    daos = DEFAULT_DAOS,
} = {}) {
    const summary = {
        scannedModels: 0,
        updatedTiers: 0,
        appended: 0,
        fallbackRemoved: 0,
    };
    const pool = appCtx?.pool;
    if (!pool || !Array.isArray(models) || models.length === 0) {
        return summary;
    }

    const tagSet = new Set(PREDEFINED_MODEL_TAGS);
    const { allModels, tiers } = await loadTagTiers(pool, daos.modelsDao, tagSet);
    if (tiers.size === 0) return summary;

    const defaultAgent = String(
        appCtx?.config?.env?.LLM_DEFAULT_AGENT || ''
    ).trim();
    const defaultModel = findDefaultAgentModel(allModels, defaultAgent);
    const appendsByTag = new Map();

    for (const model of models) {
        if (!isEnabled(model) || !isDirectModel(model)) continue;
        summary.scannedModels += 1;
        for (const tag of readTags(model)) {
            if (!tagSet.has(tag) || !tiers.has(tag)) continue;
            if (!appendsByTag.has(tag)) appendsByTag.set(tag, []);
            appendsByTag.get(tag).push(model);
        }
    }

    for (const [tag, newModels] of appendsByTag) {
        const tier = tiers.get(tag);
        const existingChildren = await daos.modelChildrenDao.listForParent(
            pool,
            tier.id
        );
        const existingIds = childModelIds(existingChildren);
        const uniqueNewModels = [];
        const pendingIds = new Set();
        for (const model of newModels) {
            if (existingIds.has(model.id) || pendingIds.has(model.id)) {
                continue;
            }
            pendingIds.add(model.id);
            uniqueNewModels.push(model);
        }
        if (uniqueNewModels.length === 0) continue;

        if (isFallbackOnly(existingChildren, defaultModel)) {
            await daos.modelChildrenDao.replaceChildren(
                pool,
                tier.id,
                makeChildren(uniqueNewModels)
            );
            summary.fallbackRemoved += 1;
        } else {
            const maxPriority = existingChildren.reduce(
                (max, child) => Math.max(max, Number(child.priority) || 0),
                0
            );
            for (let index = 0; index < uniqueNewModels.length; index++) {
                await daos.modelChildrenDao.create(pool, {
                    parentModelId: tier.id,
                    childModelId: uniqueNewModels[index].id,
                    priority: maxPriority + index + 1,
                    enabled: true,
                });
            }
        }

        summary.updatedTiers += 1;
        summary.appended += uniqueNewModels.length;
        appCtx.log?.info?.('tag-tier appended new models', {
            tier: tag,
            children: uniqueNewModels.map(modelKeyOf),
        });
    }

    return summary;
}

export default {
    bootstrapInitialTagTiers,
    appendNewModelsToTagTiers,
};
