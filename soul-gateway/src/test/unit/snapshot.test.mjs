import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../../runtime/registry/model-registry.mjs';
import { loadRuntimeSnapshot } from '../../runtime/registry/snapshot-loader.mjs';

/**
 * Build a mock snapshot for testing the registry lookup functions.
 */
function createMockSnapshot() {
    const models = new Map();
    models.set(
        'openai/gpt-4o',
        Object.freeze({
            id: 'model-1',
            modelKey: 'openai/gpt-4o',
            displayName: 'GPT-4o',
            providerId: 'prov-openai',
            providerKey: 'openai',
            providerModelId: 'gpt-4o',
            executionKind: 'provider_model',
            enabled: true,
            concurrencyLimit: 3,
            queueTimeoutMs: 60000,
            requestTimeoutMs: 120000,
            pricingMode: 'token',
            inputPricePerMillion: 2.5,
            outputPricePerMillion: 10,
            requestPriceUsd: null,
            isFree: false,
            tags: ['openai', 'fast'],
        })
    );
    models.set(
        'copilot/gpt-4o',
        Object.freeze({
            id: 'model-2',
            modelKey: 'copilot/gpt-4o',
            displayName: 'Copilot GPT-4o',
            providerId: 'prov-copilot',
            providerKey: 'copilot',
            providerModelId: 'gpt-4o',
            executionKind: 'provider_model',
            enabled: true,
            concurrencyLimit: 3,
            queueTimeoutMs: 60000,
            requestTimeoutMs: 120000,
            pricingMode: 'request',
            inputPricePerMillion: null,
            outputPricePerMillion: null,
            requestPriceUsd: 0,
            isFree: true,
            tags: ['copilot', 'free'],
        })
    );
    models.set(
        'anthropic/claude-sonnet-4',
        Object.freeze({
            id: 'model-3',
            modelKey: 'anthropic/claude-sonnet-4',
            displayName: 'Claude Sonnet 4',
            providerId: 'prov-anthropic',
            providerKey: 'anthropic',
            providerModelId: 'claude-sonnet-4-20250514',
            executionKind: 'provider_model',
            enabled: true,
            concurrencyLimit: 3,
            queueTimeoutMs: 60000,
            requestTimeoutMs: 120000,
            pricingMode: 'token',
            inputPricePerMillion: 3,
            outputPricePerMillion: 15,
            requestPriceUsd: null,
            isFree: false,
            tags: ['anthropic', 'deep'],
        })
    );

    const aliases = new Map();
    aliases.set('gpt4o', 'openai/gpt-4o');
    aliases.set('sonnet4', 'anthropic/claude-sonnet-4');
    aliases.set('fast-copilot', 'copilot/gpt-4o');

    const tiers = new Map();
    tiers.set(
        'axl/fast',
        Object.freeze({
            id: 'tier-fast',
            tierKey: 'axl/fast',
            displayName: 'Fast Tier',
            description: null,
            fallbackTierId: null,
            maxModelAttempts: 5,
            enabled: true,
            models: Object.freeze([
                Object.freeze({
                    modelKey: 'copilot/gpt-4o',
                    modelId: 'model-2',
                    priority: 1,
                    modelEnabled: true,
                    settings: {},
                }),
                Object.freeze({
                    modelKey: 'openai/gpt-4o',
                    modelId: 'model-1',
                    priority: 2,
                    modelEnabled: true,
                    settings: {},
                }),
            ]),
        })
    );
    tiers.set(
        'axl/deep',
        Object.freeze({
            id: 'tier-deep',
            tierKey: 'axl/deep',
            displayName: 'Deep Tier',
            description: null,
            fallbackTierId: 'tier-fast', // falls back to axl/fast
            maxModelAttempts: 5,
            enabled: true,
            models: Object.freeze([
                Object.freeze({
                    modelKey: 'anthropic/claude-sonnet-4',
                    modelId: 'model-3',
                    priority: 1,
                    modelEnabled: true,
                    settings: {},
                }),
                Object.freeze({
                    modelKey: 'openai/gpt-4o',
                    modelId: 'model-1',
                    priority: 2,
                    modelEnabled: true,
                    settings: {},
                }),
            ]),
        })
    );
    tiers.set(
        'axl/solo',
        Object.freeze({
            id: 'tier-solo',
            tierKey: 'axl/solo',
            displayName: 'Solo Tier',
            description: 'Only one model, no fallback',
            fallbackTierId: null,
            maxModelAttempts: 1,
            enabled: true,
            models: Object.freeze([
                Object.freeze({
                    modelKey: 'anthropic/claude-sonnet-4',
                    modelId: 'model-3',
                    priority: 1,
                    modelEnabled: true,
                    settings: {},
                }),
            ]),
        })
    );

    const cooldowns = new Set();

    const providers = new Map();
    providers.set(
        'openai',
        Object.freeze({ id: 'prov-openai', providerKey: 'openai' })
    );
    providers.set(
        'copilot',
        Object.freeze({ id: 'prov-copilot', providerKey: 'copilot' })
    );
    providers.set(
        'anthropic',
        Object.freeze({ id: 'prov-anthropic', providerKey: 'anthropic' })
    );

    return Object.freeze({
        generation: 1,
        models,
        aliases,
        tiers,
        providers,
        middlewareAssignments: Object.freeze({
            byTier: new Map(),
            byModel: new Map(),
        }),
        cooldowns,
        pricing: new Map(),
        loadedAt: Date.now(),
    });
}

