import searchConverter from '../format-converters/search.mjs';

/**
 * Search adapter — internal provider, no OAuth needed.
 * API keys for individual search providers are read from environment variables.
 */
export default {
  name: 'search',
  authType: 'internal',

  async getHeaders() {
    return { 'Content-Type': 'application/json' };
  },

  knownModels: [
    'Tavily-search', 'brave-search', 'exa-search', 'serper-search',
    'gemini-search', 'duckduckgo-search', 'searxng-search', 'jina-search',
    'deep-research',
  ],

  formatConverter: searchConverter,
  credentialsDir: null,
};
