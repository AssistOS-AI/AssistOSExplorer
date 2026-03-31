export default class DuckDuckGoProvider {
  static type = 'duckduckgo';
  static requiresApiKey = false;
  static defaultBaseUrl = 'https://html.duckduckgo.com/html/';

  constructor(apiKey, baseUrl, config = {}) {
    this.baseUrl = baseUrl || DuckDuckGoProvider.defaultBaseUrl;
    this.config = config;
  }

  async search(query, params = {}) {
    const maxResults = params.max_results || this.config.max_results || 5;

    const resp = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: `q=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      throw new Error(`DuckDuckGo ${resp.status}`);
    }

    const html = await resp.text();
    return this._parseHtml(html, maxResults);
  }

  _parseHtml(html, maxResults) {
    const results = [];
    // Match result blocks: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
      const url = this._decodeUrl(links[i][1]);
      const title = this._stripHtml(links[i][2]);
      const snippet = i < snippets.length ? this._stripHtml(snippets[i][1]) : '';

      if (url && title) {
        let source = '';
        try { source = new URL(url).hostname; } catch {}
        results.push({
          title,
          url,
          snippet,
          content: null,
          published_date: null,
          source,
          score: null,
        });
      }
    }
    return results;
  }

  _decodeUrl(uddgUrl) {
    // DuckDuckGo wraps URLs: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    if (uddgUrl.includes('uddg=')) {
      const match = uddgUrl.match(/uddg=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
    return uddgUrl;
  }

  _stripHtml(html) {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
