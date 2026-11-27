import { readBrowserCsrfToken } from '../terminal-target-modal/terminal-target-modal.js';
import { retryOnStaleBrowserProof } from '../../../services/infrastructure/browserMutationRetry.js';

export async function codingSessionsRequest(action, dir, values = {}, { signal, fetchImpl = globalThis.fetch } = {}) {
    const response = await retryOnStaleBrowserProof(() => fetchImpl('/webtty/coding-sessions', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', 'X-Ploinky-Browser-CSRF-Token': readBrowserCsrfToken() },
        body: JSON.stringify({ action, dir, ...values }),
    }));
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) {
        throw new Error(response.status === 403 ? 'Administrator access is required.'
            : body.message || 'Coding sessions are unavailable. Refresh and try again.');
    }
    return body;
}
