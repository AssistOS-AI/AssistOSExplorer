import { PUBLIC_TIER_KEYS } from '../../bootstrap/free-model-catalog.mjs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    appendNewModelsToTagTiers,
    bootstrapInitialTagTiers,
} from '../../bootstrap/reconcile-tag-tiers.mjs';
import { PREDEFINED_MODEL_TAGS } from '../../runtime/policy/model-metadata-classifier.mjs';

const DEFAULT_MODEL = {
    id: 'local-default',
    model_key: 'provider/untagged-model',
    display_name: 'Untagged model',
    enabled: true,
    strategy_kind: 'direct',
    tags: [],
    metadata: {},
};

function tier(key) {
    return {
        id: `tier-${key}`,
        model_key: key,
        display_name: key,
        enabled: true,
        strategy_kind: 'cascade',
        tags: [],
        metadata: {
            seededBy: 'tag-tier-bootstrap',
            tagKey: key,
            autoTagTier: true,
        },
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
    const removedBindings = [];
    const childrenByParent = new Map(Object.entries(existingChildren));
    const modelRows = models.map((model) => ({ ...model }));

    return {
        replacements,
        createdBindings,
        createdCascade,
        removedBindings,
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
            async removeChild(_pool, parentModelId, childModelId) {
                removedBindings.push({ parentModelId, childModelId });
                const children = childrenByParent.get(parentModelId) || [];
                const next = children.filter(
                    (child) => child.child_model_id !== childModelId
                );
                childrenByParent.set(parentModelId, next);
                return next.length !== children.length;
            },
        },
    };
}

function makeAppCtx() {
    return {
        pool: {},
        config: {
            env: {},
        },
        log: {
            info() {},
        },
    };
}

describe('bootstrapInitialTagTiers', () => {
    it('creates missing tag tiers and leaves tiers without tagged models empty', async () => {
        const daos = makeDaos([DEFAULT_MODEL, tier('chat')]);

        const summary = await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        const autoTags = PREDEFINED_MODEL_TAGS.filter((tag) => !PUBLIC_TIER_KEYS.includes(tag));
        assert.equal(summary.created, autoTags.length - 1);
        assert.equal(summary.scanned, autoTags.length);
        assert.equal(summary.updated, 0);
        assert.equal(summary.empty, autoTags.length);
        assert.deepEqual(daos.replacements, [], 'an untagged model is never used as a generic fallback');
    });

    it('leaves a compatibility or operator cascade that shares a tag name untouched', async () => {
        const fastModel = directModel({
            id: 'openai-chat',
            key: 'openai/gpt-4o-mini',
            providerId: 'provider-openai',
            tags: ['chat'],
        });
        const compatibilityFast = {
            ...tier('chat'),
            metadata: { seededBy: 'free-model-defaults', tierKey: 'chat' },
        };
        const daos = makeDaos([fastModel, compatibilityFast]);

        const summary = await bootstrapInitialTagTiers({ appCtx: makeAppCtx(), daos });
        assert.equal(summary.skippedOwned, 1);
        assert.equal(
            daos.replacements.some((replacement) => replacement.parentModelId === 'tier-chat'),
            false
        );

        const appended = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [fastModel],
        });
        assert.equal(appended.appended, 0);
    });

    it('populates a tag tier with matching models instead of fallback', async () => {
        const fastModel = directModel({
            id: 'openai-chat',
            key: 'openai/gpt-4o-mini',
            providerId: 'provider-openai',
            tags: ['chat'],
        });
        const daos = makeDaos([DEFAULT_MODEL, fastModel, tier('chat')]);

        await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        const fastReplacement = daos.replacements.find(
            (replacement) => replacement.parentModelId === 'tier-chat'
        );
        assert.deepEqual(
            fastReplacement.children.map((child) => child.childModelId),
            ['openai-chat']
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
            id: 'direct-chat-key',
            key: 'chat',
            providerId: 'provider-1',
            tags: ['chat'],
        });
        const daos = makeDaos([DEFAULT_MODEL, directFast]);

        const summary = await bootstrapInitialTagTiers({
            appCtx: makeAppCtx(),
            daos,
        });

        assert.equal(summary.skippedConflicts, 1);
        assert.equal(
            daos.createdCascade.some((created) => created.modelKey === 'chat'),
            false
        );
    });
});

describe('appendNewModelsToTagTiers', () => {
    it('never creates an auto tag tier under a public compatibility tier name', async () => {
        const fastTagged = directModel({
            id: 'tagged-fast',
            key: 'provider/tagged-fast',
            providerId: 'provider-1',
            tags: ['fast'],
        });
        const daos = makeDaos([fastTagged]);
        await bootstrapInitialTagTiers({ appCtx: makeAppCtx(), daos });
        assert.ok(PREDEFINED_MODEL_TAGS.includes('fast'));
        for (const key of PUBLIC_TIER_KEYS) {
            assert.equal(daos.createdCascade.some((created) => created.modelKey === key), false, key);
        }
        const appended = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [fastTagged],
            createMissingTiers: true,
        });
        assert.equal(appended.createdTiers, 0);
    });

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

    it('moves a retagged agent model between auto-generated tag tiers', async () => {
        const previous = directModel({
            id: 'opencode-model',
            key: 'AchillesCLI/opencodeAgent/openai/gpt-5',
            providerId: 'agent-provider',
            tags: ['coding', 'agentic'],
        });
        const current = {
            ...previous,
            tags: ['coding-agent'],
        };
        const daos = makeDaos(
            [
                DEFAULT_MODEL,
                current,
                tier('coding'),
                tier('agentic'),
            ],
            {
                'tier-coding': [{
                    child_model_id: current.id,
                    priority: 1,
                    enabled: true,
                }],
                'tier-agentic': [{
                    child_model_id: current.id,
                    priority: 1,
                    enabled: true,
                }],
            }
        );

        const summary = await appendNewModelsToTagTiers({
            appCtx: makeAppCtx(),
            daos,
            models: [current],
            previousModels: [previous],
            createMissingTiers: true,
        });

        assert.equal(summary.createdTiers, 1);
        assert.equal(summary.removed, 2);
        assert.equal(summary.appended, 1);
        assert.deepEqual(daos.removedBindings, [
            { parentModelId: 'tier-coding', childModelId: current.id },
            { parentModelId: 'tier-agentic', childModelId: current.id },
        ]);
        assert.equal(
            daos.createdCascade[0].modelKey,
            'coding-agent'
        );
        assert.equal(
            daos.createdBindings.at(-1).parentModelId,
            'tier-coding-agent'
        );
    });
});
