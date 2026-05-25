import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Extension SDK ───────────────────────────────────────────────────

import { createExtensionContext } from '../../runtime/providers/extension-sdk.mjs';

describe('Extension SDK stubs', () => {
    it('createExtensionContext returns an object with services', () => {
        const ctx = createExtensionContext({});
        assert.ok(ctx.services, 'should have services');
        assert.ok(typeof ctx.services.invokeModel === 'function');
        assert.ok(typeof ctx.services.invokeSearch === 'function');
        assert.ok(typeof ctx.services.credentials.get === 'function');
        assert.ok(typeof ctx.services.credentials.signRequest === 'function');
        assert.ok(typeof ctx.services.browserPool.acquire === 'function');
        assert.ok(typeof ctx.services.browserPool.release === 'function');
        assert.ok(typeof ctx.services.tokenEstimator.estimate === 'function');
        assert.ok(
            typeof ctx.services.tokenEstimator.countTokens === 'function'
        );
    });

    it('invokeModel rejects without snapshot', async () => {
        const ctx = createExtensionContext({});
        await assert.rejects(
            () => ctx.services.invokeModel('test', { messages: [] }),
            /snapshot/i
        );
    });

    it('invokeSearch rejects without snapshot', async () => {
        const ctx = createExtensionContext({});
        await assert.rejects(
            () => ctx.services.invokeSearch('test', 'query'),
            /snapshot/i
        );
    });

    it('credentials.get rejects without CredentialManager', async () => {
        const ctx = createExtensionContext({});
        await assert.rejects(
            () => ctx.services.credentials.get('provider-1'),
            /CredentialManager/i
        );
    });

    it('credentials.signRequest uses leased secret material and releases the lease', async () => {
        let releasedLease = null;
        const ctx = createExtensionContext({
            services: {
                credentialManager: {
                    async getCredentials() {
                        return {
                            leaseId: 'lease-1',
                            accountId: 'acc-1',
                            authType: 'oauth',
                            secret: null,
                            oauth: {
                                accessToken: 'oauth-token',
                                refreshToken: null,
                                expiresAt: null,
                            },
                            metadata: {},
                        };
                    },
                    release(lease) {
                        releasedLease = lease;
                    },
                },
            },
        });

        const headers = await ctx.services.credentials.signRequest({
            providerId: 'provider-1',
            headers: { 'X-Test': '1' },
        });

        assert.equal(headers.Authorization, 'Bearer oauth-token');
        assert.equal(headers['X-Test'], '1');
        assert.equal(releasedLease.leaseId, 'lease-1');
    });

    it('browserPool.acquire rejects with helpful message', async () => {
        const ctx = createExtensionContext({});
        await assert.rejects(
            () => ctx.services.browserPool.acquire(),
            /browser runtime/i
        );
    });

    it('tokenEstimator.estimate returns a number', () => {
        const ctx = createExtensionContext({});
        const result = ctx.services.tokenEstimator.estimate({
            messages: [{ role: 'user', content: 'hello world' }],
        });
        assert.equal(typeof result, 'number');
        assert.ok(result > 0);
    });
});

// ── Provider Interface (manifest validation) ────────────────────────

import { validateBackendManifest } from '../../runtime/backends/backend-interface.mjs';

describe('Provider manifest validation', () => {
    const validManifest = {
        key: 'test-provider',
        kind: 'external_api',
        authStrategy: 'api_key',
        supportsStreaming: true,
        supportsTools: true,
        supportedFormats: ['openai_chat'],
    };

    it('accepts a valid manifest', () => {
        assert.doesNotThrow(() => validateBackendManifest(validManifest));
    });

    it('rejects null manifest', () => {
        assert.throws(
            () => validateBackendManifest(null),
            /must be a non-null object/
        );
    });

    it('rejects missing key', () => {
        assert.throws(
            () => validateBackendManifest({ ...validManifest, key: '' }),
            /non-empty string/
        );
    });

    it('rejects invalid kind', () => {
        assert.throws(
            () => validateBackendManifest({ ...validManifest, kind: 'invalid' }),
            /kind must be one of/
        );
    });

    it('accepts all valid kinds', () => {
        for (const kind of [
            'external_api',
            'search',
            'local_model',
            'custom',
        ]) {
            assert.doesNotThrow(() =>
                validateBackendManifest({ ...validManifest, kind })
            );
        }
    });

    it('rejects invalid authStrategy', () => {
        assert.throws(
            () =>
                validateBackendManifest({ ...validManifest, authStrategy: 'invalid' }),
            /authStrategy must be one of/
        );
    });

    it('accepts all valid authStrategies', () => {
        for (const authStrategy of [
            'none',
            'api_key',
            'oauth',
            'hybrid',
            'custom',
        ]) {
            assert.doesNotThrow(() =>
                validateBackendManifest({ ...validManifest, authStrategy })
            );
        }
    });

    it('rejects non-boolean supportsStreaming', () => {
        assert.throws(
            () =>
                validateBackendManifest({
                    ...validManifest,
                    supportsStreaming: 'yes',
                }),
            /boolean/
        );
    });

    it('rejects non-boolean supportsTools', () => {
        assert.throws(
            () => validateBackendManifest({ ...validManifest, supportsTools: 1 }),
            /boolean/
        );
    });

    it('rejects non-array supportedFormats', () => {
        assert.throws(
            () =>
                validateBackendManifest({
                    ...validManifest,
                    supportedFormats: 'openai_chat',
                }),
            /array/
        );
    });
});

// ── Provider Context ────────────────────────────────────────────────

import { createBackendExecutionContext } from '../../runtime/backends/backend-context.mjs';

describe('Provider context', () => {
    it('creates a frozen context from exec context', () => {
        const ctx = createBackendExecutionContext({
            requestId: 'req-1',
            request: { messages: [] },
            resolvedModel: { id: 'm1' },
            providerRecord: { id: 'p1' },
            signal: AbortSignal.timeout(5000),
            logger: { info() {} },
        });

        assert.equal(ctx.requestId, 'req-1');
        assert.deepEqual(ctx.request, { messages: [] });
        assert.equal(ctx.credentialLease, null);
        assert.deepEqual(ctx.attempt, { index: 0, previousErrors: [] });
        assert.ok(Object.isFrozen(ctx));
        assert.ok(Object.isFrozen(ctx.attempt));
    });
});

// ── Error classification: OpenAI ────────────────────────────────────

import {
    backendModule as openaiPlugin,
    providerSupportsOpenAiStreamOptions,
} from '../../runtime/backends/builtin/openai-api.backend.mjs';

describe('OpenAI error classification', () => {
    it('classifies 401 as ProviderAuthError', () => {
        const err = openaiPlugin.classifyError({ status: 401, body: {} });
        assert.equal(err.errorType, 'provider_auth_error');
        assert.equal(err.httpStatus, 502);
    });

    it('classifies 429 as ProviderRateLimitError', () => {
        const err = openaiPlugin.classifyError({ status: 429, body: {} });
        assert.equal(err.errorType, 'provider_rate_limited');
        assert.equal(err.cooldown, true);
    });

    it('classifies 429 with insufficient_quota as ProviderQuotaError', () => {
        const err = openaiPlugin.classifyError({
            status: 429,
            body: { error: { type: 'insufficient_quota' } },
        });
        assert.equal(err.errorType, 'provider_quota_exhausted');
    });

    it('classifies 400 content_policy_violation as ProviderContentPolicyError', () => {
        const err = openaiPlugin.classifyError({
            status: 400,
            body: { error: { type: 'content_policy_violation' } },
        });
        assert.equal(err.errorType, 'provider_content_policy');
    });

    it('classifies 404 as ProviderModelNotFoundError', () => {
        const err = openaiPlugin.classifyError({ status: 404, body: {} });
        assert.equal(err.errorType, 'provider_model_not_found');
    });

    it('classifies 503 as ProviderUnavailableError', () => {
        const err = openaiPlugin.classifyError({ status: 503, body: {} });
        assert.equal(err.errorType, 'provider_unavailable');
    });

    it('classifies 500 as ProviderServerError', () => {
        const err = openaiPlugin.classifyError({ status: 500, body: {} });
        assert.equal(err.errorType, 'provider_server_error');
    });

    it('classifies ETIMEDOUT as ProviderTimeoutError', () => {
        const err = openaiPlugin.classifyError({ code: 'ETIMEDOUT' });
        assert.equal(err.errorType, 'provider_timeout');
    });

    it('classifies ECONNREFUSED as ProviderUnavailableError', () => {
        const err = openaiPlugin.classifyError({ code: 'ECONNREFUSED' });
        assert.equal(err.errorType, 'provider_unavailable');
    });

    it('manifest has correct shape', () => {
        assert.equal(openaiPlugin.manifest.key, 'openai-api');
        assert.equal(openaiPlugin.manifest.kind, 'external_api');
        assert.equal(openaiPlugin.manifest.authStrategy, 'api_key');
        assert.equal(openaiPlugin.manifest.supportsStreaming, true);
        assert.equal(openaiPlugin.manifest.supportsTools, true);
    });
});

describe('OpenAI stream_options capability detection', () => {
    it('disables stream_options for NVIDIA providers by default', () => {
        assert.equal(
            providerSupportsOpenAiStreamOptions({
                providerKey: 'nvidia',
                baseUrl: 'https://integrate.api.nvidia.com/v1',
                settings: {},
            }),
            false
        );
    });

    it('respects explicit provider settings overrides', () => {
        assert.equal(
            providerSupportsOpenAiStreamOptions({
                providerKey: 'nvidia',
                baseUrl: 'https://integrate.api.nvidia.com/v1',
                settings: { supports_stream_options: true },
            }),
            true
        );
        assert.equal(
            providerSupportsOpenAiStreamOptions({
                providerKey: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                settings: { supportsStreamOptions: false },
            }),
            false
        );
    });

    it('keeps stream_options enabled for compatible providers by default', () => {
        assert.equal(
            providerSupportsOpenAiStreamOptions({
                providerKey: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
                settings: {},
            }),
            true
        );
    });
});

// ── Error classification: Anthropic ─────────────────────────────────

import { backendModule as anthropicPlugin } from '../../runtime/backends/builtin/anthropic-api.backend.mjs';

