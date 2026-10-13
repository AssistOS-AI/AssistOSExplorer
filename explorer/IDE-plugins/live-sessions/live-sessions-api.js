import { readBrowserCsrfToken } from '../../web-components/modals/terminal-target-modal/terminal-target-modal.js';

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
            ...(method === 'POST' ? { body: '{}' } : {}),
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
