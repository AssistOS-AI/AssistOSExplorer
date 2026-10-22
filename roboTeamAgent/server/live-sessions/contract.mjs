// Live Session producer contract (Explorer DS004 "Live Session sources",
// version 1). RoboTeam validates every row and stream frame against it before
// sending, so one malformed row never makes Explorer drop the whole source.

export const LIVE_STATUSES = Object.freeze(['running', 'waiting', 'reconnecting']);
export const ENDED_STATUSES = Object.freeze(['finished', 'failed', 'stopped', 'lost']);
export const KINDS = Object.freeze(['copilot-turn', 'copilot-task', 'robot-task', 'workflow-phase']);
export const OWNER_STATES = Object.freeze(['verified', 'system', 'unverified']);
export const OUTPUT_STYLES = Object.freeze(['assistant', 'output', 'status', 'user', 'error']);
export const OUTPUT_TEXT_LIMIT = 1024 * 1024;
export const STATUS_TEXT_LIMIT = 1024;
export const MESSAGE_LIMIT = 32768;
export const LIST_LIMIT = 1024;
export const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ROW_REQUIRED = Object.freeze(['id', 'source', 'kind', 'title', 'detail', 'cwdDisplay', 'access', 'status', 'isOwner',
    'ownerLabel', 'viewerCount', 'startedAt', 'lastActivityAt', 'capabilities', 'attach', 'ownerState', 'exit']);
