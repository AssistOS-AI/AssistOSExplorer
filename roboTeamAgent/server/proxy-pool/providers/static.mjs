import crypto from 'node:crypto';

const MAX_PROXIES = 500;

function parseLine(line, index) {
    const [address, country] = line.split(/\s+/u);
    let url;
    try { url = new URL(address); } catch { throw new Error(`proxy list line ${index + 1} is not a URL`); }
    if (url.protocol !== 'http:') throw new Error(`proxy list line ${index + 1} must use http://`);
    if (!url.hostname || !url.port) throw new Error(`proxy list line ${index + 1} needs a host and a port`);
    if (country && !/^[A-Za-z]{2}$/u.test(country)) throw new Error(`proxy list line ${index + 1} has an invalid country code`);
    return {
        scheme: 'http',
        host: url.hostname,
        port: Number(url.port),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        country: country ? country.toUpperCase() : null,
    };
}

// A fixed list pasted by an administrator: any provider without an API, or with one RoboTeam
// does not implement yet. One `http://user:pass@host:port [CC]` entry per line.
export default {
    id: 'static',
    label: 'Manual list',
    fields: [{ name: 'proxies', label: 'Proxies, one per line: http://user:pass@host:port [country]', secret: true, multiline: true }],

    normalizeConfig(input) {
        const lines = String(input?.proxies || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
        if (!lines.length) throw new Error('proxy list is required');
        if (lines.length > MAX_PROXIES) throw new Error(`proxy list holds at most ${MAX_PROXIES} entries`);
        lines.forEach(parseLine);
        return { proxies: lines.join('\n') };
    },

    describeConfig(config) {
        const count = config.proxies.split('\n').length;
        return `${count} ${count === 1 ? 'proxy' : 'proxies'}`;
    },

    async listProxies(config) {
        return config.proxies.split('\n').map((line, index) => {
            const proxy = parseLine(line, index);
            // The id is stored in clear, so it names the entry without carrying its username.
            const externalId = crypto.createHash('sha256').update(`${proxy.host}\0${proxy.port}\0${proxy.username}`).digest('hex').slice(0, 32);
            return { ...proxy, externalId, city: null, available: true };
        });
    },
};
