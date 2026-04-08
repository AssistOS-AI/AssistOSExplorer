/**
 * Runtime record normalizers.
 *
 * Provider plugins and execution helpers operate on camelCase runtime
 * records. These helpers accept either DAO rows or already-normalized
 * runtime records and return a single camelCase view.
 */

export function normalizeProviderRecord(providerRecord) {
    if (!providerRecord) return null;

    return Object.freeze({
        ...providerRecord,
        providerKey:
            providerRecord.providerKey ?? providerRecord.provider_key ?? null,
        displayName:
            providerRecord.displayName ?? providerRecord.display_name ?? null,
        adapterKey:
            providerRecord.adapterKey ?? providerRecord.adapter_key ?? null,
        authStrategy:
            providerRecord.authStrategy ??
            providerRecord.auth_strategy ??
            null,
        providerMode:
            providerRecord.providerMode ??
            providerRecord.provider_mode ??
            'external_api',
        oauthAdapterKey:
            providerRecord.oauthAdapterKey ??
            providerRecord.oauth_adapter_key ??
            null,
        baseUrl: providerRecord.baseUrl ?? providerRecord.base_url ?? null,
        supportsStreaming:
            providerRecord.supportsStreaming ??
            providerRecord.supports_streaming ??
            true,
        supportsTools:
            providerRecord.supportsTools ??
            providerRecord.supports_tools ??
            true,
        supportsMessagesApi:
            providerRecord.supportsMessagesApi ??
            providerRecord.supports_messages_api ??
            false,
        supportsResponsesApi:
            providerRecord.supportsResponsesApi ??
            providerRecord.supports_responses_api ??
            false,
        settings: providerRecord.settings || {},
        metadata: providerRecord.metadata || {},
    });
}

export function normalizeModelRecord(modelRecord) {
    if (!modelRecord) return null;

    return Object.freeze({
        ...modelRecord,
        modelKey: modelRecord.modelKey ?? modelRecord.model_key ?? null,
        displayName:
            modelRecord.displayName ?? modelRecord.display_name ?? null,
        providerId: modelRecord.providerId ?? modelRecord.provider_id ?? null,
        providerKey:
            modelRecord.providerKey ?? modelRecord.provider_key ?? null,
        providerModelId:
            modelRecord.providerModelId ??
            modelRecord.provider_model_id ??
            null,
        executionKind:
            modelRecord.executionKind ?? modelRecord.execution_kind ?? null,
        concurrencyLimit:
            modelRecord.concurrencyLimit ??
            modelRecord.concurrency_limit ??
            null,
        queueTimeoutMs:
            modelRecord.queueTimeoutMs ?? modelRecord.queue_timeout_ms ?? null,
        requestTimeoutMs:
            modelRecord.requestTimeoutMs ??
            modelRecord.request_timeout_ms ??
            null,
        pricingMode:
            modelRecord.pricingMode ?? modelRecord.pricing_mode ?? null,
        inputPricePerMillion:
            modelRecord.inputPricePerMillion ??
            modelRecord.input_price_per_million ??
            null,
        outputPricePerMillion:
            modelRecord.outputPricePerMillion ??
            modelRecord.output_price_per_million ??
            null,
        requestPriceUsd:
            modelRecord.requestPriceUsd ?? modelRecord.request_price_usd ?? null,
        isFree: modelRecord.isFree ?? modelRecord.is_free ?? false,
        retryPolicy:
            modelRecord.retryPolicy || modelRecord.retry_policy || {},
        capabilities: modelRecord.capabilities || {},
        tags: modelRecord.tags || [],
        metadata: modelRecord.metadata || {},
    });
}
