const API_ROOT = 'https://proxy.webshare.io/api/v2';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30000;

async function webshareGet(config, pathAndQuery, fetchImpl) {
    const response = await fetchImpl(`${API_ROOT}${pathAndQuery}`, {
        headers: { authorization: `Token ${config.apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error('Webshare rejected the API key'), { credentialsRejected: true });
    }
    if (!response.ok) throw new Error(`Webshare API answered ${response.status}`);
    return response.json();
}

// Webshare direct-mode proxy lists. Each entry carries its own address and credentials.
export default {
    id: 'webshare',
    label: 'Webshare',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],

    normalizeConfig(input) {
        const apiKey = String(input?.apiKey || '').trim();
        if (!/^[A-Za-z0-9_-]{8,256}$/u.test(apiKey)) throw new Error('Webshare API key is invalid');
        return { apiKey };
    },

    describeConfig(config) {
        return `API key …${config.apiKey.slice(-4)}`;
    },

    async listProxies(config, { fetchImpl = fetch } = {}) {
        const proxies = [];
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await webshareGet(config, `/proxy/list/?mode=direct&page=${page}&page_size=${PAGE_SIZE}`, fetchImpl);
            for (const entry of Array.isArray(body?.results) ? body.results : []) {
                proxies.push({
                    externalId: String(entry.id),
                    scheme: 'http',
                    host: String(entry.proxy_address || ''),
                    port: Number(entry.port),
                    username: String(entry.username || ''),
                    password: String(entry.password || ''),
                    country: entry.country_code ? String(entry.country_code).toUpperCase() : null,
                    city: entry.city_name ? String(entry.city_name) : null,
                    available: entry.valid !== false,
                });
            }
            if (!body?.next) break;
        }
        return proxies;
    },
};
