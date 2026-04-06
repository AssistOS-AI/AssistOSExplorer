/**
 * OpenAI Codex provider plugin.
 *
 * Codex uses the ChatGPT backend Responses API at
 * `chatgpt.com/backend-api/codex/responses`. Important protocol quirks
 * (validated against live traffic 2026-04-06):
 *
 *  1. The endpoint path is `/responses` — NOT `/v1/responses` like
 *     the standard OpenAI Responses API.
 *  2. The payload MUST include an `instructions` field (the Codex
 *     backend rejects the request with 400 "Instructions are required"
 *     otherwise). System messages from chat completions are extracted
 *     into this field and stripped from `input`.
 *  3. `max_output_tokens` is NOT a supported parameter — Codex rejects
 *     it with 400 "Unsupported parameter: max_output_tokens".
 *  4. Only gpt-5 family models are accepted (gpt-5, gpt-5.x,
 *     gpt-5.x-codex). gpt-4o, o3, o4-mini etc. are explicitly
 *     rejected with "not supported when using Codex with a ChatGPT
 *     account".
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ProviderContentPolicyError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderServerError,
} from '../../../core/errors.mjs';
import { HTTP_STATUS } from '../../../core/constants.mjs';
import {
  classifyTransportOrServerError,
  getProviderErrorType,
  getProviderMessage,
  getProviderStatus,
  looksLikeContentPolicyError,
  looksLikeQuotaError,
} from '../error-helpers.mjs';
import * as copilotConverter from '../converters/copilot-converter.mjs';
import { getCredentialToken } from '../achilles/bridge.mjs';
import { toGatewayNormalizedStream } from '../achilles/bridge.mjs';

const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

const manifest = {
  key: 'codex-api',
  kind: 'external_api',
  authStrategy: 'oauth',
  supportsStreaming: true,
  supportsTools: true,
  supportedFormats: ['openai_chat', 'openai_responses'],
  displayName: 'OpenAI Codex',
  defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
  oauthAdapterKey: 'openai-codex',
};

// Models confirmed against the live Codex backend on 2026-04-06.
// Codex with a ChatGPT account only accepts gpt-5.x family models; it
// rejects gpt-4o, gpt-4.1, o3, o4-mini, codex-mini-latest etc. with a
// 400 "not supported when using Codex with a ChatGPT account".
const KNOWN_MODELS = [
  { modelId: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.2', displayName: 'GPT-5.2', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1', displayName: 'GPT-5.1', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1-codex', displayName: 'GPT-5.1 Codex', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5', displayName: 'GPT-5', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5-codex', displayName: 'GPT-5 Codex', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5-codex-mini', displayName: 'GPT-5 Codex Mini', contextWindow: 1000000, supportsTools: true, supportsStreaming: true, supportsVision: true },
];

export const providerPlugin = {
  manifest,

  async init() {},

  async shutdown() {},

  validateProviderRecord() {},

  validateModelRecord(modelRecord) {
    if (!modelRecord.provider_model_id && !modelRecord.model_key) {
      throw new Error('Codex model requires provider_model_id or model_key');
    }
  },

  async discoverModels() {
    return KNOWN_MODELS;
  },

  async testConnection(ctx) {
    // The Codex OAuth token is issued with OIDC scopes
    // (openid/email/profile/offline_access) and is only accepted by
    // the ChatGPT backend API at chatgpt.com/backend-api/codex. It is
    // NOT accepted by api.openai.com/v1/models — that endpoint will
    // return 401/403 even for a perfectly valid, unexpired token.
    // Mirroring the old gateway's behaviour, we validate the lease
    // itself (presence + non-expired) rather than making a live call
    // that is known to fail.
    const lease = ctx.credentialLease?.oauth;
    const token = lease?.accessToken || ctx.credentialLease?.secret;
    if (!token) return { ok: false, detail: 'No Codex OAuth token configured' };

    if (lease?.expiresAt) {
      const expiresAtMs = new Date(lease.expiresAt).getTime();
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        return { ok: false, detail: 'Codex OAuth token expired — reconnect from the Auth panel' };
      }
    }

    return { ok: true, detail: 'Codex OAuth credentials present' };
  },

  async execute(ctx) {
    const { request: normalizedReq, resolvedModel, providerRecord, credentialLease, signal, requestId } = ctx;
    const baseUrl = providerRecord.base_url || 'https://chatgpt.com/backend-api/codex';
    const responsesUrl = new URL(baseUrl.replace(/\/+$/, '') + '/responses');
    const token = getCredentialToken(credentialLease);
    const model = resolvedModel.provider_model_id || resolvedModel.model_key;

    const payload = buildCodexPayload(normalizedReq, model);

    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'codex-cli/1.0.0',
    };

    const rawStream = makeResponsesStream(
      responsesUrl,
      headers,
      JSON.stringify(payload),
      signal,
    );

    const stream = toGatewayNormalizedStream(rawStream, { requestId, model });

    return {
      accountId: credentialLease?.accountId || null,
      stream,
      abort: async () => {},
    };
  },

  classifyError(error) {
    const status = getProviderStatus(error);
    const errorType = getProviderErrorType(error);
    const message = getProviderMessage(error);

    if (status === HTTP_STATUS.UNAUTHORIZED || status === HTTP_STATUS.FORBIDDEN) {
      return new ProviderAuthError('codex', message || 'Codex auth failed');
    }
    if (status === HTTP_STATUS.NOT_FOUND) {
      return new ProviderModelNotFoundError('codex', message || 'unknown');
    }
    if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
      if (errorType === 'insufficient_quota' || looksLikeQuotaError(message)) {
        return new ProviderQuotaError('codex');
      }
      return new ProviderRateLimitError('codex');
    }
    if (status === HTTP_STATUS.BAD_REQUEST && looksLikeContentPolicyError(message)) {
      return new ProviderContentPolicyError('codex');
    }
    if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
      return classifyTransportOrServerError('codex', error, status);
    }
    return classifyTransportOrServerError('codex', error);
  },
};

/**
 * Build the Codex Responses API request body from a normalized chat
 * completion request.
 *
 * Extracts system messages into the required top-level `instructions`
 * field, strips them from `input`, and maps the remaining user /
 * assistant / tool messages into the Responses API content shape.
 * `max_output_tokens` is deliberately NOT passed through — Codex
 * rejects it as an unsupported parameter.
 *
 * Exported for unit testing; also consumed internally by `execute`.
 *
 * @param {object} normalizedReq  Gateway-normalized chat completion
 * @param {string} model          Provider model id (e.g. 'gpt-5.4')
 * @returns {object}              Request body for POST /responses
 */
