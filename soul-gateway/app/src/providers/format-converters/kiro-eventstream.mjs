/**
 * Kiro Event Stream Format Converter
 *
 * Converts between OpenAI chat completion format and Kiro's proprietary format:
 *   - Request: OpenAI messages -> conversationState with history pairs
 *   - Response: AWS binary event stream -> typed chunks (text_delta, tool_calls_delta, done, error)
 *
 * Uses node:https (not fetch) because the binary event stream protocol needs raw Buffer access.
 * Zero npm dependencies.
 *
 * Ported from kiro-gateway/server.mjs.
 */

import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { createLogger } from '../../utils/logger.mjs';

const log = createLogger('kiro-eventstream');

const KIRO_API_HOST = 'q.us-east-1.amazonaws.com';
const GENERATE_URL = `https://${KIRO_API_HOST}/generateAssistantResponse`;

// ---------------------------------------------------------------------------
// Model name normalization (ported from kiro-gateway lines 419-426)
// ---------------------------------------------------------------------------

/**
 * Normalize model name: convert trailing version dashes to dots.
 *   claude-sonnet-4-5  -> claude-sonnet-4.5
 *   claude-opus-4-6    -> claude-opus-4.6
 *   claude-3-7-sonnet  -> claude-3.7-sonnet
 */
function normalizeModelName(name) {
  return name.replace(/(\d)-(\d)(?=-|$)/g, '$1.$2');
}

// ---------------------------------------------------------------------------
// Tool conversion (ported from kiro-gateway lines 546-557)
// ---------------------------------------------------------------------------

/**
 * Convert OpenAI tool definitions to Kiro format.
 */
function convertToolsToKiro(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;
  return tools
    .filter((t) => t.type === 'function' && t.function)
    .map((t) => ({
      toolSpecification: {
        name: t.function.name,
        description: t.function.description || '',
        inputSchema: { json: t.function.parameters || {} },
      },
    }));
}

// ---------------------------------------------------------------------------
// Safe JSON parse helper
// ---------------------------------------------------------------------------

function safeParseJSON(str) {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

// ---------------------------------------------------------------------------
// Request conversion (ported from kiro-gateway lines 562-701)
// ---------------------------------------------------------------------------

/**
 * Build the Kiro conversationState from an OpenAI chat request body.
 */
function buildKiroRequest(body) {
  const model = normalizeModelName(body.model || 'claude-sonnet-4.5');
  const messages = body.messages || [];
  const tools = convertToolsToKiro(body.tools);

  // Separate system messages
  let systemPrefix = '';
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrefix += (systemPrefix ? '\n\n' : '') +
        (typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Group tool results that follow assistant tool_calls
  const processed = [];
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i];
    if (msg.role === 'tool') {
      // Attach to previous entry's toolResults
      if (processed.length > 0) {
        const prev = processed[processed.length - 1];
        if (!prev._toolResults) prev._toolResults = [];
        prev._toolResults.push({
          toolUseId: msg.tool_call_id || '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          status: 'SUCCESS',
        });
      }
      continue;
    }
    processed.push({ ...msg });
  }

  // Find the last user message — it becomes currentMessage, the rest is history
  let currentUserIdx = -1;
  for (let i = processed.length - 1; i >= 0; i--) {
    if (processed[i].role === 'user') {
      currentUserIdx = i;
      break;
    }
  }

  // Build history from everything except the current user message
  const historyItems = [];
  for (let i = 0; i < processed.length; i++) {
    if (i === currentUserIdx) continue;
    const msg = processed[i];

    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const userMsg = {
        userInputMessage: {
          content: (i === 0 && systemPrefix) ? systemPrefix + '\n\n' + content : content,
          modelId: model,
          origin: 'AI_EDITOR',
        },
      };
      if (msg._toolResults && msg._toolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: msg._toolResults,
        };
      }
      historyItems.push(userMsg);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        historyItems.push({
          assistantResponseMessage: {
            content: msg.content || '',
            toolUses: msg.tool_calls.map((tc) => ({
              name: tc.function?.name || '',
              input: safeParseJSON(tc.function?.arguments),
              toolUseId: tc.id || '',
            })),
          },
        });
      } else {
        historyItems.push({
          assistantResponseMessage: {
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
          },
        });
      }
    }
  }

  // Build currentMessage
  let lastUserContent = '';
  let lastUserToolResults = [];

  if (currentUserIdx >= 0) {
    const msg = processed[currentUserIdx];
    const rawContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    lastUserContent = (currentUserIdx === 0 && systemPrefix) ? systemPrefix + '\n\n' + rawContent : rawContent;
    if (msg._toolResults) {
      lastUserToolResults = msg._toolResults;
    }
  } else {
    // No user message at all
    lastUserContent = systemPrefix || '';
  }

  const currentMessage = {
    userInputMessage: {
      content: lastUserContent,
      modelId: model,
      origin: 'AI_EDITOR',
      userInputMessageContext: {},
    },
  };

  if (tools && tools.length > 0) {
    currentMessage.userInputMessage.userInputMessageContext.tools = tools;
  }
  if (lastUserToolResults.length > 0) {
    currentMessage.userInputMessage.userInputMessageContext.toolResults = lastUserToolResults;
  }

  // Clean up empty context
  if (Object.keys(currentMessage.userInputMessage.userInputMessageContext).length === 0) {
    delete currentMessage.userInputMessage.userInputMessageContext;
  }

  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage,
      history: historyItems,
    },
  };
}

