export function resolveWorkerPort(environment = process.env) {
    const raw = String(environment.PORT || '').trim();
    if (!/^\d+$/.test(raw)) {
        throw new Error('PORT must be configured as a decimal TCP port.');
    }

    const port = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be between 1 and 65535.');
    }
    return port;
}

export const LIVEKIT_SIGNAL_PATH = '/base-agent-additional-server/liveKitServerAgent/7880/';

// Explorer declares liveKitServerAgent no-wait, and Ploinky launches no-wait
// runtimes only after the foreground and additional agents, this worker
// included, are ready. LiveKit signaling can therefore stay unroutable for
// minutes after a workspace restart. @livekit/agents stops after ten failed
// connections (80 s of backoff) and the process exits; keep retrying at the
// library's capped 10 s interval instead.
export const LIVEKIT_WORKER_MAX_RETRY = Number.MAX_SAFE_INTEGER;

export function resolveLiveKitRouterTransport(environment = process.env) {
    for (const name of ['PLOINKY_ROUTER_URL', 'PLOINKY_ROUTER_REQUEST_AUTHORITY']) {
        if (String(environment[`PLOINKY_ENV_SOURCE_${name}`] || '').trim() !== 'generated') {
            throw new Error(`${name} must be runtime-generated for LiveKit signaling.`);
        }
    }

    const raw = String(environment.PLOINKY_ROUTER_URL || '').trim();
    if (!raw) {
        throw new Error('PLOINKY_ROUTER_URL is required for LiveKit signaling.');
    }

    let routerUrl;
    try {
        routerUrl = new URL(raw);
    } catch {
        throw new Error('PLOINKY_ROUTER_URL must be a valid HTTP URL.');
    }
    if (!['http:', 'https:'].includes(routerUrl.protocol)) {
        throw new Error('PLOINKY_ROUTER_URL must use HTTP or HTTPS.');
    }
    if (routerUrl.pathname !== '/' || routerUrl.search || routerUrl.hash || routerUrl.username || routerUrl.password) {
        throw new Error('PLOINKY_ROUTER_URL must be an exact origin.');
    }

    const requestAuthority = String(environment.PLOINKY_ROUTER_REQUEST_AUTHORITY || '').trim();
    let authorityUrl;
    try {
        authorityUrl = new URL(`http://${requestAuthority}`);
    } catch {
        throw new Error('PLOINKY_ROUTER_REQUEST_AUTHORITY must be a valid HTTP authority.');
    }
    if (!requestAuthority || authorityUrl.host !== requestAuthority || authorityUrl.pathname !== '/') {
        throw new Error('PLOINKY_ROUTER_REQUEST_AUTHORITY must be an exact HTTP authority.');
    }
    return Object.freeze({ routerUrl, requestAuthority, signalPath: LIVEKIT_SIGNAL_PATH });
}

export function bindJobToLiveKitWorkerTransport(context, environment = process.env) {
    const raw = String(environment.LIVEKIT_URL || '').trim();
    let workerUrl;
    try {
        workerUrl = new URL(raw);
    } catch {
        throw new Error('LIVEKIT_URL must identify the local LiveKit Router relay.');
    }
    if (workerUrl.protocol !== 'ws:'
        || workerUrl.hostname !== '127.0.0.1'
        || !workerUrl.port
        || workerUrl.pathname !== LIVEKIT_SIGNAL_PATH
        || workerUrl.search
        || workerUrl.hash) {
        throw new Error('LIVEKIT_URL must identify the exact loopback LiveKit Router relay.');
    }
    if (!context?.info || typeof context.info !== 'object') {
        throw new Error('LiveKit job context does not expose mutable connection information.');
    }
    context.info.url = workerUrl.href;
    return workerUrl.href;
}
import fs from 'node:fs';
