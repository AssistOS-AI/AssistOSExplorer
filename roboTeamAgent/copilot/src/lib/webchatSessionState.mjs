import { summarizeConversationSession } from './conversationSessionStore.mjs';

const WEBCHAT_SESSION_VERSION = 1;

export function createCurrentSessionEnvelope(session) {
    return {
        __webchatSession: 1,
        version: WEBCHAT_SESSION_VERSION,
        event: 'current',
        session,
        summary: summarizeConversationSession(session),
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

export function createSelectedSessionEnvelope(session) {
    return {
        __webchatSession: 1,
        version: WEBCHAT_SESSION_VERSION,
        event: 'selected',
        session,
        summary: summarizeConversationSession(session),
    };
}

export function emitWebchatSessionEnvelope(envelope, { write } = {}) {
    const output = typeof write === 'function'
        ? write
        : (value) => process.stdout.write(value);
    output(`${JSON.stringify(envelope)}\n`);
    return envelope;
}