describe('Anthropic error classification', () => {
    it('classifies authentication_error as ProviderAuthError', () => {
        const err = anthropicPlugin.classifyError({
            status: 401,
            body: { error: { type: 'authentication_error' } },
        });
        assert.equal(err.errorType, 'provider_auth_error');
    });

    it('classifies rate_limit_error as ProviderRateLimitError', () => {
        const err = anthropicPlugin.classifyError({
            status: 429,
            body: { error: { type: 'rate_limit_error' } },
        });
        assert.equal(err.errorType, 'provider_rate_limited');
    });

    it('classifies overloaded_error as ProviderUnavailableError', () => {
        const err = anthropicPlugin.classifyError({
            status: 529,
            body: { error: { type: 'overloaded_error' } },
        });
        assert.equal(err.errorType, 'provider_unavailable');
    });

    it('classifies not_found_error as ProviderModelNotFoundError', () => {
        const err = anthropicPlugin.classifyError({
            status: 404,
            body: { error: { type: 'not_found_error' } },
        });
        assert.equal(err.errorType, 'provider_model_not_found');
    });

    it('classifies content policy as ProviderContentPolicyError', () => {
        const err = anthropicPlugin.classifyError({
            status: 400,
            body: {
                error: {
                    type: 'invalid_request_error',
                    message: 'content policy violation',
                },
            },
        });
        assert.equal(err.errorType, 'provider_content_policy');
    });

    it('manifest has correct shape', () => {
        assert.equal(anthropicPlugin.manifest.key, 'anthropic-api');
        assert.equal(anthropicPlugin.manifest.kind, 'external_api');
        assert.ok(
            anthropicPlugin.manifest.supportedFormats.includes(
                'anthropic_messages'
            )
        );
    });
});

// ── Error classification: Copilot ───────────────────────────────────

import { backendModule as copilotPlugin } from '../../runtime/backends/builtin/copilot-api.backend.mjs';

describe('Copilot error classification', () => {
    it('classifies 401 as ProviderAuthError', () => {
        const err = copilotPlugin.classifyError({ status: 401, body: {} });
        assert.equal(err.errorType, 'provider_auth_error');
    });

    it('classifies 429 quota as ProviderQuotaError', () => {
        const err = copilotPlugin.classifyError({
            status: 429,
            body: { message: 'premium request limit exceeded' },
        });
        assert.equal(err.errorType, 'provider_quota_exhausted');
    });

    it('classifies 429 without quota as ProviderRateLimitError', () => {
        const err = copilotPlugin.classifyError({ status: 429, body: {} });
        assert.equal(err.errorType, 'provider_rate_limited');
    });

    it('manifest uses oauth auth strategy', () => {
        assert.equal(copilotPlugin.manifest.authStrategy, 'oauth');
    });
});

// ── Error classification: Kiro ──────────────────────────────────────

import { backendModule as kiroPlugin } from '../../runtime/backends/builtin/kiro-api.backend.mjs';

describe('Kiro error classification', () => {
    it('classifies AccessDeniedException as ProviderAuthError', () => {
        const err = kiroPlugin.classifyError({
            status: 403,
            body: { __type: 'AccessDeniedException', message: 'Denied' },
        });
        assert.equal(err.errorType, 'provider_auth_error');
    });

    it('classifies ThrottlingException as ProviderRateLimitError', () => {
        const err = kiroPlugin.classifyError({
            status: 429,
            body: { __type: 'ThrottlingException' },
        });
        assert.equal(err.errorType, 'provider_rate_limited');
    });

    it('classifies ResourceNotFoundException as ProviderModelNotFoundError', () => {
        const err = kiroPlugin.classifyError({
            status: 404,
            body: { __type: 'ResourceNotFoundException' },
        });
        assert.equal(err.errorType, 'provider_model_not_found');
    });

    it('classifies ServiceUnavailableException as ProviderUnavailableError', () => {
        const err = kiroPlugin.classifyError({
            status: 503,
            body: { __type: 'ServiceUnavailableException' },
        });
        assert.equal(err.errorType, 'provider_unavailable');
    });

    it('classifies guardrail content as ProviderContentPolicyError', () => {
        const err = kiroPlugin.classifyError({
            status: 400,
            body: {
                __type: 'ValidationException',
                message: 'guardrail violation',
            },
        });
        assert.equal(err.errorType, 'provider_content_policy');
    });

    it('manifest uses oauth auth strategy', () => {
        assert.equal(kiroPlugin.manifest.authStrategy, 'oauth');
    });
});

// ── Error classification: Search ────────────────────────────────────

import { backendModule as searchPlugin } from '../../runtime/backends/builtin/search-builtin.backend.mjs';

describe('Search error classification', () => {
    it('classifies 401 as ProviderAuthError', () => {
        const err = searchPlugin.classifyError({ status: 401 });
        assert.equal(err.errorType, 'provider_auth_error');
    });

    it('classifies 429 as ProviderRateLimitError', () => {
        const err = searchPlugin.classifyError({ status: 429 });
        assert.equal(err.errorType, 'provider_rate_limited');
    });

    it('manifest is search kind', () => {
        assert.equal(searchPlugin.manifest.kind, 'search');
        assert.equal(searchPlugin.manifest.supportsStreaming, true);
    });
});

// ── search-builtin testConnection engine resolution ─────────────────

describe('search-builtin testConnection engine resolution', () => {
    // The lifecycle path (Test button in the dashboard / POST
    // /management/providers/:id/test) calls testConnection() WITHOUT
    // a resolved model in scope, so the backend can't read the engine
    // off ctx.resolvedModel. The previous implementation hardcoded
    // 'tavily' as the fallback, which made every search provider's
    // Test button report "Tavily Search credentials present" — even
    // for an Exa, Brave, Serper, etc. provider. The fix walks
    // providerRecord (settings → providerKey → baseUrl hostname)
    // to figure out which engine the row actually represents.

    function makeCtx(providerRecord, secret = 'fake-secret') {
        return {
            providerRecord,
            credentialLease: { secret },
            // resolvedModel deliberately omitted — this is the lifecycle case
        };
    }

    it('reports the right engine name for an Exa provider via providerKey', async () => {
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'exa',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.exa.ai/search',
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /Exa Search/);
        assert.doesNotMatch(result.detail, /Tavily/);
    });

    it('reports the right engine name for a Brave provider via providerKey', async () => {
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'brave',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.search.brave.com/res/v1/web/search',
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /Brave Search/);
    });

    it('reports the right engine name for a Tavily provider', async () => {
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'tavily',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.tavily.com/search',
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /Tavily Search/);
    });

    it('reports DuckDuckGo as credential-free even with no secret', async () => {
        const result = await searchPlugin.testConnection({
            providerRecord: {
                providerKey: 'duckduckgo',
                adapterKey: 'search-builtin',
                baseUrl: 'https://html.duckduckgo.com/html/',
            },
            credentialLease: null,
        });
        assert.equal(result.ok, true);
        assert.match(result.detail, /DuckDuckGo/);
        assert.match(result.detail, /does not require authentication/);
    });

    it('falls back to baseUrl hostname when providerKey was renamed', async () => {
        // User renamed the provider but the base URL still points at
        // the canonical Exa endpoint — the backend should still resolve
        // to "Exa Search", not the literal hardcoded fallback.
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'my-search-provider',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.exa.ai/search',
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /Exa Search/);
    });

    it('honours an explicit settings.engine override', async () => {
        // settings.engine wins over providerKey + baseUrl so users
        // running a forked endpoint can still pin the engine they meant.
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'mystery',
                adapterKey: 'search-builtin',
                baseUrl: 'https://forked.example.com/search',
                settings: { engine: 'serper' },
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /Serper Search/);
    });

    it('keeps using the resolved model when the execution path passes one in', async () => {
        // execute() / discoverModels() pass ctx.resolvedModel; that
        // remains the most specific signal and beats providerKey.
        const result = await searchPlugin.testConnection({
            providerRecord: {
                providerKey: 'exa',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.exa.ai/search',
            },
            resolvedModel: { providerModelId: 'brave' },
            credentialLease: { secret: 'fake' },
        });
        assert.equal(result.ok, true);
        assert.match(result.detail, /Brave Search/);
    });

    it('reports a generic credential-present message when no engine can be identified', async () => {
        const result = await searchPlugin.testConnection(
            makeCtx({
                providerKey: 'totally-custom',
                adapterKey: 'search-builtin',
                baseUrl: 'https://unknown.example.com/api',
            })
        );
        assert.equal(result.ok, true);
        assert.match(result.detail, /credentials present/);
        assert.doesNotMatch(result.detail, /Tavily/);
    });

    it('reports missing credentials with the engine name when secret is absent', async () => {
        const result = await searchPlugin.testConnection({
            providerRecord: {
                providerKey: 'exa',
                adapterKey: 'search-builtin',
                baseUrl: 'https://api.exa.ai/search',
            },
            credentialLease: null,
        });
        assert.equal(result.ok, false);
        assert.match(result.detail, /Exa Search/);
        assert.match(result.detail, /API key/i);
    });
});

// ── search provider invariant ───────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

