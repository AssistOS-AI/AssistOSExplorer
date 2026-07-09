import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    appendNewModelsToTagTiers,
    bootstrapInitialTagTiers,
} from '../../bootstrap/reconcile-tag-tiers.mjs';
import { PREDEFINED_MODEL_TAGS } from '../../runtime/policy/model-metadata-classifier.mjs';

const DEFAULT_MODEL = {
    id: 'local-default',
    model_key: 'proxies/default-local-llm',
    display_name: 'Default Local LLM',
    enabled: true,
    strategy_kind: 'direct',
    tags: [],
    metadata: {
        discoverySource: 'ploinky-agent-discovery',
        agent: 'default-local-llm',
    },
};

function tier(key) {
    return {
        id: `tier-${key}`,
        model_key: key,
        display_name: key,
        enabled: true,
        strategy_kind: 'cascade',
        tags: [],
        metadata: {},
    };
}

function directModel({ id, key, providerId, tags, enabled = true }) {
    return {
        id,
        model_key: key,
        modelKey: key,
        display_name: key,
        displayName: key,
        provider_id: providerId,
        providerId,
        enabled,
        strategy_kind: 'direct',
        strategyKind: 'direct',
        tags,
        metadata: {},
    };
}

function makeDaos(models, existingChildren = {}) {
    const replacements = [];
    const createdBindings = [];
    const createdCascade = [];
    const childrenByParent = new Map(Object.entries(existingChildren));
    const modelRows = models.map((model) => ({ ...model }));

    return {
        replacements,
        createdBindings,
        createdCascade,
        modelsDao: {
            async list(_pool, options = {}) {
                if ((options.offset || 0) > 0) return [];
                return modelRows.map((model) => ({ ...model }));
            },
            async createCascade(_pool, fields) {
                const row = {
                    id: `tier-${fields.modelKey}`,
                    model_key: fields.modelKey,
                    display_name: fields.displayName,
                    enabled: fields.enabled ?? true,
                    strategy_kind: 'cascade',
                    max_attempts: fields.maxAttempts ?? 5,
                    discovery_source: fields.discoverySource ?? 'manual',
                    tags: [],
                    metadata: fields.metadata ?? {},
                };
                createdCascade.push({ ...fields, row });
                modelRows.push(row);
                return { ...row };
            },
        },
        modelChildrenDao: {
            async listForParent(_pool, parentModelId) {
                return (childrenByParent.get(parentModelId) || [])
                    .map((child) => ({ ...child }));
            },
            async replaceChildren(_pool, parentModelId, children) {
                replacements.push({
                    parentModelId,
                    children: children.map((child) => ({ ...child })),
                });
                childrenByParent.set(parentModelId, children.map((child) => ({
                    id: `binding-${child.childModelId}`,
                    parent_model_id: parentModelId,
                    child_model_id: child.childModelId,
                    priority: child.priority,
                    enabled: child.enabled ?? true,
                })));
            },
            async create(_pool, child) {
                createdBindings.push({ ...child });
                if (!childrenByParent.has(child.parentModelId)) {
                    childrenByParent.set(child.parentModelId, []);
                }
                childrenByParent.get(child.parentModelId).push({
                    id: `binding-${child.childModelId}`,
                    parent_model_id: child.parentModelId,
                    child_model_id: child.childModelId,
                    priority: child.priority,
                    enabled: child.enabled ?? true,
                });
                return { id: `binding-${child.childModelId}`, ...child };
            },
        },
    };
}

function makeAppCtx() {
    return {
        pool: {},
        config: {
            env: {
                LLM_DEFAULT_AGENT: 'default-local-llm',
            },
        },
        log: {
            info() {},
        },
    };
}