// ── resolveModel tests ──────────────────────────────────────────────

describe('resolveModel', () => {
    const snapshot = createMockSnapshot();

    it('resolves a direct model key', () => {
        const result = resolveModel(snapshot, 'openai/gpt-4o');
        assert.ok(result);
        assert.equal(result.model.modelKey, 'openai/gpt-4o');
        assert.equal(result.resolvedVia, 'direct');
    });

    it('resolves via alias', () => {
        const result = resolveModel(snapshot, 'gpt4o');
        assert.ok(result);
        assert.equal(result.model.modelKey, 'openai/gpt-4o');
        assert.equal(result.resolvedVia, 'alias');
    });

    it('resolves another alias', () => {
        const result = resolveModel(snapshot, 'sonnet4');
        assert.ok(result);
        assert.equal(result.model.modelKey, 'anthropic/claude-sonnet-4');
        assert.equal(result.resolvedVia, 'alias');
    });

    it('returns null for unknown model', () => {
        const result = resolveModel(snapshot, 'does-not-exist');
        assert.equal(result, null);
    });

    it('prefers direct match over alias', () => {
        const result = resolveModel(snapshot, 'copilot/gpt-4o');
        assert.ok(result);
        assert.equal(result.resolvedVia, 'direct');
    });
});

// ── snapshot loader: unified model + bindings schema ─────────────────
//
// After Workstream F2+F3, cascade models live in the `models` table
// with `strategy_kind='cascade'`, their child lists live in
// `model_children`, and every middleware binding lives in the unified
// `middleware_bindings` table.  There is no in-memory synthesizer any
// more — the loader reads the new shape directly.
//
// These tests drive `loadRuntimeSnapshot` through a fake pg pool that
// returns hand-crafted rows.

function makeFakePool({
    models = [],
    aliases = [],
    modelChildren = [],
    providers = [],
    middlewareBindings = [],
    cooldowns = [],
}) {
    return {
        async query(sql) {
            const text = sql.toLowerCase();
            if (text.includes('from soul_gateway.models m'))
                return { rows: models };
            if (text.includes('from soul_gateway.model_aliases'))
                return { rows: aliases };
            if (text.includes('from soul_gateway.model_children'))
                return { rows: modelChildren };
            if (text.includes('from soul_gateway.providers'))
                return { rows: providers };
            if (text.includes('from soul_gateway.middleware_bindings'))
                return { rows: middlewareBindings };
            if (text.includes('from soul_gateway.model_cooldowns'))
                return { rows: cooldowns };
            return { rows: [] };
        },
    };
}

