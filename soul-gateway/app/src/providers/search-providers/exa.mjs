export default class ExaProvider {
  static type = 'exa';
  static requiresApiKey = true;
  static defaultBaseUrl = 'https://api.exa.ai/search';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || ExaProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const body = {
      query,
      num_results: params.max_results || this.config.max_results || 5,
      type: params.search_type || this.config.search_type || 'auto',
      contents: { text: { max_characters: 1000 } },
    };

    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Exa API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.text || '').slice(0, 500),
      content: r.text || null,
      published_date: r.publishedDate || null,
      source: r.url ? new URL(r.url).hostname : '',
      score: r.score ?? null,
    }));
  }
}
