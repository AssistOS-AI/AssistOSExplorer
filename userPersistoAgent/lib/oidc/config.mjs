export const OIDC_SERVICE_PATH = '/service/oidc';

export function oidcIssuer() {
    const raw = String(process.env.USERPERSISTO_OIDC_ISSUER || '').trim();
    if (!raw) return null;
    let url;
    try { url = new URL(raw); } catch { throw new Error('USERPERSISTO_OIDC_ISSUER must be an absolute URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash
        || !url.pathname.endsWith(OIDC_SERVICE_PATH)
        || url.href !== raw) {
        throw new Error('USERPERSISTO_OIDC_ISSUER must be a canonical HTTPS URL ending in /service/oidc (HTTP is allowed only on loopback).');
    }
    return url;
}
