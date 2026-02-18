import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';

// Set test threshold before importing
config.slowRequestMs = 100;

import { checkResponse } from '../../pipeline/response-checker.mjs';

describe('response-checker', () => {
  it('detects truncation from max_tokens', () => {
    const result = checkResponse('max_tokens', 50);
    assert.equal(result.is_truncated, true);
    assert.equal(result.is_slow, false);
  });

  it('detects truncation from length', () => {
    const result = checkResponse('length', 50);
    assert.equal(result.is_truncated, true);
  });

  it('no truncation for stop', () => {
    const result = checkResponse('stop', 50);
    assert.equal(result.is_truncated, false);
  });

  it('no truncation for null stop reason', () => {
    const result = checkResponse(null, 50);
    assert.equal(result.is_truncated, false);
  });

  it('detects slow response', () => {
    const result = checkResponse('stop', 200);
    assert.equal(result.is_slow, true);
  });

  it('not slow when under threshold', () => {
    const result = checkResponse('stop', 50);
    assert.equal(result.is_slow, false);
  });

  it('handles exact threshold (not slow)', () => {
    const result = checkResponse('stop', config.slowRequestMs);
    assert.equal(result.is_slow, false);
  });
});
