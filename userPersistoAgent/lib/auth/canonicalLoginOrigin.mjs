import { assertRedirectUriAllowed } from '../policy.mjs';
import { getGoogleStatus } from './google.mjs';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The private Router bridge asks before creating either provider or Router
// state. Restarting on the configured origin gives all browser proofs one host.
export async function getCanonicalLoginOrigin(redirectUri) {
    const callback = new URL(await assertRedirectUriAllowed(redirectUri));
    if (!LOOPBACK_HOSTS.has(callback.hostname) || callback.pathname !== '/auth/callback'
        || callback.search || callback.hash) return null;

    const google = await getGoogleStatus();
    if (!google.available) return null;
    const configured = new URL(google.redirectUri);
    if (!LOOPBACK_HOSTS.has(configured.hostname) || configured.origin === callback.origin
        || configured.protocol !== callback.protocol || configured.port !== callback.port) return null;

    return configured.origin;
}