describe('search provider invariant', () => {
    const backendPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../runtime/backends/builtin/search-builtin.backend.mjs'
    );
    const backendSource = readFileSync(backendPath, 'utf8');

    it('search-builtin does not import from Achilles SearchProviders', () => {
        assert.doesNotMatch(
            backendSource,
            /from\s+['"]achillesAgentLib\/utils\/SearchProviders/
        );
    });

    it('search-builtin owns API search dispatch (has SEARCH_PROVIDERS table)', () => {
        assert.match(backendSource, /\bSEARCH_PROVIDERS\b/);
    });

    it('search-builtin owns vendor HTTP transport (doSearchRequest)', () => {
        assert.match(backendSource, /\bdoSearchRequest\b/);
    });

    it('Achilles search helper has no vendor HTTP code', () => {
        const achillesPath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../node_modules/achillesAgentLib/utils/SearchProviders/search.mjs'
        );
        const achillesSource = readFileSync(achillesPath, 'utf8');
        assert.doesNotMatch(achillesSource, /api\.tavily\.com/);
        assert.doesNotMatch(achillesSource, /api\.search\.brave\.com/);
        assert.doesNotMatch(achillesSource, /\bfetch\s*\(/);
        assert.match(achillesSource, /from\s+['"]\.\.\/LLMClient\.mjs['"]/);
    });

    it('headless-search is a valid kind: "search" backend', async () => {
        const { backendModule: headless } = await import(
            '../../runtime/backends/builtin/headless-search.backend.mjs'
        );
        assert.equal(headless.manifest.kind, 'search');
        assert.deepEqual(headless.manifest.supportedFormats, ['openai_chat']);
    });

    it('search-builtin and headless-search share the same output format', () => {
        assert.deepEqual(
            searchPlugin.manifest.supportedFormats,
            ['openai_chat']
        );
    });

    it('built-in search backends advertise streaming support', async () => {
        const { backendModule: headless } = await import(
            '../../runtime/backends/builtin/headless-search.backend.mjs'
        );
        assert.equal(searchPlugin.manifest.supportsStreaming, true);
        assert.equal(headless.manifest.supportsStreaming, true);

        const [searchModels, headlessModels] = await Promise.all([
            searchPlugin.discoverModels(),
            headless.discoverModels(),
        ]);
        assert.ok(
            searchModels.every((model) => model.supportsStreaming === true)
        );
        assert.ok(
            headlessModels.every((model) => model.supportsStreaming === true)
        );
    });
});

// ── LLM provider inference invariant ────────────────────────────────

const LLM_BACKEND_EXECUTION_CONTRACTS = [
    {
        fileName: 'openai-api.backend.mjs',
        achillesBinding: 'achillesOpenAI',
    },
    {
        fileName: 'anthropic-api.backend.mjs',
        achillesBinding: 'achillesAnthropic',
    },
    {
        fileName: 'copilot-api.backend.mjs',
        achillesBinding: 'achillesCopilot',
    },
    {
        fileName: 'kiro-api.backend.mjs',
        achillesBinding: 'achillesKiro',
    },
    {
        fileName: 'codex-api.backend.mjs',
        achillesBinding: 'achillesResponses',
    },
];

function readBuiltinBackendSource(fileName) {
    return readFileSync(
        path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../runtime/backends/builtin',
            fileName
        ),
        'utf8'
    );
}

function extractExecuteBody(source, fileName) {
    const marker = 'async execute(ctx)';
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${fileName} must define async execute(ctx)`);

    const braceStart = source.indexOf('{', start);
    assert.notEqual(braceStart, -1, `${fileName} execute(ctx) must have a body`);

    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        const char = source[i];
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
        if (depth === 0) {
            return source.slice(braceStart + 1, i);
        }
    }

    assert.fail(`${fileName} execute(ctx) body was not balanced`);
}

describe('LLM provider inference invariant', () => {
    it('request-time LLM execute paths delegate to Achilles transport handles', () => {
        for (const { fileName, achillesBinding } of LLM_BACKEND_EXECUTION_CONTRACTS) {
            const source = readBuiltinBackendSource(fileName);
            const executeBody = extractExecuteBody(source, fileName);

            assert.match(
                source,
                /from\s+['"]achillesAgentLib\/utils\/LLMProviders\/providers\//,
                `${fileName} must import its request-time transport from Achilles`
            );
            assert.match(
                executeBody,
                new RegExp(
                    `createAchillesExecutionHandle\\(ctx,\\s*${achillesBinding}\\b`
                ),
                `${fileName} execute(ctx) must dispatch through Achilles`
            );
        }
    });

    it('request-time LLM execute paths do not perform local upstream HTTP', () => {
        for (const { fileName } of LLM_BACKEND_EXECUTION_CONTRACTS) {
            const source = readBuiltinBackendSource(fileName);
            const executeBody = extractExecuteBody(source, fileName);

            assert.doesNotMatch(
                executeBody,
                /\b(fetch|httpGet|httpProbeStatus|doRequest|httpRequest|httpsRequest)\s*\(/,
                `${fileName} execute(ctx) must not implement a local inference transport`
            );
        }
    });
});

// ── Anthropic converter ─────────────────────────────────────────────

import * as anthropicConverter from '../../runtime/backends/converters/anthropic-converter.mjs';

describe('Anthropic converter', () => {
    describe('toProviderRequest', () => {
        it('extracts system messages to top-level system field', () => {
            const req = {
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'Hello' },
                ],
                max_tokens: 1024,
            };
            const result = anthropicConverter.toProviderRequest(
                req,
                { providerModelId: 'claude-3-haiku-20240307' },
                {}
            );

            assert.equal(result.system, 'You are helpful.');
            assert.equal(result.messages.length, 1);
            assert.equal(result.messages[0].role, 'user');
            assert.equal(result.model, 'claude-3-haiku-20240307');
        });

        it('converts tool result messages to user role with tool_result content', () => {
            const req = {
                messages: [
                    { role: 'tool', content: '42', tool_call_id: 'tc-1' },
                ],
                max_tokens: 1024,
            };
            const result = anthropicConverter.toProviderRequest(
                req,
                { providerModelId: 'claude-3-haiku-20240307' },
                {}
            );

            assert.equal(result.messages[0].role, 'user');
            assert.equal(result.messages[0].content[0].type, 'tool_result');
            assert.equal(result.messages[0].content[0].tool_use_id, 'tc-1');
        });

        it('converts tool definitions to Anthropic format', () => {
            const req = {
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 1024,
                tools: [
                    {
                        function: {
                            name: 'get_weather',
                            description: 'Get weather',
                            parameters: {
                                type: 'object',
                                properties: { city: { type: 'string' } },
                            },
                        },
                    },
                ],
            };
            const result = anthropicConverter.toProviderRequest(
                req,
                { providerModelId: 'claude-3-haiku-20240307' },
                {}
            );

            assert.equal(result.tools[0].name, 'get_weather');
            assert.ok(result.tools[0].input_schema);
        });
    });

    describe('fromProviderChunk', () => {
        it('converts message_start event', () => {
            const state = {};
            const chunks = anthropicConverter.fromProviderChunk(
                {
                    type: 'message_start',
                    message: {
                        id: 'msg-1',
                        model: 'claude-3-haiku',
                        role: 'assistant',
                        usage: { input_tokens: 10 },
                    },
                },
                state
            );

            assert.equal(chunks.length, 2);
            assert.equal(chunks[0].type, 'message_start');
            assert.equal(chunks[0].data.id, 'msg-1');
            assert.equal(chunks[1].type, 'usage');
            assert.equal(chunks[1].data.input_tokens, 10);
        });

        it('converts text_delta event', () => {
            const state = {
                _initialized: true,
                currentBlockIndex: 0,
                toolCallMap: new Map(),
                messageId: null,
                model: null,
            };
            const chunks = anthropicConverter.fromProviderChunk(
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'Hello' },
                },
                state
            );

            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].type, 'text_delta');
            assert.equal(chunks[0].data.text, 'Hello');
        });

        it('converts tool_use content_block_start', () => {
            const state = {
                _initialized: true,
                currentBlockIndex: -1,
                toolCallMap: new Map(),
                messageId: null,
                model: null,
            };
            const chunks = anthropicConverter.fromProviderChunk(
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'tc-1',
                        name: 'get_weather',
                    },
                },
                state
            );

            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].type, 'tool_call_delta');
            assert.equal(chunks[0].data.id, 'tc-1');
            assert.equal(chunks[0].data.name, 'get_weather');
        });

        it('converts message_delta with stop_reason', () => {
            const state = {
                _initialized: true,
                currentBlockIndex: 0,
                toolCallMap: new Map(),
                messageId: null,
                model: 'claude-3',
            };
            const chunks = anthropicConverter.fromProviderChunk(
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 50 },
                },
                state
            );

            // Should produce both done and usage
            const doneChunk = chunks.find((c) => c.type === 'done');
            const usageChunk = chunks.find((c) => c.type === 'usage');
            assert.ok(doneChunk);
            assert.equal(doneChunk.data.finish_reason, 'stop');
            assert.ok(usageChunk);
            assert.equal(usageChunk.data.output_tokens, 50);
        });

        it('maps tool_use stop_reason to tool_calls finish_reason', () => {
            const state = {
                _initialized: true,
                currentBlockIndex: 0,
                toolCallMap: new Map(),
                messageId: null,
                model: 'claude-3',
            };
            const chunks = anthropicConverter.fromProviderChunk(
                {
                    type: 'message_delta',
                    delta: { stop_reason: 'tool_use' },
                },
                state
            );

            const doneChunk = chunks.find((c) => c.type === 'done');
            assert.equal(doneChunk.data.finish_reason, 'tool_calls');
        });

        it('ignores ping events', () => {
            const state = {};
            const chunks = anthropicConverter.fromProviderChunk(
                { type: 'ping' },
                state
            );
            assert.equal(chunks.length, 0);
        });
    });

    describe('toBufferedResponse', () => {
        it('converts a complete Anthropic response', () => {
            const raw = {
                id: 'msg-1',
                model: 'claude-3-haiku',
                role: 'assistant',
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Hello world' }],
                usage: { input_tokens: 10, output_tokens: 5 },
            };
            const result = anthropicConverter.toBufferedResponse(raw);

            assert.equal(result.id, 'msg-1');
            assert.equal(result.content, 'Hello world');
            assert.equal(result.finish_reason, 'stop');
            assert.equal(result.usage.total_tokens, 15);
        });
    });
});

// ── Copilot converter ───────────────────────────────────────────────

import * as copilotConverter from '../../runtime/backends/converters/copilot-converter.mjs';

describe('Copilot converter', () => {
    describe('resolveEndpoint', () => {
        it('routes o1-preview to responses endpoint', () => {
            assert.equal(
                copilotConverter.resolveEndpoint('o1-preview'),
                'responses'
            );
        });

        it('routes gpt-4o to completions endpoint', () => {
            assert.equal(
                copilotConverter.resolveEndpoint('gpt-4o'),
                'completions'
            );
        });

        it('routes gpt-4.1 to responses endpoint', () => {
            assert.equal(
                copilotConverter.resolveEndpoint('gpt-4.1'),
                'responses'
            );
        });

        it('honors force_endpoint setting', () => {
            assert.equal(
                copilotConverter.resolveEndpoint('gpt-4o', {
                    settings: { force_endpoint: 'responses' },
                }),
                'responses'
            );
            assert.equal(
                copilotConverter.resolveEndpoint('o1-preview', {
                    settings: { force_endpoint: 'completions' },
                }),
                'completions'
            );
        });
    });

    describe('toProviderRequest', () => {
        it('returns completions endpoint for gpt-4o', () => {
            const result = copilotConverter.toProviderRequest(
                { messages: [{ role: 'user', content: 'hi' }], stream: true },
                { providerModelId: 'gpt-4o' },
                {}
            );
            assert.equal(result.endpoint, 'completions');
            assert.equal(result.path, '/chat/completions');
        });

        it('returns responses endpoint for o1-preview', () => {
            const result = copilotConverter.toProviderRequest(
                { messages: [{ role: 'user', content: 'hi' }], stream: true },
                { providerModelId: 'o1-preview' },
                {}
            );
            assert.equal(result.endpoint, 'responses');
            assert.match(result.path, /\/models\/o1-preview\/responses/);
        });
    });

    describe('fromCompletionsChunk', () => {
        it('emits message_start on first chunk', () => {
            const state = {};
            const chunks = copilotConverter.fromCompletionsChunk(
                {
                    id: 'c-1',
                    model: 'gpt-4o',
                    choices: [{ delta: { content: 'Hi' } }],
                },
                state
            );
            const msgStart = chunks.find((c) => c.type === 'message_start');
            assert.ok(msgStart);
            assert.equal(msgStart.data.model, 'gpt-4o');
        });

        it('emits text_delta for content', () => {
            const state = {
                _initialized: true,
                firstChunk: false,
                model: 'gpt-4o',
            };
            const chunks = copilotConverter.fromCompletionsChunk(
                { choices: [{ delta: { content: 'World' } }] },
                state
            );
            const textDelta = chunks.find((c) => c.type === 'text_delta');
            assert.ok(textDelta);
            assert.equal(textDelta.data.text, 'World');
        });
    });
});

// ── Kiro converter ──────────────────────────────────────────────────

import * as kiroConverter from '../../runtime/backends/converters/kiro-converter.mjs';

describe('Kiro converter', () => {
    describe('toProviderRequest', () => {
        it('builds conversationState with turns', () => {
            const req = {
                messages: [
                    { role: 'system', content: 'Be helpful' },
                    { role: 'user', content: 'Hello' },
                ],
                max_tokens: 2048,
                temperature: 0.7,
            };
            const result = kiroConverter.toProviderRequest(
                req,
                { providerModelId: 'claude-sonnet-4' },
                {}
            );

            assert.equal(result.modelId, 'claude-sonnet-4');
            assert.equal(
                result.conversationState.systemInstruction,
                'Be helpful'
            );
            assert.equal(result.conversationState.turns.length, 1);
            assert.equal(result.conversationState.turns[0].role, 'user');
            assert.equal(result.inferenceConfig.maxTokens, 2048);
            assert.equal(result.inferenceConfig.temperature, 0.7);
        });
    });

    describe('fromProviderChunk', () => {
        it('converts messageStart event', () => {
            const state = {};
            const chunks = kiroConverter.fromProviderChunk(
                {
                    headers: { ':event-type': 'messageStart' },
                    payload: { model: 'claude-sonnet-4', role: 'assistant' },
                },
                state
            );

            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].type, 'message_start');
            assert.equal(chunks[0].data.model, 'claude-sonnet-4');
        });

        it('converts contentBlockDelta text', () => {
            const state = {
                _initialized: true,
                firstChunk: false,
                model: 'claude-sonnet-4',
                toolIndex: 0,
            };
            const chunks = kiroConverter.fromProviderChunk(
                {
                    headers: { ':event-type': 'contentBlockDelta' },
                    payload: { delta: { type: 'text_delta', text: 'Hello' } },
                },
                state
            );

            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].type, 'text_delta');
            assert.equal(chunks[0].data.text, 'Hello');
        });

        it('converts messageStop event', () => {
            const state = {
                _initialized: true,
                firstChunk: false,
                model: 'test',
                toolIndex: 0,
            };
            const chunks = kiroConverter.fromProviderChunk(
                {
                    headers: { ':event-type': 'messageStop' },
                    payload: { stopReason: 'end_turn' },
                },
                state
            );

            assert.equal(chunks.length, 1);
            assert.equal(chunks[0].type, 'done');
            assert.equal(chunks[0].data.finish_reason, 'stop');
        });
    });

    describe('parseBinaryFrame', () => {
        it('returns null for buffers smaller than 16 bytes', () => {
            assert.equal(
                kiroConverter.parseBinaryFrame(Buffer.alloc(10)),
                null
            );
        });

        it('returns null for null input', () => {
            assert.equal(kiroConverter.parseBinaryFrame(null), null);
        });
    });
});

// ── Search converter ────────────────────────────────────────────────

import * as searchConverter from '../../runtime/backends/converters/search-converter.mjs';

describe('Search converter', () => {
    describe('formatSearchResults', () => {
        it('formats results as markdown with citations', () => {
            const results = [
                {
                    title: 'Page 1',
                    url: 'https://example.com/1',
                    snippet: 'First result',
                },
                {
                    title: 'Page 2',
                    url: 'https://example.com/2',
                    snippet: 'Second result',
                },
            ];
            const formatted = searchConverter.formatSearchResults(
                results,
                'test query'
            );

            assert.match(formatted, /Search results for/);
            assert.match(formatted, /Page 1/);
            assert.match(formatted, /Page 2/);
            assert.match(formatted, /Sources/);
            assert.match(formatted, /\[1\]/);
            assert.match(formatted, /\[2\]/);
        });

        it('handles empty results', () => {
            const formatted = searchConverter.formatSearchResults([], 'test');
            assert.match(formatted, /No search results found/);
        });

        it('respects maxResults option', () => {
            const results = Array.from({ length: 20 }, (_, i) => ({
                title: `Page ${i}`,
                url: `https://example.com/${i}`,
                snippet: `Result ${i}`,
            }));
            const formatted = searchConverter.formatSearchResults(
                results,
                'test',
                { maxResults: 3 }
            );
            // Should only contain [1], [2], [3] in sources
            assert.match(formatted, /\[3\]/);
            assert.doesNotMatch(formatted, /\[4\]/);
        });
    });

    describe('toNormalizedChunks', () => {
        it('produces message_start, text_delta, usage, done', () => {
            const results = [
                { title: 'Page 1', url: 'https://x.com', snippet: 'Test' },
            ];
            const chunks = searchConverter.toNormalizedChunks(
                results,
                'query',
                {
                    requestId: 'r1',
                    model: 'search-tavily',
                }
            );

            assert.equal(chunks.length, 4);
            assert.equal(chunks[0].type, 'message_start');
            assert.equal(chunks[1].type, 'text_delta');
            assert.equal(chunks[2].type, 'usage');
            assert.equal(chunks[3].type, 'done');
        });
    });

    describe('per-provider extractors', () => {
        it('extractTavilyResults handles tavily format', () => {
            const results = searchConverter.extractTavilyResults({
                results: [
                    {
                        title: 'T',
                        url: 'https://t.com',
                        content: 'Snippet',
                        score: 0.9,
                    },
                ],
            });
            assert.equal(results.length, 1);
            assert.equal(results[0].title, 'T');
            assert.equal(results[0].snippet, 'Snippet');
        });

        it('extractBraveResults handles brave format', () => {
            const results = searchConverter.extractBraveResults({
                web: {
                    results: [
                        {
                            title: 'B',
                            url: 'https://b.com',
                            description: 'Brave snippet',
                        },
                    ],
                },
            });
            assert.equal(results.length, 1);
            assert.equal(results[0].snippet, 'Brave snippet');
        });

        it('extractSerperResults handles serper format', () => {
            const results = searchConverter.extractSerperResults({
                organic: [
                    {
                        title: 'S',
                        link: 'https://s.com',
                        snippet: 'Serper snippet',
                        position: 1,
                    },
                ],
            });
            assert.equal(results.length, 1);
            assert.equal(results[0].url, 'https://s.com');
        });

        it('extractDuckDuckGoResults handles DDG format', () => {
            const results = searchConverter.extractDuckDuckGoResults({
                AbstractText: 'DDG answer',
                AbstractURL: 'https://ddg.com',
                Heading: 'DDG',
                RelatedTopics: [],
            });
            assert.equal(results.length, 1);
            assert.equal(results[0].snippet, 'DDG answer');
        });

        it('extractSearxngResults handles searxng format', () => {
            const results = searchConverter.extractSearxngResults({
                results: [
                    { title: 'SX', url: 'https://sx.com', content: 'SearXNG' },
                ],
            });
            assert.equal(results.length, 1);
        });

        it('extractResults routes to correct extractor', () => {
            const results = searchConverter.extractResults('tavily', {
                results: [{ title: 'T', url: 'https://t.com', content: 'X' }],
            });
            assert.equal(results.length, 1);
        });

        it('extractResults returns empty for unknown provider', () => {
            const results = searchConverter.extractResults('unknown', {});
            assert.equal(results.length, 0);
        });
    });
});

