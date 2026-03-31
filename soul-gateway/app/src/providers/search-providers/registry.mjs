import TavilyProvider from './tavily.mjs';
import BraveProvider from './brave.mjs';
import ExaProvider from './exa.mjs';
import JinaProvider from './jina.mjs';
import DuckDuckGoProvider from './duckduckgo.mjs';
import SearXNGProvider from './searxng.mjs';
import SerperProvider from './serper.mjs';
import GeminiProvider from './gemini.mjs';

const PROVIDERS = new Map([
  ['tavily', TavilyProvider],
  ['brave', BraveProvider],
  ['exa', ExaProvider],
  ['jina', JinaProvider],
  ['duckduckgo', DuckDuckGoProvider],
  ['searxng', SearXNGProvider],
  ['serper', SerperProvider],
  ['gemini', GeminiProvider],
]);

export function getProviderClass(type) {
  return PROVIDERS.get(type) || null;
}

export function listProviderTypes() {
  return [...PROVIDERS.keys()];
}

export function createProvider(type, apiKey, baseUrl, config = {}) {
  const Cls = PROVIDERS.get(type);
  if (!Cls) throw new Error(`Unknown provider type: ${type}`);
  return new Cls(apiKey, baseUrl, config);
}
