/**
 * Provider preset catalog.
 *
 * A "preset" is a pre-baked configuration bundle that references an
 * existing plugin (via `adapter_key`) and fills in the base_url,
 * display name, auth strategy, and any vendor-specific defaults so
 * the user doesn't have to look them up. Presets are NOT plugins:
 * they contain no code, they reuse the plugin's execution path by
 * setting `adapter_key` to the plugin's manifest key.
 *
 * This is the new-gateway equivalent of the old
 * `proxies/soul-gateway/app/src/api/providers.mjs PROVIDER_TEMPLATES`
 * map, adapted to the plugin-driven architecture: the plugin catalog
 * stays at one-plugin-per-protocol-family (so adding a new
 * OpenAI-compatible vendor is configuration, not code), while the
 * preset catalog gives the dashboard a ready-to-pick list of known
 * vendors with their base URLs already filled in.
 *
 * Every preset is merged into the response from
 * `ProviderCatalog.getTemplates()` and surfaces in the dashboard's
 * "Add Provider" dropdown.
 *
 * Shape notes:
 *  - `key`              dropdown key; becomes the default `provider_key`
 *                       at creation time
 *  - `adapter_key`      MUST exactly match a loaded plugin's
 *                       `manifest.key` (e.g. `openai-api`,
 *                       `anthropic-api`, `search-builtin`); the
 *                       catalog looks plugins up by direct key
 *                       lookup
 *  - `kind`             matches the plugin kind (`external_api`,
 *                       `search`, `custom`)
 *  - `auth_strategy`    `api_key` | `oauth` | `subscription` |
 *                       `managed` | `search`
 *  - `auth_type`        `api_key` | `managed` — dashboard-facing auth label
 *  - `base_url`         vendor's canonical base URL (the plugin
 *                       appends `/chat/completions`, `/responses`,
 *                       etc. via its own URL resolver)
 *  - `supported_formats` protocol families the upstream speaks; used
 *                       by the provider catalog UI
 */

const OPENAI_COMPAT_DEFAULTS = Object.freeze({
    adapter_key: 'openai-api',
    kind: 'external_api',
    auth_strategy: 'api_key',
    auth_type: 'api_key',
    oauth_adapter_key: null,
    supports_streaming: true,
    supports_tools: true,
    supported_formats: ['openai_chat'],
});

const SEARCH_DEFAULTS = Object.freeze({
    adapter_key: 'search-builtin',
    kind: 'search',
    auth_strategy: 'api_key',
    auth_type: 'api_key',
    oauth_adapter_key: null,
    supports_streaming: false,
    supports_tools: false,
    supported_formats: ['openai_chat'],
});

/**
 * Static list of known provider presets. Extend here — no code
 * changes needed elsewhere; the dashboard dropdown updates on next
 * `/management/providers/templates` fetch.
 *
 * Presets are listed in roughly user-facing priority order: the most
 * popular general-purpose vendors first, then specialized ones,
 * then search. `Object.freeze` makes the array and every entry
 * immutable so callers can't mutate catalog state at runtime.
 */
export const PROVIDER_PRESETS = Object.freeze([
    // ── OpenAI-compatible vendors (all use the `openai-api` plugin) ──
    Object.freeze({
        key: 'openai',
        display_name: 'OpenAI (Direct)',
        base_url: 'https://api.openai.com/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'openrouter',
        display_name: 'OpenRouter',
        base_url: 'https://openrouter.ai/api/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'nvidia',
        display_name: 'NVIDIA',
        base_url: 'https://integrate.api.nvidia.com/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'fireworks',
        display_name: 'Fireworks AI',
        base_url: 'https://api.fireworks.ai/inference/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'groq',
        display_name: 'Groq',
        base_url: 'https://api.groq.com/openai/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'together',
        display_name: 'Together AI',
        base_url: 'https://api.together.xyz/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'deepseek',
        display_name: 'DeepSeek',
        base_url: 'https://api.deepseek.com/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'deepinfra',
        display_name: 'DeepInfra',
        base_url: 'https://api.deepinfra.com/v1/openai',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'perplexity',
        display_name: 'Perplexity',
        base_url: 'https://api.perplexity.ai',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'mistral',
        display_name: 'Mistral',
        base_url: 'https://api.mistral.ai/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        // Codestral runs on its own subdomain, distinct from Mistral's
        // main API (api.mistral.ai). Listed as a separate preset because
        // a user picking "Mistral" expects general-purpose chat models,
        // while "Codestral" is a code-completion-tuned endpoint with its
        // own auth/billing surface.
        key: 'codestral',
        display_name: 'Mistral Codestral',
        base_url: 'https://codestral.mistral.ai/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'xai',
        display_name: 'xAI (Grok)',
        base_url: 'https://api.x.ai/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        key: 'cohere',
        display_name: 'Cohere',
        base_url: 'https://api.cohere.com/compatibility/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),

    // ── Anthropic direct (api-key, not the claude.ai OAuth plugin) ──
    Object.freeze({
        key: 'anthropic-direct',
        display_name: 'Anthropic (Direct)',
        adapter_key: 'anthropic-api',
        kind: 'external_api',
        auth_strategy: 'api_key',
        auth_type: 'api_key',
        oauth_adapter_key: null,
        base_url: 'https://api.anthropic.com',
        supports_streaming: true,
        supports_tools: true,
        supported_formats: ['anthropic_messages'],
    }),

    // ── Search engines (all use the `search-builtin` plugin) ────────
    Object.freeze({
        key: 'tavily',
        display_name: 'Tavily',
        base_url: 'https://api.tavily.com/search',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'brave',
        display_name: 'Brave Search',
        base_url: 'https://api.search.brave.com/res/v1/web/search',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'exa',
        display_name: 'Exa',
        base_url: 'https://api.exa.ai/search',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'serper',
        display_name: 'Serper',
        base_url: 'https://google.serper.dev/search',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'jina',
        display_name: 'Jina',
        base_url: 'https://s.jina.ai/',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'duckduckgo',
        display_name: 'DuckDuckGo',
        // DuckDuckGo has no API key requirement; the plugin knows to
        // treat this as unauthenticated.
        base_url: 'https://html.duckduckgo.com/html/',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'searxng',
        display_name: 'SearXNG',
        // SearXNG is self-hosted — base URL is left blank so the user
        // fills in their own instance.
        base_url: '',
        ...SEARCH_DEFAULTS,
    }),
    Object.freeze({
        key: 'gemini-search',
        display_name: 'Gemini Search (grounding)',
        base_url: 'https://generativelanguage.googleapis.com/v1beta/models/',
        ...SEARCH_DEFAULTS,
    }),
]);

/**
 * Return the preset catalog as an object keyed by `preset.key`,
 * ready to be merged into `ProviderCatalog.getTemplates()`.
 *
 * @returns {object}  key -> preset
 */
export function getProviderPresets() {
    const out = {};
    for (const preset of PROVIDER_PRESETS) {
        out[preset.key] = preset;
    }
    return out;
}
