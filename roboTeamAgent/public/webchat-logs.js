import { renderLog } from './log-render.js';

const status = document.querySelector('#requestLogStatus');
const container = document.querySelector('#requestLog');

function requestIds() {
    const match = location.pathname.match(/\/webchat-logs\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/?$/i);
    return match ? { sessionId: match[1], messageId: match[2] } : null;
}

async function load() {
    const ids = requestIds();
    if (!ids) {
        renderLog(container, 'Request logs are unavailable.', '');
        return;
    }
    try {
        const url = new URL(`api/webchat/logs/${encodeURIComponent(ids.sessionId)}/${encodeURIComponent(ids.messageId)}`, document.baseURI);
        const response = await fetch(url, { credentials: 'include', headers: { accept: 'text/plain' } });
        if (response.status === 404) {
            status.textContent = 'No logs were recorded for this request.';
            renderLog(container, '', '');
            return;
        }
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        const log = await response.text();
        const offset = Number(response.headers.get('x-log-final-offset') ?? -1);
        const length = Number(response.headers.get('x-log-final-length') ?? 0);
        const finalResponse = Number.isSafeInteger(offset) && Number.isSafeInteger(length)
            && offset >= 0 && length > 0 && offset + length <= log.length
            ? log.slice(offset, offset + length) : '';
        renderLog(container, log, finalResponse);
    } catch (error) {
        status.textContent = '';
        renderLog(container, error.message, '');
    }
}

void load();
