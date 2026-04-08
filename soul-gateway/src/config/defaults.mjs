/** Application-level defaults that do not come from environment variables. */
export const DEFAULTS = Object.freeze({
    requestIdPrefix: 'chatcmpl-',
    apiKeyPrefix: 'sk-soul-',
    adminSessionTtlMs: 43_200_000, // 12 hours
    sseEventName: 'log',
    maxRetryTraceEntries: 32,
    responseExcerptChars: 2000,
    middlewareGenerationGcGraceMs: 60_000,
    providerGenerationGcGraceMs: 60_000,
    defaultBlacklistPriority: 100,
    defaultRegexFlags: 'g',
    systemMetricsSampleMs: 15_000,
    queueDepthWarningThreshold: 100,
    slowRequestMs: 15_000,
    oversizedPromptTokens: 100_000,
    responseCacheTtlMs: 300_000, // 5 minutes
    responseCacheMaxEntries: 10_000,
    sessionSummaryMaxChars: 4000,
    streamTransformTailChars: 256,
    oauthStateTtlMs: 600_000, // 10 minutes
});
