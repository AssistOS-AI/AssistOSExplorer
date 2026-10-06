// Transient live status shown in the WebChat typing indicator. It replaces the
// "Thinking" label while a turn runs and is never persisted with the message.
const CODING_AGENT_LABELS = Object.freeze({ codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', claude: 'Claude Code' });

export function codingAgentLabel(name) {
    const value = String(name || '').trim().toLowerCase();
    return CODING_AGENT_LABELS[value] || (value ? value : 'the coding agent');
}

export function createWebchatProgressEnvelope(reason, { tool = '', type = '' } = {}) {
    const text = String(reason || '').trim();
    if (!text) return null;
    return {
        __webchatProgress: 1,
        version: 1,
        reason: text,
        ...(typeof tool === 'string' && tool.trim() ? { tool: tool.trim() } : {}),
        ...(typeof type === 'string' && type.trim() ? { type: type.trim() } : {}),
    };
}

const MAX_PROGRESS_LINE = 240;

// Coding agents stream visible text in arbitrary chunks: word deltas (OpenCode,
// Pi, Claude Code) or whole multi-line blocks (Codex). The indicator shows one
// complete line at a time, so chunks are joined per output stream and a line is
// published when it ends, when its stream completes or switches, or when it
// grows past one readable status line.
export function createProgressLineBuffer(publish) {
    let key = null;
    let pending = '';
    const show = (line) => { if (line.trim()) publish(line.trim()); };
    const flush = () => { show(pending); pending = ''; };
    return {
        push(event) {
            const next = `${event.outputKind || 'output'}:${event.outputId || ''}`;
            if (next !== key) { flush(); key = next; }
            const lines = (pending + String(event.message || '')).split('\n');
            pending = lines.pop();
            const complete = lines.filter((line) => line.trim());
            if (complete.length) show(complete.at(-1));
            while (pending.length > MAX_PROGRESS_LINE) {
                const cut = pending.lastIndexOf(' ', MAX_PROGRESS_LINE);
                const end = cut > 0 ? cut : MAX_PROGRESS_LINE;
                show(pending.slice(0, end));
                pending = pending.slice(end).trimStart();
            }
            if (event.outputComplete) flush();
        },
        flush,
    };
}
