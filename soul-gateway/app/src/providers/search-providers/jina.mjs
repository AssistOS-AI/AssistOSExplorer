export default class JinaProvider {
  static type = 'jina';
  static requiresApiKey = false;
  static defaultBaseUrl = 'https://s.jina.ai/';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || JinaProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const url = this.baseUrl + encodeURIComponent(query);
    const headers = {
      'Accept': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Jina API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const results = data.data || [];
    return results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.description || r.content || '').slice(0, 500),
      content: r.content || null,
      published_date: null,
      source: r.url ? new URL(r.url).hostname : '',
      score: null,
    }));
  }
}
