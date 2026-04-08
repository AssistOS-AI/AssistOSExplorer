/**
 * OpenAI Chat Completions API provider plugin.
 *
 * Communicates with any OpenAI-compatible API (OpenAI, OpenRouter,
 * Together, Groq, etc.) via POST /chat/completions with bearer token.
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
    getProviderStatus,
} from '../error-helpers.mjs';
import * as achillesOpenAI from 'achillesAgentLib/utils/LLMProviders/providers/openai.mjs';
import {
    createAchillesExecutionHandle,
    getCredentialToken,
} from '../achilles/bridge.mjs';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
    key: 'openai-api',
    kind: 'external_api',
    authStrategy: 'api_key',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
    displayName: 'OpenAI-Compatible API',
    defaultBaseUrl: 'https://api.openai.com/v1',
    // Dispatcher plugin: every OpenAI-compatible vendor (NVIDIA, Groq,
    // OpenRouter, Fireworks, …) is configured through its own preset in
    // provider-presets.mjs. Hide the raw `openai-api` key from the
    // dropdown so users always pick a vendor preset that fills in the
    // base_url and display name.
    hidden: true,
};

// ── Plugin ──────────────────────────────────────────────────────────

export const providerPlugin = {
    manifest,

    async init() {
        // No shared resources to warm
    },

    async shutdown() {
        // No resources to release
    },

    validateProviderRecord(providerRecord) {
        if (!providerRecord.baseUrl) {
            throw new Error('OpenAI provider requires a baseUrl');
        }
    },

    validateModelRecord(modelRecord) {
        if (!modelRecord.providerModelId && !modelRecord.modelKey) {
            throw new Error('OpenAI model requires providerModelId or modelKey');
        }
    },

    async discoverModels(ctx) {
        const baseUrl =
            ctx?.providerRecord?.baseUrl || 'https://api.openai.com/v1';
        const token =
            ctx?.credentialLease?.secret ||
            ctx?.credentialLease?.oauth?.accessToken;
        if (!token) return [];

        try {
            const body = await httpGet(baseUrl + '/models', {
                Authorization: `Bearer ${token}`,
            });
            const parsed = JSON.parse(body);
            return (parsed.data || []).map((m) => ({
                modelId: m.id,
                displayName: m.id,
                contextWindow: null,
                maxOutputTokens: null,
                supportsTools: true,
                supportsStreaming: true,
                supportsVision: false,
            }));
        } catch {
            return [];
        }
    },

    async testConnection(ctx) {
        const baseUrl =
            ctx.providerRecord?.baseUrl || 'https://api.openai.com/v1';
        const token =
            ctx.credentialLease?.secret ||
            ctx.credentialLease?.oauth?.accessToken;
        if (!token) return { ok: false, detail: 'No credentials configured' };
        const authHeaders = { Authorization: `Bearer ${token}` };

        // Most OpenAI-compatible vendors expose GET /models, so try that
        // first — a 200 is the strongest signal we can get ("auth works,
        // base URL is right, and the vendor speaks the listing dialect").
        try {
            await httpGet(baseUrl + '/models', authHeaders);
            return { ok: true, detail: 'Connected to OpenAI API' };
        } catch (modelsErr) {
            // 401/403 → credential is wrong. Falling back here would just
            // hit the same wall and waste a request, so surface immediately.
            if (modelsErr.status === 401 || modelsErr.status === 403) {
                return { ok: false, detail: modelsErr.message };
            }
            // Anything other than a missing endpoint (5xx, network, …)
            // also propagates as-is — the user needs to know what failed.
            if (modelsErr.status !== 404) {
                return { ok: false, detail: modelsErr.message };
            }

            // 404 specifically: this base URL does not host /models. The
            // canonical example is Mistral's Codestral subdomain, which
            // restricts the surface to /chat/completions and /fim/completions.
            // Probe the chat-completions route with a deliberately empty
            // body — we only care whether the route exists and the credential
            // is recognised, not whether the payload is valid:
            //   200 / 4xx (other than 401/403/404) → endpoint is reachable
            //                                        and auth was at least
            //                                        read → success
            //   401 / 403 → credential rejected → fail
            //   404       → base URL has no /chat/completions either →
            //               wrong base URL → fail
            let probeStatus;
            try {
                probeStatus = await httpProbeStatus(
                    baseUrl + '/chat/completions',
                    { ...authHeaders, 'Content-Type': 'application/json' },
                    '{}'
                );
            } catch (probeErr) {
                return { ok: false, detail: probeErr.message };
            }

            if (probeStatus === 401 || probeStatus === 403) {
                return { ok: false, detail: `HTTP ${probeStatus}` };
            }
            if (probeStatus === 404) {
                return {
                    ok: false,
                    detail: 'HTTP 404 (no /models or /chat/completions at base URL)',
                };
            }
            return {
                ok: true,
                detail: 'Connected (model listing not exposed at this base URL)',
            };
        }
    },

    async execute(ctx) {
        const {
            request: normalizedReq,
            resolvedModel,
            providerRecord,
            credentialLease,
            signal,
            logger,
        } = ctx;
        const baseUrl = providerRecord.baseUrl || 'https://api.openai.com/v1';
        const modelId = resolvedModel.providerModelId || resolvedModel.modelKey;
        const settings = providerRecord.settings || {};
        const params = {
            stream: true,
            stream_options: { include_usage: true },
        };

        if (normalizedReq.max_tokens != null)
            params.max_tokens = normalizedReq.max_tokens;
        if (normalizedReq.temperature != null)
            params.temperature = normalizedReq.temperature;
        if (normalizedReq.top_p != null) params.top_p = normalizedReq.top_p;
        if (normalizedReq.stop != null) params.stop = normalizedReq.stop;
        if (normalizedReq.tools && normalizedReq.tools.length > 0)
            params.tools = normalizedReq.tools;
        if (normalizedReq.tool_choice != null)
            params.tool_choice = normalizedReq.tool_choice;
        if (normalizedReq.response_format != null)
            params.response_format = normalizedReq.response_format;
        if (settings.extra_body) Object.assign(params, settings.extra_body);

        const headers = {};
        // OpenRouter-specific headers
        if (settings.openrouter_referer)
            headers['HTTP-Referer'] = settings.openrouter_referer;
        if (settings.openrouter_title)
            headers['X-Title'] = settings.openrouter_title;
        if (settings.extra_headers)
            Object.assign(headers, settings.extra_headers);

        return createAchillesExecutionHandle(ctx, achillesOpenAI, {
            model: modelId,
            apiKey: getCredentialToken(credentialLease),
            baseURL: baseUrl,
            signal,
            params,
            headers,
        });
    },

    classifyError(error, _ctx) {
        const status = getProviderStatus(error);
        const body = error.body || {};
        const errorType = getProviderErrorType(error);

        if (status === HTTP_STATUS.UNAUTHORIZED) {
            return new ProviderAuthError('openai', 'Invalid API key');
        }
        if (status === HTTP_STATUS.FORBIDDEN) {
            return new ProviderAuthError('openai', 'Access denied');
        }
        if (status === HTTP_STATUS.NOT_FOUND) {
            const model =
                body.error?.param === 'model' ? body.error?.message : 'unknown';
            return new ProviderModelNotFoundError('openai', model);
        }
        if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            if (
                errorType === 'insufficient_quota' ||
                errorType === 'billing_hard_limit_reached'
            ) {
                return new ProviderQuotaError('openai');
            }
            return new ProviderRateLimitError('openai');
        }
        if (status === HTTP_STATUS.BAD_REQUEST) {
            if (errorType === 'content_policy_violation') {
                return new ProviderContentPolicyError('openai');
            }
        }
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
            return classifyTransportOrServerError('openai', error, status);
        }

        return classifyTransportOrServerError('openai', error);
    },
};

// ── SSE streaming ───────────────────────────────────────────────────

async function* makeSSEStream(url, headers, payload, signal, logger) {
    const response = await doRequest(url, 'POST', headers, payload, signal);

    if (response.statusCode >= 400) {
        const body = await collectBody(response);
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            /* not JSON */
        }
        const err = new Error(`OpenAI API error: ${response.statusCode}`);
        err.status = response.statusCode;
        err.body = parsed;
        throw err;
    }

    const state = {};

    for await (const event of parseSSE(response)) {
        if (event.data === '[DONE]') {
            yield {
                type: 'done',
                data: {
                    finish_reason: state.lastFinishReason || 'stop',
                    model: state.model,
                },
            };
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(event.data);
        } catch {
            continue;
        }

        if (!state.started) {
            state.started = true;
            state.model = parsed.model;
            yield {
                type: 'message_start',
                data: { id: parsed.id, model: parsed.model, role: 'assistant' },
            };
        }

        for (const choice of parsed.choices || []) {
            const delta = choice.delta || {};

            if (delta.content) {
                yield { type: 'text_delta', data: { text: delta.content } };
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    yield {
                        type: 'tool_call_delta',
                        data: {
                            index: tc.index ?? 0,
                            id: tc.id || undefined,
                            name: tc.function?.name || undefined,
                            arguments: tc.function?.arguments || undefined,
                        },
                    };
                }
            }

            if (choice.finish_reason) {
                state.lastFinishReason = choice.finish_reason;
            }
        }

        // Usage (available when stream_options.include_usage is set)
        if (parsed.usage) {
            yield {
                type: 'usage',
                data: {
                    input_tokens: parsed.usage.prompt_tokens || 0,
                    output_tokens: parsed.usage.completion_tokens || 0,
                    total_tokens: parsed.usage.total_tokens || 0,
                },
            };
        }
    }
}

