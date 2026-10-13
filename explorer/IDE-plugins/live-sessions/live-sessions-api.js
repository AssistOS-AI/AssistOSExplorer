import { readBrowserCsrfToken } from '../../web-components/modals/terminal-target-modal/terminal-target-modal.js';
import { isOwnedLiveSessionUrl, normalizeLiveSessionSource } from '../../utils/liveSessionSource.mjs';

const LIST_PATH = '/webtty/live-sessions';
const SESSION_ID = /^[A-Za-z0-9_-]{32,128}$/;
const ATTACH_TOKEN = /^[A-Za-z0-9_-]{32}$/;
const ROW_KEYS = [
    'id', 'source', 'kind', 'title', 'detail', 'cwdDisplay', 'access', 'status',
    'isOwner', 'ownerLabel', 'viewerCount', 'startedAt', 'lastActivityAt', 'capabilities', 'attach',
];

function exactKeys(value, required, optional = []) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function displayText(value, limit) {
    return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= limit
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function timestamp(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function sessionId(value) {
    if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid live session identifier.');
    return value;
}

export function normalizeLiveSessionsPayload(payload) {
    if (!exactKeys(payload, ['ok', 'version', 'sessions']) || payload.ok !== true || payload.version !== 1
        || !Array.isArray(payload.sessions)) throw new Error('Invalid live sessions response.');
    const ids = new Set();
    const sessions = payload.sessions.map((row) => {
        if (!exactKeys(row, ROW_KEYS, ['endedAt', 'exitReason'])
            || row.source !== 'webtty' || row.kind !== 'shell' || !['rw', 'ro'].includes(row.access)
            || !['attached', 'detached', 'exited'].includes(row.status)
            || typeof row.isOwner !== 'boolean'
            || !displayText(row.title, 256) || !row.title
            || !displayText(row.detail, 256) || !displayText(row.cwdDisplay, 4096)
            || !displayText(row.ownerLabel, 128)
            || !Number.isSafeInteger(row.viewerCount) || row.viewerCount < 0 || row.viewerCount > 8
            || !timestamp(row.startedAt) || !timestamp(row.lastActivityAt)
            || !exactKeys(row.capabilities, ['watch', 'input', 'stop', 'message'])
            || row.capabilities.watch !== true || row.capabilities.input !== row.isOwner
            || row.capabilities.stop !== true || row.capabilities.message !== false
            || !exactKeys(row.attach, ['mode']) || row.attach.mode !== 'webtty'
            || (Object.hasOwn(row, 'endedAt') && (row.status !== 'exited' || !timestamp(row.endedAt)))
            || (Object.hasOwn(row, 'exitReason') && (row.status !== 'exited' || !displayText(row.exitReason, 128)))) {
            throw new Error('Invalid live session row.');
        }
        const id = sessionId(row.id);
        if (ids.has(id)) throw new Error('Duplicate live session identifier.');
        ids.add(id);
        return Object.freeze({
            ...row,
            capabilities: Object.freeze({ ...row.capabilities }),
            attach: Object.freeze({ ...row.attach }),
        });
    });
    return Object.freeze(sessions);
}

async function request(path, method, options = {}) {
    const response = await (options.fetchImpl || globalThis.fetch)(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
        ...(method === 'GET' ? {} : {
            headers: {
                'Content-Type': 'application/json',
                'X-Ploinky-Browser-CSRF-Token': readBrowserCsrfToken(),
            },
            ...(method === 'POST' ? { body: JSON.stringify(options.body || {}) } : {}),
        }),
    });
    if (!response.ok) {
        // HTTP status is enough to show a safe error, including older routers' HTML 404s.
        throw Object.assign(new Error('The live session request failed.'), { status: response.status });
    }
    try {
        return await response.json();
    } catch (_) {
        throw new Error('Invalid live session response.');
    }
}

const AGENT_KINDS = ['copilot-turn', 'copilot-task', 'robot-task', 'workflow-phase'];
export const AGENT_STATUSES = ['running', 'waiting', 'reconnecting', 'finished', 'failed', 'stopped', 'lost'];
export const ENDED_STATUSES = ['finished', 'failed', 'stopped', 'lost'];

export function validAgentExit(exit) {
    return exactKeys(exit, ['reason'], ['code', 'signal']) && displayText(exit.reason, 128)
        && (!Object.hasOwn(exit, 'code') || Number.isSafeInteger(exit.code))
        && (!Object.hasOwn(exit, 'signal') || displayText(exit.signal, 32));
}

export function normalizeAgentSessionsPayload(payload, source) {
    if (!normalizeLiveSessionSource(source?.liveSessions, source?.agent)
        || !exactKeys(payload, ['ok', 'version', 'sessions']) || payload.ok !== true
        || payload.version !== 1 || !Array.isArray(payload.sessions) || payload.sessions.length > 1024) {
        throw new Error('Invalid live sessions response.');
    }
    const ids = new Set();
    return payload.sessions.map((row) => {
        const ended = ENDED_STATUSES.includes(row?.status);
        if (!exactKeys(row, [...ROW_KEYS, 'ownerState', 'exit'], ['endedAt', 'viewUrl', 'transcriptUrl'])
            || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id)
            || !displayText(row.source, 128) || !row.source || !AGENT_KINDS.includes(row.kind)
            || !AGENT_STATUSES.includes(row.status) || !['verified', 'system', 'unverified'].includes(row.ownerState)
            || (row.isOwner && row.ownerState !== 'verified')
            || !displayText(row.title, 256) || !row.title || !displayText(row.detail, 256)
            || !displayText(row.cwdDisplay, 4096) || !['rw', 'ro'].includes(row.access)
            || !displayText(row.ownerLabel, 128) || typeof row.isOwner !== 'boolean'
            || !Number.isSafeInteger(row.viewerCount) || row.viewerCount < 0 || row.viewerCount > 64
            || !timestamp(row.startedAt) || !timestamp(row.lastActivityAt)
            || !exactKeys(row.capabilities, ['watch', 'input', 'stop', 'message'])
            || row.capabilities.watch !== true || row.capabilities.input !== false
            || typeof row.capabilities.stop !== 'boolean' || typeof row.capabilities.message !== 'boolean'
            || (row.capabilities.message && (!row.isOwner || row.ownerState !== 'verified' || ended))
            || !exactKeys(row.attach, ['mode']) || row.attach.mode !== 'event-stream'
            || (ended ? !validAgentExit(row.exit) : row.exit !== null)
            || (Object.hasOwn(row, 'endedAt') && (!ended || !timestamp(row.endedAt)))
            || ['viewUrl', 'transcriptUrl'].some((key) => Object.hasOwn(row, key) && !isOwnedLiveSessionUrl(row[key], source.agent))) {
            throw new Error('Invalid live session row.');
        }
        if (ids.has(row.id)) throw new Error('Duplicate live session identifier.');
        ids.add(row.id);
        return Object.freeze({ ...row, capabilities: Object.freeze({ ...row.capabilities }), attach: Object.freeze({ ...row.attach }) });
    });
}

