export function consumeConversationSettingsRequest(location, history) {
    const query = new URLSearchParams(location?.search || '');
    if (!query.has('copilot-session') && !query.has('copilot-robot')) return null;
    const sessions = query.getAll('copilot-session');
    const robots = query.getAll('copilot-robot');
    query.delete('copilot-session');
    query.delete('copilot-robot');
    const remaining = query.toString();
    history.replaceState(null, '', `${location.pathname}${remaining ? `?${remaining}` : ''}${location.hash || ''}`);
    if (sessions.length !== 1 || robots.length !== 1 || !/^[a-f0-9-]{36}$/.test(sessions[0])
        || !robots[0].trim() || robots[0].length > 80 || /[\x00-\x1f\x7f]/.test(robots[0])) {
        throw new Error('The conversation settings link is invalid. Open Conversation skills from the chat menu again.');
    }
    return { robot: robots[0].trim(), sessionId: sessions[0] };
}