// ── HTTP helpers (node:http / node:https only) ──────────────────────

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

async function* parseSSE(res) {
    let buffer = '';

    for await (const chunk of res) {
        buffer += chunk.toString('utf8');

        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        let currentEvent = {};
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                currentEvent.data = line.slice(6);
                yield currentEvent;
                currentEvent = {};
            } else if (line.startsWith('event: ')) {
                currentEvent.event = line.slice(7);
            } else if (line === '') {
                // Empty line — event separator
                if (currentEvent.data != null) {
                    yield currentEvent;
                    currentEvent = {};
                }
            }
        }
    }

    // Flush remaining
    if (buffer.startsWith('data: ')) {
        yield { data: buffer.slice(6) };
    }
}

function httpGet(urlStr, headers) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const reqFn = isHttps ? httpsRequest : httpRequest;

        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers,
        };

        const req = reqFn(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 400) {
                    const err = new Error(`HTTP ${res.statusCode}`);
                    err.status = res.statusCode;
                    reject(err);
                } else {
                    resolve(body);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * POST `body` and resolve with the response status code, draining
 * the body so the socket is released. Used by testConnection() as a
 * fallback probe when /models is not available — unlike httpGet
 * above, this resolves on every HTTP response (including 4xx/5xx)
 * because the probe needs to inspect the status, not the body.
 *
 * @param {string} urlStr
 * @param {object} headers
 * @param {string} body
 * @returns {Promise<number>} HTTP status code
 */
function httpProbeStatus(urlStr, headers, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const reqFn = isHttps ? httpsRequest : httpRequest;

        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        };

        const req = reqFn(opts, (res) => {
            // Drain the body so the underlying socket can be released even
            // though we only care about the status code.
            res.on('data', () => {});
            res.on('end', () => resolve(res.statusCode));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
