// View-facing state rules for saving the user's GitHub credentials to RoboTeam robots.
// Pure functions: the presenter projects their results. Only administrators configure robot git credentials;
// RoboTeam enforces it and refuses everyone else, so the section is shown only to administrators.

export const DEFAULT_ROBOT_NAME = 'default';

export const ROBOT_CREDENTIAL_CODES = Object.freeze({
    forbidden: 'ROBOT_CREDENTIALS_FORBIDDEN',
    unavailable: 'ROBOTEAM_UNAVAILABLE',
    signInRequired: 'GIT_SIGN_IN_REQUIRED',
    tokenMissing: 'GIT_TOKEN_MISSING'
});

const UNAVAILABLE_NOTE = 'RoboTeam is not available. GitHub sign-in still works; credentials cannot be saved to a robot right now.';

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRobotTargets(payload) {
    if (!payload || typeof payload !== 'object' || payload.ok === false) {
        return { available: false, robots: [], canAdmin: false, userId: '' };
    }
    const robots = (Array.isArray(payload.robots) ? payload.robots : [])
        .map((robot) => {
            const credentials = robot?.credentials && typeof robot.credentials === 'object' ? robot.credentials : {};
            const savedBy = credentials.savedBy && typeof credentials.savedBy === 'object' ? credentials.savedBy : {};
            return {
                id: text(String(robot?.id ?? '')),
                name: text(robot?.name),
                isDefault: robot?.isDefault === true || text(robot?.name) === DEFAULT_ROBOT_NAME,
                credentials: credentials.configured === true
                    ? {
                        configured: true,
                        readable: credentials.readable !== false,
                        githubLogin: text(credentials.githubLogin),
                        savedBy: { id: text(String(savedBy.id ?? '')), username: text(savedBy.username) },
                        savedAt: text(credentials.savedAt)
                    }
                    : { configured: false }
            };
        })
        .filter((robot) => robot.name)
        // The default robot leads the list; the rest keep RoboTeam's order.
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return {
        available: true,
        robots,
        canAdmin: payload.canAdmin === true,
        userId: text(String(payload.userId ?? ''))
    };
}

// Whether the section is shown: RoboTeam answered and the user is an administrator.
export function showRobotAccess(targets) {
    return targets?.available === true && targets.canAdmin === true;
}

function ownedByUser(robot, targets) {
    const credentials = robot?.credentials || { configured: false };
    return Boolean(credentials.configured && credentials.savedBy?.id && credentials.savedBy.id === targets?.userId);
}

export function formatSavedAt(value) {
    const raw = text(value);
    if (!raw) return 'an unknown date';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC');
}

function savedByLabel(savedBy = {}) {
    return text(savedBy.username) || text(savedBy.id) || 'another user';
}

// One robot card: its credential status and which actions it offers to the administrator.
export function describeRobotRow(robot, targets, { connected = false } = {}) {
    const credentials = robot.credentials || { configured: false };
    const login = credentials.githubLogin || 'an unknown GitHub account';
    const when = formatSavedAt(credentials.savedAt);
    let status = 'No git credentials';
    let tone = 'empty';
    let saveLabel = 'Add credentials';
    if (credentials.configured && ownedByUser(robot, targets)) {
        status = `Your credentials (GitHub ${login}), saved on ${when}`;
        tone = 'own';
        saveLabel = 'Replace credentials';
    } else if (credentials.configured) {
        status = `GitHub ${login}, saved by ${savedByLabel(credentials.savedBy)} on ${when}`;
        tone = 'other';
        saveLabel = 'Overwrite credentials';
    }
    if (credentials.configured && credentials.readable === false) status += '; can no longer be read, add them again';
    return {
        name: robot.name,
        label: robot.isDefault ? `${robot.name} (default)` : robot.name,
        isDefault: robot.isDefault,
        status,
        tone,
        canSave: Boolean(connected),
        saveLabel,
        canRemove: Boolean(credentials.configured)
    };
}

// A fresh GitHub login or token save by an administrator also goes to the default robot when it is free or holds
// that administrator's own credentials. Credentials someone else saved are replaced only through Overwrite credentials.
export function planAutomaticRobotSave({ targets }) {
    if (!showRobotAccess(targets)) return { save: false, robotNames: [], message: '' };
    const robot = targets.robots.find((entry) => entry.name === DEFAULT_ROBOT_NAME) || targets.robots.find((entry) => entry.isDefault);
    if (!robot) return { save: false, robotNames: [], message: '' };
    if (robot.credentials.configured && !ownedByUser(robot, targets)) {
        const login = robot.credentials.githubLogin || 'another GitHub account';
        return {
            save: false,
            robotNames: [],
            robotName: robot.name,
            tone: 'warning',
            message: `Not saved to robot ${robot.name}: it holds the GitHub credentials of ${login}, saved by ${savedByLabel(robot.credentials.savedBy)}. Use Overwrite credentials on the robot to replace them.`
        };
    }
    return { save: true, robotNames: [robot.name], message: '' };
}

export function describeRobotSaveResult(result, robotName) {
    if (result?.ok) {
        const login = text(result.metadata?.githubLogin);
        const name = text(result.robot?.name) || robotName;
        const suffix = name === DEFAULT_ROBOT_NAME ? ' ploinky update will also use them for private repositories.' : '';
        return {
            tone: 'success',
            text: `GitHub credentials${login ? ` of ${login}` : ''} saved to robot ${name}.${suffix}`
        };
    }
    const message = text(result?.message);
    if (result?.code === ROBOT_CREDENTIAL_CODES.unavailable) {
        return { tone: 'error', text: UNAVAILABLE_NOTE };
    }
    return { tone: 'error', text: message || `Could not save credentials to robot ${robotName}.` };
}

export function describeRobotRemoveResult(result, robotName) {
    if (result?.ok) {
        return {
            tone: 'success',
            text: result.deleted === false
                ? `Robot ${robotName} had no git credentials.`
                : `Git credentials removed from robot ${robotName}.`
        };
    }
    if (result?.code === ROBOT_CREDENTIAL_CODES.unavailable) return { tone: 'error', text: UNAVAILABLE_NOTE };
    return { tone: 'error', text: text(result?.message) || `Could not remove credentials from robot ${robotName}.` };
}

const TONE_RANK = { success: 0, warning: 1, error: 2 };

// Several per-robot outcomes become one message; the worst outcome sets the tone.
export function combineRobotResults(entries = []) {
    if (!entries.length) return null;
    const tone = entries.reduce((worst, entry) => (TONE_RANK[entry.tone] > TONE_RANK[worst] ? entry.tone : worst), 'success');
    return { tone, text: entries.map((entry) => entry.text).join('\n') };
}
