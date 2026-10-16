export function observeWorkflow({ url, onFlow, onLog, onResync, onError, fallback,
    ownerDocument = document, ownerWindow = window, EventSourceImpl = globalThis.EventSource }) {
    let source = null, retry = null, polling = null, attempts = 0, disposed = false, suspended = false, fallbackBusy = false;
    async function runFallback() {
        if (fallbackBusy || disposed || suspended || ownerDocument.hidden) return;
        fallbackBusy = true;
        try { await fallback(); } catch (error) { onError(error); }
        finally { fallbackBusy = false; }
    }
    function disconnect() {
        source?.close(); source = null;
        clearTimeout(retry); retry = null; clearInterval(polling); polling = null;
    }
    function backup() {
        if (!polling) polling = setInterval(() => {
            void runFallback();
        }, 30_000);
    }
    function connect() {
        if (disposed || suspended || ownerDocument.hidden || source) return;
        if (!EventSourceImpl) { backup(); return; }
        const connection = new EventSourceImpl(url()); source = connection;
        connection.onopen = () => {
            if (source !== connection) return;
            attempts = 0; clearInterval(polling); polling = null;
        };
        const listen = (name, handle) => connection.addEventListener(name, event => {
            if (source !== connection) return;
            try { handle(JSON.parse(event.data)); } catch (error) { onError(error); }
        });
        listen('snapshot', data => { onFlow(data.flow); void onResync().catch(onError); });
        listen('flow', data => onFlow(data.flow));
        listen('log', onLog);
        listen('log-reset', () => { void onResync().catch(onError); });
        listen('resync', () => { void runFallback(); });
        listen('stream-error', data => onError(new Error(data.message)));
        connection.onerror = () => {
            if (source !== connection) return;
            connection.close(); source = null;
            // Stream renewal and transport retries are background recovery, not
            // workflow failures. Failed fallback reads still report real errors.
            backup();
            retry = setTimeout(() => { retry = null; connect(); }, Math.min(60_000, 5000 * 2 ** Math.min(attempts++, 4)));
        };
    }
    function reconnect() {
        if (source && source.url === url()) return;
        disconnect(); attempts = 0; connect();
    }
    function visibility() { if (ownerDocument.hidden) disconnect(); else connect(); }
    function pagehide() { suspended = true; disconnect(); }
    function pageshow() { suspended = false; connect(); }
    ownerDocument.addEventListener('visibilitychange', visibility);
    ownerWindow.addEventListener('pagehide', pagehide); ownerWindow.addEventListener('pageshow', pageshow);
    connect();
    return { reconnect, get connected() { return source?.readyState === 1; },
        dispose() {
            disposed = true; disconnect();
            ownerDocument.removeEventListener('visibilitychange', visibility);
            ownerWindow.removeEventListener('pagehide', pagehide); ownerWindow.removeEventListener('pageshow', pageshow);
        } };
}
