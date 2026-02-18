import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mockResolveApiKey = mock.fn();

mock.module('../../db/keys-dao.mjs', {
  namedExports: { resolveApiKey: mockResolveApiKey },
});

const { authenticate } = await import('../../pipeline/auth.mjs');

describe('auth-logic', () => {
  beforeEach(() => {
    mockResolveApiKey.mock.resetCalls();
  });

  function makeReq(authHeader, soulId) {
    const headers = {};
    if (authHeader !== undefined) headers['authorization'] = authHeader;
    if (soulId) headers['x-soul-id'] = soulId;
    return { headers };
  }

  it('throws on missing Authorization header', async () => {
    await assert.rejects(
      () => authenticate(makeReq(undefined)),
      (err) => {
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('Missing'));
        return true;
      }
    );
  });

  it('throws on non-Bearer header', async () => {
    await assert.rejects(
      () => authenticate(makeReq('Basic abc')),
      (err) => {
        assert.equal(err.status, 401);
        return true;
      }
    );
  });

  it('throws on empty Bearer token', async () => {
    await assert.rejects(
      () => authenticate(makeReq('Bearer ')),
      (err) => {
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('Empty'));
        return true;
      }
    );
  });

  it('throws on invalid API key', async () => {
    mockResolveApiKey.mock.mockImplementation(async () => null);
    await assert.rejects(
      () => authenticate(makeReq('Bearer sk-soul-invalid')),
      (err) => {
        assert.equal(err.status, 401);
        assert.ok(err.message.includes('Invalid'));
        return true;
      }
    );
  });

  it('returns auth context on valid key', async () => {
    mockResolveApiKey.mock.mockImplementation(async () => ({
      id: 'key-1',
      family_id: 'fam-1',
      family_name: 'test-family',
      rpm_limit: 60,
      tpm_limit: 100000,
      model_mapping: '{"gpt-4":"axiologic-deep"}',
      allowed_models: '["axiologic-deep"]',
    }));
    const ctx = await authenticate(makeReq('Bearer sk-soul-valid'));
    assert.equal(ctx.family_id, 'fam-1');
    assert.equal(ctx.family_name, 'test-family');
    assert.equal(ctx.api_key_id, 'key-1');
    assert.equal(ctx.rpm_limit, 60);
    assert.equal(ctx.tpm_limit, 100000);
    assert.deepEqual(ctx.model_mapping, { 'gpt-4': 'axiologic-deep' });
    assert.deepEqual(ctx.allowed_models, ['axiologic-deep']);
    assert.equal(ctx.soul_id, 'anonymous');
  });

  it('uses X-Soul-Id header when provided', async () => {
    mockResolveApiKey.mock.mockImplementation(async () => ({
      id: 'key-1',
      family_id: 'fam-1',
      family_name: 'test-family',
      rpm_limit: 60,
      tpm_limit: 100000,
      model_mapping: {},
      allowed_models: [],
    }));
    const ctx = await authenticate(makeReq('Bearer sk-soul-valid', 'soul-42'));
    assert.equal(ctx.soul_id, 'soul-42');
  });

  it('handles already-parsed JSON objects in model_mapping', async () => {
    mockResolveApiKey.mock.mockImplementation(async () => ({
      id: 'key-1',
      family_id: 'fam-1',
      family_name: 'test-family',
      rpm_limit: 60,
      tpm_limit: 100000,
      model_mapping: { 'a': 'b' },
      allowed_models: ['a'],
    }));
    const ctx = await authenticate(makeReq('Bearer sk-soul-valid'));
    assert.deepEqual(ctx.model_mapping, { 'a': 'b' });
    assert.deepEqual(ctx.allowed_models, ['a']);
  });

  it('defaults empty model_mapping and allowed_models', async () => {
    mockResolveApiKey.mock.mockImplementation(async () => ({
      id: 'key-1',
      family_id: 'fam-1',
      family_name: 'test-family',
      rpm_limit: 60,
      tpm_limit: 100000,
      model_mapping: null,
      allowed_models: null,
    }));
    const ctx = await authenticate(makeReq('Bearer sk-soul-valid'));
    assert.deepEqual(ctx.model_mapping, {});
    assert.deepEqual(ctx.allowed_models, []);
  });
});
