import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../pipeline/upstream-dispatch.mjs';

describe('classifyError', () => {
  describe('non-retryable errors', () => {
    it('400 → invalid_request_error', () => {
      const r = classifyError(400, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'invalid_request_error');
    });

    it('401 → authentication_error (critical)', () => {
      const r = classifyError(401, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'authentication_error');
      assert.equal(r.critical, true);
    });

    it('402 → payment_required', () => {
      const r = classifyError(402, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'payment_required');
    });

    it('403 → permission_error', () => {
      const r = classifyError(403, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'permission_error');
    });

    it('404 → model_not_found', () => {
      const r = classifyError(404, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'model_not_found');
    });
  });

  describe('retryable errors', () => {
    it('429 → rate_limit_error', () => {
      const r = classifyError(429, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'rate_limit_error');
    });

    it('429 with model_cooldown type', () => {
      const r = classifyError(429, { error: { type: 'model_cooldown' } });
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'model_cooldown');
    });

    it('500 → server_error', () => {
      const r = classifyError(500, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'server_error');
    });

    it('502 → bad_gateway', () => {
      const r = classifyError(502, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'bad_gateway');
    });

    it('503 → service_unavailable', () => {
      const r = classifyError(503, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'service_unavailable');
    });

    it('504 → gateway_timeout', () => {
      const r = classifyError(504, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'gateway_timeout');
    });

    it('408 → timeout with maxRetries=1', () => {
      const r = classifyError(408, {});
      assert.equal(r.retryable, true);
      assert.equal(r.type, 'timeout');
      assert.equal(r.maxRetries, 1);
    });
  });

  describe('unknown errors', () => {
    it('unknown status → not retryable', () => {
      const r = classifyError(418, {});
      assert.equal(r.retryable, false);
      assert.equal(r.type, 'unknown_error');
    });

    it('uses error type from body if available', () => {
      const r = classifyError(418, { error: { type: 'teapot_error' } });
      assert.equal(r.type, 'teapot_error');
    });
  });
});
