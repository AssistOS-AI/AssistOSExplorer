const RETRYABLE_MARKETPLACE_HTTP_STATUSES = new Set([502, 503, 504]);

export function isRetryableMarketplaceStatusError(error) {
    const status = Number(error?.status);
    return error?.name !== 'AbortError'
        && (!Number.isFinite(status) || RETRYABLE_MARKETPLACE_HTTP_STATUSES.has(status));
}

export async function fetchMarketplaceSnapshot({
    signal,
    fetchImplementation = globalThis.fetch,
} = {}) {
    const response = await fetchImplementation('/api/marketplace', {
        credentials: 'include',
        cache: 'no-store',
        signal,
        headers: {Accept: 'application/json'},
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok === false || !data?.marketplace) {
        const error = new Error(data?.message || data?.error || `Marketplace request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return data.marketplace;
}