const ROW_OPTIONAL = Object.freeze(['endedAt', 'viewUrl', 'transcriptUrl']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const AGENT_NAME = /^[A-Za-z0-9_-]+$/u;
const encoder = new TextEncoder();

export function byteLength(value) {
    return encoder.encode(value).byteLength;
}

function exactKeys(value, required, optional = []) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && required.every((key) => Object.hasOwn(value, key))
        && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function displayText(value, limit) {
    return typeof value === 'string' && byteLength(value) <= limit && !CONTROL_CHARACTERS.test(value);
}

function timestamp(value) {
    return Number.isSafeInteger(value) && value > 0;
}

// Display text: control characters become spaces and the value is cut to the
// byte limit on a character boundary.
export function cleanText(value, limit) {
    let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ');
    if (byteLength(text) <= limit) return text;
    const characters = Array.from(text);
    let bytes = 0;
    text = '';
    for (const character of characters) {
        const size = byteLength(character);
        if (bytes + size > limit) break;
        bytes += size;
        text += character;
    }
    return text;
}

// The tail of an output chunk that is larger than one frame may carry.
export function tailText(value, limit) {
    const text = String(value ?? '');
    if (byteLength(text) <= limit) return text;
    const characters = Array.from(text);
    let bytes = 0;
    let start = characters.length;
    while (start > 0) {
        const size = byteLength(characters[start - 1]);
        if (bytes + size > limit) break;
        bytes += size;
        start -= 1;
    }
    return characters.slice(start).join('');
}

// Path-only URL under the declaring agent (P2.1 URL rule).
export function isOwnedUrl(value, agent) {
    if (typeof value !== 'string' || typeof agent !== 'string' || !AGENT_NAME.test(agent)
        || !value.startsWith('/') || value.startsWith('//') || /[\s\\?#]/u.test(value)) return false;
    let decoded = value;
    for (let pass = 0; pass < 4; pass += 1) {
        if (/\\|\/\/|%2f|%5c|%2e/iu.test(decoded)
            || decoded.split('/').some((segment) => segment === '.' || segment === '..')) return false;
        let next;
        try { next = decodeURIComponent(decoded); } catch { return false; }
        if (next === decoded) break;
        if (pass === 3 || /[\s?#\u0000-\u001f\u007f]/u.test(next)) return false;
        decoded = next;
    }
    try {
        const url = new URL(value, 'http://h');
        if (url.origin !== 'http://h' || url.pathname !== value || url.search || url.hash) return false;
    } catch { return false; }
    const segments = value.split('/');
    if (segments[1] === agent) return segments.length >= 3 && Boolean(segments[2]);
    if (segments[1] !== 'base-agent-additional-server' || segments[2] !== agent
        || !/^[1-9][0-9]{0,4}$/u.test(segments[3]) || Number(segments[3]) > 65535) return false;
    return segments.length >= 5 && Boolean(segments[4]);
}

export function validExit(exit) {
    return exactKeys(exit, ['reason'], ['code', 'signal']) && displayText(exit.reason, 128) && Boolean(exit.reason)
        && (!Object.hasOwn(exit, 'code') || Number.isSafeInteger(exit.code))
        && (!Object.hasOwn(exit, 'signal') || (displayText(exit.signal, 32) && Boolean(exit.signal)));
}

// Returns null for a valid row, otherwise the first rule it breaks.
export function rowViolation(row, agent) {
    if (!exactKeys(row, ROW_REQUIRED, ROW_OPTIONAL)) return 'keys';
    if (typeof row.id !== 'string' || !RUN_ID.test(row.id)) return 'id';
    if (!displayText(row.source, 128) || !row.source) return 'source';
    if (!KINDS.includes(row.kind)) return 'kind';
    const ended = ENDED_STATUSES.includes(row.status);
    if (!ended && !LIVE_STATUSES.includes(row.status)) return 'status';
    if (!OWNER_STATES.includes(row.ownerState)) return 'ownerState';
    if (typeof row.isOwner !== 'boolean' || (row.isOwner && row.ownerState !== 'verified')) return 'isOwner';
    if (!displayText(row.title, 256) || !row.title) return 'title';
    if (!displayText(row.detail, 256)) return 'detail';
    if (!displayText(row.cwdDisplay, 4096)) return 'cwdDisplay';
    if (!['rw', 'ro'].includes(row.access)) return 'access';
    if (!displayText(row.ownerLabel, 128)) return 'ownerLabel';
    if (!Number.isSafeInteger(row.viewerCount) || row.viewerCount < 0 || row.viewerCount > 64) return 'viewerCount';
    if (!timestamp(row.startedAt) || !timestamp(row.lastActivityAt)) return 'timestamps';
    const capabilities = row.capabilities;
    if (!exactKeys(capabilities, ['watch', 'input', 'stop', 'message']) || capabilities.watch !== true
        || capabilities.input !== false || typeof capabilities.stop !== 'boolean' || typeof capabilities.message !== 'boolean') return 'capabilities';
    if (capabilities.message && (!row.isOwner || row.ownerState !== 'verified' || ended)) return 'message';
    if (!exactKeys(row.attach, ['mode']) || row.attach.mode !== 'event-stream') return 'attach';
    if (ended ? !validExit(row.exit) : row.exit !== null) return 'exit';
    if (Object.hasOwn(row, 'endedAt') && (!ended || !timestamp(row.endedAt))) return 'endedAt';
    for (const key of ['viewUrl', 'transcriptUrl']) if (Object.hasOwn(row, key) && !isOwnedUrl(row[key], agent)) return key;
    return null;
}

// Returns null for a valid stream frame, otherwise the first rule it breaks.
export function frameViolation(event, data) {
    if (event === 'output') {
        if (!exactKeys(data, ['text', 'style']) || typeof data.text !== 'string' || !OUTPUT_STYLES.includes(data.style)) return 'output';
        return byteLength(data.text) > OUTPUT_TEXT_LIMIT ? 'output-size' : null;
    }
    if (event === 'status') {
        if (!exactKeys(data, ['status'], ['text']) || !LIVE_STATUSES.includes(data.status)) return 'status';
        return data.text !== undefined && (typeof data.text !== 'string' || data.text.length > STATUS_TEXT_LIMIT) ? 'status-text' : null;
    }
    if (event === 'exit') return exactKeys(data, ['status', 'exit']) && ENDED_STATUSES.includes(data.status) && validExit(data.exit) ? null : 'exit';
    if (event === 'replay-truncated' || event === 'resync') return exactKeys(data, []) ? null : event;
    return 'event';
}

// One SSE frame. JSON.stringify keeps the data on one line.
export function serializeFrame(event, data, id = null) {
    return `${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
