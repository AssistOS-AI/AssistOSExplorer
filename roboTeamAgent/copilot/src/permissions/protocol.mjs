export const PERMISSION_MODES = Object.freeze({
    ASK: 'ask-for-approval',
    FULL: 'full-access',
});

const WEBCHAT_INTERACTION_RESOLVED_FLAG = '__webchatInteractionResolved';
const WEBCHAT_INTERACTION_RESPONSE_FLAG = '__webchatInteractionResponse';
const INTERACTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INTERACTION_OPTION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizePermissionMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === PERMISSION_MODES.ASK || normalized === 'ask') {
        return PERMISSION_MODES.ASK;
    }
    if (normalized === PERMISSION_MODES.FULL || normalized === 'full') {
        return PERMISSION_MODES.FULL;
    }
    return null;
}


export function createWebchatInteractionResolved({ id, optionId = null, status = 'resolved' } = {}) {
    return {
        [WEBCHAT_INTERACTION_RESOLVED_FLAG]: 1,
        version: 1,
        id,
        optionId,
        status,
    };
}

export function parseWebchatInteractionResponse(raw) {
    const text = String(raw || '').trim();
    if (!text || !text.includes(`"${WEBCHAT_INTERACTION_RESPONSE_FLAG}"`)) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed?.[WEBCHAT_INTERACTION_RESPONSE_FLAG] || parsed.version !== 1) {
            return null;
        }
        const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
        const optionId = typeof parsed.optionId === 'string' ? parsed.optionId.trim() : '';
        const response = typeof parsed.response === 'string' ? parsed.response : null;
        const cancelled = parsed.cancelled === true;
        if (!INTERACTION_ID_RE.test(id)
            || (optionId && !INTERACTION_OPTION_RE.test(optionId))
            || (response !== null && response.length > 65536)
            || (cancelled && (optionId || response !== null))
            || (optionId && response !== null)
            || (!cancelled && !optionId && response === null)) {
            return null;
        }
        return {
            id,
            ...(cancelled ? { cancelled: true } : {}),
            ...(optionId ? { optionId } : {}),
            ...(response !== null ? { response } : {}),
        };
    } catch {
        return null;
    }
}
