import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as contextCompacter from '../../runtime/hooks/provider/builtin/provider-context-compacter.hook.mjs';
import * as promptInjector from '../../runtime/hooks/provider/builtin/provider-prompt-injector.hook.mjs';
import * as outputCompressor from '../../runtime/hooks/provider/builtin/provider-output-compressor.hook.mjs';
import * as responseFilter from '../../runtime/hooks/provider/builtin/provider-response-filter.hook.mjs';

// ── Meta validation ────────────────────────────────────────────────

describe('built-in provider hooks: meta', () => {

  const allHooks = [
    { name: 'context-compacter', mod: contextCompacter },
    { name: 'prompt-injector', mod: promptInjector },
    { name: 'output-compressor', mod: outputCompressor },
    { name: 'response-filter', mod: responseFilter },
  ];

  for (const { name, mod } of allHooks) {
    it(`${name} has scope='provider'`, () => {
      assert.equal(mod.meta.scope, 'provider');
    });

    it(`${name} has a non-empty key`, () => {
      assert.ok(mod.meta.key);
      assert.equal(typeof mod.meta.key, 'string');
    });

    it(`${name} has a non-empty name`, () => {
      assert.ok(mod.meta.name);
      assert.equal(typeof mod.meta.name, 'string');
    });

    it(`${name} has a non-empty phases array`, () => {
      assert.ok(Array.isArray(mod.meta.phases));
      assert.ok(mod.meta.phases.length > 0);
    });

    it(`${name} has only valid phases`, () => {
      const allowed = new Set(['request', 'stream', 'response']);
      for (const phase of mod.meta.phases) {
        assert.ok(allowed.has(phase), `invalid phase: ${phase}`);
      }
    });
  }

  it('context-compacter phases = [request]', () => {
    assert.deepEqual(contextCompacter.meta.phases, ['request']);
  });

  it('prompt-injector phases = [request]', () => {
    assert.deepEqual(promptInjector.meta.phases, ['request']);
  });

  it('output-compressor phases = [request]', () => {
    assert.deepEqual(outputCompressor.meta.phases, ['request']);
  });

  it('response-filter phases = [response]', () => {
    assert.deepEqual(responseFilter.meta.phases, ['response']);
  });
});

// ── provider-context-compacter ─────────────────────────────────────

describe('provider-context-compacter', () => {

  function makeCtx(messages) {
    return { request: { messages } };
  }

  it('compresses when messages exceed maxTokens', async () => {
    // Each message is ~100 chars => ~25 tokens at 4 chars/token
    // 20 messages => ~500 tokens. Set maxTokens to 100 to trigger compression.
    const messages = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: 'a'.repeat(100) });
    }
    const ctx = makeCtx(messages);

    await contextCompacter.onRequest(ctx, {
      maxTokens: 100,
      preserveRecent: 5,
      charsPerToken: 4,
      summaryPrefix: '[Summary] ',
    });

    // After compression: system messages + summary + 5 recent
    const result = ctx.request.messages;
    assert.ok(result.length <= 7, `expected <= 7 messages, got ${result.length}`);

    // Last 5 should be the original recent messages
    const recent = result.slice(-5);
    for (const msg of recent) {
      assert.equal(msg.role, 'user');
      assert.equal(msg.content, 'a'.repeat(100));
    }

    // There should be a summary message
    const summaryMsg = result.find(m => m.content.startsWith('[Summary]'));
    assert.ok(summaryMsg, 'summary message should be present');
    assert.equal(summaryMsg.role, 'system');
  });

  it('preserves recent N messages', async () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `message-${i} ${'x'.repeat(200)}` });
    }
    const ctx = makeCtx(messages);

    await contextCompacter.onRequest(ctx, {
      maxTokens: 50,
      preserveRecent: 3,
      charsPerToken: 4,
      summaryPrefix: '[Summarized] ',
    });

    const result = ctx.request.messages;
    // Last 3 should be preserved intact
    const recent = result.slice(-3);
    assert.equal(recent.length, 3);
    assert.ok(recent[0].content.startsWith('message-7'));
    assert.ok(recent[1].content.startsWith('message-8'));
    assert.ok(recent[2].content.startsWith('message-9'));
  });

  it('does nothing when under maxTokens', async () => {
    const messages = [
      { role: 'user', content: 'short message' },
    ];
    const ctx = makeCtx(messages);

    await contextCompacter.onRequest(ctx, {
      maxTokens: 100_000,
      preserveRecent: 5,
      charsPerToken: 4,
    });

    assert.equal(ctx.request.messages.length, 1);
    assert.equal(ctx.request.messages[0].content, 'short message');
  });

  it('preserves system messages', async () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `msg-${i} ${'z'.repeat(200)}` })),
    ];
    const ctx = makeCtx(messages);

    await contextCompacter.onRequest(ctx, {
      maxTokens: 50,
      preserveRecent: 3,
      charsPerToken: 4,
    });

    // System message should still be first
    assert.equal(ctx.request.messages[0].role, 'system');
    assert.equal(ctx.request.messages[0].content, 'You are a helpful assistant.');
  });
});

