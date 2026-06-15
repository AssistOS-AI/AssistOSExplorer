/**
 * Ploinky agent OpenAI backend module (`adapter_key = ploinky-agent-openai`).
 *
 * Calls a discovered Ploinky agent's `/v1/chat/completions` THROUGH the Ploinky
 * router, authenticating with an HTTP Agent Assertion that Soul Gateway signs
 * with its own injected `PLOINKY_AGENT_SECRET`. Providers for these agents are
 * written by the agent-discovery reconciler with `auth_strategy = 'none'`: no
 * upstream credential is leased; this backend self-signs every call.
 *
 * ── Why this backend owns its HTTP transport (documented decision) ──────────
 *
 * Soul Gateway's convention is that request-time LLM inference goes through
 * `achillesAgentLib` and LLM `execute()` paths do not add ad-hoc upstream HTTP.
 * That rule targets VENDOR LLM inference (OpenAI, Anthropic, Gemini, …). This
 * backend is NOT vendor inference: it is internal agent-to-agent transport
 * through the Ploinky router (the router's default responder returns an agent
 * capability message, not vendor completion), analogous to the router's own
 * discovery / delegation calls.
 *
 * The assertion's `rch` must bind the EXACT outbound body bytes via
 * `computeRchHttp`, byte-for-byte matching what the router + AgentServer
 * recompute. The Achilles execution path (`createAchillesExecutionHandle` →
 * `callLLMStreaming`) serializes the body internally, so it cannot expose the
 * exact bytes for signing. This backend therefore owns serialization, signing,
 * and the `node:http`/`node:https` POST so the bytes it hashes are the bytes it
 * sends. The SSE parsing and error classification mirror the OpenAI backend's
 * normalized-stream contract.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
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
    getProviderStatus,
} from '../error-helpers.mjs';
import {
    signOpenAiAgentAssertion,
    readAgentSecretBuffer,
} from '../ploinky/agent-assertion.mjs';

const PROVIDER_LABEL = 'ploinky-agent-openai';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
    key: 'ploinky-agent-openai',
    kind: 'external_api',
    // No upstream credential is leased; the backend self-signs each call with
    // the injected PLOINKY_AGENT_SECRET. Providers are reconciled with
    // auth_strategy='none' and route here by adapter_key.
    authStrategy: 'none',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
    displayName: 'Ploinky Agent (OpenAI-compatible)',
    // Discovered + reconciled automatically; never picked from the dropdown.
    hidden: true,
};

// ── Config resolution ───────────────────────────────────────────────

/**
 * Read the Ploinky agent identity/transport config the backend needs to sign
 * and route. The Ploinky runtime injects these into the process environment, so
 * `process.env` is the source of truth (the same pattern other backends use for
 * runtime-injected values). `envOverride` exists purely so tests can drive the
 * backend without mutating the global environment.
 *
 * @param {object} [envOverride]
 * @returns {{ routerUrl: string, agentId: string, secretHex: string }}
 */
function readPloinkyConfig(envOverride) {
    const env = envOverride || process.env;
    return {
        routerUrl: String(env.PLOINKY_ROUTER_URL || '').trim(),
        agentId: String(env.PLOINKY_AGENT_ID || '').trim(),
        secretHex: String(env.PLOINKY_AGENT_SECRET || '').trim(),
    };
}

/**
 * Pull the route key and target subject id from provider metadata. The
 * discovery reconciler writes both: `routeKey` is the route name the URL
 * addresses (and the value the router checks the assertion's `targetAgent`
 * against); `subjectId` (`agent:<repo>/<agent>`) is informational here.
 *
 * @param {object} providerRecord
 * @returns {{ routeKey: string, subjectId: string }}
 */
function readProviderMetadata(providerRecord) {
    const metadata = providerRecord?.metadata || {};
    return {
        routeKey: String(metadata.routeKey || '').trim(),
        subjectId: String(metadata.subjectId || '').trim(),
    };
}

// ── Request body assembly ───────────────────────────────────────────

/**
 * Build the OpenAI chat-completions request payload from the normalized request
 * and the resolved model. Mirrors the parameter passthrough of the OpenAI
 * backend so a Ploinky agent sees the same request shape any OpenAI-compatible
 * vendor would.
 *
 * @param {object} normalizedReq
 * @param {string} modelId
 * @param {object} settings
 * @returns {object}
 */
function buildPayload(normalizedReq, modelId, settings) {
    const payload = {
        model: modelId,
        messages: normalizedReq.messages || [],
        stream: true,
    };

    if (normalizedReq.max_tokens != null)
        payload.max_tokens = normalizedReq.max_tokens;
    if (normalizedReq.temperature != null)
        payload.temperature = normalizedReq.temperature;
    if (normalizedReq.top_p != null) payload.top_p = normalizedReq.top_p;
    if (normalizedReq.stop != null) payload.stop = normalizedReq.stop;
    if (normalizedReq.tools && normalizedReq.tools.length > 0)
        payload.tools = normalizedReq.tools;
    if (normalizedReq.tool_choice != null)
        payload.tool_choice = normalizedReq.tool_choice;
    if (normalizedReq.response_format != null)
        payload.response_format = normalizedReq.response_format;
    if (settings && settings.extra_body)
        Object.assign(payload, settings.extra_body);

    return payload;
}

// ── Backend module ──────────────────────────────────────────────────