export function discoverLiveSessionSources(appPlugins = {}) {
    const seen = new Set();
    return (appPlugins['live-sessions:source'] || []).filter((source) => {
        const config = normalizeLiveSessionSource(source?.liveSessions, source?.agent);
        if (source?.contributionType !== 'live-sessions-source' || !config || seen.has(config.base)) return false;
        seen.add(config.base);
        return true;
    });
}

export async function aggregateLiveSessions(sources, { admin = false, signal, fetchImpl, onResult } = {}) {
    const entries = [...(admin ? [{ agent: 'webtty', label: 'Terminals', shell: true }] : []),
        ...sources.filter((source) => normalizeLiveSessionSource(source?.liveSessions, source?.agent))];
    return Promise.all(entries.map(async (source) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let timer;
        try {
            const timeout = new Promise((_, reject) => {
                controller.signal.addEventListener('abort', () => reject(new Error('Live session source timed out or closed.')), { once: true });
                timer = setTimeout(abort, 5000);
                if (controller.signal.aborted) reject(new Error('Live session source closed.'));
            });
            const options = { signal: controller.signal, fetchImpl };
            const rows = await Promise.race([timeout, source.shell ? listLiveSessions(options) :
                request(source.liveSessions.base, 'GET', options).then((payload) => normalizeAgentSessionsPayload(payload, source))]);
            const result = { source, rows };
            if (!signal?.aborted) onResult?.(result);
            return result;
        } catch (error) {
            const result = !source.shell && [401, 403].includes(error.status)
                ? { source, rows: [] } : { source, rows: [], error };
            if (!signal?.aborted) onResult?.(result);
            return result;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }));
}