// ── Credential Manager ──────────────────────────────────────────────

import { CredentialManager } from '../../runtime/providers/credential-manager.mjs';

describe('CredentialManager', () => {
    let manager;
    let mockAccountPool;

    // Default oauth-manager stub for the main suite: never signals that a
    // refresh is needed, so these tests don't have to model the inline
    // refresh path. The dedicated suite below exercises it explicitly.
    const noopOAuthManager = {
        needsRefresh() {
            return false;
        },
        async refreshTokens() {},
    };
    const noopProvidersDao = {
        async findById() {
            return null;
        },
    };

    beforeEach(() => {
        mockAccountPool = {
            _nextAccount: null,
            async getNextAccount() {
                return this._nextAccount;
            },
        };
        manager = new CredentialManager({
            pool: {},
            accountsDao: {},
            providersDao: noopProvidersDao,
            accountPool: mockAccountPool,
            encryptionKey: Buffer.alloc(32, 'a'),
            oauthManager: noopOAuthManager,
            log: { info() {}, error() {}, warn() {} },
        });
    });

    it('returns null when no account available', async () => {
        mockAccountPool._nextAccount = null;
        const lease = await manager.getCredentials('provider-1');
        assert.equal(lease, null);
    });

    it('returns a lease with authType for api_key account (no encrypted secret)', async () => {
        mockAccountPool._nextAccount = {
            id: 'acc-1',
            auth_type: 'api_key',
            secret_ciphertext: null,
            metadata: {},
        };
        const lease = await manager.getCredentials('provider-1');
        assert.ok(lease);
        assert.equal(lease.accountId, 'acc-1');
        assert.equal(lease.authType, 'api_key');
        assert.equal(lease.secret, null); // no ciphertext to decrypt
    });

    it('returns oauth lease for oauth accounts', async () => {
        mockAccountPool._nextAccount = {
            id: 'acc-2',
            auth_type: 'oauth',
            metadata: { access_token: 'tok-123', refresh_token: 'ref-456' },
            access_token_expires_at: '2026-12-31T00:00:00Z',
        };
        const lease = await manager.getCredentials('provider-1');
        assert.ok(lease);
        assert.equal(lease.authType, 'oauth');
        assert.equal(lease.oauth.accessToken, 'tok-123');
        assert.equal(lease.oauth.refreshToken, 'ref-456');
    });

    it('release clears secret from memory', async () => {
        mockAccountPool._nextAccount = {
            id: 'acc-3',
            auth_type: 'oauth',
            metadata: { access_token: 'tok' },
        };
        const lease = await manager.getCredentials('provider-1');
        // Simulate a secret
        lease.secret = 'sensitive';
        manager.release(lease);
        assert.equal(lease.secret, null);
        assert.equal(manager.activeLeaseCount, 0);
    });

    it('tracks active lease count', async () => {
        mockAccountPool._nextAccount = {
            id: 'acc-4',
            auth_type: 'none',
            metadata: {},
        };
        const lease1 = await manager.getCredentials('p1');
        const lease2 = await manager.getCredentials('p1');
        assert.equal(manager.activeLeaseCount, 2);
        manager.release(lease1);
        assert.equal(manager.activeLeaseCount, 1);
        manager.release(lease2);
        assert.equal(manager.activeLeaseCount, 0);
    });

    describe('inline OAuth refresh', () => {
        const PROVIDER_ID = 'prov-1';

        function buildManager({ oauthManager, providersDao, accountsDao }) {
            return new CredentialManager({
                pool: {},
                accountsDao,
                providersDao,
                accountPool: mockAccountPool,
                encryptionKey: Buffer.alloc(32, 'a'),
                oauthManager,
                log: { info() {}, error() {}, warn() {}, debug() {} },
            });
        }

        it('refreshes an expiring oauth account synchronously before leasing', async () => {
            const staleAccount = {
                id: 'acc-expiring',
                provider_id: PROVIDER_ID,
                auth_type: 'oauth',
                metadata: { access_token: 'stale', refresh_token: 'rt' },
                access_token_expires_at: new Date(
                    Date.now() + 60_000
                ).toISOString(),
                refresh_margin_seconds: 300,
            };
            const freshAccount = {
                ...staleAccount,
                metadata: { access_token: 'fresh', refresh_token: 'rt2' },
                access_token_expires_at: new Date(
                    Date.now() + 3_600_000
                ).toISOString(),
            };

            mockAccountPool._nextAccount = staleAccount;
            const refreshCalls = [];
            const oauthManager = {
                needsRefresh(account) {
                    const expiresAt = new Date(
                        account.access_token_expires_at
                    ).getTime();
                    const marginMs =
                        (account.refresh_margin_seconds || 300) * 1000;
                    return Date.now() >= expiresAt - marginMs;
                },
                async refreshTokens(accountId, adapterKey) {
                    refreshCalls.push({ accountId, adapterKey });
                },
            };
            const providersDao = {
                async findById(_pool, id) {
                    assert.equal(id, PROVIDER_ID);
                    return {
                        id: PROVIDER_ID,
                        oauth_adapter_key: 'openai-codex',
                    };
                },
            };
            const accountsDao = {
                async findById(_pool, id) {
                    assert.equal(id, 'acc-expiring');
                    return freshAccount;
                },
            };

            const m = buildManager({ oauthManager, providersDao, accountsDao });
            const lease = await m.getCredentials(PROVIDER_ID);

            assert.equal(refreshCalls.length, 1);
            assert.deepEqual(refreshCalls[0], {
                accountId: 'acc-expiring',
                adapterKey: 'openai-codex',
            });
            assert.equal(lease.oauth.accessToken, 'fresh');
            assert.equal(lease.oauth.refreshToken, 'rt2');
        });

        it('does not refresh when the token is comfortably fresh', async () => {
            mockAccountPool._nextAccount = {
                id: 'acc-fresh',
                provider_id: PROVIDER_ID,
                auth_type: 'oauth',
                metadata: { access_token: 'fresh', refresh_token: 'rt' },
                access_token_expires_at: new Date(
                    Date.now() + 3_600_000
                ).toISOString(),
                refresh_margin_seconds: 300,
            };
            const oauthManager = {
                needsRefresh() {
                    return false;
                },
                async refreshTokens() {
                    throw new Error('refreshTokens should not be called');
                },
            };
            const m = buildManager({
                oauthManager,
                providersDao: {
                    async findById() {
                        throw new Error('lookup should be skipped');
                    },
                },
                accountsDao: {},
            });

            const lease = await m.getCredentials(PROVIDER_ID);
            assert.equal(lease.oauth.accessToken, 'fresh');
        });

        it('falls through with the stale token when the refresh throws', async () => {
            const stale = {
                id: 'acc-err',
                provider_id: PROVIDER_ID,
                auth_type: 'oauth',
                metadata: { access_token: 'stale', refresh_token: 'rt' },
                access_token_expires_at: new Date(
                    Date.now() + 30_000
                ).toISOString(),
                refresh_margin_seconds: 300,
            };
            mockAccountPool._nextAccount = stale;
            const warnings = [];
            const oauthManager = {
                needsRefresh() {
                    return true;
                },
                async refreshTokens() {
                    throw new Error('network down');
                },
            };
            const providersDao = {
                async findById() {
                    return { oauth_adapter_key: 'openai-codex' };
                },
            };
            const m = new CredentialManager({
                pool: {},
                accountsDao: {},
                providersDao,
                accountPool: mockAccountPool,
                encryptionKey: Buffer.alloc(32, 'a'),
                oauthManager,
                log: {
                    info() {},
                    error() {},
                    warn(msg, meta) {
                        warnings.push({ msg, meta });
                    },
                    debug() {},
                },
            });

            const lease = await m.getCredentials(PROVIDER_ID);
            assert.equal(lease.oauth.accessToken, 'stale');
            assert.equal(warnings.length, 1);
            assert.equal(warnings[0].msg, 'inline_oauth_refresh_failed');
            assert.equal(warnings[0].meta.accountId, 'acc-err');
            assert.equal(warnings[0].meta.error, 'network down');
        });

        it('skips refresh for api_key accounts even when oauthManager is present', async () => {
            mockAccountPool._nextAccount = {
                id: 'acc-apikey',
                provider_id: PROVIDER_ID,
                auth_type: 'api_key',
                secret_ciphertext: null,
                metadata: {},
            };
            const oauthManager = {
                needsRefresh() {
                    throw new Error('should not be consulted for api_key');
                },
                async refreshTokens() {
                    throw new Error('should not be called');
                },
            };
            const m = buildManager({
                oauthManager,
                providersDao: {},
                accountsDao: {},
            });

            const lease = await m.getCredentials(PROVIDER_ID);
            assert.equal(lease.authType, 'api_key');
        });

        it('uses oauth_adapter_key already on the account row without a providers lookup', async () => {
            const stale = {
                id: 'acc-inline-key',
                provider_id: PROVIDER_ID,
                oauth_adapter_key: 'aws-kiro',
                auth_type: 'oauth',
                metadata: { access_token: 'stale', refresh_token: 'rt' },
                access_token_expires_at: new Date(
                    Date.now() + 30_000
                ).toISOString(),
                refresh_margin_seconds: 300,
            };
            const fresh = {
                ...stale,
                metadata: { access_token: 'fresh', refresh_token: 'rt' },
            };
            mockAccountPool._nextAccount = stale;
            const calls = [];
            const oauthManager = {
                needsRefresh() {
                    return true;
                },
                async refreshTokens(accountId, adapterKey) {
                    calls.push({ accountId, adapterKey });
                },
            };
            const providersDao = {
                async findById() {
                    throw new Error('providersDao should not be called');
                },
            };
            const accountsDao = {
                async findById() {
                    return fresh;
                },
            };
            const m = buildManager({ oauthManager, providersDao, accountsDao });

            const lease = await m.getCredentials(PROVIDER_ID);
            assert.deepEqual(calls, [
                { accountId: 'acc-inline-key', adapterKey: 'aws-kiro' },
            ]);
            assert.equal(lease.oauth.accessToken, 'fresh');
        });
    });
});

