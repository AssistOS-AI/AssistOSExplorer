/**
 * AWS Kiro backend module.
 *
 * Communicates with the Kiro API using AWS-style auth and binary
 * event-stream protocol.  Uses the kiro converter for format
 * translation.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
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
import * as kiroConverter from '../converters/kiro-converter.mjs';
import * as achillesKiro from 'achillesAgentLib/utils/LLMProviders/providers/kiro.mjs';
import {
    createAchillesExecutionHandle,
    getCredentialToken,
} from '../achilles/bridge.mjs';

// ── Manifest ────────────────────────────────────────────────────────

const manifest = {
    key: 'kiro-api',
    kind: 'external_api',
    authStrategy: 'oauth',
    supportsStreaming: true,
    supportsTools: true,
    supportedFormats: ['openai_chat'],
    displayName: 'AWS Kiro',
    defaultBaseUrl: 'https://api.kiro.dev',
    oauthAdapterKey: 'aws-kiro',
};

// Known Kiro models
const KNOWN_MODELS = [
    {
        modelId: 'claude-sonnet-4',
        displayName: 'Claude Sonnet 4 (Kiro)',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-3.7-sonnet',
        displayName: 'Claude 3.7 Sonnet (Kiro)',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'claude-haiku-4.5',
        displayName: 'Claude Haiku 4.5 (Kiro)',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'claude-sonnet-4.5',
        displayName: 'Claude Sonnet 4.5 (Kiro)',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: true,
    },
    {
        modelId: 'deepseek-3.2',
        displayName: 'DeepSeek 3.2 (Kiro)',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'minimax-m2.1',
        displayName: 'MiniMax M2.1 (Kiro)',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsTools: false,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'qwen3-coder-next',
        displayName: 'Qwen3 Coder Next (Kiro)',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
    {
        modelId: 'auto-kiro',
        displayName: 'Auto Kiro',
        contextWindow: 200000,
        maxOutputTokens: 16384,
        supportsTools: true,
        supportsStreaming: true,
        supportsVision: false,
    },
];

// ── Backend module ──────────────────────────────────────────────────

export const backendModule = {
    manifest,

    formatConverter: kiroConverter,

    async init() {},

    async shutdown() {},

    validateProviderRecord(providerRecord) {
        // baseUrl should point to the Kiro API endpoint
    },

    validateModelRecord(modelRecord) {
        if (!modelRecord.providerModelId && !modelRecord.modelKey) {
            throw new Error('Kiro model requires providerModelId or modelKey');
        }
    },

    async discoverModels() {
        return KNOWN_MODELS;
    },

    async testConnection(ctx) {
        const token =
            ctx.credentialLease?.oauth?.accessToken ||
            ctx.credentialLease?.secret;
        if (!token)
            return { ok: false, detail: 'No Kiro credentials configured' };
        // Kiro doesn't have a lightweight health endpoint — return optimistic
        return { ok: true, detail: 'Kiro credentials present' };
    },

    async execute(ctx) {
        const {
            request: normalizedReq,
            resolvedModel,
            providerRecord,
            credentialLease,
            signal,
        } = ctx;
        const baseUrl = providerRecord.baseUrl || 'https://api.kiro.dev';
        const token = getCredentialToken(credentialLease);
        const headers = {
            Accept: 'application/vnd.amazon.eventstream',
        };
        const params = { stream: true };
        if (normalizedReq.max_tokens != null)
            params.max_tokens = normalizedReq.max_tokens;
        if (normalizedReq.temperature != null)
            params.temperature = normalizedReq.temperature;
        if (normalizedReq.top_p != null) params.top_p = normalizedReq.top_p;
        if (normalizedReq.stop != null) params.stop = normalizedReq.stop;
        if (normalizedReq.tools && normalizedReq.tools.length > 0)
            params.tools = normalizedReq.tools;

        // AWS-style signing if credentials provide access keys
        const awsAccessKey = credentialLease?.metadata?.aws_access_key;
        const awsSecretKey = credentialLease?.metadata?.aws_secret_key;
        const awsSessionToken = credentialLease?.metadata?.aws_session_token;
        const region = providerRecord.settings?.kiro_region || 'us-east-1';
        params.region = region;

        if (awsAccessKey && awsSecretKey) {
            const now = new Date();
            const sigHeaders = signAWSRequest({
                method: 'POST',
                url: new URL(baseUrl + '/v1/converse-stream'),
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/vnd.amazon.eventstream',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify(
                    kiroConverter.toProviderRequest(
                        normalizedReq,
                        resolvedModel,
                        providerRecord
                    )
                ),
                accessKey: awsAccessKey,
                secretKey: awsSecretKey,
                sessionToken: awsSessionToken,
                region,
                service: 'bedrock',
                now,
            });
            Object.assign(headers, sigHeaders);
        }
        if (providerRecord.settings?.extra_headers) {
            Object.assign(headers, providerRecord.settings.extra_headers);
        }

        return createAchillesExecutionHandle(ctx, achillesKiro, {
            model: resolvedModel.providerModelId || resolvedModel.modelKey,
            apiKey: token,
            baseURL: baseUrl,
            signal,
            params,
            headers,
        });
    },

    classifyError(error, _ctx) {
        const status = getProviderStatus(error);
        const body = error.body || {};
        const errorCode = body.__type || body.code || body.error?.code || '';
        const message = getProviderMessage(error);

        // AWS error codes
        if (
            errorCode === 'UnrecognizedClientException' ||
            errorCode === 'AccessDeniedException' ||
            status === HTTP_STATUS.UNAUTHORIZED ||
            status === HTTP_STATUS.FORBIDDEN
        ) {
            return new ProviderAuthError('kiro', message || 'Auth failed');
        }
        if (
            errorCode === 'ResourceNotFoundException' ||
            status === HTTP_STATUS.NOT_FOUND
        ) {
            return new ProviderModelNotFoundError('kiro', message || 'unknown');
        }
        if (
            errorCode === 'ThrottlingException' ||
            errorCode === 'TooManyRequestsException' ||
            status === HTTP_STATUS.TOO_MANY_REQUESTS
        ) {
            if (looksLikeQuotaError(message)) {
                return new ProviderQuotaError('kiro');
            }
            return new ProviderRateLimitError('kiro');
        }
        if (
            errorCode === 'ValidationException' ||
            status === HTTP_STATUS.BAD_REQUEST
        ) {
            if (looksLikeContentPolicyError(message)) {
                return new ProviderContentPolicyError('kiro');
            }
        }
        if (
            errorCode === 'ServiceUnavailableException' ||
            status === HTTP_STATUS.SERVICE_UNAVAILABLE
        ) {
            return new ProviderUnavailableError('kiro');
        }
        if (status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && status < 600) {
            return classifyTransportOrServerError('kiro', error, status);
        }

        return classifyTransportOrServerError('kiro', error);
    },
};

// ── Binary event-stream parsing ─────────────────────────────────────

async function* makeKiroStream(url, headers, payload, signal) {
    const response = await doRequest(url, 'POST', headers, payload, signal);

    if (response.statusCode >= 400) {
        const body = await collectBody(response);
        let parsed = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            /* not JSON */
        }
        const err = new Error(`Kiro API error: ${response.statusCode}`);
        err.status = response.statusCode;
        err.body = parsed;
        throw err;
    }

    const contentType = response.headers['content-type'] || '';
    const converterState = {};

    if (contentType.includes('application/vnd.amazon.eventstream')) {
        // Binary event-stream protocol
        for await (const frame of parseBinaryEventStream(response)) {
            const normalized = kiroConverter.fromProviderChunk(
                frame,
                converterState
            );
            for (const chunk of normalized) {
                yield chunk;
            }
        }
    } else {
        // Fallback: SSE or JSON lines
        for await (const event of parseSSE(response)) {
            let parsed;
            try {
                parsed = JSON.parse(event.data);
            } catch {
                continue;
            }

            if (event.event && !parsed.type) {
                parsed.type = event.event;
            }

            const normalized = kiroConverter.fromProviderChunk(
                parsed,
                converterState
            );
            for (const chunk of normalized) {
                yield chunk;
            }
        }
    }
}

