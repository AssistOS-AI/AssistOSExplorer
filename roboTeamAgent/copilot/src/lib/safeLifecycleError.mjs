export const SAFE_LIFECYCLE_CODES = Object.freeze([
    'PLOINKY_BOX_MARKER_INVALID',
    'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED',
    'PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE',
    'PLOINKY_MANIFEST_SECURITY_INVALID',
    'PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED',
    'PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE',
    'PLOINKY_RUNTIME_INPUT_CHANGED',
]);
const safeLifecycleCodeSet = new Set(SAFE_LIFECYCLE_CODES);

const SAFE_MESSAGES = Object.freeze({
    PLOINKY_BOX_MARKER_INVALID: 'The Box runtime identity could not be verified.',
    PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED: 'The Box runtime does not support the required capability.',
    PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE: 'The delegated task sandbox capability is unavailable.',
    PLOINKY_MANIFEST_SECURITY_INVALID: 'The agent manifest security declaration is invalid.',
    PLOINKY_MANIFEST_SECURITY_PROFILE_UNSUPPORTED: 'The agent security profile is unsupported.',
    PLOINKY_OPEN_INTERPRETER_BOX_UNAVAILABLE: 'Open Interpreter is unavailable in this Box runtime.',
    PLOINKY_RUNTIME_INPUT_CHANGED: 'The admitted runtime input changed before activation.',
});

function candidateCodes(value) {
    if (!value || typeof value !== 'object') return [];
    const pending = [value];
    const seen = new Set();
    const codes = [];
    while (pending.length && seen.size < 16) {
        const candidate = pending.shift();
        if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
        seen.add(candidate);
        codes.push(candidate.code);
        for (const nested of [candidate.error, candidate.cause, candidate.result, candidate.task]) {
            if (nested && typeof nested === 'object') pending.push(nested);
        }
    }
    return codes;
}

export function safeLifecycleCode(value) {
    for (const candidate of candidateCodes(value)) {
        const code = typeof candidate === 'string' ? candidate.trim() : '';
        if (safeLifecycleCodeSet.has(code)) return code;
    }
    return '';
}

export function formatSafeLifecycleError(value) {
    const code = safeLifecycleCode(value);
    return code ? `${code}: ${SAFE_MESSAGES[code]}` : '';
}