// ── provider-prompt-injector ───────────────────────────────────────

describe('provider-prompt-injector', () => {

  it('prepend mode adds system message at start', async () => {
    const ctx = {
      request: {
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      },
    };

    await promptInjector.onRequest(ctx, {
      content: 'Be helpful.',
      position: 'prepend',
      role: 'system',
    });

    assert.equal(ctx.request.messages.length, 2);
    assert.equal(ctx.request.messages[0].role, 'system');
    assert.equal(ctx.request.messages[0].content, 'Be helpful.');
    assert.equal(ctx.request.messages[1].content, 'Hello');
  });

  it('append mode adds system message at end', async () => {
    const ctx = {
      request: {
        messages: [
          { role: 'user', content: 'Hello' },
        ],
      },
    };

    await promptInjector.onRequest(ctx, {
      content: 'Remember to be concise.',
      position: 'append',
      role: 'system',
    });

    assert.equal(ctx.request.messages.length, 2);
    assert.equal(ctx.request.messages[0].content, 'Hello');
    assert.equal(ctx.request.messages[1].role, 'system');
    assert.equal(ctx.request.messages[1].content, 'Remember to be concise.');
  });

  it('prepend inserts after existing system messages', async () => {
    const ctx = {
      request: {
        messages: [
          { role: 'system', content: 'Existing system prompt' },
          { role: 'user', content: 'Hello' },
        ],
      },
    };

    await promptInjector.onRequest(ctx, {
      content: 'Injected system prompt',
      position: 'prepend',
      role: 'system',
    });

    assert.equal(ctx.request.messages.length, 3);
    assert.equal(ctx.request.messages[0].content, 'Existing system prompt');
    assert.equal(ctx.request.messages[1].content, 'Injected system prompt');
    assert.equal(ctx.request.messages[2].content, 'Hello');
  });

  it('does nothing when content is empty', async () => {
    const ctx = {
      request: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    };

    await promptInjector.onRequest(ctx, { content: '', position: 'prepend', role: 'system' });

    assert.equal(ctx.request.messages.length, 1);
  });

  it('supports custom role', async () => {
    const ctx = {
      request: {
        messages: [{ role: 'user', content: 'Hello' }],
      },
    };

    await promptInjector.onRequest(ctx, {
      content: 'Developer note',
      position: 'prepend',
      role: 'developer',
    });

    assert.equal(ctx.request.messages[0].role, 'developer');
  });
});

// ── provider-output-compressor ─────────────────────────────────────

