/**
 * Model naming convention: axl/<provider-slug>/<model>
 *
 * All models in Soul Gateway follow this convention so consumers
 * can immediately tell which upstream provider a model routes through.
 *
 * NOTE: The provider slug map is duplicated in app/src/public/js/app.mjs
 * for the dashboard client. Keep both in sync when adding new slugs.
 */

const SLUG_MAP = {
  axiologic_kiro: 'kiro',
  search_gateway: 'search',
};

/**
 * Convert a provider_key to its URL-friendly slug.
 * Most provider keys are already clean; only a few need mapping.
 */
export function providerSlug(providerKey) {
  return SLUG_MAP[providerKey] || providerKey;
}

/**
 * Build a canonical model name: axl/<slug>/<providerModel>
 */
export function buildModelName(providerKey, providerModel) {
  const slug = providerSlug(providerKey);
  return `axl/${slug}/${providerModel}`;
}

/**
 * Strip known legacy prefixes from old-style model names to get the
 * bare model part.  Used during the one-time rename migration.
 *
 *   copilot-gpt-4o  →  gpt-4o
 *   kiro-claude-sonnet-4.5  →  claude-sonnet-4.5
 *   auto-kiro  →  auto  (special case)
 *   claude-opus-4.6  →  claude-opus-4.6  (no prefix to strip)
 */
export function stripLegacyPrefix(name, providerKey) {
  if (providerKey === 'copilot' && name.startsWith('copilot-')) {
    return name.slice('copilot-'.length);
  }
  if (providerKey === 'axiologic_kiro') {
    if (name === 'auto-kiro') return 'auto';
    if (name.startsWith('kiro-')) return name.slice('kiro-'.length);
  }
  // Direct providers (anthropic, openai, google, etc.) — keep full name
  return name;
}

/**
 * Predefined model tags. Used by both the /api/v1/models/tags endpoint
 * and the seed migration in init.mjs.
 */
export const PREDEFINED_TAGS = [
  'fast', 'thinking', 'coding', 'agentic', 'search', 'vision',
  'creative', 'chat', 'long-context', 'instruction-following',
  'multilingual', 'reasoning', 'multimodal', 'function-calling', 'roleplay',
];
