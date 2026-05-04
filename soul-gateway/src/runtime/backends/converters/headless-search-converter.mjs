/**
 * Headless browser search result converter.
 *
 * Extracts Google AI Mode answers and citations from a rendered page,
 * and converts them to NormalizedChunks for the streaming pipeline.
 *
 * @module runtime/backends/converters/headless-search-converter
 */

const SELECTORS = Object.freeze({
    aiAnswerContainer: '[data-ai-answer], .XDKMoc, div[jsname="WbKHeb"], div[jsname="H7tCnf"], .QGG6Id.YNk70c, .bzXtMb',
    aiAnswerParagraphs: '.n6owBd.awi2gc, span.T286Pc, p, span.hgKElc, div > span',
    citationLinks: 'a[href][data-ved], a.KEVENd, a.cz3goc',
    captchaIndicator: '#captcha-form, form[action*="/sorry"]',
    organicResults: 'div.g, div.tF2Cxc',
    organicTitle: 'h3',
    organicLink: 'a[href]',
    organicSnippet: 'div.VwiC3b, span.aCOpRe',
});

/**
 * Extract AI Mode answer and citations from a rendered Google page.
 *
 * @param {object} page  Puppeteer Page object
 * @param {object} [settings]
 * @returns {Promise<{ answer: string, citations: Array<{title: string, url: string}> }>}
 */
export async function extractGoogleAiModeResults(page, settings = {}) {
    const selectors = settings.custom_selectors
        ? { ...SELECTORS, ...settings.custom_selectors }
        : SELECTORS;
    const timeoutMs = settings.browser_timeout_ms || 30_000;

    const currentUrl = page.url();
    if (currentUrl.includes('/sorry/') || currentUrl.includes('/sorry?')) {
        const err = new Error('Google CAPTCHA detected');
        err.captchaDetected = true;
        throw err;
    }

    const captcha = await page.$(selectors.captchaIndicator);
    if (captcha) {
        const err = new Error('Google CAPTCHA detected');
        err.captchaDetected = true;
        throw err;
    }

    let aiContainer = null;
    try {
        aiContainer = await page.waitForSelector(selectors.aiAnswerContainer, { timeout: timeoutMs });
    } catch {
        // AI container not found
    }

    if (!aiContainer) {
        if (settings.fallback_to_organic === false) {
            return { answer: '', citations: [] };
        }
        return extractOrganicResults(page, selectors);
    }

    const answer = await aiContainer.evaluate((el, pSelector) => {
        const isUiText = (text) =>
            [
                /vil du slette/i,
                /tidsbesparende/i,
                /din feedback/i,
                /google anvender/i,
                /opretter et offentligt link/i,
                /tak, fordi/i,
                /du er logget ud/i,
                /historik for ai/i,
                /this response uses data provided/i,
            ].some((pattern) => pattern.test(text));
        const paragraphs = el.querySelectorAll(pSelector);
        if (paragraphs.length > 0) {
            return Array.from(paragraphs)
                .filter((p) => {
                    if (p.closest('script, style, [role="dialog"], #fbproxy3')) return false;
                    const aria = p.getAttribute('aria-label') || '';
                    if (/feedback|historik|history/i.test(aria)) return false;
                    return true;
                })
                .map((p) => p.textContent.trim())
                .filter(Boolean)
                .filter((text) => !isUiText(text))
                .join('\n\n');
        }
        return el.textContent.trim();
    }, selectors.aiAnswerParagraphs);

    const citations = await page.evaluate((linkSelector) => {
        const links = document.querySelectorAll(linkSelector);
        const seen = new Set();
        const results = [];
        for (const a of links) {
            const href = a.href;
            if (!href || href.startsWith('javascript:') || seen.has(href)) continue;
            if (href.includes('google.com/search')) continue;
            seen.add(href);
            results.push({
                title: a.textContent.trim() || a.getAttribute('aria-label') || href,
                url: href,
            });
        }
        return results;
    }, selectors.citationLinks);

    return { answer, citations };
}

async function extractOrganicResults(page, selectors) {
    const results = await page.evaluate(
        (containerSel, titleSel, linkSel, snippetSel) => {
            const items = document.querySelectorAll(containerSel);
            const out = [];
            for (const item of items) {
                const titleEl = item.querySelector(titleSel);
                const linkEl = item.querySelector(linkSel);
                const snippetEl = item.querySelector(snippetSel);
                if (!titleEl || !linkEl) continue;
                out.push({
                    title: titleEl.textContent.trim(),
                    url: linkEl.href,
                    snippet: snippetEl?.textContent?.trim() || '',
                });
            }
            return out;
        },
        selectors.organicResults,
        selectors.organicTitle,
        selectors.organicLink,
        selectors.organicSnippet
    );

    if (results.length === 0) return { answer: '', citations: [] };

    const lines = results.map(
        (r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
    );
    return {
        answer: lines.join('\n\n'),
        citations: results.map((r) => ({ title: r.title, url: r.url })),
    };
}

/**
 * Format AI Mode answer and citations into markdown.
 *
 * @param {string} answer
 * @param {Array<{title: string, url: string}>} citations
 * @param {string} query
 * @returns {string}
 */
export function formatAiModeResponse(answer, citations, query) {
    if (!answer && citations.length === 0) {
        return `No results found for: "${query}"`;
    }

    const displayAnswer = stripLeadingQuery(answer, query);
    const lines = [`**Google AI Mode answer for:** "${query}"\n`];

    if (displayAnswer) {
        lines.push(displayAnswer);
        lines.push('');
    }

    if (citations.length > 0) {
        lines.push('---');
        lines.push('**Sources:**');
        for (let i = 0; i < citations.length; i++) {
            const c = citations[i];
            lines.push(`[${i + 1}] [${c.title}](${c.url})`);
        }
    }

    return lines.join('\n');
}

function stripLeadingQuery(answer, query) {
    if (!answer || !query) return answer;
    const lines = answer.split('\n');
    while (lines.length > 0 && !lines[0].trim()) {
        lines.shift();
    }
    if (lines.length > 0 && lines[0].trim().toLowerCase() === query.trim().toLowerCase()) {
        lines.shift();
    }
    return lines.join('\n').trim();
}

/**
 * Convert extracted results to NormalizedChunks.
 *
 * @param {{ answer: string, citations: Array }} extracted
 * @param {string} query
 * @param {{ requestId: string, model: string, provider: string }} meta
 * @returns {Array<import('../backend-interface.mjs').NormalizedChunk>}
 */
export function toNormalizedChunks(extracted, query, meta) {
    const formatted = formatAiModeResponse(
        extracted.answer,
        extracted.citations,
        query
    );

    return [
        {
            type: 'message_start',
            data: {
                id: meta.requestId || null,
                model: meta.model || 'headless-search',
                role: 'assistant',
            },
        },
        {
            type: 'text_delta',
            data: { text: formatted },
        },
        {
            type: 'usage',
            data: {
                input_tokens: Math.ceil(query.length / 4),
                output_tokens: Math.ceil(formatted.length / 4),
                total_tokens: Math.ceil(query.length / 4) + Math.ceil(formatted.length / 4),
            },
        },
        {
            type: 'done',
            data: { finish_reason: 'stop', model: meta.model || 'headless-search' },
        },
    ];
}
