// Offsets refer to the original output; the index never stores summary text.
export const SUMMARY_MARKER = '<<human-report>>';

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

// Separate machine-readable payloads may be followed by a human report.
export function withoutSummaryBlocks(source) {
    let text = String(source || '');
    for (const range of summaryRanges(text).reverse()) {
        const opening = text.lastIndexOf(SUMMARY_MARKER, range.start - 1);
        text = text.slice(0, opening) + text.slice(range.end + SUMMARY_MARKER.length);
    }
    return text;
}

// Chat display only: drops the marker lines themselves and keeps the report
// text. Markers inside code fences are content and stay. Text without markers
// is returned unchanged.
export function withoutSummaryMarkers(source) {
    const text = String(source ?? '');
    let fence = null;
    let removed = false;
    const kept = (text.match(/[^\n]*\n|[^\n]+$/g) || []).filter((line) => {
        const value = line.replace(/\r?\n$/, '');
        const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
        if (opening) {
            if (!fence) fence = { char: opening[1][0], length: opening[1].length };
            else if (opening[1][0] === fence.char && opening[1].length >= fence.length && !opening[2].trim()) fence = null;
            return true;
        }
        if (fence || value.trim() !== SUMMARY_MARKER) return true;
        removed = true;
        return false;
    });
    return removed ? kept.join('').replace(/^\s*\n/, '').replace(/\s+$/, '') : text;
}
