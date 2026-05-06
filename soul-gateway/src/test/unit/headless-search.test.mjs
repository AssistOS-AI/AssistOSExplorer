/**
 * Headless search backend + converter + browser pool tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validateBackendManifest } from '../../runtime/backends/backend-interface.mjs';
import { backendModule } from '../../runtime/backends/builtin/headless-search.backend.mjs';
import * as converter from '../../runtime/backends/converters/headless-search-converter.mjs';
import { BrowserPool } from '../../runtime/backends/browser-pool.mjs';
import { createExtensionContext } from '../../runtime/providers/extension-sdk.mjs';

// ── Manifest validation ────────────────────────────────────────────

describe('headless-search backend manifest', () => {
    it('passes manifest validation', () => {
        assert.doesNotThrow(() => validateBackendManifest(backendModule.manifest));
    });

    it('has the correct key', () => {
        assert.equal(backendModule.manifest.key, 'headless-search');
    });

    it('is a search backend', () => {
        assert.equal(backendModule.manifest.kind, 'search');
    });

    it('uses no auth', () => {
        assert.equal(backendModule.manifest.authStrategy, 'none');
    });

    it('is hidden (surfaced via preset)', () => {
        assert.equal(backendModule.manifest.hidden, true);
    });

    it('supports streaming through the OpenAI-compatible route surface', () => {
        assert.equal(backendModule.manifest.supportsStreaming, true);
    });
});

// ── Backend module contract ────────────────────────────────────────

describe('headless-search backend module', () => {
    it('exports required execute function', () => {
        assert.equal(typeof backendModule.execute, 'function');
    });

    it('exports required classifyError function', () => {
        assert.equal(typeof backendModule.classifyError, 'function');
    });

    it('exports optional lifecycle methods', () => {
        assert.equal(typeof backendModule.shutdown, 'function');
        assert.equal(typeof backendModule.discoverModels, 'function');
        assert.equal(typeof backendModule.testConnection, 'function');
    });

    it('discoverModels returns the expected model', async () => {
        const models = await backendModule.discoverModels();
        assert.equal(models.length, 1);
        assert.equal(models[0].modelKey, 'headless-google-ai-mode');
        assert.equal(models[0].modelId, 'headless-google-ai-mode');
        assert.equal(models[0].supportsTools, false);
        assert.equal(models[0].supportsStreaming, true);
    });
});

// ── testConnection ──────────────────────────────────────────────────

describe('headless-search testConnection', () => {
    it('returns ok=false when browserPool is null', async () => {
        const result = await backendModule.testConnection({ services: {} });
        assert.equal(result.ok, false);
        assert.match(result.detail, /not configured/);
    });

    it('returns ok=false when browserPool is absent from services', async () => {
        const result = await backendModule.testConnection({ services: { browserPool: null } });
        assert.equal(result.ok, false);
    });

    it('returns ok=true when pool has available slots', async () => {
        const result = await backendModule.testConnection({
            services: {
                browserPool: {
                    status() {
                        return { total: 2, available: 1, busy: 1 };
                    },
                },
            },
        });
        assert.equal(result.ok, true);
        assert.match(result.detail, /1\/2 available/);
    });

    it('works through the extension SDK browserPool delegate', async () => {
        const services = createExtensionContext({
            services: {
                browserPool: {
                    status() {
                        return { total: 1, available: 1, busy: 0 };
                    },
                },
            },
        }).services;

        const result = await backendModule.testConnection({ services });
        assert.equal(result.ok, true);
        assert.match(result.detail, /1\/1 available/);
    });

    it('returns ok=false when pool has zero total', async () => {
        const result = await backendModule.testConnection({
            services: {
                browserPool: {
                    status() {
                        return { total: 0, available: 0, busy: 0 };
                    },
                },
            },
        });
        assert.equal(result.ok, false);
    });
});

// ── classifyError ──────────────────────────────────────────────────

describe('headless-search classifyError', () => {
    it('classifies CAPTCHA as rate limit error', () => {
        const err = new Error('Google CAPTCHA detected');
        err.captchaDetected = true;
        const classified = backendModule.classifyError(err);
        assert.equal(classified.constructor.name, 'ProviderRateLimitError');
        assert.equal(classified.cooldown, true);
    });

    it('classifies navigation timeout', () => {
        const err = new Error('Navigation timeout of 30000ms exceeded');
        err.name = 'TimeoutError';
        const classified = backendModule.classifyError(err);
        assert.equal(classified.constructor.name, 'ProviderTimeoutError');
        assert.equal(classified.retryable, true);
    });

    it('classifies pool exhaustion', () => {
        const err = new Error('Browser pool acquire timeout');
        const classified = backendModule.classifyError(err);
        assert.equal(classified.constructor.name, 'ProviderUnavailableError');
        assert.equal(classified.retryable, true);
    });

    it('classifies missing Chrome as ConfigurationError', () => {
        const err = new Error('Failed to launch browser: ENOENT');
        const classified = backendModule.classifyError(err);
        assert.equal(classified.constructor.name, 'ConfigurationError');
    });

    it('classifies CDP disconnect as unavailable', () => {
        const err = new Error('Protocol error: Target closed');
        const classified = backendModule.classifyError(err);
        assert.equal(classified.constructor.name, 'ProviderUnavailableError');
    });
});

// ── Converter ──────────────────────────────────────────────────────

describe('headless-search-converter', () => {
    describe('formatAiModeResponse', () => {
        it('formats answer with citations', () => {
            const result = converter.formatAiModeResponse(
                'This is the AI answer.',
                [
                    { title: 'Source 1', url: 'https://example.com/1' },
                    { title: 'Source 2', url: 'https://example.com/2' },
                ],
                'test query'
            );
            assert.match(result, /Google AI Mode answer for/);
            assert.match(result, /This is the AI answer/);
            assert.match(result, /\[1\] \[Source 1\]/);
            assert.match(result, /\[2\] \[Source 2\]/);
        });

        it('handles empty results', () => {
            const result = converter.formatAiModeResponse('', [], 'test query');
            assert.match(result, /No results found/);
        });

        it('formats answer without citations', () => {
            const result = converter.formatAiModeResponse(
                'Answer only.',
                [],
                'test query'
            );
            assert.match(result, /Answer only/);
            assert.ok(!result.includes('Sources:'));
        });
    });

    describe('toNormalizedChunks', () => {
        it('produces the correct chunk sequence', () => {
            const chunks = converter.toNormalizedChunks(
                { answer: 'Test answer', citations: [] },
                'test query',
                { requestId: 'req-1', model: 'headless-google-ai-mode', provider: 'headless-search' }
            );
            assert.equal(chunks.length, 4);
            assert.equal(chunks[0].type, 'message_start');
            assert.equal(chunks[1].type, 'text_delta');
            assert.equal(chunks[2].type, 'usage');
            assert.equal(chunks[3].type, 'done');
        });

        it('message_start has correct shape', () => {
            const chunks = converter.toNormalizedChunks(
                { answer: 'x', citations: [] },
                'q',
                { requestId: 'r1', model: 'm1', provider: 'p1' }
            );
            assert.equal(chunks[0].data.id, 'r1');
            assert.equal(chunks[0].data.model, 'm1');
            assert.equal(chunks[0].data.role, 'assistant');
        });

        it('usage has non-negative token counts', () => {
            const chunks = converter.toNormalizedChunks(
                { answer: 'hello', citations: [] },
                'query',
                { requestId: 'r', model: 'm', provider: 'p' }
            );
            const usage = chunks[2].data;
            assert.ok(usage.input_tokens >= 0);
            assert.ok(usage.output_tokens >= 0);
            assert.ok(usage.total_tokens >= 0);
        });

        it('done chunk has finish_reason stop', () => {
            const chunks = converter.toNormalizedChunks(
                { answer: 'x', citations: [] },
                'q',
                { requestId: 'r', model: 'm', provider: 'p' }
            );
            assert.equal(chunks[3].data.finish_reason, 'stop');
        });
    });
});

// ── BrowserPool unit tests ──────────────────────────────────────────

describe('BrowserPool', () => {
    function silentLog() {
        return { info() {}, warn() {}, error() {}, debug() {} };
    }

    it('constructor sets fields correctly', () => {
        const pool = new BrowserPool({
            poolSize: 2,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        assert.equal(pool._poolSize, 2);
        assert.equal(pool._executablePath, '/usr/bin/chromium');
    });

    it('status() returns zeros before warmup', () => {
        const pool = new BrowserPool({
            poolSize: 1,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        const st = pool.status();
        assert.equal(st.total, 1);
        assert.equal(st.available, 0);
        assert.equal(st.busy, 0);
    });

    it('acquire rejects when pool is closed', async () => {
        const pool = new BrowserPool({
            poolSize: 1,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        pool._closed = true;
        await assert.rejects(
            () => pool.acquire(),
            /closed/
        );
    });

    it('closeAll clears slots and rejects waiters', async () => {
        const pool = new BrowserPool({
            poolSize: 1,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        await pool.closeAll();
        assert.equal(pool._slots.length, 0);
        assert.equal(pool._closed, true);
    });

    it('resets slot busy state when checkout setup fails', async () => {
        const pool = new BrowserPool({
            poolSize: 1,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        const slot = {
            busy: false,
            lastUsed: 0,
            browser: {
                isConnected() {
                    return true;
                },
                async createBrowserContext() {
                    throw new Error('context failed');
                },
            },
        };
        pool._slots = [slot];

        await assert.rejects(() => pool.acquire(), /context failed/);
        assert.equal(slot.busy, false);
    });

    it('removes abort listener on release before slot reuse', async () => {
        const pool = new BrowserPool({
            poolSize: 1,
            executablePath: '/usr/bin/chromium',
            headlessMode: 'new',
            proxyUrl: null,
            userDataDir: null,
            log: silentLog(),
        });
        const context = {
            async newPage() {
                return {
                    async setUserAgent() {},
                    async evaluateOnNewDocument() {},
                };
            },
            async close() {},
        };
        const slot = {
            busy: false,
            lastUsed: 0,
            browser: {
                isConnected() {
                    return true;
                },
                async createBrowserContext() {
                    return context;
                },
            },
        };
        pool._slots = [slot];
        const controller = new AbortController();

        const handle = await pool.acquire(controller.signal);
        await pool.release(handle);
        slot.busy = true;
        controller.abort(new Error('late abort'));

        assert.equal(slot.busy, true);
    });
});
