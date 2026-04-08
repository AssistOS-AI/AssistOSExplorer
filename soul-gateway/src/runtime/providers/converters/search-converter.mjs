/**
 * Search results to chat format converter.
 *
 * Converts raw search API responses into a normalized chat message
 * with inline citations, suitable for streaming as NormalizedChunks.
 */

// ── Response formatting ─────────────────────────────────────────────

/**
 * Format raw search results into a markdown chat message with citations.
 *
 * @param {Array<SearchResult>} results
 * @param {string} query  The original search query
 * @param {object} [options]
 * @param {number} [options.maxResults=10]
 * @param {boolean} [options.includeSnippets=true]
 * @returns {string} Formatted markdown
 */
export function formatSearchResults(results, query, options = {}) {
    const { maxResults = 10, includeSnippets = true } = options;
    const trimmed = results.slice(0, maxResults);

    if (trimmed.length === 0) {
        return `No search results found for: "${query}"`;
    }

    const lines = [`**Search results for:** "${query}"\n`];

    for (let i = 0; i < trimmed.length; i++) {
        const r = trimmed[i];
        const idx = i + 1;
        const title = r.title || r.name || 'Untitled';
        const url = r.url || r.link || '';
        const snippet = r.snippet || r.content || r.description || '';

        lines.push(`### [${idx}] ${title}`);
        if (url) lines.push(`> ${url}`);
        if (includeSnippets && snippet) {
            lines.push('');
            lines.push(snippet.trim());
        }
        lines.push('');
    }

    // Citations footer
    lines.push('---');
    lines.push('**Sources:**');
    for (let i = 0; i < trimmed.length; i++) {
        const r = trimmed[i];
        const title = r.title || r.name || 'Untitled';
        const url = r.url || r.link || '';
        lines.push(`[${i + 1}] [${title}](${url})`);
    }

    return lines.join('\n');
}

// ── Chunk conversion ────────────────────────────────────────────────

/**
 * Convert search results into an array of NormalizedChunks suitable
 * for the streaming pipeline.
 *
 * @param {Array<SearchResult>} results  Parsed search results
 * @param {string} query                 Original query
 * @param {object} meta                  { requestId, model, provider }
 * @returns {Array<import('../provider-interface.mjs').NormalizedChunk>}
 */
export function toNormalizedChunks(results, query, meta) {
    const formatted = formatSearchResults(results, query);
    const chunks = [];

    chunks.push({
        type: 'message_start',
        data: {
            id: meta.requestId || null,
            model: meta.model || 'search',
            role: 'assistant',
        },
    });

    // Emit the full formatted text as a single delta
    // (search results are small enough that chunking is unnecessary)
    chunks.push({
        type: 'text_delta',
        data: { text: formatted },
    });

    chunks.push({
        type: 'usage',
        data: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
        },
    });

    chunks.push({
        type: 'done',
        data: { finish_reason: 'stop', model: meta.model || 'search' },
    });

    return chunks;
}

// ── Per-provider result extractors ──────────────────────────────────

/**
 * Extract a normalized result array from a Tavily API response.
 *
 * @param {object} raw  Tavily API response body
 * @returns {Array<SearchResult>}
 */
export function extractTavilyResults(raw) {
    return (raw.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
    }));
}

/**
 * Extract from Brave Search API response.
 */
export function extractBraveResults(raw) {
    const web = raw.web?.results || [];
    return web.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
    }));
}

/**
 * Extract from Exa (formerly Metaphor) API response.
 */
export function extractExaResults(raw) {
    return (raw.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.text || r.highlights?.join(' '),
        score: r.score,
    }));
}

/**
 * Extract from Serper API response.
 */
export function extractSerperResults(raw) {
    return (raw.organic || []).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        position: r.position,
    }));
}

/**
 * Extract from Jina Reader API response.
 */
export function extractJinaResults(raw) {
    if (raw.data && Array.isArray(raw.data)) {
        return raw.data.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content || r.description,
        }));
    }
    // Single-result mode
    if (raw.data && typeof raw.data === 'object') {
        return [
            {
                title: raw.data.title,
                url: raw.data.url,
                snippet: raw.data.content || raw.data.description,
            },
        ];
    }
    return [];
}

/**
 * Extract from DuckDuckGo Instant Answer API response.
 */
export function extractDuckDuckGoResults(raw) {
    const results = [];

    if (raw.AbstractText) {
        results.push({
            title: raw.Heading || 'DuckDuckGo Answer',
            url: raw.AbstractURL || '',
            snippet: raw.AbstractText,
        });
    }

    for (const topic of raw.RelatedTopics || []) {
        if (topic.FirstURL) {
            results.push({
                title: topic.Text?.split(' - ')[0] || '',
                url: topic.FirstURL,
                snippet: topic.Text || '',
            });
        }
        // Handle subtopics
        for (const sub of topic.Topics || []) {
            if (sub.FirstURL) {
                results.push({
                    title: sub.Text?.split(' - ')[0] || '',
                    url: sub.FirstURL,
                    snippet: sub.Text || '',
                });
            }
        }
    }

    return results;
}

/**
 * Extract from SearXNG API response.
 */
export function extractSearxngResults(raw) {
    return (raw.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        engine: r.engine,
    }));
}

/**
 * Extract from Google Gemini grounding search response.
 */
export function extractGeminiResults(raw) {
    const chunks =
        raw.groundingChunks || raw.searchEntryPoint?.renderedContent
            ? raw.groundingChunks || []
            : [];
    return chunks.map((c) => ({
        title: c.web?.title || c.retrievedContext?.title || '',
        url: c.web?.uri || c.retrievedContext?.uri || '',
        snippet: c.web?.snippet || '',
    }));
}

/**
 * Route to the correct extractor based on search provider key.
 *
 * @param {string} searchProvider  e.g. 'tavily', 'brave', 'exa'
 * @param {object} rawResponse
 * @returns {Array<SearchResult>}
 */
export function extractResults(searchProvider, rawResponse) {
    const extractors = {
        tavily: extractTavilyResults,
        brave: extractBraveResults,
        exa: extractExaResults,
        serper: extractSerperResults,
        jina: extractJinaResults,
        duckduckgo: extractDuckDuckGoResults,
        searxng: extractSearxngResults,
        gemini: extractGeminiResults,
    };

    const fn = extractors[searchProvider];
    if (!fn) return [];
    return fn(rawResponse);
}

// ── Types ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} snippet
 * @property {number} [score]
 * @property {string} [engine]
 * @property {number} [position]
 */

// ── Deep Research formatter ────────────────────────────────────────

/**
 * Format deduplicated multi-engine results into a synthesized deep research response.
 */
export function formatDeepResearchResults(results, query, engineCount) {
    if (!results.length) {
        return `No results found across ${engineCount} search engines for: "${query}"`;
    }

    const lines = [
        `## Deep Research Results`,
        ``,
        `*Query: "${query}" — ${results.length} results from ${engineCount} search engine${engineCount > 1 ? 's' : ''}*`,
        ``,
    ];

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const source = r._source ? ` (via ${r._source})` : '';
        lines.push(`${i + 1}. **${r.title || 'Untitled'}**${source}`);
        if (r.url) lines.push(`   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
        lines.push('');
    }

    const urls = results.filter((r) => r.url).map((r) => r.url);
    if (urls.length) {
        lines.push('---');
        lines.push(`Sources: ${urls.join(', ')}`);
    }

    return lines.join('\n');
}
