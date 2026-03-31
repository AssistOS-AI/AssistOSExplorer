export default class GeminiProvider {
  static type = 'gemini';
  static requiresApiKey = true;
  static models = [
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  ];
  static defaultModel = 'gemini-3-flash';
  static baseUrlTemplate = 'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.model = config.model || GeminiProvider.defaultModel;
    this.baseUrl = baseUrl || GeminiProvider.baseUrlTemplate.replace('{MODEL}', this.model);
    this.config = config;
  }

  async search(query, params = {}) {
    const url = `${this.baseUrl}?key=${this.apiKey}`;

    const body = {
      contents: [{ parts: [{ text: query }] }],
      tools: [{ google_search: {} }],
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Gemini API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();

    // Extract grounding metadata from the response
    const candidate = data.candidates?.[0];
    if (!candidate) return [];

    const groundingMeta = candidate.groundingMetadata;
    if (!groundingMeta) {
      // No grounding — return the text as a single result
      const text = candidate.content?.parts?.map(p => p.text).join('') || '';
      return text ? [{
        title: 'Gemini Answer',
        url: '',
        snippet: text.slice(0, 500),
        content: text,
        published_date: null,
        source: 'gemini',
        score: null,
      }] : [];
    }

    // Extract grounding chunks (web sources)
    const chunks = groundingMeta.groundingChunks || [];
    const supports = groundingMeta.groundingSupports || [];
    const searchResult = groundingMeta.searchEntryPoint;

    const results = chunks
      .filter(c => c.web)
      .map((c, i) => {
        const web = c.web;
        // Find matching support text for this chunk
        const supportText = supports
          .filter(s => s.groundingChunkIndices?.includes(i))
          .map(s => s.segment?.text)
          .filter(Boolean)
          .join(' ');

        let source = '';
        try { source = new URL(web.uri).hostname; } catch {}

        return {
          title: web.title || '',
          url: web.uri || '',
          snippet: supportText || '',
          content: null,
          published_date: null,
          source,
          score: null,
        };
      });

    return results;
  }
}
