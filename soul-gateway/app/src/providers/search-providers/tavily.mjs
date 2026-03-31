export default class TavilyProvider {
  static type = 'tavily';
  static requiresApiKey = true;
  static defaultBaseUrl = 'https://api.tavily.com/search';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || TavilyProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const body = {
      query,
      api_key: this.apiKey,
      search_depth: params.search_depth || this.config.search_depth || 'basic',
      max_results: params.max_results || this.config.max_results || 5,
      include_answer: false,
    };
    if (params.include_domains) body.include_domains = params.include_domains;
    if (params.exclude_domains) body.exclude_domains = params.exclude_domains;

    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Tavily API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return (data.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 500),
      content: r.raw_content || r.content || null,
      published_date: r.published_date || null,
      source: r.url ? new URL(r.url).hostname : '',
      score: r.score ?? null,
    }));
  }
}