export const backendModule = {
    manifest,

    async init() {
        // No shared resources to warm.
    },

    async shutdown() {
        // No resources to release.
    },

    validateProviderRecord(providerRecord) {
        if (!providerRecord) {
            throw new Error('Ploinky agent provider requires a record');
        }
        const { routeKey } = readProviderMetadata(providerRecord);
        if (!routeKey) {
            throw new Error(
                'Ploinky agent provider requires metadata.routeKey'
            );
        }
        // base_url carries the router origin; the reconciler sets it to
        // PLOINKY_ROUTER_URL. Accept it but do not require it — the backend
        // falls back to the injected PLOINKY_ROUTER_URL when absent.
    },

    validateModelRecord(modelRecord) {
        if (!modelRecord.providerModelId && !modelRecord.modelKey) {
            throw new Error(
                'Ploinky agent model requires providerModelId or modelKey'
            );
        }
    },

    async execute(ctx) {
        const {
            request: normalizedReq,
            resolvedModel,
            providerRecord,
            signal,
        } = ctx;

        const { routerUrl, agentId, secretHex } = readPloinkyConfig(
            ctx.env
        );
        const { routeKey, subjectId } = readProviderMetadata(providerRecord);

        const baseUrl = String(providerRecord.baseUrl || routerUrl || '').trim();
        if (!baseUrl) {
            throw new Error(
                'Ploinky agent backend requires PLOINKY_ROUTER_URL (or provider base_url)'
            );
        }
        if (!routeKey) {
            throw new Error(
                'Ploinky agent backend requires provider metadata.routeKey'
            );
        }
        if (!agentId) {
            throw new Error(
                'Ploinky agent backend requires PLOINKY_AGENT_ID'
            );
        }
        const secret = readAgentSecretBuffer(secretHex);
        if (!secret) {
            throw new Error(
                'Ploinky agent backend requires a hex PLOINKY_AGENT_SECRET'
            );
        }

        const modelId = resolvedModel.providerModelId || resolvedModel.modelKey;
        const settings = providerRecord.settings || {};
        const payload = buildPayload(normalizedReq, modelId, settings);

        // Serialize ONCE. The exact Buffer we hash is the exact Buffer we send;
        // nothing re-serializes between signing and the POST.
        const bodyBytes = Buffer.from(JSON.stringify(payload));

        const { assertion } = signOpenAiAgentAssertion({
            body: bodyBytes,
            targetAgent: routeKey,
            secret,
            self: agentId,
        });

        const url = buildRouterUrl(baseUrl, routeKey);
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${assertion}`,
        };

        const stream = makeSSEStream(url, headers, bodyBytes, signal, {
            requestId: ctx.requestId,
            model: modelId,
            subjectId,
        });

        return {
            accountId: null,
            stream,
            abort: async () => {},
        };
    },

    classifyError(error, _ctx) {
        const status = getProviderStatus(error);
        const body = error.body || {};
        const errorType = getProviderErrorType(error);

        if (status === HTTP_STATUS.UNAUTHORIZED) {
            return new ProviderAuthError(
                PROVIDER_LABEL,
                'Agent assertion rejected by router'
            );
        }
        if (status === HTTP_STATUS.FORBIDDEN) {
            return new ProviderAuthError(PROVIDER_LABEL, 'Access denied');
        }
        if (status === HTTP_STATUS.NOT_FOUND) {
            const model =
                body.error?.param === 'model'
                    ? body.error?.message
                    : 'unknown';
            return new ProviderModelNotFoundError(PROVIDER_LABEL, model);
        }
        if (status === HTTP_STATUS.TOO_MANY_REQUESTS) {
            if (
                errorType === 'insufficient_quota' ||
                errorType === 'billing_hard_limit_reached'
            ) {
                return new ProviderQuotaError(PROVIDER_LABEL);
            }
            return new ProviderRateLimitError(PROVIDER_LABEL);
        }
        if (status === HTTP_STATUS.BAD_REQUEST) {
            if (errorType === 'content_policy_violation') {
                return new ProviderContentPolicyError(PROVIDER_LABEL);
            }
        }
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
            return classifyTransportOrServerError(PROVIDER_LABEL, error, status);
        }

        return classifyTransportOrServerError(PROVIDER_LABEL, error);
    },
};

// ── URL assembly ────────────────────────────────────────────────────

/**
 * Build the router URL `<base>/<routeKey>/v1/chat/completions`, tolerating a
 * trailing slash on the base origin.
 *
 * @param {string} baseUrl
 * @param {string} routeKey
 * @returns {URL}
 */
export function buildRouterUrl(baseUrl, routeKey) {
    const origin = String(baseUrl).replace(/\/+$/, '');
    const key = String(routeKey).replace(/^\/+|\/+$/g, '');
    return new URL(`${origin}/${key}/v1/chat/completions`);
}

// ── SSE streaming ───────────────────────────────────────────────────

async function* makeSSEStream(url, headers, payload, signal, meta) {
    const response = await doRequest(url, 'POST', headers, payload, signal);

    if (response.statusCode >= 400) {
        const body = await collectBody(response);
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            /* not JSON */
        }
        const err = new Error(
            `Ploinky agent OpenAI error: ${response.statusCode}`
        );
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
                    model: state.model || meta.model || null,
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
            state.model = parsed.model || meta.model || null;
            yield {
                type: 'message_start',
                data: {
                    id: parsed.id || meta.requestId || null,
                    model: state.model,
                    role: 'assistant',
                },
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

export default backendModule;
