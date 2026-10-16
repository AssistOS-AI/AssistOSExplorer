/**
 * Built-in middleware: Rate Limiter
 *
 * Enforces a simple in-memory sliding-window RPM limit per API key.
 */

export const meta = Object.freeze({
    key: 'rate-limiter',
    name: 'Rate Limiter',
    description:
        'Sliding-window RPM rate limiter. Blocks requests that exceed the configured limit.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        overrideRpmLimit: null,
        windowMs: 60_000,
    }),
});

const _windows = new Map();

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const windowMs = merged.windowMs || 60_000;

    return async function rateLimiter(ctx, next) {
        const apiKey = ctx.auth?.keyId || 'anonymous';
        const now = Date.now();
        const rpmLimit =
            merged.overrideRpmLimit ??
            ctx.auth?.rpmLimit ??
            ctx.appCtx?.config?.env?.DEFAULT_RPM_LIMIT ??
            60;

        let timestamps = _windows.get(apiKey);
        if (!timestamps) {
            timestamps = [];
            _windows.set(apiKey, timestamps);
        }

        const cutoff = now - windowMs;
        while (timestamps.length > 0 && timestamps[0] <= cutoff) {
            timestamps.shift();
        }

        if (timestamps.length >= rpmLimit) {
            const retryAfter = Math.ceil((timestamps[0] + windowMs - now) / 1000);
            ctx.log.warn('Rate limit exceeded', {
                keyId: apiKey,
                rpm: timestamps.length,
                limit: rpmLimit,
                retryAfterSeconds: retryAfter,
            });
            ctx.abort.error(
                429,
                `Rate limit exceeded: ${timestamps.length}/${rpmLimit} RPM`
            );
        }

        timestamps.push(now);
        await next();
    };
}

export function _resetWindows() {
    _windows.clear();
}

export function _getWindow(key) {
    return _windows.get(key) || [];
}
