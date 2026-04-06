/**
 * OpenAI Codex provider plugin.
 *
 * Codex uses the ChatGPT backend Responses API at
 * `chatgpt.com/backend-api/codex/responses`. The transport layer lives
 * in achillesAgentLib's `openaiResponses.mjs` — this plugin is a thin
 * wrapper that supplies the Codex-specific payload shape through
 * `createAchillesExecutionHandle`.
 *
 * Protocol quirks (validated against live traffic 2026-04-06):
 *
 *  1. The endpoint path is `/responses` — NOT `/v1/responses` like the
 *     standard OpenAI Responses API. achilles's `resolveResponsesURL`
 *     detects the `/backend-api/` segment and appends `/responses`
 *     directly, so we just pass the provider's `base_url` through.
 *  2. The payload MUST include an `instructions` field (the Codex
 *     backend rejects the request with 400 "Instructions are required"
 *     otherwise). We extract system messages from the chat request
 *     into this field and rely on achilles to strip system/developer
 *     messages from `input` when `params.instructions` is set.
 *  3. `max_output_tokens` is NOT a supported parameter — Codex rejects
 *     it with 400 "Unsupported parameter: max_output_tokens". This
 *     plugin deliberately never sets it, even when the normalized
 *     request carries `max_tokens`.
 *  4. Only gpt-5 family models are accepted (gpt-5, gpt-5.x,
 *     gpt-5.x-codex). gpt-4o, gpt-4.1, o3, o4-mini, codex-mini-latest
 *     are explicitly rejected by the backend with "not supported when
 *     using Codex with a ChatGPT account" and are excluded from
 *     `KNOWN_MODELS`.
 */

import {
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ProviderContentPolicyError,
  ProviderModelNotFoundError,
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
import * as achillesResponses from 'achillesAgentLib/utils/LLMProviders/providers/openaiResponses.mjs';
import { createAchillesExecutionHandle, getCredentialToken } from '../achilles/bridge.mjs';

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
    const { request: normalizedReq, resolvedModel, providerRecord, credentialLease, signal } = ctx;
    const baseURL = providerRecord.base_url || 'https://chatgpt.com/backend-api/codex';
    const model = resolvedModel.provider_model_id || resolvedModel.model_key;

    return createAchillesExecutionHandle(ctx, achillesResponses, {
      model,
      apiKey: getCredentialToken(credentialLease),
      baseURL,
      signal,
      params: buildCodexParams(normalizedReq),
      headers: {
        Accept: 'text/event-stream',
        'User-Agent': 'codex-cli/1.0.0',
      },
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

/**
 * Build the Codex-specific `params` object that is merged into the
 * Responses API payload by achillesAgentLib.
 *
 * Responsibilities:
 *  - Extract system messages from the chat request into the required
 *    top-level `instructions` field (achilles strips them from
 *    `input` when `instructions` is set).
 *  - Fall back to `DEFAULT_INSTRUCTIONS` when the caller hasn't
 *    supplied any system prompt — Codex rejects empty-string
 *    instructions in practice, so we always send a non-empty value.
 *  - Forward `temperature`, `top_p`, and `tools` when present.
 *  - Deliberately NEVER set `max_output_tokens` (Codex rejects it).
 *  - Set `store: false` to match the reference Codex CLI client.
 *
 * Exported for unit testing.
 *
 * @param {object} normalizedReq  Gateway-normalized chat completion
 * @returns {object}              Params merged into the achilles payload
 */
export function buildCodexParams(normalizedReq) {
  const instructions = extractInstructions(normalizedReq?.messages || []);
  const params = {
    store: false,
    instructions: instructions || DEFAULT_INSTRUCTIONS,
  };

  if (normalizedReq?.temperature != null) params.temperature = normalizedReq.temperature;
  if (normalizedReq?.top_p != null) params.top_p = normalizedReq.top_p;
  if (Array.isArray(normalizedReq?.tools) && normalizedReq.tools.length > 0) {
    params.tools = normalizedReq.tools;
  }
  // NOTE: max_output_tokens is deliberately omitted. Codex rejects it
  // with 400 "Unsupported parameter: max_output_tokens" even though
  // the standard OpenAI Responses API accepts it.

  return params;
}

/**
 * Extract and concatenate system messages from a chat request into a
 * single instructions string (blank-line separated). Structured
 * content is JSON-stringified so non-text system prompts still reach
 * the model in some form.
 *
 * Exported for unit testing.
 *
 * @param {Array<object>} messages
 * @returns {string}  Possibly empty
 */
export function extractInstructions(messages) {
  const parts = [];
  for (const msg of messages || []) {
    if (msg?.role !== 'system') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}