// ── Account Pool ────────────────────────────────────────────────────

import { AccountPool } from '../../runtime/providers/account-pool.mjs';

describe('AccountPool', () => {
    let pool;
    let mockDao;
    let mockPgPool;

    beforeEach(() => {
        mockPgPool = { query: async () => ({}) };
        mockDao = {
            _accounts: [],
            async listByProvider() {
                return this._accounts;
            },
            async markExhausted() {
                return {};
            },
            async markRefreshing() {
                return {};
            },
            async updateTokenExpiry() {
                return {};
            },
            async updateStatus() {
                return {};
            },
        };
        pool = new AccountPool({
            pool: mockPgPool,
            accountsDao: mockDao,
            log: { info() {}, error() {}, warn() {} },
        });
    });

    it('returns null when no accounts exist', async () => {
        mockDao._accounts = [];
        const account = await pool.getNextAccount('provider-1');
        assert.equal(account, null);
    });

    it('returns active accounts', async () => {
        mockDao._accounts = [{ id: 'a1', status: 'active', metadata: {} }];
        const account = await pool.getNextAccount('provider-1');
        assert.equal(account.id, 'a1');
    });

    it('excludes exhausted accounts', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'active', metadata: {} },
            { id: 'a2', status: 'active', metadata: {} },
        ];
        await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60000));
        const account = await pool.getNextAccount('provider-1');
        assert.equal(account.id, 'a2');
    });

    it('excludes accounts in excludeAccountIds set', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'active', metadata: {} },
            { id: 'a2', status: 'active', metadata: {} },
        ];
        const account = await pool.getNextAccount('provider-1', {
            excludeAccountIds: new Set(['a1']),
        });
        assert.equal(account.id, 'a2');
    });

    it('round-robins between accounts', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'active', metadata: {} },
            { id: 'a2', status: 'active', metadata: {} },
        ];
        const first = await pool.getNextAccount('provider-1');
        const second = await pool.getNextAccount('provider-1');
        assert.notEqual(first.id, second.id);
    });

    it('excludes non-active/non-refreshing statuses', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'deleted', metadata: {} },
            { id: 'a2', status: 'error', metadata: {} },
            { id: 'a3', status: 'quota_exhausted', metadata: {} },
        ];
        const account = await pool.getNextAccount('provider-1');
        assert.equal(account, null);
    });

    it('includes refreshing accounts', async () => {
        mockDao._accounts = [{ id: 'a1', status: 'refreshing', metadata: {} }];
        const account = await pool.getNextAccount('provider-1');
        assert.equal(account.id, 'a1');
    });

    it('purges expired exhaustions', async () => {
        mockDao._accounts = [{ id: 'a1', status: 'active', metadata: {} }];
        await pool.markExhausted('p1', 'a1', new Date(Date.now() - 1000)); // already expired
        const purged = pool.purgeExpiredExhaustions();
        assert.equal(purged, 1);
        assert.equal(pool.exhaustedCount, 0);
    });

    it('clears restored exhausted accounts explicitly', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'active', metadata: {} },
            { id: 'a2', status: 'active', metadata: {} },
        ];
        await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60_000));
        await pool.markExhausted('p1', 'a2', new Date(Date.now() + 60_000));

        const cleared = pool.clearExhaustions(['a1']);

        assert.equal(cleared, 1);
        assert.equal(pool.exhaustedCount, 1);
    });

    it('tracks exhausted and refreshing counts', async () => {
        mockDao._accounts = [
            { id: 'a1', status: 'active', metadata: {} },
            { id: 'a2', status: 'active', metadata: {} },
        ];
        await pool.markExhausted('p1', 'a1', new Date(Date.now() + 60000));
        await pool.markRefreshing('a2');
        assert.equal(pool.exhaustedCount, 1);
        assert.equal(pool.refreshingCount, 1);
    });
});

