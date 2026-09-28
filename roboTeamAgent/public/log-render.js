// Shared log renderer used by the workflow phase log and the WebChat request
// log. It highlights inline code, file paths and service links.
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const LOG_STREAM_PREFIX_RE = /^\[([^\]]+)\s+(stdout|stderr)\]\s?/i;
const LOG_INLINE_CODE_RE = /`[^`\r\n]+`/gu;
const LOG_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\/|~\/|\.{1,2}\/)[^\s"'`<>|]+|[\p{L}\p{N}_+.-]+(?:[\\/][\p{L}\p{N}_+.@-]+)+(?::\d+(?::\d+)?)?)/gu;
const LOG_FILE_RE = /(?:^|[\s([{<"'`])([\p{L}\p{N}_+-]+\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|htm|html|java|jpeg|jpg|js|json|jsx|log|md|mdx|mjs|pdf|php|png|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|webp|xml|yaml|yml)(?::\d+(?::\d+)?)?)(?=$|[\s)\]}>.,'";!?`])/giu;
const LOG_TRAILING_PUNCTUATION_RE = /[),.;!?}\]]+$/u;
const LOG_MARKDOWN_LINK_RE = /\[([^\]\r\n]+)\]\(([^)\s]+)\)/gu;
const LOG_SERVICE_PATH_RE = /(^|\s)(\/base-agent-additional-server\/[A-Za-z0-9/_-]+)(?=\s|$)/gu;

function addLogHighlight(matches, start, end, kind) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
    if (matches.some(match => start < match.end && end > match.start)) return;
    matches.push({ start, end, kind });
}

function logPathLength(value) {
    const trimmed = value.replace(LOG_TRAILING_PUNCTUATION_RE, '');
    if (!trimmed) return 0;
    if (trimmed.startsWith('/') && !trimmed.slice(1).includes('/')
        && !/\.[\p{L}\p{N}]{1,10}(?::\d+(?::\d+)?)?$/u.test(trimmed)) return 0;
    return trimmed.length;
}

function logTokens(text) {
    const matches = [];
    let match;
    LOG_INLINE_CODE_RE.lastIndex = 0;
    while ((match = LOG_INLINE_CODE_RE.exec(text))) addLogHighlight(matches, match.index, match.index + match[0].length, 'code');
    LOG_PATH_RE.lastIndex = 0;
    while ((match = LOG_PATH_RE.exec(text))) {
        const length = logPathLength(match[0]);
        addLogHighlight(matches, match.index, match.index + length, 'path');
    }
    LOG_FILE_RE.lastIndex = 0;
    while ((match = LOG_FILE_RE.exec(text))) {
        const start = match.index + match[0].indexOf(match[1]);
        addLogHighlight(matches, start, start + match[1].length, 'path');
    }
    matches.sort((left, right) => left.start - right.start);
    const tokens = [];
    let cursor = 0;
    for (const highlight of matches) {
        if (highlight.start > cursor) tokens.push({ text: text.slice(cursor, highlight.start), kind: null });
        tokens.push({ text: text.slice(highlight.start, highlight.end), kind: highlight.kind });
        cursor = highlight.end;
    }
    if (cursor < text.length) tokens.push({ text: text.slice(cursor), kind: null });
    return tokens.length ? tokens : [{ text, kind: null }];
}

function tokenFragments(text) {
    return logTokens(text).map(token => {
        if (!token.kind) return document.createTextNode(token.text);
        const span = element('span', token.text);
        span.className = `phase-log-token is-${token.kind}`;
        return span;
    });
}

function safeLogUrl(raw) {
    try {
        const url = new URL(raw, location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
}

function lineFragments(text) {
    const linkified = text.replace(LOG_SERVICE_PATH_RE, (_match, prefix, path) => `${prefix}[${path}](${path})`);
    const fragments = [];
    let cursor = 0;
    let found = false;
    let match;
    LOG_MARKDOWN_LINK_RE.lastIndex = 0;
    while ((match = LOG_MARKDOWN_LINK_RE.exec(linkified))) {
        fragments.push(...tokenFragments(linkified.slice(cursor, match.index)));
        const href = safeLogUrl(match[2]);
        if (href) {
            const link = document.createElement('a');
            link.className = 'phase-log-inline-link';
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = match[1] === match[2] ? href : match[1];
            fragments.push(link);
            found = true;
        } else {
            fragments.push(document.createTextNode(match[0]));
        }
        cursor = match.index + match[0].length;
    }
    if (!found) return tokenFragments(text);
    fragments.push(...tokenFragments(linkified.slice(cursor)));
    return fragments;
}

function splitLogLines(text) {
    const lines = [];
    let start = 0;
    for (const chunk of text.split('\n')) {
        lines.push({ text: chunk, start, end: start + chunk.length });
        start += chunk.length + 1;
    }
    return lines;
}

function logLine(rawText, isFinal) {
    const row = document.createElement('span');
    let text = String(rawText || '').replace(ANSI_RE, '');
    let stream = 'stdout';
    const streamMatch = LOG_STREAM_PREFIX_RE.exec(text);
    if (streamMatch) {
        stream = streamMatch[2].toLowerCase();
        text = text.slice(streamMatch[0].length);
    }
    const promptMatch = /^(?:User:\s*|you>\s?)(.*)$/i.exec(text);
    if (promptMatch) {
        row.className = 'phase-log-line is-user-prompt';
        for (const fragment of lineFragments(`you> ${promptMatch[1]}`)) row.append(fragment);
        return row;
    }
    row.className = `phase-log-line is-${stream} ${isFinal ? 'is-final' : 'is-intermediate'}`;
    for (const fragment of lineFragments(text)) row.append(fragment);
    return row;
}

export function renderLog(container, log, finalResponse = '') {
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    container.replaceChildren();
    if (!log) {
        const empty = element('div', 'No log output yet.');
        empty.className = 'phase-log-empty';
        container.append(empty);
    } else {
        const start = finalResponse ? log.lastIndexOf(finalResponse) : -1;
        const end = start >= 0 ? start + finalResponse.length : -1;
        for (const line of splitLogLines(log)) {
            container.append(logLine(line.text, start >= 0 && line.end > start && line.start < end));
        }
    }
    if (atBottom) container.scrollTop = container.scrollHeight;
}