function directModelRow(overrides) {
    return {
        id: overrides.id || 'm-default',
        model_key: overrides.model_key,
        display_name: overrides.display_name || overrides.model_key,
        provider_id: overrides.provider_id || 'p-default',
        provider_key: overrides.provider_key || 'openai',
        provider_model_id: overrides.provider_model_id || overrides.model_key,
        execution_kind: 'provider_model',
        strategy_kind: 'direct',
        max_attempts: null,
        enabled: overrides.enabled ?? true,
        concurrency_limit: 3,
        queue_timeout_ms: 60000,
        request_timeout_ms: 120000,
        pricing_mode: 'token',
        input_price_per_million: '1.0',
        output_price_per_million: '2.0',
        request_price_usd: null,
        rate_limit_override: {},
        budget_override: {},
        loop_override: {},
        response_filter_override: {},
        retry_policy: {},
        capabilities: {},
        tags: [],
        is_free: false,
        discovery_source: 'manual',
        metadata: {},
        ...overrides,
    };
}

function cascadeModelRow(overrides) {
    return {
        id: overrides.id,
        model_key: overrides.model_key,
        display_name: overrides.display_name || overrides.model_key,
        provider_id: null,
        provider_key: null,
        provider_model_id: null,
        execution_kind: null,
        strategy_kind: 'cascade',
        max_attempts: overrides.max_attempts ?? 5,
        enabled: overrides.enabled ?? true,
        concurrency_limit: null,
        queue_timeout_ms: null,
        request_timeout_ms: null,
        pricing_mode: null,
        input_price_per_million: null,
        output_price_per_million: null,
        request_price_usd: null,
        rate_limit_override: {},
        budget_override: {},
        loop_override: {},
        response_filter_override: {},
        retry_policy: {},
        capabilities: {},
        tags: [],
        is_free: false,
        discovery_source: 'manual',
        metadata: overrides.metadata || {},
    };
}

function modelChildRow(overrides) {
    return {
        parent_model_id: overrides.parent_model_id,
        child_model_id: overrides.child_model_id,
        child_model_key: overrides.child_model_key,
        priority: overrides.priority,
        child_enabled: overrides.enabled ?? true,
        settings: overrides.settings || {},
        child_model_enabled: overrides.child_model_enabled ?? true,
    };
}

function providerRow(overrides) {
    return {
        id: overrides.id,
        provider_key: overrides.provider_key,
        display_name: overrides.display_name || overrides.provider_key,
        kind: 'external_api',
        adapter_key: 'openai-api',
        auth_strategy: 'api_key',
        provider_mode: 'external_api',
        oauth_adapter_key: null,
        base_url: 'https://example.com',
        enabled: true,
        supports_streaming: true,
        supports_tools: true,
        supports_messages_api: false,
        supports_responses_api: false,
        settings: {},
        metadata: {},
    };
}

