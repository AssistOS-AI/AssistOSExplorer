/**
 * Provider/runtime record adapters.
 *
 * The snapshot layer uses camelCase fields while provider plugins were
 * originally written against snake_case DAO rows. These helpers expose
 * both shapes so the provider contract stays stable during the migration.
 */

export function withProviderFieldAliases(providerRecord) {
  if (!providerRecord) return null;

  const record = { ...providerRecord };
  record.providerKey = providerRecord.providerKey ?? providerRecord.provider_key ?? null;
  record.provider_key = providerRecord.provider_key ?? providerRecord.providerKey ?? null;
  record.displayName = providerRecord.displayName ?? providerRecord.display_name ?? null;
  record.display_name = providerRecord.display_name ?? providerRecord.displayName ?? null;
  record.adapterKey = providerRecord.adapterKey ?? providerRecord.adapter_key ?? null;
  record.adapter_key = providerRecord.adapter_key ?? providerRecord.adapterKey ?? null;
  record.authStrategy = providerRecord.authStrategy ?? providerRecord.auth_strategy ?? null;
  record.auth_strategy = providerRecord.auth_strategy ?? providerRecord.authStrategy ?? null;
  record.providerMode = providerRecord.providerMode ?? providerRecord.provider_mode ?? 'external_api';
  record.provider_mode = providerRecord.provider_mode ?? providerRecord.providerMode ?? 'external_api';
  record.executorKey = providerRecord.executorKey ?? providerRecord.executor_key ?? null;
  record.executor_key = providerRecord.executor_key ?? providerRecord.executorKey ?? null;
  record.oauthAdapterKey = providerRecord.oauthAdapterKey ?? providerRecord.oauth_adapter_key ?? null;
  record.oauth_adapter_key = providerRecord.oauth_adapter_key ?? providerRecord.oauthAdapterKey ?? null;
  record.baseUrl = providerRecord.baseUrl ?? providerRecord.base_url ?? null;
  record.base_url = providerRecord.base_url ?? providerRecord.baseUrl ?? null;
  record.supportsStreaming = providerRecord.supportsStreaming ?? providerRecord.supports_streaming ?? true;
  record.supports_streaming = providerRecord.supports_streaming ?? providerRecord.supportsStreaming ?? true;
  record.supportsTools = providerRecord.supportsTools ?? providerRecord.supports_tools ?? true;
  record.supports_tools = providerRecord.supports_tools ?? providerRecord.supportsTools ?? true;
  record.supportsMessagesApi = providerRecord.supportsMessagesApi ?? providerRecord.supports_messages_api ?? false;
  record.supports_messages_api = providerRecord.supports_messages_api ?? providerRecord.supportsMessagesApi ?? false;
  record.supportsResponsesApi = providerRecord.supportsResponsesApi ?? providerRecord.supports_responses_api ?? false;
  record.supports_responses_api = providerRecord.supports_responses_api ?? providerRecord.supportsResponsesApi ?? false;
  record.settings = providerRecord.settings || {};
  record.metadata = providerRecord.metadata || {};

  return Object.freeze(record);
}

export function withModelFieldAliases(modelRecord) {
  if (!modelRecord) return null;

  const record = { ...modelRecord };
  record.modelKey = modelRecord.modelKey ?? modelRecord.model_key ?? null;
  record.model_key = modelRecord.model_key ?? modelRecord.modelKey ?? null;
  record.displayName = modelRecord.displayName ?? modelRecord.display_name ?? null;
  record.display_name = modelRecord.display_name ?? modelRecord.displayName ?? null;
  record.providerId = modelRecord.providerId ?? modelRecord.provider_id ?? null;
  record.provider_id = modelRecord.provider_id ?? modelRecord.providerId ?? null;
  record.providerKey = modelRecord.providerKey ?? modelRecord.provider_key ?? null;
  record.provider_key = modelRecord.provider_key ?? modelRecord.providerKey ?? null;
  record.providerModelId = modelRecord.providerModelId ?? modelRecord.provider_model_id ?? null;
  record.provider_model_id = modelRecord.provider_model_id ?? modelRecord.providerModelId ?? null;
  record.executionKind = modelRecord.executionKind ?? modelRecord.execution_kind ?? null;
  record.execution_kind = modelRecord.execution_kind ?? modelRecord.executionKind ?? null;
  record.concurrencyLimit = modelRecord.concurrencyLimit ?? modelRecord.concurrency_limit ?? null;
  record.concurrency_limit = modelRecord.concurrency_limit ?? modelRecord.concurrencyLimit ?? null;
  record.queueTimeoutMs = modelRecord.queueTimeoutMs ?? modelRecord.queue_timeout_ms ?? null;
  record.queue_timeout_ms = modelRecord.queue_timeout_ms ?? modelRecord.queueTimeoutMs ?? null;
  record.requestTimeoutMs = modelRecord.requestTimeoutMs ?? modelRecord.request_timeout_ms ?? null;
  record.request_timeout_ms = modelRecord.request_timeout_ms ?? modelRecord.requestTimeoutMs ?? null;
  record.pricingMode = modelRecord.pricingMode ?? modelRecord.pricing_mode ?? null;
  record.pricing_mode = modelRecord.pricing_mode ?? modelRecord.pricingMode ?? null;
  record.inputPricePerMillion = modelRecord.inputPricePerMillion ?? modelRecord.input_price_per_million ?? null;
  record.input_price_per_million = modelRecord.input_price_per_million ?? modelRecord.inputPricePerMillion ?? null;
  record.outputPricePerMillion = modelRecord.outputPricePerMillion ?? modelRecord.output_price_per_million ?? null;
  record.output_price_per_million = modelRecord.output_price_per_million ?? modelRecord.outputPricePerMillion ?? null;
  record.requestPriceUsd = modelRecord.requestPriceUsd ?? modelRecord.request_price_usd ?? null;
  record.request_price_usd = modelRecord.request_price_usd ?? modelRecord.requestPriceUsd ?? null;
  record.isFree = modelRecord.isFree ?? modelRecord.is_free ?? false;
  record.is_free = modelRecord.is_free ?? modelRecord.isFree ?? false;
  record.retryPolicy = modelRecord.retryPolicy || modelRecord.retry_policy || {};
  record.retry_policy = modelRecord.retry_policy || modelRecord.retryPolicy || {};
  record.capabilities = modelRecord.capabilities || {};
  record.tags = modelRecord.tags || [];
  record.metadata = modelRecord.metadata || {};

  return Object.freeze(record);
}
