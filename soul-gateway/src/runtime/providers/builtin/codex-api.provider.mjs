/**
 * OpenAI Codex provider plugin.
 *
 * Codex uses the ChatGPT backend Responses API at /responses for all
 * supported models. It authenticates with OAuth bearer tokens.
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
import * as achillesResponses from 'achillesAgentLib/utils/LLMProviders/providers/openaiResponses.mjs';
import { createAchillesExecutionHandle, getCredentialToken } from '../achilles/bridge.mjs';

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

const KNOWN_MODELS = [
  { modelId: 'gpt-5.4', displayName: 'GPT-5.4', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.2', displayName: 'GPT-5.2', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-4.1', displayName: 'GPT-4.1', contextWindow: 1000000, maxOutputTokens: 32768, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, supportsTools: true, supportsStreaming: true, supportsVision: true },
  { modelId: 'o3', displayName: 'o3', contextWindow: 200000, maxOutputTokens: 100000, supportsTools: true, supportsStreaming: true, supportsVision: false },
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
    const token = ctx.credentialLease?.oauth?.accessToken || ctx.credentialLease?.secret;
    if (!token) return { ok: false, detail: 'No Codex OAuth token configured' };

    try {
      await httpGet('https://api.openai.com/v1/models', {
        Authorization: `Bearer ${token}`,
      });
      return { ok: true, detail: 'Connected to OpenAI Codex OAuth' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  },

  async execute(ctx) {
    const { request: normalizedReq, resolvedModel, providerRecord, credentialLease, signal } = ctx;
    const baseUrl = providerRecord.base_url || 'https://chatgpt.com/backend-api/codex';
    const token = getCredentialToken(credentialLease);
    const headers = {
      'User-Agent': 'codex-cli/1.0.0',
      Accept: 'text/event-stream',
    };
    const params = { stream: true };
    if (normalizedReq.max_tokens != null) params.max_output_tokens = normalizedReq.max_tokens;
    if (normalizedReq.temperature != null) params.temperature = normalizedReq.temperature;
    if (normalizedReq.top_p != null) params.top_p = normalizedReq.top_p;
    if (normalizedReq.tools && normalizedReq.tools.length > 0) params.tools = normalizedReq.tools;

    return createAchillesExecutionHandle(ctx, achillesResponses, {
      model: resolvedModel.provider_model_id || resolvedModel.model_key,
      apiKey: token,
      baseURL: baseUrl,
      signal,
      params,
      headers,
    });
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

async function* makeResponsesStream(url, headers, payload, signal) {
  const response = await doRequest(url, 'POST', headers, payload, signal);

  if (response.statusCode >= 400) {
    const body = await collectBody(response);
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* ignore */ }
    const err = new Error(`Codex API error: ${response.statusCode}`);
    err.status = response.statusCode;
    err.body = parsed;
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

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = client(parsed, { method: 'GET', headers }, async (res) => {
      const body = await collectBody(res);
      if (res.statusCode >= 400) {
        const err = new Error(`HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        err.body = body;
        reject(err);
        return;
      }
      resolve(body);
    });
    req.on('error', reject);
    req.end();
  });
}
