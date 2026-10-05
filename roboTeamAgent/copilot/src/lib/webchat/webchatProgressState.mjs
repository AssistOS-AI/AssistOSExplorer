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