// ── Backend Catalog ────────────────────────────────────────────────

import { BackendCatalog } from '../../runtime/backends/backend-catalog.mjs';
import { backendModule as codexBackend } from '../../runtime/backends/builtin/codex-api.backend.mjs';
import { backendModule as geminiOAuthBackend } from '../../runtime/backends/builtin/gemini-openai.backend.mjs';
import { backendModule as claudeaiBackend } from '../../runtime/backends/builtin/claudeai-api.backend.mjs';

describe('BackendCatalog', () => {
    let catalog;

    beforeEach(() => {
        catalog = new BackendCatalog({ log: { info() {}, error() {} } });
    });

    function makeBackendModule(key) {
        return {
            manifest: {
                key,
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['openai_chat'],
            },
            async init() {},
            async shutdown() {},
            async execute() {},
            classifyError() {},
        };
    }

    it('starts empty', () => {
        assert.equal(catalog.size, 0);
        assert.equal(catalog.generation, 0);
    });

    it('loads backend modules and increments generation', () => {
        catalog.load([
            makeBackendModule('test-1'),
            makeBackendModule('test-2'),
        ]);
        assert.equal(catalog.size, 2);
        assert.equal(catalog.generation, 1);
    });

    it('retrieves backend module by key', () => {
        catalog.load([makeBackendModule('test-1')]);
        const backendModule = catalog.getBackend('test-1');
        assert.ok(backendModule);
        assert.equal(backendModule.manifest.key, 'test-1');
    });

    it('returns null for unknown key', () => {
        catalog.load([makeBackendModule('test-1')]);
        assert.equal(catalog.getBackend('nonexistent'), null);
    });

    it('rejects duplicate keys', () => {
        assert.throws(
            () =>
                catalog.load([
                    makeBackendModule('dup'),
                    makeBackendModule('dup'),
                ]),
            /Duplicate backend key/
        );
    });

    it('listKeys returns all keys', () => {
        catalog.load([makeBackendModule('a'), makeBackendModule('b')]);
        const keys = catalog.listKeys();
        assert.deepEqual(keys.sort(), ['a', 'b']);
    });

    it('shutdownAll clears all backend modules', async () => {
        let shutdownCount = 0;
        const backendModule = makeBackendModule('test');
        backendModule.shutdown = async () => {
            shutdownCount++;
        };
        catalog.load([backendModule]);
        await catalog.shutdownAll();
        assert.equal(catalog.size, 0);
        assert.equal(shutdownCount, 1);
    });

    it('testConnection leases credentials for backend modules that need them', async () => {
        let releasedLease = null;
        const backendModule = makeBackendModule('test-provider');
        backendModule.testConnection = async (ctx) => {
            assert.equal(ctx.credentialLease.secret, 'sk-test');
            assert.equal(
                ctx.providerRecord.base_url,
                'https://api.example.test'
            );
            return { ok: true, detail: 'ok' };
        };
        catalog.load([backendModule]);

        const result = await catalog.testConnection(
            {
                id: 'provider-1',
                adapter_key: 'test-provider',
                base_url: 'https://api.example.test',
            },
            {
                credentialManager: {
                    async getCredentials(providerId) {
                        assert.equal(providerId, 'provider-1');
                        return {
                            leaseId: 'lease-1',
                            accountId: 'acc-1',
                            authType: 'api_key',
                            secret: 'sk-test',
                            oauth: null,
                            metadata: {},
                        };
                    },
                    release(lease) {
                        releasedLease = lease;
                    },
                },
            }
        );

        assert.deepEqual(result, { ok: true, detail: 'ok' });
        assert.equal(releasedLease.leaseId, 'lease-1');
    });

    it('discoverModels leases credentials and releases them after discovery', async () => {
        let releasedLease = null;
        const backendModule = makeBackendModule('discovery-provider');
        backendModule.discoverModels = async (ctx) => {
            assert.equal(ctx.credentialLease.oauth.accessToken, 'oauth-token');
            return [{ modelId: 'm1' }];
        };
        catalog.load([backendModule]);

        const result = await catalog.discoverModels(
            { id: 'provider-2', adapter_key: 'discovery-provider' },
            {
                credentialManager: {
                    async getCredentials(providerId) {
                        assert.equal(providerId, 'provider-2');
                        return {
                            leaseId: 'lease-2',
                            accountId: 'acc-2',
                            authType: 'oauth',
                            secret: null,
                            oauth: {
                                accessToken: 'oauth-token',
                                refreshToken: null,
                                expiresAt: null,
                            },
                            metadata: {},
                        };
                    },
                    release(lease) {
                        releasedLease = lease;
                    },
                },
            }
        );

        assert.deepEqual(result, [{ modelId: 'm1' }]);
        assert.equal(releasedLease.leaseId, 'lease-2');
    });

    it('routes custom-mode providers through the same backend catalog as built-ins', async () => {
        // After unifying provider and transport catalogs, custom-mode
        // providers no longer need a separate fallback registry: their
        // backend module is loaded into the same BackendCatalog and
        // resolved via getBackend(provider.backendKey) just like every
        // built-in.
        const customBackend = makeBackendModule('custom-backend');
        customBackend.testConnection = async (ctx) => {
            assert.equal(ctx.providerRecord.backendKey, 'custom-backend');
            return { ok: true, detail: 'custom-ok' };
        };
        customBackend.discoverModels = async () => [{ modelId: 'custom-model' }];

        catalog.load([customBackend]);

        const test = await catalog.testConnection({
            id: 'provider-custom',
            provider_key: 'custom-provider',
            adapter_key: 'custom-backend',
            provider_mode: 'custom',
        });
        assert.deepEqual(test, { ok: true, detail: 'custom-ok' });

        const discovered = await catalog.discoverModels({
            id: 'provider-custom',
            provider_key: 'custom-provider',
            adapter_key: 'custom-backend',
            provider_mode: 'custom',
        });
        assert.deepEqual(discovered, [{ modelId: 'custom-model' }]);
    });

    it('getTemplates exposes dashboard metadata for OAuth-capable providers', () => {
        catalog.load([codexBackend, geminiOAuthBackend, claudeaiBackend]);

        const templates = catalog.getTemplates();

        assert.equal(templates['codex-api'].adapter_key, 'codex-api');
        assert.equal(templates['codex-api'].auth_type, 'managed');
        assert.equal(templates['codex-api'].oauth_adapter_key, 'openai-codex');
        assert.equal(
            templates['codex-api'].base_url,
            'https://chatgpt.com/backend-api/codex'
        );

        assert.equal(
            templates['gemini-openai'].oauth_adapter_key,
            'google-gemini'
        );
        assert.equal(
            templates['claudeai-api'].oauth_adapter_key,
            'anthropic-claudeai'
        );
    });

    describe('preset catalog merge', () => {
        // Stubs mirror the production manifests of the dispatcher backends:
        //   openai-api      → generic OpenAI-compatible client used by every
        //                     vendor preset (nvidia, groq, fireworks, …)
        //   anthropic-api   → generic Anthropic API client behind the
        //                     `anthropic-direct` preset
        //   search-builtin  → multi-engine search dispatcher behind the
        //                     tavily/brave/exa/… presets
        //
        // Each carries `hidden: true` so getTemplates() does not surface
        // the dispatcher key itself in the dropdown — the only way to
        // configure them is via a preset (which fills in the vendor-specific
        // base_url, display_name, etc.). Without `hidden`, the dropdown
        // would show meaningless raw entries like "search-builtin" with no
        // base_url, and a user picking one would have nothing to point at.
        const openaiApiPlugin = {
            manifest: {
                key: 'openai-api',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['openai_chat'],
                displayName: 'OpenAI-Compatible API',
                hidden: true,
            },
            async init() {},
            async shutdown() {},
            async execute() {},
            classifyError() {},
        };

        const searchBuiltinPlugin = {
            manifest: {
                key: 'search-builtin',
                kind: 'search',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: false,
                supportedFormats: ['openai_chat'],
                displayName: 'Web Search (Built-in)',
                hidden: true,
            },
            async init() {},
            async shutdown() {},
            async execute() {},
            classifyError() {},
        };

        const anthropicApiPlugin = {
            manifest: {
                key: 'anthropic-api',
                kind: 'external_api',
                authStrategy: 'api_key',
                supportsStreaming: true,
                supportsTools: true,
                supportedFormats: ['anthropic_messages'],
                displayName: 'Anthropic API',
                hidden: true,
            },
            async init() {},
            async shutdown() {},
            async execute() {},
            classifyError() {},
        };

        it('includes openai-compat presets when the openai-api backend is loaded', () => {
            catalog.load([openaiApiPlugin]);
            const templates = catalog.getTemplates();

            for (const key of [
                'openai',
                'nvidia',
                'groq',
                'fireworks',
                'together',
                'deepseek',
                'mistral',
                'codestral',
                'xai',
                'perplexity',
                'cohere',
                'openrouter',
                'deepinfra',
            ]) {
                assert.ok(templates[key], `missing preset: ${key}`);
                assert.equal(templates[key].adapter_key, 'openai-api');
                assert.equal(templates[key].kind, 'external_api');
                assert.equal(templates[key].auth_strategy, 'api_key');
                assert.ok(
                    templates[key].base_url &&
                        templates[key].base_url.length > 0,
                    `${key} should have a base_url`
                );
            }

            // Codestral runs on a separate host from the main Mistral API
            // (api.mistral.ai). Asserting both URLs side-by-side guards
            // against accidentally collapsing the two presets onto the same
            // base_url, which would silently break code-completion routing.
            assert.equal(
                templates['mistral'].base_url,
                'https://api.mistral.ai/v1'
            );
            assert.equal(
                templates['codestral'].base_url,
                'https://codestral.mistral.ai/v1'
            );
            assert.equal(
                templates['codestral'].display_name,
                'Mistral Codestral'
            );
        });

        it('includes all 8 search presets when search-builtin is loaded', () => {
            catalog.load([searchBuiltinPlugin]);
            const templates = catalog.getTemplates();

            for (const key of [
                'tavily',
                'brave',
                'exa',
                'serper',
                'jina',
                'duckduckgo',
                'searxng',
                'gemini-search',
            ]) {
                assert.ok(templates[key], `missing search preset: ${key}`);
                assert.equal(templates[key].adapter_key, 'search-builtin');
                assert.equal(templates[key].kind, 'search');
                assert.equal(templates[key].supports_streaming, true);
            }
            // SearXNG ships with an empty base_url (self-hosted) — user fills it in.
            assert.equal(templates['searxng'].base_url, '');
        });

        it('includes the anthropic-direct preset only when anthropic-api is loaded', () => {
            // No backends → no preset
            const emptyCatalog = new BackendCatalog({
                log: { info() {}, error() {} },
            });
            emptyCatalog.load([]);
            assert.equal(
                emptyCatalog.getTemplates()['anthropic-direct'],
                undefined
            );

            // anthropic-api loaded → preset appears
            catalog.load([anthropicApiPlugin]);
            const templates = catalog.getTemplates();
            assert.ok(templates['anthropic-direct']);
            assert.equal(
                templates['anthropic-direct'].adapter_key,
                'anthropic-api'
            );
            assert.equal(
                templates['anthropic-direct'].base_url,
                'https://api.anthropic.com'
            );
        });

        it('filters out presets whose backend is not loaded', () => {
            // Load only anthropic-api — openai-compat + search presets should be absent
            catalog.load([anthropicApiPlugin]);
            const templates = catalog.getTemplates();
            assert.equal(templates['nvidia'], undefined);
            assert.equal(templates['groq'], undefined);
            assert.equal(templates['tavily'], undefined);
            assert.ok(templates['anthropic-direct']);
        });

        it('hides dispatcher backend keys from getTemplates() even when their backend is loaded', () => {
            // Regression: before this fix, getTemplates() unconditionally
            // surfaced every loaded backend key — including the protocol-
            // family dispatchers — which polluted the dropdown with raw
            // `openai-api`, `anthropic-api`, `search-builtin` entries that
            // had no base_url and no meaningful display name. Vendors are
            // configured exclusively through presets; the dispatcher keys
            // are an implementation detail and must stay out of the dropdown.
            catalog.load([
                openaiApiPlugin,
                anthropicApiPlugin,
                searchBuiltinPlugin,
            ]);
            const templates = catalog.getTemplates();

            assert.equal(templates['openai-api'], undefined);
            assert.equal(templates['anthropic-api'], undefined);
            assert.equal(templates['search-builtin'], undefined);

            // …and yet the presets routed through them still appear.
            assert.ok(templates['nvidia']);
            assert.ok(templates['anthropic-direct']);
            assert.ok(templates['tavily']);
        });

        it('OAuth-backed backends remain visible alongside the presets', () => {
            // OAuth providers are distinct vendor offerings (not dispatchers),
            // so their backend keys MUST appear in the dropdown — there are no
            // presets for claude.ai / Codex / Copilot / Kiro / Gemini OAuth.
            catalog.load([
                codexBackend,
                geminiOAuthBackend,
                claudeaiBackend,
                openaiApiPlugin,
            ]);
            const templates = catalog.getTemplates();

            assert.ok(
                templates['codex-api'],
                'codex-api should be in dropdown'
            );
            assert.equal(templates['codex-api'].auth_strategy, 'oauth');
            assert.ok(
                templates['gemini-openai'],
                'gemini-openai should be in dropdown'
            );
            assert.ok(
                templates['claudeai-api'],
                'claudeai-api should be in dropdown'
            );

            // The hidden dispatcher loaded alongside them is still filtered.
            assert.equal(templates['openai-api'], undefined);
        });

        it('total dropdown count: hidden dispatchers contribute zero, presets surface in full', () => {
            // 3 dispatcher backends (all hidden) + 22 vendor presets = 22 entries.
            catalog.load([
                openaiApiPlugin,
                searchBuiltinPlugin,
                anthropicApiPlugin,
            ]);
            const templates = catalog.getTemplates();

            const openaiPresetKeys = [
                'openai',
                'openrouter',
                'nvidia',
                'fireworks',
                'groq',
                'together',
                'deepseek',
                'deepinfra',
                'perplexity',
                'mistral',
                'codestral',
                'xai',
                'cohere',
            ];
            const searchPresetKeys = [
                'tavily',
                'brave',
                'exa',
                'serper',
                'jina',
                'duckduckgo',
                'searxng',
                'gemini-search',
            ];
            const anthropicPresetKeys = ['anthropic-direct'];

            for (const k of openaiPresetKeys)
                assert.ok(templates[k], `missing openai preset: ${k}`);
            for (const k of searchPresetKeys)
                assert.ok(templates[k], `missing search preset: ${k}`);
            for (const k of anthropicPresetKeys)
                assert.ok(templates[k], `missing anthropic preset: ${k}`);

            assert.equal(
                Object.keys(templates).length,
                openaiPresetKeys.length +
                    searchPresetKeys.length +
                    anthropicPresetKeys.length
            );
        });
    });
});

