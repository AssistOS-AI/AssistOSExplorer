import { summarizeConversationSession } from './conversationSessionStore.mjs';

const WEBCHAT_SESSION_VERSION = 1;

export function createConversationSettingsAction(session, robot = process.env.ROBOTEAM_COPILOT_ROBOT_NAME) {
    if (typeof robot !== 'string' || !robot.trim() || robot.trim().length > 80
        || /[\x00-\x1f\x7f]/.test(robot) || !/^[a-f0-9-]{36}$/.test(session?.sessionId || '')) return undefined;
    const query = new URLSearchParams({ 'copilot-robot': robot.trim(), 'copilot-session': session.sessionId });
    return { label: 'Conversation skills', href: `/explorer/index.html?${query}#file-exp/` };
}

export function createCurrentSessionEnvelope(session, options = {}) {
    const settingsAction = createConversationSettingsAction(session, options.robot);
    return {
        __webchatSession: 1,
        version: WEBCHAT_SESSION_VERSION,
        event: 'current',
        session,
        summary: summarizeConversationSession(session),
        ...(settingsAction ? { settingsAction } : {}),
    };
}

export function createSessionListEnvelope(payload) {
    return {
        __webchatSession: 1,
        version: WEBCHAT_SESSION_VERSION,
        event: 'list',
        currentSessionId: payload.currentSessionId,
        sessions: payload.sessions,
    };
}

export function createSelectedSessionEnvelope(session, options = {}) {
    return { ...createCurrentSessionEnvelope(session, options), event: 'selected' };
}

export function emitWebchatSessionEnvelope(envelope, { write } = {}) {
    const output = typeof write === 'function'
        ? write
        : (value) => process.stdout.write(value);
    output(`${JSON.stringify(envelope)}\n`);
    return envelope;
}
