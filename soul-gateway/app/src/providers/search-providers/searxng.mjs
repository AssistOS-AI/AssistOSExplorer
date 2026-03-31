export default class SearXNGProvider {
  static type = 'searxng';
  static requiresApiKey = false;
  static defaultBaseUrl = null; // Must be configured

  constructor(apiKey, baseUrl, config = {}) {
    this.baseUrl = baseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    if (!this.baseUrl) {
      throw new Error('SearXNG instance URL not configured');
    }

    const maxResults = params.max_results || this.config.max_results || 5;
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    if (params.categories) url.searchParams.set('categories', params.categories);
    if (params.language) url.searchParams.set('language', params.language);

    const resp = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`SearXNG ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return (data.results || []).slice(0, maxResults).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 500),
      content: r.content || null,
      published_date: r.publishedDate || null,
      source: r.url ? new URL(r.url).hostname : '',
      score: r.score ?? null,
    }));
  }
}