export function buildCodexPayload(normalizedReq, model) {
  const messages = normalizedReq.messages || [];
  const { instructions, input } = splitSystemMessages(messages);

  const payload = {
    model,
    instructions: instructions || DEFAULT_INSTRUCTIONS,
    input,
    stream: true,
    store: false,
  };

  if (normalizedReq.temperature != null) payload.temperature = normalizedReq.temperature;
  if (normalizedReq.top_p != null) payload.top_p = normalizedReq.top_p;
  if (normalizedReq.tools && normalizedReq.tools.length > 0) {
    payload.tools = normalizedReq.tools.map(convertToolForCodex);
  }

  return payload;
}

/**
 * Split chat messages into Codex-shaped `instructions` (from system
 * messages) and `input` (everything else, with content-part mapping).
 *
 * Exported for unit testing.
 *
 * @param {Array<object>} messages
 * @returns {{ instructions: string, input: Array<object> }}
 */
export function splitSystemMessages(messages) {
  const systemParts = [];
  const input = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      if (text) systemParts.push(text);
      continue;
    }

    input.push({
      role: msg.role === 'assistant' ? 'assistant' : (msg.role === 'tool' ? 'tool' : 'user'),
      content: convertMessageContent(msg.content),
    });
  }

  return {
    instructions: systemParts.join('\n\n'),
    input,
  };
}

/**
 * Map chat completion message content into the Responses API content
 * shape. Strings pass through unchanged (Codex accepts raw strings);
 * content-part arrays are mapped to the `input_text` / `input_image`
 * variants the Responses API expects.
 *
 * @param {string|Array<object>|any} content
 * @returns {string|Array<object>}
 */
function convertMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'input_text', text: String(part ?? '') };
    if (part.type === 'text') return { type: 'input_text', text: part.text || '' };
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url || '';
      return { type: 'input_image', image_url: url };
    }
    return part;
  });
}

/**
 * Map a chat-completions tool definition to the Responses API shape.
 *
 * @param {object} tool
 * @returns {object}
 */
function convertToolForCodex(tool) {
  if (tool?.type === 'function' && tool.function) {
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description || '',
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    };
  }
  return tool;
}

async function* makeResponsesStream(url, headers, payload, signal) {
  const response = await doRequest(url, 'POST', headers, payload, signal);

  if (response.statusCode >= 400) {
    const body = await collectBody(response);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const detail = parsed?.detail
      || parsed?.error?.message
      || parsed?.message
      || (typeof body === 'string' ? body.slice(0, 300) : '');
    const err = new Error(`Codex API error (${response.statusCode}): ${detail}`);
    err.status = response.statusCode;
    err.body = parsed || { raw: body };
    throw err;
  }

  const converterState = {};
  for await (const event of parseSSE(response)) {
    let parsed;
    try { parsed = JSON.parse(event.data); } catch { continue; }

    if (event.event && !parsed.type) {
      parsed.type = event.event;
    }

    const normalized = copilotConverter.fromProviderChunk(parsed, converterState, 'responses');
    for (const chunk of normalized) {
      yield chunk;
    }
  }
}

function doRequest(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? httpsRequest : httpRequest;
    const req = client(url, { method, headers, signal }, resolve);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function* parseSSE(res) {
  let buffer = '';

  for await (const chunk of res) {
    buffer += chunk.toString('utf8');
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';

    for (const frame of frames) {
      let event = '';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) {
        yield { event, data: dataLines.join('\n') };
      }
    }
  }
}

function collectBody(res) {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}
