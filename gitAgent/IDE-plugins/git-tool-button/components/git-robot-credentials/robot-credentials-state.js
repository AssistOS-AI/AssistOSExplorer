// View-facing state rules for saving the user's GitHub credentials to a RoboTeam robot.
// Pure functions: the presenter projects their results; RoboTeam remains the authority on permissions.

export const NO_ROBOT = '__none__';
export const DEFAULT_ROBOT_NAME = 'default';

export const ROBOT_CREDENTIAL_CODES = Object.freeze({
    occupied: 'ROBOT_CREDENTIALS_OCCUPIED',
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
        const signInRequired = payload?.code === ROBOT_CREDENTIAL_CODES.signInRequired;
        return {
            available: false,
            robots: [],
            canAdmin: false,
            userId: '',
            note: signInRequired
                ? 'Sign in to the workspace to save git credentials to a robot.'
                : UNAVAILABLE_NOTE
        };
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
        .filter((robot) => robot.name);
    return {
        available: true,
        robots,
        canAdmin: payload.canAdmin === true,
        userId: text(String(payload.userId ?? '')),
        note: robots.length ? '' : 'No robots are available.'
    };
}

// Keeps a still-valid previous choice; otherwise preselects the robot named "default".
export function pickRobotSelection(robots = [], previous = '') {
    const names = robots.map((robot) => robot.name);
    if (previous === NO_ROBOT) return NO_ROBOT;
    if (previous && names.includes(previous)) return previous;
    const preferred = robots.find((robot) => robot.name === DEFAULT_ROBOT_NAME) || robots.find((robot) => robot.isDefault);
    return preferred ? preferred.name : NO_ROBOT;
}

export function buildRobotOptions(robots = []) {
    return [
        ...robots.map((robot) => ({ value: robot.name, name: robot.isDefault ? `${robot.name} (default)` : robot.name })),
        { value: NO_ROBOT, name: "Don't save to a robot" }
    ];
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

// What the selection means for the user: notices, warnings and which actions apply.
export function describeRobotSelection({ targets, selection, connected }) {
    const empty = {
        robot: null,
        notice: '',
        warning: '',
        adminNote: '',
        canSave: false,
        canRemove: false,
        saveLabel: 'Save to robot',
        blocked: false
    };
    if (!targets?.available || !selection || selection === NO_ROBOT) return empty;
    const robot = targets.robots.find((entry) => entry.name === selection) || null;
    if (!robot) return empty;
    const credentials = robot.credentials || { configured: false };
    const ownedByUser = Boolean(credentials.configured && credentials.savedBy?.id && credentials.savedBy.id === targets.userId);
    const ownedByOther = Boolean(credentials.configured && !ownedByUser);
    const blocked = ownedByOther && !targets.canAdmin;
    const result = {
        ...empty,
        robot,
        blocked,
        canSave: Boolean(connected) && !blocked,
        canRemove: Boolean(credentials.configured) && (ownedByUser || targets.canAdmin)
    };
    const login = credentials.githubLogin || 'an unknown GitHub account';
    const when = formatSavedAt(credentials.savedAt);
    if (ownedByOther) {
        result.warning = `Robot ${robot.name} already holds the GitHub credentials of ${login}, saved by ${savedByLabel(credentials.savedBy)} on ${when}.`;
        result.adminNote = targets.canAdmin
            ? 'Saving will overwrite them because you are an administrator.'
            : 'Only an administrator can overwrite credentials saved by another user.';
        if (targets.canAdmin) result.saveLabel = 'Overwrite robot credentials';
    } else if (ownedByUser) {
        result.notice = `You saved the GitHub credentials of ${login} to robot ${robot.name} on ${when}. Saving again replaces them.`;
    }
    if (credentials.configured && credentials.readable === false) {
        result.notice = `${result.notice} The stored credentials can no longer be read; save them again.`.trim();
    }
    return result;
}

// Decides whether a fresh GitHub login or token save should also go to the selected robot.
export function planAutomaticRobotSave({ targets, selection }) {
    if (!targets?.available || !selection || selection === NO_ROBOT) return { save: false, message: '' };
    const description = describeRobotSelection({ targets, selection, connected: true });
    if (!description.robot) return { save: false, message: '' };
    if (description.blocked) {
        return {
            save: false,
            tone: 'warning',
            message: `Not saved to robot ${description.robot.name}: ${description.adminNote}`
        };
    }
    return { save: true, robotName: description.robot.name, message: '' };
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
    if (result?.code === ROBOT_CREDENTIAL_CODES.occupied) {
        return { tone: 'warning', text: message || `Robot ${robotName} already holds credentials saved by another user. Only an administrator can overwrite them.` };
    }
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
