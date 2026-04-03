import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelName } from '../../runtime/registry/model-name-normalizer.mjs';

/**
 * Build a minimal mock snapshot for normalizer tests.
 */
function createMockSnapshot() {
  const models = new Map();
  models.set('openai/gpt-4o', { modelKey: 'openai/gpt-4o' });
  models.set('copilot/gpt-4o', { modelKey: 'copilot/gpt-4o' });
  models.set('anthropic/claude-sonnet-4', { modelKey: 'anthropic/claude-sonnet-4' });
  models.set('openai/o1-mini', { modelKey: 'openai/o1-mini' });

  const aliases = new Map();
  aliases.set('gpt4o', 'openai/gpt-4o');
  aliases.set('sonnet', 'anthropic/claude-sonnet-4');

  const tiers = new Map();
  tiers.set('axl/fast', { tierKey: 'axl/fast' });
  tiers.set('axl/deep', { tierKey: 'axl/deep' });

  return { models, aliases, tiers };
}

describe('normalizeModelName', () => {
  const snapshot = createMockSnapshot();

  // ── exact matches ─────────────────────────────────────────────────

  it('returns exact model match', () => {
    const result = normalizeModelName('openai/gpt-4o', snapshot);
    assert.equal(result.normalized, 'openai/gpt-4o');
    assert.equal(result.kind, 'model');
  });

  it('returns exact tier match', () => {
    const result = normalizeModelName('axl/fast', snapshot);
    assert.equal(result.normalized, 'axl/fast');
    assert.equal(result.kind, 'tier');
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

  // ── legacy mode: prefix ───────────────────────────────────────────

  it('normalizes mode:fast -> axl/fast', () => {
    const result = normalizeModelName('mode:fast', snapshot);
    assert.equal(result.normalized, 'axl/fast');
    assert.equal(result.kind, 'tier');
  });

  it('normalizes mode:deep -> axl/deep', () => {
    const result = normalizeModelName('mode:deep', snapshot);
    assert.equal(result.normalized, 'axl/deep');
    assert.equal(result.kind, 'tier');
  });

  it('normalizes mode:axl/deep -> axl/deep (already prefixed)', () => {
    const result = normalizeModelName('mode:axl/deep', snapshot);
    assert.equal(result.normalized, 'axl/deep');
    assert.equal(result.kind, 'tier');
  });

  // ── bare model names ──────────────────────────────────────────────

  it('resolves bare model name to first matching provider-prefixed key', () => {
    const result = normalizeModelName('o1-mini', snapshot);
    assert.equal(result.normalized, 'openai/o1-mini');
    assert.equal(result.kind, 'model');
  });

  it('resolves bare tier name with axl/ prefix', () => {
    const result = normalizeModelName('fast', snapshot);
    assert.equal(result.normalized, 'axl/fast');
    assert.equal(result.kind, 'tier');
  });

  // ── case-insensitive ──────────────────────────────────────────────

  it('resolves case-insensitive model match', () => {
    const result = normalizeModelName('OpenAI/GPT-4o', snapshot);
    assert.equal(result.normalized, 'openai/gpt-4o');
    assert.equal(result.kind, 'model');
  });

  it('resolves case-insensitive alias match', () => {
    const result = normalizeModelName('GPT4O', snapshot);
    // First tries alias exact (fails), then bare name (gpt-4o != GPT4O),
    // then case-insensitive alias search
    assert.equal(result.normalized, 'openai/gpt-4o');
    assert.equal(result.kind, 'model');
  });

  it('resolves case-insensitive tier match', () => {
    const result = normalizeModelName('AXL/FAST', snapshot);
    assert.equal(result.normalized, 'axl/fast');
    assert.equal(result.kind, 'tier');
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
});
