/**
 * Built-in headless browser search backend module.
 *
 * Navigates a headless Chrome to Google AI Mode (?udm=50) to extract
 * the AI-generated answer and citation links. Returns results as
 * NormalizedChunks in the same format as search-builtin.
 *
 * Requires BROWSER_POOL_SIZE > 0 and puppeteer-core installed.
 * The browser pool is a bootstrap service injected via ctx.services.
 */

import {
    ConfigurationError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    ProviderUnavailableError,
} from '../../../core/errors.mjs';
import {
    classifyTransportOrServerError,
} from '../error-helpers.mjs';
import * as converter from '../converters/headless-search-converter.mjs';

const manifest = {
    key: 'headless-search',
    kind: 'search',
    authStrategy: 'none',
    supportsStreaming: false,
    supportsTools: false,
    supportedFormats: ['openai_chat'],
    hidden: true,
};

export const backendModule = {
    manifest,

    formatConverter: converter,

    async shutdown() {},

    validateProviderRecord() {},

    validateModelRecord() {},

    async discoverModels() {
        return [
            {
                modelId: 'headless-google-ai-mode',
                displayName: 'Google AI Mode (headless)',
                contextWindow: null,
                maxOutputTokens: null,
                supportsTools: false,
                supportsStreaming: false,
                supportsVision: false,
            },
        ];
    },

    async testConnection(ctx) {
        const pool = ctx.services?.browserPool;
        if (!pool) {
            return {
                ok: false,
                detail: 'Browser pool not configured (BROWSER_POOL_SIZE=0 or puppeteer-core not installed)',
            };
        }

        const poolStatus = pool.status();
        return {
            ok: poolStatus.total > 0,
            detail: `Browser pool: ${poolStatus.available}/${poolStatus.total} available, ${poolStatus.busy} busy`,
        };
    },

    async execute(ctx) {
        const {
            request: normalizedReq,
            providerRecord,
            signal,
        } = ctx;
        const settings = providerRecord?.settings || {};

        const pool = ctx.services?.browserPool;
        if (!pool) {
            throw new ConfigurationError(
                'Headless search requires BROWSER_POOL_SIZE > 0 and puppeteer-core installed'
            );
        }

        const query = extractSearchQuery(normalizedReq);
        if (!query) {
            const stream = emptyResultStream(ctx.requestId);
            return { accountId: null, stream, abort: async () => {} };
        }

        const timeoutMs = settings.browser_timeout_ms || 30_000;
        const minInterval = settings.min_request_interval_ms || 2_000;
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;

        let handle = null;
        try {
            handle = await pool.acquire(signal);

            if (minInterval > 0) {
                await new Promise((r) => setTimeout(r, minInterval));
            }

            await handle.page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: timeoutMs,
            });

            if (settings.debug_screenshots) {
                try {
                    const { mkdirSync } = await import('node:fs');
                    const { join } = await import('node:path');
                    const dir = join(process.env.DATA_DIR || './data', 'screenshots');
                    mkdirSync(dir, { recursive: true });
                    await handle.page.screenshot({
                        path: join(dir, `headless-search-${Date.now()}.png`),
                        fullPage: true,
                    });
                } catch { /* screenshot failure is non-fatal */ }
            }

            const extracted = await converter.extractGoogleAiModeResults(
                handle.page,
                settings
            );

            const chunks = converter.toNormalizedChunks(extracted, query, {
                requestId: ctx.requestId,
                model: 'headless-google-ai-mode',
                provider: 'headless-search',
            });

            const stream = arrayToAsyncGenerator(chunks);
            return { accountId: null, stream, abort: async () => {} };
        } finally {
            if (handle) pool.release(handle);
        }
    },

    classifyError(error) {
        if (error?.captchaDetected || error?.message?.includes('/sorry/')) {
            return new ProviderRateLimitError('headless-search');
        }

        if (error?.name === 'TimeoutError' || error?.message?.includes('Navigation timeout')) {
            return new ProviderTimeoutError('headless-search');
        }

        if (error?.message?.includes('pool acquire timeout') || error?.message?.includes('pool is closed')) {
            return new ProviderUnavailableError('headless-search');
        }

        if (error?.message?.includes('ENOENT') || error?.message?.includes('executablePath')) {
            return new ConfigurationError(
                'Chrome/Chromium not found. Set BROWSER_EXECUTABLE_PATH to the Chrome binary path.'
            );
        }

        if (error?.message?.includes('Target closed') || error?.message?.includes('disconnected')) {
            return new ProviderUnavailableError('headless-search');
        }

        return classifyTransportOrServerError('headless-search', error);
    },
};

function extractSearchQuery(normalizedReq) {
    const messages = normalizedReq.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            const content = messages[i].content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
                const text = content.find((p) => p.type === 'text');
                return text?.text || '';
            }
        }
    }
    return '';
}

async function* emptyResultStream(requestId) {
    yield {
        type: 'message_start',
        data: { id: requestId, model: 'headless-search', role: 'assistant' },
    };
    yield { type: 'text_delta', data: { text: 'No search query provided.' } };
    yield { type: 'done', data: { finish_reason: 'stop', model: 'headless-search' } };
}

async function* arrayToAsyncGenerator(arr) {
    for (const item of arr) {
        yield item;
    }
}