describe('provider-output-compressor', () => {

  it('truncates tool output beyond maxOutputLength', async () => {
    const longOutput = 'x'.repeat(10_000);
    const ctx = {
      request: {
        messages: [
          { role: 'tool', content: longOutput },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 100,
      truncationMarker: '...[cut]',
      compressToolMessages: true,
    });

    const result = ctx.request.messages[0].content;
    assert.ok(result.length <= 100, `expected <= 100, got ${result.length}`);
    assert.ok(result.endsWith('...[cut]'));
  });

  it('leaves short output unchanged', async () => {
    const shortOutput = 'short result';
    const ctx = {
      request: {
        messages: [
          { role: 'tool', content: shortOutput },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 5000,
      truncationMarker: '... [truncated]',
      compressToolMessages: true,
    });

    assert.equal(ctx.request.messages[0].content, shortOutput);
  });

  it('truncates function-role messages too', async () => {
    const longOutput = 'y'.repeat(8000);
    const ctx = {
      request: {
        messages: [
          { role: 'function', content: longOutput },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 200,
      truncationMarker: '[...]',
      compressToolMessages: true,
    });

    assert.ok(ctx.request.messages[0].content.length <= 200);
    assert.ok(ctx.request.messages[0].content.endsWith('[...]'));
  });

  it('truncates array-style multimodal content', async () => {
    const longText = 'z'.repeat(10_000);
    const ctx = {
      request: {
        messages: [
          { role: 'tool', content: [{ type: 'text', text: longText }] },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 150,
      truncationMarker: '~truncated~',
      compressToolMessages: true,
    });

    const part = ctx.request.messages[0].content[0];
    assert.ok(part.text.length <= 150);
    assert.ok(part.text.endsWith('~truncated~'));
  });

  it('does nothing when compressToolMessages is false', async () => {
    const longOutput = 'x'.repeat(10_000);
    const ctx = {
      request: {
        messages: [
          { role: 'tool', content: longOutput },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 100,
      truncationMarker: '...',
      compressToolMessages: false,
    });

    assert.equal(ctx.request.messages[0].content.length, 10_000);
  });

  it('leaves non-tool messages unchanged', async () => {
    const longContent = 'a'.repeat(10_000);
    const ctx = {
      request: {
        messages: [
          { role: 'user', content: longContent },
        ],
      },
    };

    await outputCompressor.onRequest(ctx, {
      maxOutputLength: 100,
      truncationMarker: '...',
      compressToolMessages: true,
    });

    // user messages should not be truncated (only tool/function)
    assert.equal(ctx.request.messages[0].content.length, 10_000);
  });
});

// ── provider-response-filter ───────────────────────────────────────

describe('provider-response-filter', () => {

  it('applies regex replacement to response content (direct)', async () => {
    const ctx = {
      response: {
        content: 'The secret code is ABC123 and the password is XYZ789.',
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: '[A-Z]{3}\\d{3}', replace: '[REDACTED]', flags: 'g' },
      ],
      replacement: '[REDACTED]',
    });

    assert.equal(ctx.response.content, 'The secret code is [REDACTED] and the password is [REDACTED].');
  });

  it('applies regex replacement to choices-style response', async () => {
    const ctx = {
      response: {
        choices: [
          { message: { content: 'Hello secret-world!' } },
        ],
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: 'secret-', replace: '', flags: 'g' },
      ],
    });

    assert.equal(ctx.response.choices[0].message.content, 'Hello world!');
  });

  it('handles multiple patterns', async () => {
    const ctx = {
      response: {
        content: 'email: user@test.com, phone: 555-1234',
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: '[\\w.]+@[\\w.]+', replace: '[EMAIL]', flags: 'g' },
        { find: '\\d{3}-\\d{4}', replace: '[PHONE]', flags: 'g' },
      ],
      replacement: '[REDACTED]',
    });

    assert.equal(ctx.response.content, 'email: [EMAIL], phone: [PHONE]');
  });

  it('uses default replacement when pattern.replace is missing', async () => {
    const ctx = {
      response: {
        content: 'some bad-word here',
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: 'bad-word' },
      ],
      replacement: '[CENSORED]',
    });

    assert.equal(ctx.response.content, 'some [CENSORED] here');
  });

  it('does nothing with empty patterns array', async () => {
    const ctx = {
      response: {
        content: 'unchanged content',
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [],
      replacement: '[REDACTED]',
    });

    assert.equal(ctx.response.content, 'unchanged content');
  });

  it('does nothing when ctx.response is absent', async () => {
    const ctx = {};

    // Should not throw
    await responseFilter.onResponse(ctx, {
      patterns: [{ find: 'test', replace: 'replaced' }],
    });

    assert.equal(ctx.response, undefined);
  });

  it('skips invalid regex patterns gracefully', async () => {
    const ctx = {
      response: {
        content: 'test content',
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: '(invalid[', replace: 'oops' },  // invalid regex
        { find: 'test', replace: 'valid' },
      ],
    });

    // The invalid pattern is skipped; the valid one still applies
    assert.equal(ctx.response.content, 'valid content');
  });

  it('handles delta-style choices', async () => {
    const ctx = {
      response: {
        choices: [
          { delta: { content: 'secret data here' } },
        ],
      },
    };

    await responseFilter.onResponse(ctx, {
      patterns: [
        { find: 'secret', replace: '***', flags: 'g' },
      ],
    });

    assert.equal(ctx.response.choices[0].delta.content, '*** data here');
  });
});