describe('bootstrapInitialTagTiers', () => {
    it('creates missing tag tiers and uses default-local-llm as fallback', async () => {
        const daos = makeDaos([DEFAULT_MODEL, tier('fast')]);

        const summary = await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        assert.equal(summary.created, PREDEFINED_MODEL_TAGS.length - 1);
        assert.equal(summary.scanned, PREDEFINED_MODEL_TAGS.length);
        assert.equal(summary.updated, PREDEFINED_MODEL_TAGS.length);
        assert.equal(summary.fallbackUsed, PREDEFINED_MODEL_TAGS.length);
        const fastReplacement = daos.replacements.find(
            (replacement) => replacement.parentModelId === 'tier-fast'
        );
        assert.deepEqual(fastReplacement, {
            parentModelId: 'tier-fast',
            children: [
                {
                    childModelId: 'local-default',
                    priority: 1,
                    enabled: true,
                },
            ],
        });
    });

    it('populates a tag tier with matching models instead of fallback', async () => {
        const fastModel = directModel({
            id: 'openai-fast',
            key: 'openai/gpt-4o-mini',
            providerId: 'provider-openai',
            tags: ['fast', 'chat'],
        });
        const daos = makeDaos([DEFAULT_MODEL, fastModel, tier('fast')]);

        await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        const fastReplacement = daos.replacements.find(
            (replacement) => replacement.parentModelId === 'tier-fast'
        );
        assert.deepEqual(
            fastReplacement.children.map((child) => child.childModelId),
            ['openai-fast']
        );
    });

    it('populates the embeddings tier from embeddings-tagged models', async () => {
        const embeddingModel = directModel({
            id: 'embed-model',
            key: 'provider/text-embed',
            providerId: 'provider-embed',
            tags: ['embeddings'],
        });
        const daos = makeDaos([DEFAULT_MODEL, embeddingModel, tier('embeddings')]);

        await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        const embeddingReplacement = daos.replacements.find(
            (replacement) => replacement.parentModelId === 'tier-embeddings'
        );
        assert.deepEqual(
            embeddingReplacement.children.map((child) => child.childModelId),
            ['embed-model']
        );
    });

    it('does not overwrite a direct model whose key matches a tag', async () => {
        const directFast = directModel({
            id: 'direct-fast-key',
            key: 'fast',
            providerId: 'provider-1',
            tags: ['fast'],
        });
        const daos = makeDaos([DEFAULT_MODEL, directFast]);

        const summary = await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        assert.equal(summary.skippedConflicts, 1);
        assert.equal(
            daos.createdCascade.some((created) => created.modelKey === 'fast'),
            false
        );
    });
});

describe('appendNewModelsToTagTiers', () => {
    it('appends newly-created provider models to matching existing tiers at the tail', async () => {
        const codingModel = directModel({
            id: 'new-coding',
            key: 'provider/new-coder',
            providerId: 'provider-new',
            tags: ['coding'],
        });
        const daos = makeDaos(
            [DEFAULT_MODEL, codingModel, tier('coding')],
            {
                'tier-coding': [
                    {
                        child_model_id: 'old-coding',
                        priority: 1,
                        enabled: true,
                    },
                ],
            }
        );

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [codingModel],
        });

        assert.equal(summary.appended, 1);
        assert.deepEqual(daos.createdBindings, [
            {
                parentModelId: 'tier-coding',
                childModelId: 'new-coding',
                priority: 2,
                enabled: true,
            },
        ]);
    });

    it('adds one multi-tag model to each matching tier without creating missing tiers', async () => {
        const model = directModel({
            id: 'new-multi',
            key: 'provider/new-multi',
            providerId: 'provider-new',
            tags: ['coding', 'reasoning', 'vision'],
        });
        const daos = makeDaos([
            DEFAULT_MODEL,
            model,
            tier('coding'),
            tier('reasoning'),
        ]);

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [model],
        });

        assert.equal(summary.appended, 2);
        assert.deepEqual(
            daos.createdBindings.map((binding) => binding.parentModelId).sort(),
            ['tier-coding', 'tier-reasoning']
        );
    });

    it('removes fallback when appending the first real matching model', async () => {
        const model = directModel({
            id: 'new-fast',
            key: 'provider/new-fast',
            providerId: 'provider-new',
            tags: ['fast'],
        });
        const daos = makeDaos(
            [DEFAULT_MODEL, model, tier('fast')],
            {
                'tier-fast': [
                    {
                        child_model_id: 'local-default',
                        priority: 1,
                        enabled: true,
                    },
                ],
            }
        );

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [model],
        });

        assert.equal(summary.fallbackRemoved, 1);
        assert.deepEqual(daos.replacements, [
            {
                parentModelId: 'tier-fast',
                children: [
                    {
                        childModelId: 'new-fast',
                        priority: 1,
                        enabled: true,
                    },
                ],
            },
        ]);
    });

    it('does not re-add an existing or manually removed old model on restart-like calls', async () => {
        const oldModel = directModel({
            id: 'old-coding',
            key: 'provider/old-coder',
            providerId: 'provider-old',
            tags: ['coding'],
        });
        const daos = makeDaos([DEFAULT_MODEL, oldModel, tier('coding')]);

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [],
        });

        assert.equal(summary.appended, 0);
        assert.deepEqual(daos.createdBindings, []);
    });

    it('appends embeddings-tagged models to the embeddings tier', async () => {
        const model = directModel({
            id: 'new-embed',
            key: 'provider/new-embed',
            providerId: 'provider-new',
            tags: ['embeddings'],
        });
        const daos = makeDaos([DEFAULT_MODEL, model, tier('embeddings')]);

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [model],
        });

        assert.equal(summary.appended, 1);
        assert.deepEqual(daos.createdBindings, [
            {
                parentModelId: 'tier-embeddings',
                childModelId: 'new-embed',
                priority: 1,
                enabled: true,
            },
        ]);
    });
});
