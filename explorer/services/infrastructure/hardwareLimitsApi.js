import { fetchMarketplaceProof } from './authApi.js';

const ENDPOINT = '/api/marketplace/hardware-limits';
const PROOF_ERRORS = new Set(['csrf_invalid', 'browser_csrf_invalid']);

export class HardwareLimitsError extends Error {
    constructor(payload = {}, status = 0) {
        super(String(payload.message || payload.error || `Hardware limits request failed (${status}).`).slice(0, 2048));
        this.name = 'HardwareLimitsError';
        this.status = status;
        this.code = String(payload.error || '').slice(0, 128);
        this.fix = String(payload.fix || '').slice(0, 2048);
        this.hardwareOutcome = payload.hardwareOutcome || null;
        this.committed = payload.committed === true;
        this.token = payload.token || null;
    }
}

export function hardwareAccessDenied(error) {
    return error?.status === 401 || error?.status === 403 || error?.code === 'not_in_box';
}

export function createHardwareLimitsApi({
    fetchImplementation = globalThis.fetch,
    expectedOrigin = globalThis.location?.origin,
} = {}) {
    async function read({ signal } = {}) {
        const response = await fetchImplementation(ENDPOINT, {
            signal,
            credentials: 'include',
            cache: 'no-store',
            headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) throw new HardwareLimitsError(payload, response.status);
        return payload;
    }

    async function mutate(body, { signal } = {}) {
        async function send() {
            signal?.throwIfAborted();
            let proofStatus = 0;
            let proof;
            try {
                proof = await fetchMarketplaceProof({
                    expectedOrigin,
                    fetchImplementation: async (...args) => {
                        const response = await fetchImplementation(...args);
                        proofStatus = response.status;
                        return response;
                    },
                });
            } catch (error) {
                throw new HardwareLimitsError({ error: proofStatus === 401 ? 'not_authenticated' : proofStatus === 403 ? 'admin_required' : 'proof_unavailable', message: error.message }, proofStatus);
            }
            signal?.throwIfAborted();
            const response = await fetchImplementation(ENDPOINT, {
                signal,
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', [proof.header]: proof.csrfToken },
                body: JSON.stringify(body),
            });
            return { response, payload: await response.json().catch(() => ({})) };
        }
        let result = await send();
        if (result.response.status === 403 && PROOF_ERRORS.has(result.payload.error)) result = await send();
        if (!result.response.ok || result.payload.ok === false) {
            throw new HardwareLimitsError(result.payload, result.response.status);
        }
        return result.payload;
    }

    return {
        read,
        set: (expectedToken, agentRef, limits, options) => mutate({ action: 'set_agent_limits', expectedToken, agentRef, limits }, options),
        clear: (expectedToken, agentRef, options) => mutate({ action: 'clear_agent_limits', expectedToken, agentRef }, options),
        apply: (expectedToken, containers = [], options) => mutate({ action: 'apply', expectedToken, containers }, options),
    };
}
