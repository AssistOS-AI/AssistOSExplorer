import { PUBLIC_BASE_PATH } from '../../../../server/constants.mjs';
import { summarizeConversationSession } from '../storage/conversationSessionStore.mjs';

const WEBCHAT_SESSION_VERSION = 1;

// The action opens RoboTeam's own Conversation skills page for the saved conversation. The
// link names only the robot id and the session id; the page resolves everything else, and a
// conversation bound to another robot gets no link because the page would refuse it.
export function createConversationSettingsAction(session, robotId = process.env.ROBOTEAM_COPILOT_ROBOT_ID) {
    if (typeof robotId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(robotId) || !/^[a-f0-9-]{36}$/.test(session?.sessionId || '')) return undefined;
    if (session.engine?.robotId && session.engine.robotId !== robotId) return undefined;
    return { label: 'Conversation skills', href: `${PUBLIC_BASE_PATH}conversation-skills/${robotId}/${session.sessionId}` };
}

export function createCurrentSessionEnvelope(session, options = {}) {
    const settingsAction = createConversationSettingsAction(session, options.robotId);
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
