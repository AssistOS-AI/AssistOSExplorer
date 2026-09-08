const PROVIDER_TOKEN_RE = /(^|\s)@(?:web-search|search)(?=\s|$|[.,:;!?])/i;

export async function action(args = {}) {
    const prompt = typeof args.prompt === 'string'
        ? args.prompt.trim()
        : typeof args.promptText === 'string'
        ? args.promptText.trim()
        : '';
    const context = args.context && typeof args.context === 'object' ? args.context : {};
    if (PROVIDER_TOKEN_RE.test(prompt)) {
        const tokenResult = {
            ok: false,
            backend: 'web-search',
            cacheable: false,
            result_text: '`@web-search` is ordinary chat text now. I did not start a web search from that token.',
            persistence_hint: {
                ku_type: 'agent.result.web-search',
                record_result: false,
                ttl_hint_seconds: null,
            },
            diagnostics: {
                providerAvailability: 'disabled',
                deprecatedToken: true,
                promptProvided: true,
            },
        };
        if (context && typeof context === 'object') {
            if (!Array.isArray(context.providerLauncherResults)) {
                context.providerLauncherResults = [];
            }
            context.providerLauncherResults.push({
                launcher: 'launch-web-search',
                backend: 'web-search',
                prompt,
                result: tokenResult,
            });
        }
        return tokenResult;
    }
    const result = {
        ok: false,
        backend: 'web-search',
        cacheable: false,
        result_text: 'Web search is not deployed for this Copilot workspace yet. I cannot look up current online information from here.',
        persistence_hint: {
            ku_type: 'agent.result.web-search',
            record_result: false,
            ttl_hint_seconds: null,
        },
        diagnostics: {
            providerAvailability: 'disabled',
            promptProvided: Boolean(prompt),
        },
    };
    if (context && typeof context === 'object') {
        if (!Array.isArray(context.providerLauncherResults)) {
            context.providerLauncherResults = [];
        }
        context.providerLauncherResults.push({
            launcher: 'launch-web-search',
            backend: 'web-search',
            prompt,
            result,
        });
    }
    return result;
}
