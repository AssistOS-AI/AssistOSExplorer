// Offsets refer to the original output; the index never stores summary text.
export const SUMMARY_MARKER = '<<human-report>>';
export const SUMMARY_INDEX_VERSION = 1;

export function scanSummaryLines(text, { offset = 0, bytes = false, final = true, state = {} } = {}) {
    const next = { cursor: offset, open: state.open ?? null, fence: state.fence || null, ranges: [] };
    let position = offset;
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    for (const line of lines) {
        if (!final && !line.endsWith('\n')) break;
        const length = bytes ? Buffer.byteLength(line) : line.length;
        const value = line.replace(/\r?\n$/, '');
        const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
        if (fence) {
            if (!next.fence) next.fence = { char: fence[1][0], length: fence[1].length };
            else if (fence[1][0] === next.fence.char && fence[1].length >= next.fence.length && !fence[2].trim()) next.fence = null;
        } else if (!next.fence && value === SUMMARY_MARKER) {
            if (next.open === null) next.open = position + length;
            else {
                if (position > next.open) next.ranges.push({ start: next.open, end: position });
                next.open = null;
            }
        }
        position += length;
        next.cursor = position;
    }
    return next;
}

export function summaryRanges(text) {
    return scanSummaryLines(String(text || '')).ranges;
}

export function validRange(range, length) {
    return Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end)
        && range.start >= 0 && range.end > range.start && range.end <= length;
}

export function indexConversationSummaries(session, previous = null) {
    const old = new Map((previous?.messages || []).filter(message => message.role === 'assistant').map(message => [message.id, message.text]));
    const refs = new Map((session.summaryRefs || []).map(ref => [ref.messageId, ref]));
    session.summaryRefs = session.messages.filter(message => message.role === 'assistant').map(message => {
        if (session.summaryIndexVersion === SUMMARY_INDEX_VERSION && old.get(message.id) === message.text) return refs.get(message.id) || { messageId: message.id, ranges: [] };
        return { messageId: message.id, ranges: summaryRanges(message.text) };
    }).filter(ref => ref.ranges.length);
    session.summaryIndexVersion = SUMMARY_INDEX_VERSION;
}

// Separate machine-readable payloads may be followed by a human report.
export function withoutSummaryBlocks(source) {
    let text = String(source || '');
    for (const range of summaryRanges(text).reverse()) {
        const opening = text.lastIndexOf(SUMMARY_MARKER, range.start - 1);
        text = text.slice(0, opening) + text.slice(range.end + SUMMARY_MARKER.length);
    }
    return text;
}
