import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SoulGatewayError,
  AuthError,
  RateLimitError,
  BlacklistError,
  ModelNotFoundError,
  UpstreamError,
} from '../../utils/errors.mjs';

describe('error classes', () => {
  it('SoulGatewayError has message, status, type', () => {
    const err = new SoulGatewayError('test', 500, 'internal_error');
    assert.equal(err.message, 'test');
    assert.equal(err.status, 500);
    assert.equal(err.type, 'internal_error');
    assert.ok(err instanceof Error);
  });

  it('AuthError defaults to 401', () => {
    const err = new AuthError();
    assert.equal(err.status, 401);
    assert.equal(err.type, 'authentication_error');
    assert.equal(err.message, 'Unauthorized');
  });

  it('AuthError accepts custom message', () => {
    const err = new AuthError('Bad token');
    assert.equal(err.message, 'Bad token');
    assert.equal(err.status, 401);
  });

  it('RateLimitError defaults to 429 with retryAfter', () => {
    const err = new RateLimitError();
    assert.equal(err.status, 429);
    assert.equal(err.type, 'rate_limit_error');
    assert.equal(err.retryAfter, 60);
  });

  it('RateLimitError accepts custom retryAfter', () => {
    const err = new RateLimitError('slow down', 30);
    assert.equal(err.retryAfter, 30);
    assert.equal(err.message, 'slow down');
  });

  it('BlacklistError has ruleId and match', () => {
    const err = new BlacklistError('blocked', 'rule-1', 'bad-word');
    assert.equal(err.status, 400);
    assert.equal(err.type, 'content_blocked');
    assert.equal(err.ruleId, 'rule-1');
    assert.equal(err.match, 'bad-word');
  });

  it('ModelNotFoundError includes model name', () => {
    const err = new ModelNotFoundError('gpt-99');
    assert.equal(err.status, 404);
    assert.equal(err.type, 'model_not_found');
    assert.ok(err.message.includes('gpt-99'));
  });

  it('UpstreamError defaults to 502', () => {
    const err = new UpstreamError('bad gateway');
    assert.equal(err.status, 502);
    assert.equal(err.type, 'upstream_error');
  });

  it('UpstreamError accepts custom status/type', () => {
    const err = new UpstreamError('timeout', 504, 'gateway_timeout');
    assert.equal(err.status, 504);
    assert.equal(err.type, 'gateway_timeout');
  });

  it('all error classes extend SoulGatewayError', () => {
    assert.ok(new AuthError() instanceof SoulGatewayError);
    assert.ok(new RateLimitError() instanceof SoulGatewayError);
    assert.ok(new BlacklistError() instanceof SoulGatewayError);
    assert.ok(new ModelNotFoundError('x') instanceof SoulGatewayError);
    assert.ok(new UpstreamError('x') instanceof SoulGatewayError);
  });
});
