import https from 'node:https';
import tls from 'node:tls';
import { proxyAuthorization } from './proxy-relay.mjs';
import { fallbackLocaleProfile, localeProfileFromLookup } from './locale-profile.mjs';

const LOOKUP_HOST = 'ipwho.is';
const LOOKUP_TIMEOUT_MS = 20000;

// Asks a geolocation service through the proxy, so the answer describes the address websites see
// and never the host's own address. A missing, refused or unreadable answer is the neutral profile
// and is not cached, so the next start tries again; the lookup never fails the workstation start.
export function lookupExitLocale(proxy, exitIp, { timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
    const fallback = { ...fallbackLocaleProfile(), unresolved: true };
    if (!exitIp || !proxy) return Promise.resolve(fallback);
    return new Promise((resolve) => {
        const finish = (profile) => { clearTimeout(timer); resolve(profile); };
        const authorization = proxyAuthorization(proxy);
        const timer = setTimeout(() => { request.destroy(); finish(fallback); }, timeoutMs);
        const request = https.request({
            host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${LOOKUP_HOST}:443`, agent: false,
            headers: { host: `${LOOKUP_HOST}:443`, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
        });
        request.once('connect', (response, socket) => {
            if (response.statusCode !== 200) { socket.destroy(); return finish(fallback); }
            const lookup = https.get({
                host: LOOKUP_HOST, path: `/${encodeURIComponent(exitIp)}`, agent: false,
                createConnection: () => tls.connect({ socket, servername: LOOKUP_HOST }),
            }, (reply) => {
                let body = '';
                reply.setEncoding('utf8');
                reply.on('data', (chunk) => { body = `${body}${chunk}`.slice(0, 65536); });
                reply.once('end', () => {
                    socket.destroy();
                    try {
                        const parsed = JSON.parse(body);
                        finish(parsed?.success === false ? fallback : localeProfileFromLookup(parsed, proxy.country));
                    } catch { finish(fallback); }
                });
            });
            lookup.once('error', () => { socket.destroy(); finish(fallback); });
        });
        request.once('error', () => finish(fallback));
        request.end();
    });
}
