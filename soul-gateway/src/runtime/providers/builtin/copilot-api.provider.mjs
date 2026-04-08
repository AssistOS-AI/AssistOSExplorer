/**
 * GitHub Copilot provider plugin.
 *
 * Routes to /chat/completions or /models/{model}/responses based on
 * model capabilities.  Uses Copilot token auth and VS Code User-Agent
 * spoofing for API access.
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
    getProviderMessage,
    getProviderStatus,
    looksLikeContentPolicyError,
    looksLikeQuotaError,
} from '../error-helpers.mjs';
import * as copilotConverter from '../converters/copilot-converter.mjs';
import * as achillesCopilot from 'achillesAgentLib/utils/LLMProviders/providers/copilot.mjs';
import {
    createAchillesExecutionHandle,
    getCredentialToken,
} from '../achilles/bridge.mjs';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
    key: 'copilot-api',
    kind: 'external_api',
    authStrategy: 'oauth',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
    displayName: 'GitHub Copilot',
    defaultBaseUrl: 'https://api.githubcopilot.com',
    oauthAdapterKey: 'github-copilot',
};

// VS Code User-Agent — required for Copilot API access
const VSCODE_USER_AGENT = 'GitHubCopilotChat/0.24.2024122001';
const COPILOT_INTEGRATION_ID = 'vscode-chat';

// Known Copilot models for discovery
const KNOWN_MODELS = [
    {
        modelId: 'gpt-4o',
        displayName: 'GPT-4o',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'gpt-4.1',
        displayName: 'GPT-4.1',
        contextWindow: 1000000,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'gpt-4.1-mini',
        displayName: 'GPT-4.1 Mini',
        contextWindow: 1000000,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'gpt-4.1-nano',
        displayName: 'GPT-4.1 Nano',
        contextWindow: 1000000,
        maxOutputTokens: 32768,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'claude-sonnet-4',
        displayName: 'Claude Sonnet 4',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-3.5-sonnet',
        displayName: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'o1-preview',
        displayName: 'o1-preview',
        contextWindow: 128000,
        maxOutputTokens: 32768,
        supportsTools: false,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'o1-mini',
        displayName: 'o1-mini',
        contextWindow: 128000,
        maxOutputTokens: 65536,
        supportsTools: false,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'o3-mini',
        displayName: 'o3-mini',
        contextWindow: 200000,
        maxOutputTokens: 100000,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
];

// ── Plugin ──────────────────────────────────────────────────────────

export const providerPlugin = {
    manifest,

    formatConverter: copilotConverter,

    async init() {},

    async shutdown() {},

    validateProviderRecord(providerRecord) {
        // base_url defaults to https://api.githubcopilot.com
        // oauth_adapter_key should reference a copilot OAuth adapter
    },

    validateModelRecord(modelRecord) {
        if (!modelRecord.providerModelId && !modelRecord.modelKey) {
            throw new Error(
                'Copilot model requires providerModelId or modelKey'
            );
        }
    },

    async discoverModels(ctx) {
        const baseUrl =
            ctx?.providerRecord?.baseUrl || 'https://api.githubcopilot.com';
        const token = ctx?.credentialLease?.oauth?.accessToken;
        if (!token) return KNOWN_MODELS;

        try {
            const body = await httpGet(baseUrl + '/models', {
                Authorization: `Bearer ${token}`,
                'User-Agent': VSCODE_USER_AGENT,
                'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
            });
            const parsed = JSON.parse(body);
            return (parsed.data || []).map((m) => ({
                modelId: m.id,
                displayName: m.name || m.id,
                contextWindow:
                    m.capabilities?.limits?.max_prompt_tokens || null,
                maxOutputTokens:
                    m.capabilities?.limits?.max_output_tokens || null,
                supportsTools: m.capabilities?.supports?.tool_calls ?? true,
                supportsStreaming: true,
                supportsVision: m.capabilities?.supports?.vision ?? false,
            }));
        } catch {
            return KNOWN_MODELS;
        }
    },

    async testConnection(ctx) {
        const baseUrl =
            ctx.providerRecord?.baseUrl || 'https://api.githubcopilot.com';
        const token = ctx.credentialLease?.oauth?.accessToken;
        if (!token) return { ok: false, detail: 'No Copilot token configured' };

        try {
            await httpGet(baseUrl + '/models', {
                Authorization: `Bearer ${token}`,
                'User-Agent': VSCODE_USER_AGENT,
                'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
            });
            return { ok: true, detail: 'Connected to GitHub Copilot API' };
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
        const baseUrl =
            providerRecord.baseUrl || 'https://api.githubcopilot.com';
        const token = getCredentialToken(credentialLease);
        const headers = {};
        const params = {};

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

        // Custom headers from settings
        const settings = providerRecord.settings || {};
        if (settings.extra_headers) {
            Object.assign(headers, settings.extra_headers);
        }
        if (settings.force_endpoint) {
            params.force_endpoint = settings.force_endpoint;
        }

        return createAchillesExecutionHandle(ctx, achillesCopilot, {
            model: resolvedModel.providerModelId || resolvedModel.modelKey,
            apiKey: token,
            baseURL: baseUrl,
            signal,
            params: { ...params, stream: true },
            headers,
        });
    },

    classifyError(error, _ctx) {
        const status = getProviderStatus(error);
        const message = getProviderMessage(error);

        if (
            status === HTTP_STATUS.UNAUTHORIZED ||
            status === HTTP_STATUS.FORBIDDEN
        ) {
            return new ProviderAuthError(
                'copilot',
                message || 'Copilot auth failed'
            );
        }
        if (status === HTTP_STATUS.NOT_FOUND) {
            return new ProviderModelNotFoundError(
                'copilot',
                message || 'unknown'
            );
        }
        if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            if (looksLikeQuotaError(message)) {
                return new ProviderQuotaError('copilot');
            }
            return new ProviderRateLimitError('copilot');
        }
        if (status === HTTP_STATUS.BAD_REQUEST) {
            if (looksLikeContentPolicyError(message)) {
                return new ProviderContentPolicyError('copilot');
            }
        }
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
            return classifyTransportOrServerError('copilot', error, status);
        }

        return classifyTransportOrServerError('copilot', error);
    },
};

// ── SSE streaming ───────────────────────────────────────────────────

async function* makeCopilotStream(url, headers, payload, signal, endpoint) {
    const response = await doRequest(url, 'POST', headers, payload, signal);

    if (response.statusCode >= 400) {
        const body = await collectBody(response);
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            /* not JSON */
        }
        const err = new Error(`Copilot API error: ${response.statusCode}`);
        err.status = response.statusCode;
        err.body = parsed;
        throw err;
    }

    const converterState = {};

    for await (const event of parseSSE(response)) {
        if (event.data === '[DONE]') {
            // For completions endpoint
            if (endpoint === 'completions') {
                const lastChunks = copilotConverter.fromProviderChunk(
                    '[DONE]',
                    converterState,
                    endpoint
                );
                for (const chunk of lastChunks) yield chunk;
            }
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(event.data);
        } catch {
            continue;
        }

        // Add event type from SSE if present
        if (event.event && !parsed.type) {
            parsed.type = event.event;
        }

        const normalized = copilotConverter.fromProviderChunk(
            parsed,
            converterState,
            endpoint
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
