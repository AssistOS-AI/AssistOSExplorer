// Pure logic of the Conversation skills page. Nothing here touches the DOM or the
// network, so Node tests import it directly.

export const ROBOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/;

export const INVALID_LINK = 'The conversation skills link is invalid. Open Conversation skills from the chat menu again.';
export const LOADING = 'Loading conversation skills…';
export const LOADED = 'Current selection loaded. Changes apply at the next execution.';
export const SAVING = 'Saving skill selection…';
export const INVALID_PAYLOAD = 'RoboTeam returned an invalid or mismatched skill policy. Refresh before changing settings.';
export const STALE_RESPONSE = 'An older policy response was ignored. Refresh to load the current selection.';

export function failureText(message) {
    return `${String(message || 'The request failed.')} Refresh to load the current policy.`;
}

// Returns the robot and conversation of a page path, or null. There is no fallback:
// anything that is not exactly <base>conversation-skills/<robotId>/<sessionId>[/] is invalid.
export function parseConversationSkillsPath(pathname, basePath = '/') {
    if (typeof pathname !== 'string') return null;
    const base = String(basePath || '/');
    const prefix = `${base.endsWith('/') ? base : `${base}/`}conversation-skills/`;
    if (!pathname.startsWith(prefix)) return null;
    const parts = pathname.slice(prefix.length).replace(/\/$/, '').split('/');
    if (parts.length !== 2) return null;
    const [robotId, sessionId] = parts;
    return ROBOT_ID_PATTERN.test(robotId) && SESSION_ID_PATTERN.test(sessionId) ? { robotId, sessionId } : null;
}

export function conversationSkillsEndpoint({ robotId, sessionId }) {
    return `api/robots/${robotId}/conversations/${sessionId}/skills`;
}

const text = (value) => typeof value === 'string' ? value : '';
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function normalizeConversationSkills(skills) {
    if (!Array.isArray(skills)) return [];
    return skills
        .filter((entry) => entry && typeof entry.identity === 'string' && entry.identity && typeof entry.name === 'string' && entry.name)
        .map((entry) => ({
            identity: entry.identity,
            name: entry.name,
            description: text(entry.description),
            state: text(entry.state),
            enabled: entry.enabled === true,
            readOnly: entry.required === true || entry.readOnly === true,
            diagnostic: text(entry.error) || text(entry.reason),
        }))
        .sort((left, right) => compare(left.name, right.name) || compare(left.identity, right.identity));
}

function sameConversation(payload, context) {
    return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
        && payload.scope === 'conversation' && payload.sessionId === context.sessionId && payload.robotId === context.robotId
        && Number.isSafeInteger(payload.policyVersion) && payload.policyVersion >= 0 && Array.isArray(payload.skills);
}

// A response is applied only when it describes this conversation of this robot. An
// older policy version than the one on screen is ignored instead of replacing it.
export function validateConversationCatalog(payload, context, currentPolicyVersion) {
    if (!sameConversation(payload, context)) return { ok: false, reason: 'invalid' };
    if (Number.isSafeInteger(currentPolicyVersion) && payload.policyVersion < currentPolicyVersion) return { ok: false, reason: 'stale' };
    return { ok: true };
}

// A saved mutation must report a version greater than the one that was sent.
export function validateMutationCatalog(payload, context, sentPolicyVersion) {
    if (!sameConversation(payload, context) || !(payload.policyVersion > sentPolicyVersion)) return { ok: false, reason: 'invalid' };
    return { ok: true };
}

export function toggleRequestBody(item, policyVersion) {
    return { identity: item.identity, enabled: !item.enabled, policyVersion };
}

export function toggleDisabled(item, { busy, policyVersion, mode }) {
    return Boolean(busy) || !Number.isSafeInteger(policyVersion) || mode === 'pinned' || item.readOnly === true || item.state === 'invalid';
}

export function conversationSummaryLines({ robotName, sessionId, policyVersion, skills, diagnostics }) {
    const lines = [`Robot: ${robotName}`, `Conversation: ${sessionId}`, `Policy version: ${policyVersion}`,
        `Skills: ${skills.length}`, `Enabled: ${skills.filter((skill) => skill.enabled).length}`];
    for (const entry of Array.isArray(diagnostics) ? diagnostics : []) {
        const message = typeof entry === 'string' ? entry : text(entry?.message);
        if (message) lines.push(`Diagnostic: ${message}`);
    }
    return lines;
}
