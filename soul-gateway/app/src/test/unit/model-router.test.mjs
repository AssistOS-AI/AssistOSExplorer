import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mockGetModelByName = mock.fn();

mock.module('../../db/models-dao.mjs', {
  namedExports: { getModelByName: mockGetModelByName },
});

const { resolveModel } = await import('../../pipeline/model-router.mjs');

describe('model-router', () => {
  beforeEach(() => {
    mockGetModelByName.mock.resetCalls();
  });

  const MODEL_CONFIG = {
    name: 'axiologic-deep',
    upstream_model: 'claude-opus-4.6',
    mode: 'deep',
    input_price: '5',
    output_price: '25',
    is_enabled: true,
  };

  it('resolves a model directly', async () => {
    mockGetModelByName.mock.mockImplementation(async () => MODEL_CONFIG);
    const result = await resolveModel('axiologic-deep', { model_mapping: {}, allowed_models: [] });
    assert.equal(result.resolvedModel, 'axiologic-deep');
    assert.equal(result.upstreamModel, 'claude-opus-4.6');
    assert.equal(result.mode, 'deep');
    assert.equal(result.inputPrice, 5);
    assert.equal(result.outputPrice, 25);
  });

  it('applies model_mapping', async () => {
    mockGetModelByName.mock.mockImplementation(async (name) => {
      if (name === 'axiologic-deep') return MODEL_CONFIG;
      return null;
    });
    const result = await resolveModel('gpt-4', {
      model_mapping: { 'gpt-4': 'axiologic-deep' },
      allowed_models: [],
    });
    assert.equal(result.resolvedModel, 'axiologic-deep');
    assert.equal(mockGetModelByName.mock.calls[0].arguments[0], 'axiologic-deep');
  });

  it('throws ModelNotFoundError for unknown model', async () => {
    mockGetModelByName.mock.mockImplementation(async () => null);
    await assert.rejects(
      () => resolveModel('nonexistent', { model_mapping: {}, allowed_models: [] }),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.type, 'model_not_found');
        return true;
      }
    );
  });

  it('throws for disabled model', async () => {
    mockGetModelByName.mock.mockImplementation(async () => ({
      ...MODEL_CONFIG,
      is_enabled: false,
    }));
    await assert.rejects(
      () => resolveModel('axiologic-deep', { model_mapping: {}, allowed_models: [] }),
      (err) => {
        assert.equal(err.status, 404);
        assert.ok(err.message.includes('disabled'));
        return true;
      }
    );
  });

  it('validates against allowed_models list', async () => {
    mockGetModelByName.mock.mockImplementation(async () => MODEL_CONFIG);
    await assert.rejects(
      () => resolveModel('axiologic-deep', {
        model_mapping: {},
        allowed_models: ['axiologic-fast'], // deep not in list
      }),
      (err) => {
        assert.equal(err.status, 404);
        return true;
      }
    );
  });

  it('passes when model is in allowed_models', async () => {
    mockGetModelByName.mock.mockImplementation(async () => MODEL_CONFIG);
    const result = await resolveModel('axiologic-deep', {
      model_mapping: {},
      allowed_models: ['axiologic-deep'],
    });
    assert.equal(result.resolvedModel, 'axiologic-deep');
  });

  it('passes when requested model name is in allowed_models (pre-mapping)', async () => {
    mockGetModelByName.mock.mockImplementation(async (name) => {
      if (name === 'axiologic-deep') return MODEL_CONFIG;
      return null;
    });
    const result = await resolveModel('gpt-4', {
      model_mapping: { 'gpt-4': 'axiologic-deep' },
      allowed_models: ['gpt-4'], // original name is allowed
    });
    assert.equal(result.resolvedModel, 'axiologic-deep');
  });

  it('empty allowed_models means all models allowed', async () => {
    mockGetModelByName.mock.mockImplementation(async () => MODEL_CONFIG);
    const result = await resolveModel('axiologic-deep', {
      model_mapping: {},
      allowed_models: [],
    });
    assert.equal(result.resolvedModel, 'axiologic-deep');
  });

  it('handles zero prices', async () => {
    mockGetModelByName.mock.mockImplementation(async () => ({
      ...MODEL_CONFIG,
      input_price: '0',
      output_price: '0',
    }));
    const result = await resolveModel('axiologic-deep', { model_mapping: {}, allowed_models: [] });
    assert.equal(result.inputPrice, 0);
    assert.equal(result.outputPrice, 0);
  });
});
