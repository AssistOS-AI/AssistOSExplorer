import { fetchMarketplaceProof } from './authApi.js';

const ENDPOINT = '/api/marketplace/cache';
const PROOF_ERRORS = new Set(['csrf_invalid', 'browser_csrf_invalid']);

export function cacheAccessDenied(error) {
    return error?.status === 401 || error?.status === 403;
}

export function createCacheApi({
    fetchImplementation = globalThis.fetch,
    expectedOrigin = globalThis.location?.origin,
} = {}) {
    async function request(options) {
        const response = await fetchImplementation(ENDPOINT, {
            credentials: 'include',
            cache: 'no-store',
            ...options,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || payload.ok === false) {
            const message = payload?.message || payload?.error || `Cache request failed (${response.status}).`;
            const failure = Object.assign(new Error(message), { status: response.status, code: payload?.error });
            if (Number.isFinite(payload?.retryAfterSeconds)) failure.retryAfterSeconds = payload.retryAfterSeconds;
            throw failure;
        }
        return payload;
    }

    async function mutate(body, { signal } = {}) {
        async function send() {
            signal?.throwIfAborted();
            const proof = await fetchMarketplaceProof({
                expectedOrigin,
                fetchImplementation: async (url, options) => {
                    const response = await fetchImplementation(url, { ...options, signal });
                    if (!response.ok) {
                        throw Object.assign(new Error(`Cache authorization failed (${response.status}).`), { status: response.status });
                    }
                    return response;
                },
            });
            signal?.throwIfAborted();
            return request({
                method: 'POST',
                signal,
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', [proof.header]: proof.csrfToken },
                body: JSON.stringify(body),
            });
        }
        try {
            return await send();
        } catch (error) {
            if (error.status === 403 && PROOF_ERRORS.has(error.code)) return send();
            throw error;
        }
    }

    return {
        read: ({ signal } = {}) => request({ method: 'GET', signal, headers: { Accept: 'application/json' } }),
        setApplication: ({ agent, enabled, pageSeconds }, options) => mutate({ op: 'set', agent, enabled, pageSeconds }, options),
        purgeHost: ({ host }, options) => mutate({ op: 'purge', host }, options),
        setRoute: ({ agent, path, setting }, options) => mutate({ op: 'route', agent, path, setting }, options),
        checkRoute: ({ agent, path }, options) => mutate({ op: 'check', agent, path }, options),
    };
}