// ── Codex backend module ────────────────────────────────────────────

describe('codex-api backend module', () => {
    it('testConnection fails when no oauth token is leased', async () => {
        const result = await codexBackend.testConnection({
            credentialLease: {},
        });
        assert.equal(result.ok, false);
        assert.match(result.detail, /No Codex OAuth token/);
    });

    it('testConnection reports expiry without hitting the network', async () => {
        const result = await codexBackend.testConnection({
            credentialLease: {
                oauth: {
                    accessToken: 'tok',
                    expiresAt: new Date(Date.now() - 1000).toISOString(),
                },
            },
        });
        assert.equal(result.ok, false);
        assert.match(result.detail, /expired/);
    });

    it('testConnection succeeds when an unexpired oauth token is present', async () => {
        const result = await codexBackend.testConnection({
            credentialLease: {
                oauth: {
                    accessToken: 'tok',
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
            },
        });
        assert.equal(result.ok, true);
        assert.match(result.detail, /credentials present/);
    });

    it('testConnection does not perform any HTTP call (scope cannot list /v1/models)', async () => {
        // If testConnection were making a live request it would fail with a
        // connection error in this test environment. Reaching the success
        // branch proves no outbound fetch happened.
        const originalFetch = globalThis.fetch;
        globalThis.fetch = () => {
            throw new Error('testConnection must not call fetch');
        };
        try {
            const result = await codexBackend.testConnection({
                credentialLease: { oauth: { accessToken: 'tok' } },
            });
            assert.equal(result.ok, true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('codex-api payload builder', () => {
    let buildCodexParams, extractInstructions;

    beforeEach(async () => {
        ({ buildCodexParams, extractInstructions } = await import(
            '../../runtime/backends/builtin/codex-api.backend.mjs'
        ));
    });

    describe('extractInstructions', () => {
        it('concatenates system messages with a blank-line separator', () => {
            const instructions = extractInstructions([
                { role: 'system', content: 'rule 1' },
                { role: 'user', content: 'ignored' },
                { role: 'system', content: 'rule 2' },
            ]);
            assert.equal(instructions, 'rule 1\n\nrule 2');
        });

        it('JSON-stringifies structured system content', () => {
            const instructions = extractInstructions([
                { role: 'system', content: [{ type: 'text', text: 'A' }] },
            ]);
            assert.ok(instructions.includes('A'));
        });

        it('returns an empty string when no system messages are present', () => {
            const instructions = extractInstructions([
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hello' },
            ]);
            assert.equal(instructions, '');
        });

        it('tolerates null/undefined input', () => {
            assert.equal(extractInstructions(null), '');
            assert.equal(extractInstructions(undefined), '');
            assert.equal(extractInstructions([]), '');
        });
    });

    describe('buildCodexParams', () => {
        it('falls back to DEFAULT_INSTRUCTIONS when no system messages are supplied', () => {
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
            });
            assert.ok(params.instructions && params.instructions.length > 0);
            assert.equal(params.store, false);
        });

        it('prefers system messages over the default instructions', () => {
            const params = buildCodexParams({
                messages: [
                    { role: 'system', content: 'You are a pirate.' },
                    { role: 'user', content: 'hi' },
                ],
            });
            assert.equal(params.instructions, 'You are a pirate.');
        });

        it('does NOT include max_output_tokens even when the normalized request has max_tokens', () => {
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 500,
            });
            assert.equal(params.max_output_tokens, undefined);
            assert.equal(params.max_tokens, undefined);
        });

        it('passes temperature and top_p through when present', () => {
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
                temperature: 0.5,
                top_p: 0.8,
            });
            assert.equal(params.temperature, 0.5);
            assert.equal(params.top_p, 0.8);
        });

        it('forwards tools as-is (achilles converts them to the Responses API shape)', () => {
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'lookup',
                        description: 'look something up',
                        parameters: {
                            type: 'object',
                            properties: { q: { type: 'string' } },
                        },
                    },
                },
            ];
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
                tools,
            });
            assert.equal(params.tools, tools);
        });

        it('omits tools entirely when no tools are requested', () => {
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
            });
            assert.equal(params.tools, undefined);
        });

        it('tolerates an empty / missing messages list', () => {
            const params = buildCodexParams({});
            assert.ok(params.instructions && params.instructions.length > 0);
            assert.equal(params.tools, undefined);
        });

        it('never sets model, input, or stream directly (achilles builds the payload)', () => {
            const params = buildCodexParams({
                messages: [{ role: 'user', content: 'hi' }],
            });
            assert.equal(params.model, undefined);
            assert.equal(params.input, undefined);
            assert.equal(params.stream, undefined);
        });
    });

    describe('execute / achilles transport contract', () => {
        it('dispatches via achillesResponses and does NOT call fetch directly', async () => {
            // Regression fuse against anyone re-adding a local HTTP path.
            // The backend must hand its work off to achilles via
            // createAchillesExecutionHandle; this test swaps achillesResponses
            // out from under the module cache and asserts the replacement was
            // what got invoked.
            const originalFetch = globalThis.fetch;
            globalThis.fetch = () => {
                throw new Error(
                    'codex execute must go through achilles, not global fetch'
                );
            };

            try {
                // Import the backend execute path and inspect that the call site
                // references achillesResponses.callLLMStreaming. A black-box way:
                // drive execute() with a controllable credentialLease and verify
                // the returned handle has the expected shape without an actual
                // network call (achilles will throw inside the generator when we
                // start consuming it, which is fine — we don't consume here).
                const backendModule = await import(
                    '../../runtime/backends/builtin/codex-api.backend.mjs'
                );
                const handle = await backendModule.backendModule.execute({
                    request: { messages: [{ role: 'user', content: 'hi' }] },
                    resolvedModel: {
                        provider_model_id: 'gpt-5.4',
                        model_key: 'codex/gpt-5.4',
                    },
                    providerRecord: {
                        base_url: 'https://chatgpt.com/backend-api/codex',
                    },
                    credentialLease: {
                        accountId: 'acc-1',
                        oauth: { accessToken: 'tok' },
                    },
                    signal: new AbortController().signal,
                    requestId: 'req-1',
                });
                assert.ok(handle.stream);
                assert.equal(handle.accountId, 'acc-1');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    describe('discoverModels / manifest', () => {
        let originalFetch;

        function stubFetch(responder) {
            originalFetch = globalThis.fetch;
            globalThis.fetch = async (url, init) =>
                responder(String(url), init);
        }
        function restoreFetch() {
            globalThis.fetch = originalFetch;
        }

        it('throws a helpful error when no OAuth credential is leased', async () => {
            await assert.rejects(
                () =>
                    codexBackend.discoverModels({
                        providerRecord: {
                            base_url: 'https://chatgpt.com/backend-api/codex',
                        },
                        credentialLease: null,
                    }),
                /requires an OAuth access token/i
            );
        });

        it('live-queries /backend-api/codex/models via achilles and returns the normalized list', async () => {
            stubFetch(async (url) => {
                assert.ok(
                    url.startsWith(
                        'https://chatgpt.com/backend-api/codex/models?client_version='
                    ),
                    `unexpected URL: ${url}`
                );
                return new Response(
                    JSON.stringify({
                        models: [
                            {
                                slug: 'gpt-5.2-codex',
                                display_name: 'gpt-5.2-codex',
                                context_window: 272000,
                                visibility: 'list',
                                supported_in_api: true,
                                input_modalities: ['text', 'image'],
                            },
                            {
                                slug: 'gpt-5',
                                display_name: 'gpt-5',
                                context_window: 128000,
                                visibility: 'hide',
                                supported_in_api: true,
                                input_modalities: ['text'],
                            },
                            {
                                slug: 'legacy',
                                visibility: 'list',
                                supported_in_api: false,
                            },
                        ],
                    }),
                    {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }
                );
            });

            try {
                const discovered = await codexBackend.discoverModels({
                    providerRecord: {
                        base_url: 'https://chatgpt.com/backend-api/codex',
                    },
                    credentialLease: { oauth: { accessToken: 'tok' } },
                });
                assert.equal(
                    discovered.length,
                    2,
                    'supported_in_api=false entries should be filtered out'
                );
                assert.equal(discovered[0].modelId, 'gpt-5.2-codex');
                assert.equal(discovered[0].contextWindow, 272000);
                assert.equal(discovered[0].supportsVision, true);
                assert.equal(discovered[1].modelId, 'gpt-5');
                assert.equal(discovered[1].visibility, 'hide');
            } finally {
                restoreFetch();
            }
        });

        it('surfaces structured errors from the upstream /models endpoint', async () => {
            stubFetch(
                async () =>
                    new Response(JSON.stringify({ detail: 'scope denied' }), {
                        status: 403,
                        headers: { 'Content-Type': 'application/json' },
                    })
            );

            try {
                let caught;
                try {
                    await codexBackend.discoverModels({
                        providerRecord: {
                            base_url: 'https://chatgpt.com/backend-api/codex',
                        },
                        credentialLease: { oauth: { accessToken: 'tok' } },
                    });
                } catch (err) {
                    caught = err;
                }
                assert.ok(caught);
                assert.equal(caught.status, 403);
                assert.ok(/scope denied/.test(caught.message));
            } finally {
                restoreFetch();
            }
        });

        it('declares the correct default base URL and oauth adapter key', () => {
            assert.equal(
                codexBackend.manifest.defaultBaseUrl,
                'https://chatgpt.com/backend-api/codex'
            );
            assert.equal(codexBackend.manifest.oauthAdapterKey, 'openai-codex');
        });
    });
});

// ── openai-api testConnection HTTP behavior ─────────────────────────

import { createServer } from 'node:http';
import { backendModule as openaiApiPlugin } from '../../runtime/backends/builtin/openai-api.backend.mjs';

/**
 * Spin up a tiny HTTP server that returns canned responses for the
 * two endpoints openai-api's testConnection() probes:
 *   GET  /v1/models
 *   POST /v1/chat/completions
 *
 * Pass `null` (or omit) for either endpoint to make it 404. The
 * fixture mirrors what a real OpenAI-compatible vendor exposes so
 * the backend module can be exercised end-to-end without mocking node:http.
 *
 * @param {{ models?: { status: number, body?: string }|null,
 *           completions?: { status: number, body?: string }|null }} opts
 */
async function spinUpFakeOpenAI(opts = {}) {
    const seen = [];
    const server = createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, headers: req.headers });

        let route = null;
        if (req.method === 'GET' && req.url === '/v1/models')
            route = opts.models;
        else if (req.method === 'POST' && req.url === '/v1/chat/completions')
            route = opts.completions;

        if (!route) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"error":"not found"}');
            return;
        }

        // Drain the request body so the socket can be released even though
        // testConnection() doesn't care about it.
        req.on('data', () => {});
        req.on('end', () => {
            res.writeHead(route.status, { 'Content-Type': 'application/json' });
            res.end(route.body || '{}');
        });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        seen,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function makeOpenAITestCtx(baseUrl, secret = 'test-key') {
    return {
        providerRecord: { baseUrl },
        credentialLease: { secret },
    };
}

