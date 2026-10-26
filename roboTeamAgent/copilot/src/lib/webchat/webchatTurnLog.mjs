// "View Thinking" pages render the coding-agent output that ALA recorded for a
// turn. The URL names the conversation and its assistant message; the server
// maps the message to its turn and reads the turn from ALA's transcript.
export function webchatTurnLogUrl(base, sessionId, messageId) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return '';
    return `${root}/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`;
}

// Plain-text log of a recorded ALA turn, in recording order. Current ALA folds
// turns without a `tools` array; older transcripts still carry one, so every
// list is optional and entries without text are skipped.
const recorded = (value) => (Array.isArray(value) ? value : []);

export function renderAlaTurnLog(turn) {
    const entries = [
        ...recorded(turn?.followUps).map((entry) => ({ seq: entry?.seq, text: typeof entry?.text === 'string' ? `you> ${entry.text}` : null })),
        ...recorded(turn?.messages).map((entry) => ({ seq: entry?.seq, text: entry?.text })),
        ...recorded(turn?.tools).map((entry) => ({ seq: entry?.seq, text: entry?.reason })),
    ].filter((entry) => typeof entry.text === 'string')
        // Entries without a numeric sequence go last, in recording order.
        .map((entry, index) => ({ ...entry, order: Number.isFinite(entry.seq) ? entry.seq : Infinity, index }))
        .sort((left, right) => (left.order === right.order ? left.index - right.index : left.order < right.order ? -1 : 1));
    return entries.map((entry) => (entry.text.endsWith('\n') ? entry.text : `${entry.text}\n`)).join('').replace(/\n$/, '');
}
