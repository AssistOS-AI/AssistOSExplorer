export default class BraveProvider {
  static type = 'brave';
  static requiresApiKey = true;
  static defaultBaseUrl = 'https://api.search.brave.com/res/v1/web/search';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || BraveProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const count = params.max_results || this.config.max_results || 5;
    const url = new URL(this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    if (params.freshness) url.searchParams.set('freshness', params.freshness);
    if (params.country) url.searchParams.set('country', params.country);

    const resp = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Brave API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const results = data.web?.results || [];
    return results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
      content: r.extra_snippets?.join('\n') || null,
      published_date: r.age || null,
      source: r.url ? new URL(r.url).hostname : '',
      score: null,
    }));
  }
}