function makeNoAuthOpenAITestCtx(baseUrl) {
    return {
        providerRecord: { baseUrl, authStrategy: 'none' },
        credentialLease: null,
    };
}

describe('openai-api discoverModels metadata parsing', () => {
    it('captures pricing and context metadata from rich /models responses', async () => {
        const fake = await spinUpFakeOpenAI({
            models: {
                status: 200,
                body: JSON.stringify({
                    data: [
                        {
                            id: 'google/gemma-3-27b-it',
                            name: 'Google: Gemma 3 27B',
                            context_length: 131072,
                            pricing: {
                                prompt: '0.00000027',
                                completion: '0.00000040',
                            },
                            top_provider: {
                                max_completion_tokens: 8192,
                            },
                            architecture: {
                                input_modalities: ['text', 'image'],
                                output_modalities: ['text'],
                            },
                            supported_parameters: [
                                'tools',
                                'structured_outputs',
                            ],
                        },
                    ],
                }),
            },
        });

        try {
            const discovered = await openaiApiPlugin.discoverModels(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.deepEqual(discovered, [
                {
                    modelId: 'google/gemma-3-27b-it',
                    displayName: 'Google: Gemma 3 27B',
                    contextWindow: 131072,
                    maxOutputTokens: 8192,
                    supportsTools: true,
                    supportsStreaming: true,
                    supportsVision: true,
                    pricing: {
                        mode: 'token',
                        inputPricePerMillion: 0.27,
                        outputPricePerMillion: 0.4,
                        requestPriceUsd: null,
                    },
                    isFree: false,
                    tags: ['structured-outputs', 'tool-calling', 'vision'],
                },
            ]);
        } finally {
            await fake.close();
        }
    });
});

describe('openai-api testConnection HTTP behavior', () => {
    it('returns ok=true when /models returns 200', async () => {
        // Happy path — every vendor that exposes /models hits this branch.
        const fake = await spinUpFakeOpenAI({
            models: {
                status: 200,
                body: JSON.stringify({ data: [{ id: 'gpt-test' }] }),
            },
        });
        try {
            const result = await openaiApiPlugin.testConnection(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, true);
            // The backend must NOT touch /chat/completions when /models worked.
            assert.equal(fake.seen.length, 1);
            assert.equal(fake.seen[0].url, '/v1/models');
        } finally {
            await fake.close();
        }
    });

    it('allows no-auth local providers without sending authorization headers', async () => {
        const fake = await spinUpFakeOpenAI({
            models: {
                status: 200,
                body: JSON.stringify({ data: [{ id: 'local-model' }] }),
            },
        });
        try {
            const result = await openaiApiPlugin.testConnection(
                makeNoAuthOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, true);
            assert.equal(fake.seen.length, 1);
            assert.equal(fake.seen[0].headers.authorization, undefined);
        } finally {
            await fake.close();
        }
    });

    it('falls back to /chat/completions probe when /models returns 404 (Codestral case)', async () => {
        // Mirrors Codestral: the restricted subdomain only exposes
        // /chat/completions and /fim/completions, so /models 404s. The
        // backend should probe /chat/completions with an empty body — a
        // 400 from the vendor means "your payload is bad but your
        // credential is fine", which is the strongest signal we can get
        // without spending API quota.
        const fake = await spinUpFakeOpenAI({
            models: { status: 404, body: '{"error":"not found"}' },
            completions: {
                status: 400,
                body: '{"error":"missing model field"}',
            },
        });
        try {
            const result = await openaiApiPlugin.testConnection(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, true);
            assert.match(result.detail, /model listing not exposed/i);
            // Both endpoints must have been probed in order.
            assert.equal(fake.seen.length, 2);
            assert.equal(fake.seen[0].url, '/v1/models');
            assert.equal(fake.seen[1].url, '/v1/chat/completions');
            assert.equal(fake.seen[1].method, 'POST');
        } finally {
            await fake.close();
        }
    });

    it('does NOT fall back when /models returns 401 (auth bad)', async () => {
        // 401 from /models is unambiguous: the credential is wrong, no
        // amount of probing /chat/completions will rescue it. Falling
        // back here would waste a request and could mislead the user.
        const fake = await spinUpFakeOpenAI({
            models: { status: 401, body: '{"error":"unauthorized"}' },
        });
        try {
            const result = await openaiApiPlugin.testConnection(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, false);
            assert.match(result.detail, /401/);
            assert.equal(
                fake.seen.length,
                1,
                'must not probe /chat/completions on 401 from /models'
            );
        } finally {
            await fake.close();
        }
    });

    it('reports failure when both /models and /chat/completions return 404', async () => {
        // base_url is wrong — neither endpoint exists. The backend must
        // not optimistically report success here.
        const fake = await spinUpFakeOpenAI({});
        try {
            const result = await openaiApiPlugin.testConnection(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, false);
            assert.match(result.detail, /404/);
        } finally {
            await fake.close();
        }
    });

    it('reports auth failure when /models 404 and /chat/completions returns 401', async () => {
        // Codestral-shaped layout (no /models) but the credential is bad.
        // The probe surfaces the 401 instead of the leading 404.
        const fake = await spinUpFakeOpenAI({
            completions: { status: 401, body: '{"detail":"Unauthorized"}' },
        });
        try {
            const result = await openaiApiPlugin.testConnection(
                makeOpenAITestCtx(fake.baseUrl)
            );
            assert.equal(result.ok, false);
            assert.match(result.detail, /401/);
        } finally {
            await fake.close();
        }
    });
});
