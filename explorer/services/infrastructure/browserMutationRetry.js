// The Router rejects a state-changing browser request whose proof is stale and
// re-mints the proof cookie on that same response, so one immediate resend
// succeeds. A Router or agent restart is the usual cause; the user should not see it.
const STALE_PROOF_ANSWERS = Object.freeze({
    403: 'browser_csrf_invalid',
    503: 'edge_generation_changed',
});

export async function isStaleBrowserProofResponse(response) {
    const expected = STALE_PROOF_ANSWERS[response?.status];
    if (!expected || typeof response.clone !== 'function') {
        return false;
    }
    try {
        // Read a clone so the caller can still consume the returned response.
        const body = await response.clone().json();
        return body?.error === expected;
    } catch (_) {
        return false;
    }
}

// `send` builds and issues the request afresh on every call, so a header copied
// from the cookie is read again and a File, Blob or string body is passed again.
// Never pass a one-shot stream body. The second response is returned as it is.
// The first call is made synchronously, so a synchronous throw from `send`
// reaches the caller exactly as it would without this wrapper.
export function retryOnStaleBrowserProof(send) {
    return Promise.resolve(send()).then(async (response) => {
        if (!await isStaleBrowserProofResponse(response)) {
            return response;
        }
        return send();
    });
}