// ---------------------------------------------------------------------------
// AWS Event Stream binary parser (ported from kiro-gateway lines 435-540)
//
// Wire format per message:
//   [4 bytes] total_length (big-endian uint32)
//   [4 bytes] headers_length (big-endian uint32)
//   [4 bytes] prelude_crc (big-endian uint32)
//   [headers_length bytes] headers
//   [payload_length bytes] payload   (payload_length = total_length - headers_length - 16)
//   [4 bytes] message_crc (big-endian uint32)
// ---------------------------------------------------------------------------

/**
 * Parse AWS event stream header bytes into an array of { name, type, value }.
 */
function parseEventStreamHeaders(buf) {
  const headers = [];
  let offset = 0;
  while (offset < buf.length) {
    const nameLen = buf.readUInt8(offset);
    offset += 1;
    const name = buf.subarray(offset, offset + nameLen).toString('utf-8');
    offset += nameLen;
    const headerType = buf.readUInt8(offset);
    offset += 1;

    let value;
    switch (headerType) {
      case 0: // bool true
        value = true;
        break;
      case 1: // bool false
        value = false;
        break;
      case 2: // byte
        value = buf.readUInt8(offset);
        offset += 1;
        break;
      case 3: // short
        value = buf.readInt16BE(offset);
        offset += 2;
        break;
      case 4: // int
        value = buf.readInt32BE(offset);
        offset += 4;
        break;
      case 5: // long (8 bytes)
        value = buf.readBigInt64BE(offset);
        offset += 8;
        break;
      case 6: // bytes
      {
        const bytesLen = buf.readUInt16BE(offset);
        offset += 2;
        value = buf.subarray(offset, offset + bytesLen);
        offset += bytesLen;
        break;
      }
      case 7: // string
      {
        const strLen = buf.readUInt16BE(offset);
        offset += 2;
        value = buf.subarray(offset, offset + strLen).toString('utf-8');
        offset += strLen;
        break;
      }
      case 8: // timestamp
        value = Number(buf.readBigInt64BE(offset));
        offset += 8;
        break;
      case 9: // uuid
        value = buf.subarray(offset, offset + 16).toString('hex');
        offset += 16;
        break;
      default:
        // Unknown header type — bail out
        return headers;
    }
    headers.push({ name, type: headerType, value });
  }
  return headers;
}

/**
 * Parse a single event-stream message from a buffer at the given offset.
 * Returns { totalLength, headers, payload } or null if the buffer is too short.
 */
function parseEventStreamMessage(buf, offset = 0) {
  if (buf.length - offset < 12) return null; // prelude is 12 bytes minimum

  const totalLength = buf.readUInt32BE(offset);
  const headersLength = buf.readUInt32BE(offset + 4);
  // bytes 8-11: prelude CRC (skip)

  if (buf.length - offset < totalLength) return null; // incomplete message

  const headersStart = offset + 12;
  const headersBuf = buf.subarray(headersStart, headersStart + headersLength);
  const headers = parseEventStreamHeaders(headersBuf);

  const payloadLength = totalLength - headersLength - 16; // 12 prelude + 4 message CRC
  const payloadStart = headersStart + headersLength;
  const payload = buf.subarray(payloadStart, payloadStart + payloadLength);

  return { totalLength, headers, payload };
}

/**
 * Extract all complete event-stream messages from a buffer.
 */
function parseAllEvents(buf) {
  const events = [];
  let offset = 0;
  while (offset < buf.length) {
    const msg = parseEventStreamMessage(buf, offset);
    if (!msg) break;
    events.push(msg);
    offset += msg.totalLength;
  }
  return events;
}

// ---------------------------------------------------------------------------
// HTTPS request helper — returns { statusCode, headers, stream }
// Uses node:https for raw Buffer access needed by binary event stream.
// Ported from kiro-gateway lines 239-268.
// ---------------------------------------------------------------------------

