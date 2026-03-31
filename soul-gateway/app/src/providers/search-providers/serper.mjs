export default class SerperProvider {
  static type = 'serper';
  static requiresApiKey = true;
  static defaultBaseUrl = 'https://google.serper.dev/search';

  constructor(apiKey, baseUrl, config = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || SerperProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const body = {
      q: query,
      num: params.max_results || this.config.max_results || 5,
    };
    if (params.gl) body.gl = params.gl;
    if (params.hl) body.hl = params.hl;

    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Serper API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    return (data.organic || []).map(r => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
      content: null,
      published_date: r.date || null,
      source: r.link ? new URL(r.link).hostname : '',
      score: r.position ? (1 / r.position) : null,
    }));
  }
}
