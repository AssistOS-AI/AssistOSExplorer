import { ensureSafeAchillesPrivateDirectory, assertSafeAchillesPrivatePath } from './privateDataRoot.mjs';

function validateSessionId(sessionId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
        throw new Error('invalid_session_id');
    }
}

export function sessionDirectory(cwd, sessionId, options = {}) {
    validateSessionId(sessionId);
    return ensureSafeAchillesPrivateDirectory(cwd, `sessions/${sessionId}`, options);
}

export function sessionConfigPath(cwd, sessionId, options = {}) {
    validateSessionId(sessionId);
    return assertSafeAchillesPrivatePath(cwd, `sessions/${sessionId}/config.json`, { ...options, type: 'file' });
}