async function* parseBinaryEventStream(res) {
    let buffer = Buffer.alloc(0);

    for await (const chunk of res) {
        buffer = Buffer.concat([buffer, chunk]);

        // Process complete frames
        while (buffer.length >= 12) {
            const totalLength = buffer.readUInt32BE(0);

            if (buffer.length < totalLength) break; // Wait for more data

            const frameBytes = buffer.subarray(0, totalLength);
            buffer = buffer.subarray(totalLength);

            const frame = kiroConverter.parseBinaryFrame(frameBytes);
            if (frame) {
                yield frame;
            }
        }
    }
}

// ── AWS Signature V4 (simplified) ──────────────────────────────────

function signAWSRequest({
    method,
    url,
    headers,
    body,
    accessKey,
    secretKey,
    sessionToken,
    region,
    service,
    now,
}) {
    const dateStamp = formatDate(now);
    const amzDate = formatAmzDate(now);
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

    const canonicalHeaders = `content-type:${headers['Content-Type']}\nhost:${url.hostname}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-date';

    const payloadHash = sha256(body);
    const canonicalRequest = [
        method,
        url.pathname,
        url.search.replace('?', ''),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
    const signature = hmacHex(signingKey, stringToSign);

    const result = {
        'x-amz-date': amzDate,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };

    if (sessionToken) {
        result['x-amz-security-token'] = sessionToken;
    }

    return result;
}

function sha256(data) {
    return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
    return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacHex(key, data) {
    return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

function getSignatureKey(key, dateStamp, region, service) {
    const kDate = hmac('AWS4' + key, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

function formatDate(d) {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function formatAmzDate(d) {
    return d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z/, 'Z');
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
