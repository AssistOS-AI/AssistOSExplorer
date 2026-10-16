/**
 * Built-in middleware: Token Tracker
 *
 * Records token usage in an in-memory sliding window per API key.
 */

export const meta = Object.freeze({
    key: 'token-tracker',
    name: 'Token Tracker',
    description: 'Records token usage (TPM) per API key after each response.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        windowMs: 60_000,
    }),
});

const _tpm = new Map();

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };
    const windowMs = merged.windowMs || 60_000;

    return async function tokenTracker(ctx, next) {
        await next();

        const usage = ctx.response?.usage ?? ctx.usage;
        const totalTokens = usage?.total_tokens ?? usage?.totalTokens ?? 0;
        if (totalTokens <= 0) {
            return;
        }

        const apiKey = ctx.auth?.keyId || 'anonymous';
        const now = Date.now();
        let entries = _tpm.get(apiKey);
        if (!entries) {
            entries = [];
            _tpm.set(apiKey, entries);
        }

        entries.push({ ts: now, tokens: totalTokens });
        const cutoff = now - windowMs;
        while (entries.length > 0 && entries[0].ts <= cutoff) {
            entries.shift();
        }

        const currentTpm = entries.reduce((sum, entry) => sum + entry.tokens, 0);
        ctx.log.debug('Token usage recorded', {
            keyId: apiKey,
            tokens: totalTokens,
            tpm: currentTpm,
        });
    };
}

export function _resetTpm() {
    _tpm.clear();
}

export function _getTpm(apiKey) {
    return _tpm.get(apiKey) || [];
}
