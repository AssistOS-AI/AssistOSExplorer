import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName } from '../../runtime/registry/model-name-normalizer.mjs';

/**
 * Build a minimal mock snapshot for normalizer tests.
 *
 * Every addressable target lives in `snapshot.models`, both direct
 * models and cascade models. These mocks model the post-loader shape
 * directly — `axl/fast` and `axl/deep` are entries in `models`, not
 * in a separate `tiers` map.
 */
function createMockSnapshot() {
    const models = new Map();
    models.set('openai/gpt-4o', {
        modelKey: 'openai/gpt-4o',
        strategyKind: 'direct',
    });
    models.set('copilot/gpt-4o', {
        modelKey: 'copilot/gpt-4o',
        strategyKind: 'direct',
    });
    models.set('anthropic/claude-sonnet-4', {
        modelKey: 'anthropic/claude-sonnet-4',
        strategyKind: 'direct',
    });
    models.set('openai/o1-mini', {
        modelKey: 'openai/o1-mini',
        strategyKind: 'direct',
    });
    // Synthesized cascade models — same key namespace as direct models
    models.set('axl/fast', { modelKey: 'axl/fast', strategyKind: 'cascade' });
    models.set('axl/deep', { modelKey: 'axl/deep', strategyKind: 'cascade' });

    const aliases = new Map();
    aliases.set('gpt4o', 'openai/gpt-4o');
    aliases.set('sonnet', 'anthropic/claude-sonnet-4');

    // tiers map remains for management API but the normalizer must not
    // consult it; populate as empty so a leaked branch fails loudly.
    const tiers = new Map();

    return { models, aliases, tiers };
}

describe('normalizeModelName', () => {
    const snapshot = createMockSnapshot();

    // ── exact matches ─────────────────────────────────────────────────

    it('returns exact direct-model match with kind="model"', () => {
        const result = normalizeModelName('openai/gpt-4o', snapshot);
        assert.equal(result.normalized, 'openai/gpt-4o');
        assert.equal(result.kind, 'model');
    });

    it('returns exact cascade-model match with kind="model" (no separate "tier" kind)', () => {
        const result = normalizeModelName('axl/fast', snapshot);
        assert.equal(result.normalized, 'axl/fast');
        assert.equal(result.kind, 'model');
    });

    // ── alias resolution ──────────────────────────────────────────────

    it('resolves alias to canonical model key', () => {
        const result = normalizeModelName('gpt4o', snapshot);
        assert.equal(result.normalized, 'openai/gpt-4o');
        assert.equal(result.kind, 'model');
    });

    it('resolves another alias', () => {
        const result = normalizeModelName('sonnet', snapshot);
        assert.equal(result.normalized, 'anthropic/claude-sonnet-4');
        assert.equal(result.kind, 'model');
    });

    // ── bare names ────────────────────────────────────────────────────

    it('resolves bare model name to first matching provider-prefixed key', () => {
        const result = normalizeModelName('o1-mini', snapshot);
        assert.equal(result.normalized, 'openai/o1-mini');
        assert.equal(result.kind, 'model');
    });

    it('does not resolve bare cascade shorthand without the axl/ prefix', () => {
        const result = normalizeModelName('fast', snapshot);
        assert.equal(result.normalized, 'fast');
        assert.equal(result.kind, 'unknown');
    });

    // ── case-insensitive ──────────────────────────────────────────────

    it('resolves case-insensitive direct-model match', () => {
        const result = normalizeModelName('OpenAI/GPT-4o', snapshot);
        assert.equal(result.normalized, 'openai/gpt-4o');
        assert.equal(result.kind, 'model');
    });

    it('resolves case-insensitive alias match', () => {
        const result = normalizeModelName('GPT4O', snapshot);
        assert.equal(result.normalized, 'openai/gpt-4o');
        assert.equal(result.kind, 'model');
    });

    it('resolves case-insensitive cascade match', () => {
        const result = normalizeModelName('AXL/FAST', snapshot);
        assert.equal(result.normalized, 'axl/fast');
        assert.equal(result.kind, 'model');
    });

    // ── unknown / edge cases ──────────────────────────────────────────

    it('returns unknown for unrecognized input', () => {
        const result = normalizeModelName('does-not-exist-anywhere', snapshot);
        assert.equal(result.normalized, 'does-not-exist-anywhere');
        assert.equal(result.kind, 'unknown');
    });

    it('handles empty string', () => {
        const result = normalizeModelName('', snapshot);
        assert.equal(result.normalized, '');
        assert.equal(result.kind, 'unknown');
    });

    it('handles null input', () => {
        const result = normalizeModelName(null, snapshot);
        assert.equal(result.normalized, null);
        assert.equal(result.kind, 'unknown');
    });

    it('handles undefined input', () => {
        const result = normalizeModelName(undefined, snapshot);
        assert.equal(result.normalized, undefined);
        assert.equal(result.kind, 'unknown');
    });

    it('trims whitespace', () => {
        const result = normalizeModelName('  openai/gpt-4o  ', snapshot);
        assert.equal(result.normalized, 'openai/gpt-4o');
        assert.equal(result.kind, 'model');
    });

    it('does NOT consult snapshot.tiers (only snapshot.models)', () => {
        const tierOnlySnapshot = {
            models: new Map(),
            aliases: new Map(),
            // The normalizer should ignore this map.
            tiers: new Map([['axl/orphan', { tierKey: 'axl/orphan' }]]),
        };
        const result = normalizeModelName('axl/orphan', tierOnlySnapshot);
        assert.equal(result.kind, 'unknown');
    });
});
