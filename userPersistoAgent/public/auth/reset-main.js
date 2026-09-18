import { mountReset } from './reset.js';

// Standalone reset page entry point:
// <prefix>/service/auth/reset.html#token=...
// The guard lets this module be imported without a DOM, e.g. under node --test.
if (typeof document !== 'undefined') {
    mountReset({
        root: document.querySelector('#auth_content'),
        document,
        fetch: window.fetch.bind(window),
        location: window.location,
        history: window.history,
        navigate: (url) => window.location.assign(url),
    });
}