function httpsRequestStream(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOpts, (res) => {
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        stream: res,
      });
    });

    req.on('error', reject);
    req.setTimeout(300_000, () => {
      req.destroy(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Consume an entire readable stream into a single Buffer.
 */
function consumeStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Response conversion — parse binary event stream into typed chunks
//
// Typed chunk interface (matches fetchLLMStreaming from llm-client.mjs):
//   { type: 'text_delta', text }
//   { type: 'tool_calls_delta', toolCalls }
//   { type: 'done', fullText, toolCalls, usage, stopReason }
//   { type: 'error', error }
// ---------------------------------------------------------------------------

/**
 * Extract event type from an event-stream message's headers.
 */
function getEventType(headers) {
  for (const h of headers) {
    if (h.name === ':event-type') return h.value;
  }
  return '';
}

/**
 * Extract message type from an event-stream message's headers.
 */
function getMessageType(headers) {
  for (const h of headers) {
    if (h.name === ':message-type') return h.value;
  }
  return '';
}

/**
 * Process a single parsed event-stream message.
 * Returns an array of typed chunks to yield (may be empty, one, or multiple).
 */
function processEvent(msg) {
  const chunks = [];

  if (msg.payload.length === 0) return chunks;

  const messageType = getMessageType(msg.headers);

  // Check for error events
  if (messageType === 'exception' || messageType === 'error') {
    try {
      const payload = JSON.parse(msg.payload.toString('utf-8'));
      chunks.push({
        type: 'error',
        error: new Error(payload.message || payload.Message || JSON.stringify(payload)),
      });
    } catch {
      chunks.push({
        type: 'error',
        error: new Error(`Kiro stream error: ${msg.payload.toString('utf-8').slice(0, 200)}`),
      });
    }
    return chunks;
  }

  const eventType = getEventType(msg.headers);

  try {
    const payload = JSON.parse(msg.payload.toString('utf-8'));

    // Handle assistantResponseEvent — text content and tool uses
    if (eventType === 'assistantResponseEvent' || eventType === 'AssistantResponseEvent' || payload.assistantResponseEvent) {
      const evt = payload.assistantResponseEvent || payload;

      if (evt.content) {
        chunks.push({ type: 'text_delta', text: evt.content });
      }

      // toolUse is collected and emitted in the done chunk
      // but we also emit a tool_calls_delta for incremental streaming
      if (evt.toolUse) {
        const tu = evt.toolUse;
        chunks.push({
          type: 'tool_calls_delta',
          toolCalls: [{
            index: 0,
            id: tu.toolUseId || `call_${randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
              name: tu.name || '',
              arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}),
            },
          }],
        });
      }
    }

    // Handle toolUseEvent — streamed tool call (name, input fragments, stop)
    if (eventType === 'toolUseEvent') {
      // Kiro streams tool calls as separate events with incremental input
      // { name, toolUseId, input?, stop? }
      // We emit these as tool_calls_delta chunks — the accumulator in dispatch() assembles them
      if (!payload.stop) {
        chunks.push({
          type: 'tool_calls_delta',
          toolCalls: [{
            index: 0,
            id: payload.toolUseId || `call_${randomBytes(8).toString('hex')}`,
            type: 'function',
            function: {
              name: payload.name || '',
              arguments: payload.input || '',
            },
          }],
        });
      }
      // When stop=true, the tool call is complete (final chunk signals done)
    }

    // Handle codeEvent — code content treated as text
    if (payload.codeEvent?.content) {
      chunks.push({ type: 'text_delta', text: payload.codeEvent.content });
    }
  } catch {
    // Not valid JSON — skip
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Main dispatch — the format converter entry point
// ---------------------------------------------------------------------------

export default {
  name: 'kiro-eventstream',

  /**
   * Dispatch a request to the Kiro API, converting formats in both directions.
   *
   * @param {Array} messages - OpenAI chat messages
   * @param {object} payload - Full OpenAI request payload (model, messages, tools, etc.)
   * @param {string} baseUrl - Ignored (Kiro endpoint is fixed)
   * @param {object} headers - Auth headers from adapter.getHeaders()
   * @param {AbortSignal} [signal] - Optional abort signal
   * @yields {{ type: 'text_delta', text } | { type: 'tool_calls_delta', toolCalls } | { type: 'done', fullText, toolCalls, usage, stopReason } | { type: 'error', error }}
   */
  async* dispatch(messages, payload, baseUrl, headers, signal) {
    // Build Kiro-format request from OpenAI payload
    const kiroPayload = buildKiroRequest(payload);

    // Merge auth headers with required Content-Type
    const requestHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.amazon.eventstream',
      ...headers,
    };

    log.info('Kiro request', {
      url: GENERATE_URL,
      model: payload.model,
      hasTools: !!(payload.tools?.length),
      toolCount: payload.tools?.length || 0,
      messageCount: messages.length,
      kiroPayloadKeys: Object.keys(kiroPayload.conversationState || {}),
      hasKiroTools: !!kiroPayload.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools,
    });

    let kiroRes;
    try {
      kiroRes = await httpsRequestStream(GENERATE_URL, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(kiroPayload),
      });
    } catch (err) {
      throw new Error(`Kiro connection failed: ${err.message}`);
    }

    // Handle non-200 responses
    if (kiroRes.statusCode !== 200) {
      const errBody = await consumeStream(kiroRes.stream);
      const errText = errBody.toString('utf-8').slice(0, 500);

      if (kiroRes.statusCode === 401 || kiroRes.statusCode === 403) {
        throw new Error(`API Error (${kiroRes.statusCode}): Kiro authentication failed — ${errText}`);
      }
      if (kiroRes.statusCode === 429) {
        throw new Error(`API Error (429): Rate limited by Kiro API — ${errText}`);
      }
      throw new Error(`API Error (${kiroRes.statusCode}): Kiro upstream error — ${errText}`);
    }

    // Wire up abort signal to destroy the stream
    if (signal) {
      signal.addEventListener('abort', () => {
        kiroRes.stream.destroy(new Error('Request aborted'));
      }, { once: true });
    }

    // Parse the binary event stream as chunks arrive
    let buffer = Buffer.alloc(0);
    let fullText = '';
    const toolCallAccum = [];
    let hadError = false;

    // Wrap the node stream in an async iterator
    const streamChunks = streamToAsyncIterator(kiroRes.stream);

    for await (const chunk of streamChunks) {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse all complete messages from the buffer
      let offset = 0;
      while (offset < buffer.length) {
        const msg = parseEventStreamMessage(buffer, offset);
        if (!msg) break;
        offset += msg.totalLength;

        const eventType = getEventType(msg.headers);
        const messageType = getMessageType(msg.headers);
        const payloadStr = msg.payload.toString('utf-8').slice(0, 300);
        log.info('Kiro event', { eventType, messageType, payloadLen: msg.payload.length, payload: payloadStr });

        const typedChunks = processEvent(msg);
        for (const tc of typedChunks) {
          if (tc.type === 'text_delta') {
            fullText += tc.text;
          }
          if (tc.type === 'tool_calls_delta') {
            // Accumulate tool calls — append input fragments incrementally
            for (const toolCall of tc.toolCalls) {
              const idx = toolCall.index ?? 0;
              if (!toolCallAccum[idx]) {
                toolCallAccum[idx] = {
                  id: toolCall.id || '',
                  type: 'function',
                  function: { name: toolCall.function.name || '', arguments: '' },
                };
              }
              // Update name and id if provided (first fragment has them)
              if (toolCall.id) toolCallAccum[idx].id = toolCall.id;
              if (toolCall.function.name) toolCallAccum[idx].function.name = toolCall.function.name;
              // Append arguments fragment
              toolCallAccum[idx].function.arguments += toolCall.function.arguments || '';
            }
          }
          if (tc.type === 'error') {
            hadError = true;
          }
          yield tc;
        }
      }

      // Keep the unparsed remainder
      buffer = buffer.subarray(offset);
    }

    // Yield the final done chunk unless we already errored out
    if (!hadError) {
      const toolCalls = toolCallAccum.filter(Boolean);
      yield {
        type: 'done',
        fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
        usage: null, // Kiro does not return usage metrics
        stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Node.js Readable stream to an async iterator of Buffers.
 */
function streamToAsyncIterator(stream) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      let error = null;
      const pending = [];
      let waiting = null;

      stream.on('data', (chunk) => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value: chunk, done: false });
        } else {
          pending.push(chunk);
        }
      });

      stream.on('end', () => {
        done = true;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value: undefined, done: true });
        }
      });

      stream.on('error', (err) => {
        error = err;
        done = true;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve({ value: undefined, done: true });
        }
      });

      return {
        next() {
          if (error) {
            return Promise.resolve({ value: undefined, done: true });
          }
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift(), done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };
}

// Exported for testing
export { buildKiroRequest, convertToolsToKiro, normalizeModelName };
export { parseEventStreamHeaders, parseEventStreamMessage, parseAllEvents };
export { httpsRequestStream };