describe('snapshot loader: unified model + children schema', () => {
    it('reads direct models with strategy_kind="direct" and null children', async () => {
        const pool = makeFakePool({
            models: [
                directModelRow({
                    id: 'm1',
                    model_key: 'openai/gpt-4o',
                    provider_id: 'p-1',
                }),
            ],
            providers: [providerRow({ id: 'p-1', provider_key: 'openai' })],
        });
        const snapshot = await loadRuntimeSnapshot({ pool });
        const direct = snapshot.models.get('openai/gpt-4o');
        assert.equal(direct.strategyKind, 'direct');
        assert.equal(direct.children, null);
        assert.equal(direct.providerKey, 'openai');
    });

    it('reads cascade models with their children list from model_children', async () => {
        const pool = makeFakePool({
            models: [
                directModelRow({
                    id: 'm-fast-a',
                    model_key: 'openai/fast-a',
                    provider_id: 'p-1',
                }),
                directModelRow({
                    id: 'm-fast-b',
                    model_key: 'openai/fast-b',
                    provider_id: 'p-1',
                }),
                cascadeModelRow({
                    id: 't-fast',
                    model_key: 'axl/fast',
                    max_attempts: 3,
                }),
            ],
            modelChildren: [
                modelChildRow({
                    parent_model_id: 't-fast',
                    child_model_id: 'm-fast-a',
                    child_model_key: 'openai/fast-a',
                    priority: 1,
                }),
                modelChildRow({
                    parent_model_id: 't-fast',
                    child_model_id: 'm-fast-b',
                    child_model_key: 'openai/fast-b',
                    priority: 2,
                }),
            ],
            providers: [providerRow({ id: 'p-1', provider_key: 'openai' })],
        });

        const snapshot = await loadRuntimeSnapshot({ pool });
        const cascade = snapshot.models.get('axl/fast');
        assert.equal(cascade.strategyKind, 'cascade');
        assert.equal(cascade.modelKey, 'axl/fast');
        assert.equal(cascade.maxAttempts, 3);
        assert.equal(cascade.children.length, 2);
        assert.equal(cascade.children[0].modelKey, 'openai/fast-a');
        assert.equal(cascade.children[0].priority, 1);
        assert.equal(cascade.children[1].modelKey, 'openai/fast-b');
        assert.equal(cascade.children[1].priority, 2);
        assert.equal(cascade.providerKey, null);
    });

    it('cascade models with no children appear as empty arrays, not null', async () => {
        const pool = makeFakePool({
            models: [
                cascadeModelRow({ id: 't-empty', model_key: 'axl/empty' }),
            ],
            modelChildren: [],
            providers: [],
        });
        const snapshot = await loadRuntimeSnapshot({ pool });
        const cascade = snapshot.models.get('axl/empty');
        assert.equal(cascade.strategyKind, 'cascade');
        assert.ok(Array.isArray(cascade.children));
        assert.equal(cascade.children.length, 0);
    });

    it('groups unified middleware bindings into gateway / byModel / byProvider buckets', async () => {
        const pool = makeFakePool({
            models: [
                directModelRow({
                    id: 'm1',
                    model_key: 'openai/gpt-4o',
                    provider_id: 'p-1',
                }),
            ],
            providers: [providerRow({ id: 'p-1', provider_key: 'openai' })],
            middlewareBindings: [
                {
                    id: 'b-g',
                    scope: 'gateway',
                    target_id: null,
                    middleware_key: 'rate-limiter',
                    sort_order: 10,
                    settings: {},
                    module_path: null,
                    source_type: 'builtin',
                    middleware_default_settings: {},
                },
                {
                    id: 'b-m',
                    scope: 'model',
                    target_id: 'm1',
                    middleware_key: 'response-filter',
                    sort_order: 20,
                    settings: {},
                    module_path: null,
                    source_type: 'builtin',
                    middleware_default_settings: {},
                },
                {
                    id: 'b-p',
                    scope: 'provider',
                    target_id: 'p-1',
                    middleware_key: 'provider-prompt-injector',
                    sort_order: 30,
                    settings: { content: 'HI' },
                    module_path: null,
                    source_type: 'builtin',
                    middleware_default_settings: {},
                },
            ],
        });

        const snapshot = await loadRuntimeSnapshot({ pool });

        assert.equal(snapshot.middlewareBindings.gateway.length, 1);
        assert.equal(
            snapshot.middlewareBindings.gateway[0].middlewareKey,
            'rate-limiter'
        );

        const modelBindings = snapshot.middlewareBindings.byModel.get('m1');
        assert.equal(modelBindings.length, 1);
        assert.equal(modelBindings[0].middlewareKey, 'response-filter');

        const providerBindings =
            snapshot.middlewareBindings.byProvider.get('p-1');
        assert.equal(providerBindings.length, 1);
        assert.equal(
            providerBindings[0].middlewareKey,
            'provider-prompt-injector'
        );
        assert.deepEqual(providerBindings[0].settings, { content: 'HI' });
    });
});
