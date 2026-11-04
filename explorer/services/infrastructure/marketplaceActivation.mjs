import { fetchMarketplaceProof } from './authApi.js';

const ENDPOINT = '/api/marketplace/agents';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TRANSIENT = new Set([502, 503, 504]);

function requestError(response, data) {
    return Object.assign(new Error(data?.message || data?.error || `Marketplace request failed (${response.status})`), { status: response.status });
}

function validOperation(operation, expected, pendingOnly = false) {
    return operation && UUID.test(operation.id) && operation.agentRef === expected.agentRef
        && operation.mode === expected.mode && (!expected.id || operation.id === expected.id)
        && (pendingOnly ? operation.state === 'pending' : ['pending', 'succeeded', 'failed'].includes(operation.state));
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

async function requestJson(url, options, signal, requestTimeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Marketplace request timed out.', 'TimeoutError')), requestTimeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        controller.signal.throwIfAborted();
        return { response, data };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

export async function activateMarketplaceAgent(body, {
    signal, proofFetcher = fetchMarketplaceProof,
    pollIntervalMs = 2_000, requestTimeoutMs = 5_000, observationTimeoutMs = 600_000,
} = {}) {
    const send = async () => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal?.throwIfAborted();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new DOMException('Marketplace request timed out.', 'TimeoutError')), requestTimeoutMs);
        try {
            const proof = await proofFetcher({ fetchImplementation: (url, options) => fetch(url, { ...options, signal: controller.signal }) });
            controller.signal.throwIfAborted();
            return await requestJson(ENDPOINT, {
                method: 'POST', credentials: 'include', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'respond-async', [proof.header]: proof.csrfToken },
                body: JSON.stringify(body),
            }, controller.signal, requestTimeoutMs);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    };
    let { response, data } = await send();
    if (response.status === 403 && ['csrf_invalid', 'browser_csrf_invalid'].includes(data?.error)) {
        ({ response, data } = await send());
    }
    if (!response.ok || data?.ok === false) throw requestError(response, data);
    if (response.status === 200) return data;
    const mode = String(body.mode || body.enableMode || '').trim().toLowerCase();
    const expected = { agentRef: String(body.agentRef || '').trim().split('/').filter(Boolean).join('/'), mode: mode === 'default' ? '' : mode };
    if (response.status !== 202 || data?.ok !== true || data.action !== 'enable_agent' || !validOperation(data.operation, expected, true)) {
        throw new Error('Invalid Marketplace activation receipt.');
    }
    expected.id = data.operation.id;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException('Agent activation observation timed out. Refresh Marketplace to check its state.', 'TimeoutError')), observationTimeoutMs);
    try {
        for (;;) {
            await delay(pollIntervalMs, controller.signal);
            let result;
            try {
                result = await requestJson(`${ENDPOINT}?operation=${encodeURIComponent(expected.id)}`, {
                    credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' },
                }, controller.signal, requestTimeoutMs);
            } catch (error) {
                controller.signal.throwIfAborted();
                if (error instanceof TypeError || error?.name === 'TimeoutError') continue;
                throw error;
            }
            if (TRANSIENT.has(result.response.status)) continue;
            if (!result.response.ok || result.data?.ok !== true) throw requestError(result.response, result.data);
            const operation = result.data.operation;
            if (result.response.status !== 200 || result.data.action !== 'enable_agent' || !validOperation(operation, expected)) {
                throw new Error('Invalid Marketplace operation status.');
            }
            if (operation.state === 'failed') throw new Error(operation.error?.message || 'Agent activation failed.');
            if (operation.state === 'succeeded') return result.data;
        }
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
