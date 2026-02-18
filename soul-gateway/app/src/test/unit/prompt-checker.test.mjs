import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config.mjs';

// Lower threshold for testing
config.largePromptTokens = 100;

import { checkPromptSize } from '../../pipeline/prompt-checker.mjs';

describe('prompt-checker', () => {
  it('estimates tokens as chars / 4', () => {
    // 200 chars = 50 estimated tokens
    const messages = [{ role: 'user', content: 'x'.repeat(200) }];
    const result = checkPromptSize(messages);
    assert.equal(result.estimatedTokens, 50);
    assert.equal(result.requestSizeBytes, 200);
    assert.equal(result.promptSizeWarning, false);
  });

  it('warns on large prompt', () => {
    // 500 chars = 125 tokens, above threshold of 100
    const messages = [{ role: 'user', content: 'x'.repeat(500) }];
    const result = checkPromptSize(messages);
    assert.equal(result.estimatedTokens, 125);
    assert.equal(result.promptSizeWarning, true);
  });

  it('sums across multiple messages', () => {
    const messages = [
      { role: 'system', content: 'a'.repeat(100) },
      { role: 'user', content: 'b'.repeat(100) },
    ];
    const result = checkPromptSize(messages);
    assert.equal(result.requestSizeBytes, 200);
    assert.equal(result.estimatedTokens, 50);
  });

  it('handles array content (multimodal)', () => {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'x'.repeat(80) },
        { type: 'image_url', image_url: { url: 'data:...' } },
        { type: 'text', text: 'y'.repeat(40) },
      ],
    }];
    const result = checkPromptSize(messages);
    assert.equal(result.requestSizeBytes, 120);
  });

  it('handles empty messages', () => {
    const result = checkPromptSize([]);
    assert.equal(result.estimatedTokens, 0);
    assert.equal(result.promptSizeWarning, false);
  });

  it('rounds up token estimate', () => {
    // 5 chars / 4 = 1.25 -> ceil -> 2
    const messages = [{ role: 'user', content: 'hello' }];
    const result = checkPromptSize(messages);
    assert.equal(result.estimatedTokens, 2);
  });
});
