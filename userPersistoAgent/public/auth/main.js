import { createSsoAdapter } from './sso-adapter.js';
import { mountWizard } from './wizard.js';

// SSO entry point: the Router serves this page at
// <prefix>/service/auth/?requestId=...&state=...&returnTo=...&notice=...
// The guard lets this module be imported without a DOM, e.g. under node --test.
if (typeof document !== 'undefined') {
    const adapter = createSsoAdapter({
        location: window.location,
        fetch: window.fetch.bind(window),
        navigate: (url) => window.location.assign(url),
    });
    mountWizard({
        root: document.querySelector('#auth_content'),
        document,
        adapter,
        // Blocked storage throws on access; the wizard works without it.
        storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
        credentials: navigator.credentials,
    });
}
