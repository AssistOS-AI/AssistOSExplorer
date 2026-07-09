/**
 * Provider preset catalog.
 *
 * A "preset" is a pre-baked configuration bundle that references an
 * existing backend module (via `adapter_key`) and fills in the base_url,
 * display name, auth strategy, and any vendor-specific defaults so
 * the user doesn't have to look them up. Presets are NOT backend
 * modules: they contain no code, they reuse the backend module's
 * execution path by setting `adapter_key` to the module's manifest key.
 *
 * This is the new-gateway equivalent of the old
 * `proxies/soul-gateway/app/src/api/providers.mjs PROVIDER_TEMPLATES`
 * map, adapted to the backend-module architecture: the backend catalog
 * stays at one-module-per-protocol-family (so adding a new
 * OpenAI-compatible vendor is configuration, not code), while the
 * preset catalog gives the dashboard a ready-to-pick list of known
 * vendors with their base URLs already filled in.
 *
 * Every preset is merged into the response from
 * `BackendCatalog.getTemplates()` and surfaces in the dashboard's
 * "Add Provider" dropdown.
 *
 * Shape notes:
 *  - `key`              dropdown key; becomes the default `provider_key`
 *                       at creation time
 *  - `adapter_key`      MUST exactly match a loaded backend module's
 *                       `manifest.key` (e.g. `openai-api`,
 *                       `anthropic-api`); the
 *                       catalog looks backend modules up by direct key
 *                       lookup
 *  - `kind`             matches the backend kind (`external_api`,
 *                       `local_model`, `custom`)
 *  - `auth_strategy`    `api_key` | `oauth` | `subscription` |
 *                       `managed`
 *  - `auth_type`        `api_key` | `managed` — dashboard-facing auth label
 *  - `base_url`         vendor's canonical base URL (the backend module
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

/**
 * Static list of known provider presets. Extend here — no code
 * changes needed elsewhere; the dashboard dropdown updates on next
 * `/management/providers/templates` fetch.
 *
 * Presets are listed in roughly user-facing priority order: the most
 * popular general-purpose vendors first, then specialized ones,
 * then specialized providers. `Object.freeze` makes the array and every entry
 * immutable so callers can't mutate catalog state at runtime.
 */
export const PROVIDER_PRESETS = Object.freeze([
    // ── OpenAI-compatible vendors (all use the `openai-api` backend) ──
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
    Object.freeze({
        // OpenCode Zen — curated multi-vendor coding-model gateway. The
        // /zen/v1 base also exposes /messages and /responses for native
        // clients, but /chat/completions is the universal OpenAI-compatible
        // surface the openai-api backend targets.
        key: 'opencode-zen',
        display_name: 'OpenCode Zen',
        base_url: 'https://opencode.ai/zen/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),
    Object.freeze({
        // OpenCode Go — flat-rate subscription tier serving open coding
        // models (GLM, Kimi, MiMo, Qwen, MiniMax, DeepSeek). Note the base
        // lives under /zen/go/v1, NOT /go/v1.
        key: 'opencode-go',
        display_name: 'OpenCode Go',
        base_url: 'https://opencode.ai/zen/go/v1',
        ...OPENAI_COMPAT_DEFAULTS,
    }),

    // ── Anthropic direct (api-key, not the claude.ai OAuth backend) ──
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

]);

/**
 * Return the preset catalog as an object keyed by `preset.key`,
 * ready to be merged into `BackendCatalog.getTemplates()`.
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
