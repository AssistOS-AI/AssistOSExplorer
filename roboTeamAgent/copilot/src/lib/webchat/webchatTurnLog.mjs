// "View Thinking" pages render the coding-agent output that ALA recorded for a
// turn. The URL names the conversation and its assistant message; the server
// maps the message to its turn and reads the turn from ALA's transcript.
export function webchatTurnLogUrl(base, sessionId, messageId) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return '';
    return `${root}/${encodeURIComponent(sessionId)}/${encodeURIComponent(messageId)}`;
}

// Plain-text log of a recorded ALA turn, in recording order.
export function renderAlaTurnLog(turn) {
    const entries = [
        ...turn.followUps.map((entry) => ({ seq: entry.seq, text: `you> ${entry.text}` })),
        ...turn.messages.map((entry) => ({ seq: entry.seq, text: entry.text })),
        ...turn.tools.map((entry) => ({ seq: entry.seq, text: entry.reason })),
    ].sort((left, right) => left.seq - right.seq);
    return entries.map((entry) => (entry.text.endsWith('\n') ? entry.text : `${entry.text}\n`)).join('').replace(/\n$/, '');
}
