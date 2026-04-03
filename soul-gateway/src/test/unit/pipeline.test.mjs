import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeIncomingFormat } from '../../request/format-normalizer.mjs';
import { serializeBufferedResponse, serializeStreamChunk } from '../../request/format-serializers.mjs';
import { resolveIdentity } from '../../request/identity.mjs';
import { validateNormalizedRequest } from '../../request/validator.mjs';
import { createRequestContext } from '../../request/request-context.mjs';
import { ValidationError, UnsupportedFormatError, BadRequestError } from '../../core/errors.mjs';

// ═══════════════════════════════════════════════════════════════════════
// Format Normalizer
// ═══════════════════════════════════════════════════════════════════════

describe('normalizeIncomingFormat', () => {
  // ── OpenAI Chat ─────────────────────────────────────────────────

  describe('openai_chat', () => {
    it('passes through a standard chat request', () => {
      const body = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
        temperature: 0.7,
      };
      const result = normalizeIncomingFormat('openai_chat', body);
      assert.equal(result.model, 'gpt-4o');
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.stream, false);
      assert.equal(result.temperature, 0.7);
    });

    it('defaults stream to false', () => {
      const body = { model: 'gpt-4o', messages: [] };
      const result = normalizeIncomingFormat('openai_chat', body);
      assert.equal(result.stream, false);
    });

    it('preserves extra parameters', () => {
      const body = {
        model: 'gpt-4o',
        messages: [],
        top_p: 0.9,
        max_tokens: 100,
        frequency_penalty: 0.5,
      };
      const result = normalizeIncomingFormat('openai_chat', body);
      assert.equal(result.top_p, 0.9);
      assert.equal(result.max_tokens, 100);
      assert.equal(result.frequency_penalty, 0.5);
    });
  });

  // ── Anthropic Messages ──────────────────────────────────────────

  describe('anthropic_messages', () => {
    it('converts system string to system message at position 0', () => {
      const body = {
        model: 'claude-3-sonnet',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0].role, 'system');
      assert.equal(result.messages[0].content, 'You are a helpful assistant.');
      assert.equal(result.messages[1].role, 'user');
      assert.equal(result.messages[1].content, 'Hello');
    });

    it('converts system content block array', () => {
      const body = {
        model: 'claude-3-sonnet',
        system: [{ type: 'text', text: 'System prompt' }],
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.equal(result.messages[0].role, 'system');
      assert.equal(result.messages[0].content, 'System prompt');
    });

    it('maps max_tokens', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1024,
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.equal(result.max_tokens, 1024);
    });

    it('maps stop_sequences to stop', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        stop_sequences: ['\n\nHuman:', '###'],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.deepEqual(result.stop, ['\n\nHuman:', '###']);
    });

    it('converts content blocks with images', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
          ],
        }],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      const msgContent = result.messages[0].content;
      assert.ok(Array.isArray(msgContent));
      assert.equal(msgContent[0].type, 'text');
      assert.equal(msgContent[1].type, 'image_url');
      assert.ok(msgContent[1].image_url.url.startsWith('data:image/png;base64,'));
    });

    it('converts tool definitions', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{
          name: 'get_weather',
          description: 'Get the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        }],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0].type, 'function');
      assert.equal(result.tools[0].function.name, 'get_weather');
      assert.deepEqual(result.tools[0].function.parameters, body.tools[0].input_schema);
    });

    it('converts tool_use content blocks to tool_calls', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the weather.' },
            { type: 'tool_use', id: 'call_123', name: 'get_weather', input: { city: 'NYC' } },
          ],
        }],
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      const msg = result.messages[0];
      assert.equal(msg.role, 'assistant');
      assert.ok(msg.tool_calls);
      assert.equal(msg.tool_calls.length, 1);
      assert.equal(msg.tool_calls[0].id, 'call_123');
      assert.equal(msg.tool_calls[0].function.name, 'get_weather');
    });

    it('converts tool_choice "any" to "required"', () => {
      const body = {
        model: 'claude-3-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        tool_choice: 'any',
      };
      const result = normalizeIncomingFormat('anthropic_messages', body);
      assert.equal(result.tool_choice, 'required');
    });
  });

  // ── OpenAI Responses ────────────────────────────────────────────

  describe('openai_responses', () => {
    it('converts instructions to system message', () => {
      const body = {
        model: 'gpt-4o',
        instructions: 'You are a helpful assistant.',
        input: 'Hello',
      };
      const result = normalizeIncomingFormat('openai_responses', body);
      assert.equal(result.messages[0].role, 'system');
      assert.equal(result.messages[0].content, 'You are a helpful assistant.');
      assert.equal(result.messages[1].role, 'user');
      assert.equal(result.messages[1].content, 'Hello');
    });

    it('converts string input to user message', () => {
      const body = { model: 'gpt-4o', input: 'Hello' };
      const result = normalizeIncomingFormat('openai_responses', body);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'user');
      assert.equal(result.messages[0].content, 'Hello');
    });

    it('converts array input items', () => {
      const body = {
        model: 'gpt-4o',
        input: [
          { type: 'message', role: 'user', content: 'First' },
          { type: 'message', role: 'assistant', content: 'Response' },
          { type: 'message', role: 'user', content: 'Follow-up' },
        ],
      };
      const result = normalizeIncomingFormat('openai_responses', body);
      assert.equal(result.messages.length, 3);
      assert.equal(result.messages[0].content, 'First');
      assert.equal(result.messages[1].role, 'assistant');
      assert.equal(result.messages[2].content, 'Follow-up');
    });

    it('maps max_output_tokens to max_tokens', () => {
      const body = {
        model: 'gpt-4o',
        input: 'Hi',
        max_output_tokens: 500,
      };
      const result = normalizeIncomingFormat('openai_responses', body);
      assert.equal(result.max_tokens, 500);
    });

    it('converts function tools', () => {
      const body = {
        model: 'gpt-4o',
        input: 'Hi',
        tools: [{
          type: 'function',
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        }],
      };
      const result = normalizeIncomingFormat('openai_responses', body);
      assert.equal(result.tools.length, 1);
      assert.equal(result.tools[0].type, 'function');
      assert.equal(result.tools[0].function.name, 'search');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  it('throws UnsupportedFormatError for unknown routeKind', () => {
    assert.throws(
      () => normalizeIncomingFormat('graphql', { model: 'x' }),
      (err) => err instanceof UnsupportedFormatError,
    );
  });

  it('throws BadRequestError for null body', () => {
    assert.throws(
      () => normalizeIncomingFormat('openai_chat', null),
      (err) => err instanceof BadRequestError,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Format Serializers
// ═══════════════════════════════════════════════════════════════════════

describe('serializeBufferedResponse', () => {
  const completion = {
    model: 'gpt-4o',
    choices: [{
      message: { role: 'assistant', content: 'Hello world' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  it('serializes to OpenAI chat format', () => {
    const result = serializeBufferedResponse(completion, 'openai_chat', 'req-1');
    assert.equal(result.id, 'req-1');
    assert.equal(result.object, 'chat.completion');
    assert.equal(result.choices[0].message.role, 'assistant');
    assert.equal(result.choices[0].message.content, 'Hello world');
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.usage.prompt_tokens, 10);
  });

  it('serializes to Anthropic messages format', () => {
    const result = serializeBufferedResponse(completion, 'anthropic_messages', 'req-2');
    assert.equal(result.id, 'req-2');
    assert.equal(result.type, 'message');
    assert.equal(result.role, 'assistant');
    assert.ok(result.content.length > 0);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hello world');
    assert.equal(result.stop_reason, 'end_turn');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  it('serializes to Responses API format', () => {
    const result = serializeBufferedResponse(completion, 'openai_responses', 'req-3');
    assert.equal(result.id, 'req-3');
    assert.equal(result.object, 'response');
    assert.equal(result.status, 'completed');
    assert.ok(result.output.length > 0);
    assert.equal(result.output[0].type, 'message');
    assert.equal(result.output[0].content[0].text, 'Hello world');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
  });

  it('serializes tool_calls for Anthropic format', () => {
    const tcCompletion = {
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = serializeBufferedResponse(tcCompletion, 'anthropic_messages', 'req-4');
    assert.equal(result.stop_reason, 'tool_use');
    const toolBlock = result.content.find(c => c.type === 'tool_use');
    assert.ok(toolBlock);
    assert.equal(toolBlock.name, 'search');
    assert.deepEqual(toolBlock.input, { q: 'test' });
  });

  it('serializes tool_calls for Responses format', () => {
    const tcCompletion = {
      model: 'gpt-4o',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = serializeBufferedResponse(tcCompletion, 'openai_responses', 'req-5');
    const fcItem = result.output.find(o => o.type === 'function_call');
    assert.ok(fcItem);
    assert.equal(fcItem.name, 'search');
    assert.equal(fcItem.arguments, '{"q":"test"}');
  });
});

describe('serializeStreamChunk', () => {
  it('serializes OpenAI chat stream chunk', () => {
    const chunk = {
      model: 'gpt-4o',
      choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
    };
    const result = JSON.parse(serializeStreamChunk(chunk, 'openai_chat', 'req-s1'));
    assert.equal(result.object, 'chat.completion.chunk');
    assert.equal(result.choices[0].delta.content, 'Hi');
  });

  it('serializes Anthropic stream chunk', () => {
    const chunk = {
      model: 'claude-3-sonnet',
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    };
    const result = JSON.parse(serializeStreamChunk(chunk, 'anthropic_messages', 'req-s2'));
    assert.equal(result.type, 'content_block_delta');
    assert.equal(result.delta.type, 'text_delta');
    assert.equal(result.delta.text, 'Hello');
  });

  it('serializes Anthropic finish chunk', () => {
    const chunk = {
      model: 'claude-3-sonnet',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    };
    const result = JSON.parse(serializeStreamChunk(chunk, 'anthropic_messages', 'req-s3'));
    assert.equal(result.type, 'message_delta');
    assert.equal(result.delta.stop_reason, 'end_turn');
  });

  it('serializes Responses stream chunk', () => {
    const chunk = {
      model: 'gpt-4o',
      choices: [{ delta: { content: 'World' }, finish_reason: null }],
    };
    const result = JSON.parse(serializeStreamChunk(chunk, 'openai_responses', 'req-s4'));
    assert.equal(result.type, 'response.output_text.delta');
    assert.equal(result.delta, 'World');
  });

  it('serializes Responses finish chunk', () => {
    const chunk = {
      model: 'gpt-4o',
      choices: [{ delta: {}, finish_reason: 'stop' }],
    };
    const result = JSON.parse(serializeStreamChunk(chunk, 'openai_responses', 'req-s5'));
    assert.equal(result.type, 'response.completed');
    assert.equal(result.response.status, 'completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Identity Resolution
// ═══════════════════════════════════════════════════════════════════════

describe('resolveIdentity', () => {
  it('extracts X-Soul-Id header', () => {
    const result = resolveIdentity({ 'x-soul-id': 'soul-123' }, '');
    assert.equal(result.soulId, 'soul-123');
  });

  it('extracts X-Agent-Name header', () => {
    const result = resolveIdentity({ 'x-agent-name': 'my-agent' }, '');
    assert.equal(result.agentName, 'my-agent');
  });

  it('extracts X-Soul-Agent header as agent name fallback', () => {
    const result = resolveIdentity({ 'x-soul-agent': 'coral-agent' }, '');
    assert.equal(result.agentName, 'coral-agent');
  });

  it('X-Agent-Name takes precedence over X-Soul-Agent', () => {
    const result = resolveIdentity({
      'x-agent-name': 'primary',
      'x-soul-agent': 'secondary',
    }, '');
    assert.equal(result.agentName, 'primary');
  });

  it('extracts X-Session-Id header', () => {
    const result = resolveIdentity({ 'x-session-id': 'sess-abc' }, '');
    assert.equal(result.explicitSessionId, 'sess-abc');
  });

  it('returns null for missing headers', () => {
    const result = resolveIdentity({}, '');
    assert.equal(result.soulId, null);
    assert.equal(result.explicitSessionId, null);
  });

  // ── User-Agent inference ──────────────────────────────────────

  it('infers Claude Code from User-Agent', () => {
    const result = resolveIdentity({}, 'Claude-Code/1.2.3');
    assert.equal(result.agentName, 'claude-code');
  });

  it('infers Cursor from User-Agent', () => {
    const result = resolveIdentity({}, 'Cursor/0.45.1');
    assert.equal(result.agentName, 'cursor');
  });

  it('infers Copilot from User-Agent', () => {
    const result = resolveIdentity({}, 'GitHub-Copilot/1.0');
    assert.equal(result.agentName, 'copilot');
  });

  it('infers Aider from User-Agent', () => {
    const result = resolveIdentity({}, 'Aider/0.30.0');
    assert.equal(result.agentName, 'aider');
  });

  it('infers Cline from User-Agent', () => {
    const result = resolveIdentity({}, 'Cline/2.0');
    assert.equal(result.agentName, 'cline');
  });

  it('infers Windsurf from User-Agent', () => {
    const result = resolveIdentity({}, 'Windsurf-Editor/1.0');
    assert.equal(result.agentName, 'windsurf');
  });

  it('infers Continue from User-Agent', () => {
    const result = resolveIdentity({}, 'Continue-Dev/1.5');
    assert.equal(result.agentName, 'continue');
  });

  it('infers OpenAI Python SDK from User-Agent', () => {
    const result = resolveIdentity({}, 'OpenAI-Python/1.0');
    assert.equal(result.agentName, 'openai-python');
  });

  it('infers OpenAI Node SDK from User-Agent', () => {
    const result = resolveIdentity({}, 'OpenAI-Node/4.0');
    assert.equal(result.agentName, 'openai-node');
  });

  it('falls back to unknown when no header or UA match', () => {
    const result = resolveIdentity({}, 'SomeRandomApp/1.0');
    assert.equal(result.agentName, 'unknown');
  });

  it('falls back to unknown with empty user-agent', () => {
    const result = resolveIdentity({}, '');
    assert.equal(result.agentName, 'unknown');
  });

  it('explicit header wins over User-Agent inference', () => {
    const result = resolveIdentity({ 'x-agent-name': 'my-bot' }, 'Claude-Code/1.0');
    assert.equal(result.agentName, 'my-bot');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Validator
// ═══════════════════════════════════════════════════════════════════════

describe('validateNormalizedRequest', () => {
  it('accepts a valid request', () => {
    assert.doesNotThrow(() => {
      validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });
  });

  it('rejects missing model', () => {
    assert.throws(
      () => validateNormalizedRequest({ messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => err instanceof ValidationError && err.message.includes('model'),
    );
  });

  it('rejects empty model string', () => {
    assert.throws(
      () => validateNormalizedRequest({ model: '   ', messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => err instanceof ValidationError && err.message.includes('empty'),
    );
  });

  it('rejects non-string model', () => {
    assert.throws(
      () => validateNormalizedRequest({ model: 123, messages: [{ role: 'user', content: 'Hi' }] }),
      (err) => err instanceof ValidationError && err.message.includes('model'),
    );
  });

  it('rejects missing messages', () => {
    assert.throws(
      () => validateNormalizedRequest({ model: 'gpt-4o' }),
      (err) => err instanceof ValidationError && err.message.includes('messages'),
    );
  });

  it('rejects empty messages array', () => {
    assert.throws(
      () => validateNormalizedRequest({ model: 'gpt-4o', messages: [] }),
      (err) => err instanceof ValidationError && err.message.includes('at least one'),
    );
  });

  it('rejects messages that are not an array', () => {
    assert.throws(
      () => validateNormalizedRequest({ model: 'gpt-4o', messages: 'not array' }),
      (err) => err instanceof ValidationError && err.message.includes('array'),
    );
  });

  it('rejects message without role', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ content: 'No role' }],
      }),
      (err) => err instanceof ValidationError && err.message.includes('role'),
    );
  });

  it('rejects message with invalid role', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'villain', content: 'Hi' }],
      }),
      (err) => err instanceof ValidationError && err.message.includes('role'),
    );
  });

  it('rejects message without content or tool_calls', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user' }],
      }),
      (err) => err instanceof ValidationError && err.message.includes('content or tool_calls'),
    );
  });

  it('accepts message with tool_calls but no content', () => {
    assert.doesNotThrow(() => {
      validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{
          role: 'assistant',
          tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        }],
      });
    });
  });

  it('accepts message with array content', () => {
    assert.doesNotThrow(() => {
      validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
        }],
      });
    });
  });

  it('rejects message with non-string, non-array content', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 42 }],
      }),
      (err) => err instanceof ValidationError && err.message.includes('content'),
    );
  });

  it('rejects tool message without tool_call_id', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'tool', content: 'result' }],
      }),
      (err) => err instanceof ValidationError && err.message.includes('tool_call_id'),
    );
  });

  it('rejects null parsed input', () => {
    assert.throws(
      () => validateNormalizedRequest(null),
      (err) => err instanceof ValidationError && err.message.includes('object'),
    );
  });

  it('validates temperature range', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 3,
      }),
      (err) => err instanceof ValidationError && err.message.includes('temperature'),
    );
  });

  it('validates top_p range', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        top_p: 1.5,
      }),
      (err) => err instanceof ValidationError && err.message.includes('top_p'),
    );
  });

  it('validates max_tokens is positive integer', () => {
    assert.throws(
      () => validateNormalizedRequest({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: -1,
      }),
      (err) => err instanceof ValidationError && err.message.includes('max_tokens'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Request Context
// ═══════════════════════════════════════════════════════════════════════

describe('createRequestContext', () => {
  function mockAppCtx() {
    return {
      config: {
        defaults: { requestIdPrefix: 'test-' },
        env: { BODY_LIMIT_BYTES: 5_242_880, SESSION_TIMEOUT_MINUTES: 30 },
      },
      pool: null,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      services: {},
      draining: false,
      snapshotGeneration: 0,
      startedAt: Date.now(),
    };
  }

  it('creates a context with a request ID', () => {
    const ctx = createRequestContext({ req: {}, res: {} }, mockAppCtx());
    assert.ok(ctx.requestId);
    assert.ok(ctx.requestId.startsWith('test-'));
  });

  it('initializes startedAt timestamp', () => {
    const before = Date.now();
    const ctx = createRequestContext({ req: {}, res: {} }, mockAppCtx());
    assert.ok(ctx.startedAt >= before);
    assert.ok(ctx.startedAt <= Date.now());
  });

  it('attaches req and res', () => {
    const req = { headers: {} };
    const res = { writeHead() {} };
    const ctx = createRequestContext({ req, res }, mockAppCtx());
    assert.equal(ctx.req, req);
    assert.equal(ctx.res, res);
  });

  it('attaches appCtx', () => {
    const appCtx = mockAppCtx();
    const ctx = createRequestContext({ req: {}, res: {} }, appCtx);
    assert.equal(ctx.appCtx, appCtx);
  });

  it('initializes pipeline fields to null', () => {
    const ctx = createRequestContext({ req: {}, res: {} }, mockAppCtx());
    assert.equal(ctx.body, null);
    assert.equal(ctx.identity, null);
    assert.equal(ctx.apiKey, null);
    assert.equal(ctx.session, null);
    assert.equal(ctx.normalizedRequest, null);
    assert.equal(ctx.resolvedModel, null);
    assert.equal(ctx.snapshot, null);
    assert.equal(ctx.completion, null);
    assert.equal(ctx.routeKind, null);
    assert.equal(ctx.responseFormat, null);
  });

  it('initializes timings and metadata', () => {
    const ctx = createRequestContext({ req: {}, res: {} }, mockAppCtx());
    assert.deepEqual(ctx.timings, {});
    assert.deepEqual(ctx.metadata, {});
  });

  it('initializes middlewareState as a Map', () => {
    const ctx = createRequestContext({ req: {}, res: {} }, mockAppCtx());
    assert.ok(ctx.middlewareState instanceof Map);
    assert.equal(ctx.middlewareState.size, 0);
  });
});