export function agentSessionPath(source, id, action) {
    const config = normalizeLiveSessionSource(source?.liveSessions, source?.agent);
    if (!config || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['stream', 'messages', 'stop'].includes(action)) {
        throw new Error('Invalid live session request.');
    }
    return `${config.base}/${id}/${action}`;
}

export async function stopAgentSession(source, row, options = {}) {
    if (!row.capabilities.stop) throw new Error('Stop is unavailable.');
    const payload = await request(agentSessionPath(source, row.id, 'stop'), 'POST', options);
    if (!exactKeys(payload, ['ok']) || payload.ok !== true) throw new Error('Invalid stop response.');
}

export async function messageAgentSession(source, row, message, options = {}) {
    if (!row.isOwner || !row.capabilities.message || typeof message !== 'string' || message.length < 1 || message.length > 32768) {
        throw new Error('Message is unavailable or invalid.');
    }
    const response = await (options.fetchImpl || globalThis.fetch)(agentSessionPath(source, row.id, 'messages'), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: options.signal,
        headers: { 'Content-Type': 'application/json', 'X-Ploinky-Browser-CSRF-Token': readBrowserCsrfToken() },
        body: JSON.stringify({ message }),
    });
    const payload = await response.json();
    if (response.status === 200 && exactKeys(payload, ['delivery']) && ['delivered', 'queued'].includes(payload.delivery)) return payload.delivery;
    if (response.status === 409 && exactKeys(payload, ['error'], ['detail']) && ['rejected', 'run_ended'].includes(payload.error)) return payload.error;
    if (response.status === 504 && exactKeys(payload, ['error']) && payload.error === 'delivery_unknown') return 'unknown';
    throw Object.assign(new Error('The live session message failed.'), { status: response.status });
}

export function navigateLiveSessionWindow(popup, url, agent) {
    try {
        if (!isOwnedLiveSessionUrl(url, agent) || !popup || popup.closed || popup.opener !== null) throw new Error('Unsafe popup.');
        const anchor = popup.document.createElement('a');
        anchor.href = url;
        anchor.target = '_self';
        anchor.rel = 'noopener noreferrer';
        anchor.referrerPolicy = 'no-referrer';
        popup.document.body.appendChild(anchor);
        anchor.click();
        return popup;
    } catch {
        try { popup?.close?.(); } catch {}
        return null;
    }
}

export async function listLiveSessions(options = {}) {
    return normalizeLiveSessionsPayload(await request(LIST_PATH, 'GET', options));
}

export async function mintLiveSessionAttach(id, options = {}) {
    const payload = await request(`${LIST_PATH}/${sessionId(id)}/attach-tokens`, 'POST', options);
    if (!exactKeys(payload, ['ok', 'attach', 'expiresAt']) || payload.ok !== true
        || typeof payload.attach !== 'string' || !ATTACH_TOKEN.test(payload.attach)
        || !timestamp(payload.expiresAt) || payload.expiresAt <= Date.now()) {
        throw new Error('Invalid live session attachment response.');
    }
    return payload.attach;
}

export async function killLiveSession(id, options = {}) {
    const payload = await request(`/webtty/sessions/${sessionId(id)}`, 'DELETE', options);
    if (!exactKeys(payload, ['ok']) || payload.ok !== true) throw new Error('Invalid live session Kill response.');
}
