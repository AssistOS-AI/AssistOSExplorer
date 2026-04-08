/**
 * Parse a Cookie header into a plain object.
 */
export function parseCookies(header) {
    if (!header) return {};
    const cookies = {};
    for (const pair of header.split(';')) {
        const idx = pair.indexOf('=');
        if (idx < 0) continue;
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        cookies[key] = decodeURIComponent(val);
    }
    return cookies;
}
