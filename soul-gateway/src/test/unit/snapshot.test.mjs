import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, resolveTier } from '../../runtime/registry/model-registry.mjs';

/**
 * Build a mock snapshot for testing the registry lookup functions.
 */
function createMockSnapshot() {
  const models = new Map();
  models.set('openai/gpt-4o', Object.freeze({
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
  }));
  models.set('copilot/gpt-4o', Object.freeze({
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
  }));
  models.set('anthropic/claude-sonnet-4', Object.freeze({
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
  }));

  const aliases = new Map();
  aliases.set('gpt4o', 'openai/gpt-4o');
  aliases.set('sonnet4', 'anthropic/claude-sonnet-4');
  aliases.set('fast-copilot', 'copilot/gpt-4o');

  const tiers = new Map();
  tiers.set('axl/fast', Object.freeze({
    id: 'tier-fast',
    tierKey: 'axl/fast',
    displayName: 'Fast Tier',
    description: null,
    fallbackTierId: null,
    maxModelAttempts: 5,
    enabled: true,
    models: Object.freeze([
      Object.freeze({ modelKey: 'copilot/gpt-4o', modelId: 'model-2', priority: 1, modelEnabled: true, settings: {} }),
      Object.freeze({ modelKey: 'openai/gpt-4o', modelId: 'model-1', priority: 2, modelEnabled: true, settings: {} }),
    ]),
  }));
  tiers.set('axl/deep', Object.freeze({
    id: 'tier-deep',
    tierKey: 'axl/deep',
    displayName: 'Deep Tier',
    description: null,
    fallbackTierId: 'tier-fast', // falls back to axl/fast
    maxModelAttempts: 5,
    enabled: true,
    models: Object.freeze([
      Object.freeze({ modelKey: 'anthropic/claude-sonnet-4', modelId: 'model-3', priority: 1, modelEnabled: true, settings: {} }),
      Object.freeze({ modelKey: 'openai/gpt-4o', modelId: 'model-1', priority: 2, modelEnabled: true, settings: {} }),
    ]),
  }));
  tiers.set('axl/solo', Object.freeze({
    id: 'tier-solo',
    tierKey: 'axl/solo',
    displayName: 'Solo Tier',
    description: 'Only one model, no fallback',
    fallbackTierId: null,
    maxModelAttempts: 1,
    enabled: true,
    models: Object.freeze([
      Object.freeze({ modelKey: 'anthropic/claude-sonnet-4', modelId: 'model-3', priority: 1, modelEnabled: true, settings: {} }),
    ]),
  }));

  const cooldowns = new Set();

  const providers = new Map();
  providers.set('openai', Object.freeze({ id: 'prov-openai', providerKey: 'openai' }));
  providers.set('copilot', Object.freeze({ id: 'prov-copilot', providerKey: 'copilot' }));
  providers.set('anthropic', Object.freeze({ id: 'prov-anthropic', providerKey: 'anthropic' }));

  return Object.freeze({
    generation: 1,
    models,
    aliases,
    tiers,
    providers,
    middlewareAssignments: Object.freeze({ byTier: new Map(), byModel: new Map() }),
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

// ── resolveTier tests ───────────────────────────────────────────────

describe('resolveTier', () => {
  it('resolves a tier with ordered candidates', () => {
    const snapshot = createMockSnapshot();
    const result = resolveTier(snapshot, 'axl/fast');
    assert.ok(result);
    assert.equal(result.tier.tierKey, 'axl/fast');
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].model.modelKey, 'copilot/gpt-4o');
    assert.equal(result.candidates[1].model.modelKey, 'openai/gpt-4o');
    assert.equal(result.exhausted, false);
    assert.deepEqual(result.fallbackChain, ['axl/fast']);
  });

  it('returns null for unknown tier', () => {
    const snapshot = createMockSnapshot();
    const result = resolveTier(snapshot, 'axl/nonexistent');
    assert.equal(result, null);
  });

  it('follows fallback chain', () => {
    const snapshot = createMockSnapshot();
    const result = resolveTier(snapshot, 'axl/deep');
    assert.ok(result);
    // Deep tier has 2 models + fallback to fast tier adds copilot/gpt-4o
    // (openai/gpt-4o already included from deep tier)
    assert.deepEqual(result.fallbackChain, ['axl/deep', 'axl/fast']);
    // Deep tier: claude-sonnet-4 (p1), openai/gpt-4o (p2)
    // Fast tier: copilot/gpt-4o (p1), openai/gpt-4o (p2)
    // Total: 4 candidates (openai/gpt-4o appears twice, one from each tier)
    assert.equal(result.candidates.length, 4);
    assert.equal(result.candidates[0].model.modelKey, 'anthropic/claude-sonnet-4');
    assert.equal(result.candidates[0].tierKey, 'axl/deep');
  });

  it('filters out cooled-down models', () => {
    const snapshot = createMockSnapshot();
    // Manually add a cooldown
    snapshot.cooldowns.add('anthropic/claude-sonnet-4');

    const result = resolveTier(snapshot, 'axl/deep');
    assert.ok(result);
    // claude-sonnet-4 should be filtered out from deep tier
    const modelKeys = result.candidates.map((c) => c.model.modelKey);
    assert.ok(!modelKeys.includes('anthropic/claude-sonnet-4') || false);
    // Only candidates from deep tier should be openai/gpt-4o
    const deepCandidates = result.candidates.filter((c) => c.tierKey === 'axl/deep');
    assert.equal(deepCandidates.length, 1);
    assert.equal(deepCandidates[0].model.modelKey, 'openai/gpt-4o');

    // Clean up
    snapshot.cooldowns.delete('anthropic/claude-sonnet-4');
  });

  it('respects skipCooldowns=false', () => {
    const snapshot = createMockSnapshot();
    snapshot.cooldowns.add('anthropic/claude-sonnet-4');

    const result = resolveTier(snapshot, 'axl/deep', { skipCooldowns: false });
    assert.ok(result);
    const modelKeys = result.candidates.map((c) => c.model.modelKey);
    assert.ok(modelKeys.includes('anthropic/claude-sonnet-4'));

    snapshot.cooldowns.delete('anthropic/claude-sonnet-4');
  });

  it('reports exhausted when all models are cooled down', () => {
    const snapshot = createMockSnapshot();
    snapshot.cooldowns.add('anthropic/claude-sonnet-4');

    const result = resolveTier(snapshot, 'axl/solo');
    assert.ok(result);
    assert.equal(result.exhausted, true);
    assert.equal(result.candidates.length, 0);

    snapshot.cooldowns.delete('anthropic/claude-sonnet-4');
  });

  it('does not infinite-loop on fallback cycles', () => {
    // Build a snapshot with a cycle: A -> B -> A
    const models = new Map();
    models.set('m1', Object.freeze({
      id: 'm1', modelKey: 'm1', displayName: 'M1', enabled: true,
    }));

    const tiers = new Map();
    tiers.set('tierA', Object.freeze({
      id: 'idA', tierKey: 'tierA', displayName: 'A', fallbackTierId: 'idB',
      maxModelAttempts: 3, enabled: true,
      models: Object.freeze([Object.freeze({ modelKey: 'm1', modelId: 'm1', priority: 1, modelEnabled: true, settings: {} })]),
    }));
    tiers.set('tierB', Object.freeze({
      id: 'idB', tierKey: 'tierB', displayName: 'B', fallbackTierId: 'idA',
      maxModelAttempts: 3, enabled: true,
      models: Object.freeze([Object.freeze({ modelKey: 'm1', modelId: 'm1', priority: 1, modelEnabled: true, settings: {} })]),
    }));

    const cyclicSnapshot = Object.freeze({
      generation: 1, models, aliases: new Map(), tiers,
      providers: new Map(),
      middlewareAssignments: Object.freeze({ byTier: new Map(), byModel: new Map() }),
      cooldowns: new Set(), pricing: new Map(), loadedAt: Date.now(),
    });

    const result = resolveTier(cyclicSnapshot, 'tierA');
    assert.ok(result);
    // Should visit each tier exactly once
    assert.deepEqual(result.fallbackChain, ['tierA', 'tierB']);
    assert.equal(result.candidates.length, 2); // m1 from each tier
  });
});
