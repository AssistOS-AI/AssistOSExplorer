/**
 * Anthropic Messages API backend module.
 *
 * Communicates with the Anthropic API via POST /v1/messages with
 * x-api-key header authentication.  Uses the anthropic converter
 * for request/response format translation.
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
} from '../error-helpers.mjs';
import * as anthropicConverter from '../converters/anthropic-converter.mjs';
import * as achillesAnthropic from 'achillesAgentLib/utils/LLMProviders/providers/anthropic.mjs';
import {
    createAchillesExecutionHandle,
    getCredentialToken,
} from '../achilles/bridge.mjs';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
    key: 'anthropic-api',
    kind: 'external_api',
    authStrategy: 'api_key',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat', 'anthropic_messages'],
    displayName: 'Anthropic API',
    defaultBaseUrl: 'https://api.anthropic.com',
    // Dispatcher backend: configured exclusively via the
    // `anthropic-direct` preset (which fills in display_name + base_url
    // + supported_formats). Hide the raw `anthropic-api` key from the
    // dropdown so users always pick the preset.
    hidden: true,
};

// Known model families for discovery
const KNOWN_MODELS = [
    {
        modelId: 'claude-sonnet-4-20250514',
        displayName: 'Claude Sonnet 4',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-opus-4-20250514',
        displayName: 'Claude Opus 4',
        contextWindow: 200000,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-3-5-haiku-20241022',
        displayName: 'Claude 3.5 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'claude-3-haiku-20240307',
        displayName: 'Claude 3 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
];

const DEFAULT_API_VERSION = '2023-06-01';

// ── Backend module ──────────────────────────────────────────────────

export const backendModule = {
    manifest,

    // Optional converter reference (ISP — present because Anthropic needs conversion)
    formatConverter: anthropicConverter,

    async init() {},

    async shutdown() {},

    validateProviderRecord(providerRecord) {
        // base_url is optional — defaults to https://api.anthropic.com
        // No strict requirements beyond adapter_key matching
    },

    validateModelRecord(modelRecord) {
        if (!modelRecord.providerModelId && !modelRecord.modelKey) {
            throw new Error(
                'Anthropic model requires providerModelId or modelKey'
            );
        }
    },

    async discoverModels() {
        // Anthropic doesn't have a /models list endpoint — return known models
        return KNOWN_MODELS;
    },

    async testConnection(ctx) {
        const baseUrl =
            ctx.providerRecord?.baseUrl || 'https://api.anthropic.com';
        const headers = buildAnthropicHeaders(
            ctx.credentialLease,
            ctx.providerRecord?.settings,
            DEFAULT_API_VERSION
        );
        if (!headers) return { ok: false, detail: 'No credentials configured' };

        try {
            // Send a minimal request to check auth
            const apiVersion =
                ctx.providerRecord?.settings?.anthropic_version ||
                DEFAULT_API_VERSION;
            const body = JSON.stringify({
                model: 'claude-3-haiku-20240307',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'test' }],
            });

            const url = new URL(baseUrl + '/v1/messages');
            const response = await doRequest(
                url,
                'POST',
                {
                    'Content-Type': 'application/json',
                    ...headers,
                },
                body
            );

            // 200 = success; 401 = bad key; 529 = overloaded
            if (response.statusCode === 200 || response.statusCode === 529) {
                await drainResponse(response);
                return { ok: true, detail: 'Connected to Anthropic API' };
            }
            const resBody = await collectBody(response);
            return {
                ok: false,
                detail: `HTTP ${response.statusCode}: ${resBody.slice(0, 200)}`,
            };
        } catch (err) {
            return { ok: false, detail: err.message };
        }
    },

    async execute(ctx) {
        const {
            request: normalizedReq,
            resolvedModel,
            providerRecord,
            credentialLease,
            signal,
        } = ctx;
        const baseUrl = providerRecord.baseUrl || 'https://api.anthropic.com';
        const apiVersion =
            providerRecord.settings?.anthropic_version || DEFAULT_API_VERSION;
        const authHeaders = buildAnthropicHeaders(
            credentialLease,
            providerRecord.settings,
            apiVersion
        );
        if (!authHeaders) {
            throw new Error('No Anthropic credentials configured');
        }

        const params = {
            stream: true,
            max_tokens:
                normalizedReq.max_tokens ??
                resolvedModel.default_max_tokens ??
                4096,
        };
        if (normalizedReq.temperature != null)
            params.temperature = normalizedReq.temperature;
        if (normalizedReq.top_p != null) params.top_p = normalizedReq.top_p;
        if (normalizedReq.stop != null) {
            params.stop_sequences = Array.isArray(normalizedReq.stop)
                ? normalizedReq.stop
                : [normalizedReq.stop];
        }
        if (normalizedReq.tools && normalizedReq.tools.length > 0) {
            params.tools = normalizedReq.tools.map((tool) => {
                const fn = tool.function || tool;
                return {
                    name: fn.name,
                    description: fn.description || '',
                    input_schema: fn.parameters || {
                        type: 'object',
                        properties: {},
                    },
                };
            });
        }

        return createAchillesExecutionHandle(ctx, achillesAnthropic, {
            model: resolvedModel.providerModelId || resolvedModel.modelKey,
            apiKey:
                authHeaders['x-api-key'] || getCredentialToken(credentialLease),
            baseURL: baseUrl,
            signal,
            params,
            headers: authHeaders,
        });
    },

    classifyError(error, _ctx) {
        const status = getProviderStatus(error);
        const body = error.body || {};
        const errorType = getProviderErrorType(error);
        const message = getProviderMessage(error);

        // Anthropic-specific error types
        if (
            errorType === 'authentication_error' ||
            status === HTTP_STATUS.UNAUTHORIZED
        ) {
            return new ProviderAuthError(
                'anthropic',
                body.error?.message || 'Authentication failed'
            );
        }
        if (
            errorType === 'permission_error' ||
            status === HTTP_STATUS.FORBIDDEN
        ) {
            return new ProviderAuthError('anthropic', 'Permission denied');
        }
        if (
            errorType === 'not_found_error' ||
            status === HTTP_STATUS.NOT_FOUND
        ) {
            return new ProviderModelNotFoundError(
                'anthropic',
                body.error?.message || 'unknown'
            );
        }
        if (
            errorType === 'rate_limit_error' ||
            status === HTTP_STATUS.TOO_MANY_REQUESTS
        ) {
            return new ProviderRateLimitError('anthropic');
        }
        if (errorType === 'overloaded_error' || status === 529) {
            return new ProviderUnavailableError('anthropic');
        }
        if (
            errorType === 'invalid_request_error' ||
            status === HTTP_STATUS.BAD_REQUEST
        ) {
            if (looksLikeContentPolicyError(message)) {
                return new ProviderContentPolicyError('anthropic');
            }
        }
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
            return classifyTransportOrServerError('anthropic', error, status);
        }

        return classifyTransportOrServerError('anthropic', error);
    },
};

function buildAnthropicHeaders(
    credentialLease,
    settings = {},
    apiVersion = DEFAULT_API_VERSION
) {
    if (credentialLease?.oauth?.accessToken) {
        return {
            Authorization: `Bearer ${credentialLease.oauth.accessToken}`,
            'anthropic-version': apiVersion,
            'anthropic-beta': settings?.anthropic_beta || 'oauth-2025-04-20',
            'anthropic-dangerous-direct-browser-access': 'true',
        };
    }

    if (credentialLease?.secret) {
        const headers = {
            'x-api-key': credentialLease.secret,
            'anthropic-version': apiVersion,
        };
        if (settings?.anthropic_beta) {
            headers['anthropic-beta'] = settings.anthropic_beta;
        }
        return headers;
    }

    return null;
}

// ── SSE streaming ───────────────────────────────────────────────────

async function* makeAnthropicStream(url, headers, payload, signal) {
    const response = await doRequest(url, 'POST', headers, payload, signal);

    if (response.statusCode >= 400) {
        const body = await collectBody(response);
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            /* not JSON */
        }
        const err = new Error(`Anthropic API error: ${response.statusCode}`);
        err.status = response.statusCode;
        err.body = parsed;
        throw err;
    }

    const converterState = {};

    for await (const event of parseSSE(response)) {
        let parsed;
        try {
            parsed = JSON.parse(event.data);
        } catch {
            continue;
        }

        // Add the SSE event type to the parsed data
        if (event.event && !parsed.type) {
            parsed.type = event.event;
        }

        const normalized = anthropicConverter.fromProviderChunk(
            parsed,
            converterState
        );
        for (const chunk of normalized) {
            yield chunk;
        }
    }
}

// ── HTTP helpers ────────────────────────────────────────────────────

function doRequest(url, method, headers, body, signal) {
    return new Promise((resolve, reject) => {
        const isHttps = url.protocol === 'https:';
        const reqFn = isHttps ? httpsRequest : httpRequest;

        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method,
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
            signal,
        };

        const req = reqFn(opts, (res) => resolve(res));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function collectBody(res) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
    });
}

function drainResponse(res) {
    return new Promise((resolve) => {
        res.on('data', () => {});
        res.on('end', resolve);
        res.on('error', resolve);
    });
}

async function* parseSSE(res) {
    let buffer = '';

    for await (const chunk of res) {
        buffer += chunk.toString('utf8');

        const lines = buffer.split('\n');
        buffer = lines.pop();

        let currentEvent = {};
        for (const line of lines) {
            if (line.startsWith('event: ')) {
                currentEvent.event = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                currentEvent.data = line.slice(6);
                yield currentEvent;
                currentEvent = {};
            } else if (line === '') {
                if (currentEvent.data != null) {
                    yield currentEvent;
                    currentEvent = {};
                }
            }
        }
    }

    if (buffer.startsWith('data: ')) {
        yield { data: buffer.slice(6) };
    }
}
