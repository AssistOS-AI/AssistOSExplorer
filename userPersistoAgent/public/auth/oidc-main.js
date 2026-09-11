import { createOidcAdapter } from './oidc-adapter.js';
import { mountWizard } from './wizard.js';

// OIDC entry point: the interaction page (lib/oidc/http.mjs renderWizard)
// embeds <script type="application/json" id="userpersisto-wizard-config">
// and a no-JS fallback panel inside #auth_content; mounting the wizard
// replaces that fallback the same way every other screen transition does.
if (typeof document !== 'undefined') {
    const config = JSON.parse(document.getElementById('userpersisto-wizard-config').textContent);
    const adapter = createOidcAdapter({
        config,
        document,
        fetch: window.fetch.bind(window),
        navigate: (url) => window.location.assign(url),
        closeWindow: () => window.close(),
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
