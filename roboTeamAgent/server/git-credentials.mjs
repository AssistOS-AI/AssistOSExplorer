import { DEFAULT_ROBOT_NAME } from './robot-store.mjs';
import { isAdminActor } from './request-identity.mjs';

// Robot git credentials (GitHub only). RoboWork stores the encrypted token and serves it to the robot's git
// credential helper; RoboTeam decides who may save or remove it. The token passes through this module once,
// on save, straight into the RoboWork call: it is never logged, stored, projected or returned.

export const CREDENTIALS_OCCUPIED = 'ROBOT_CREDENTIALS_OCCUPIED';
export const CREDENTIALS_FORBIDDEN = 'ROBOT_CREDENTIALS_FORBIDDEN';
export const CREDENTIALS_INVALID = 'ROBOT_CREDENTIALS_INVALID';
export const ROBOT_NOT_FOUND = 'ROBOT_NOT_FOUND';
export const CALLER_REFUSED = 'ROBOT_CREDENTIALS_CALLER_REFUSED';

const TOKEN_MAX_LENGTH = 4096;
const FIELD_MAX_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

function failure(message, code, statusCode) {
    return Object.assign(new Error(message), { code, statusCode });
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function normalizeUserId(value) {
    return text(String(value ?? '')).replace(/^user:/iu, '').trim();
}

function normalizedRoles(roles) {
    return Array.isArray(roles) ? roles.map((role) => String(role || '').trim().toLowerCase()).filter(Boolean) : [];
}

// The workspace user acting on robot credentials: a non-empty id and no guest role.
export function credentialUser({ id, username = '', roles = [] } = {}) {
    const userId = normalizeUserId(id);
    const userRoles = normalizedRoles(roles);
    if (!userId || userRoles.includes('guest')) return null;
    return { id: userId, username: text(username) || userId, roles: userRoles, canAdmin: isAdminActor({ roles: userRoles }) };
}

// Non-secret metadata only, whatever RoboWork returns.
export function publicCredentialMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    const savedBy = metadata.savedBy && typeof metadata.savedBy === 'object' ? metadata.savedBy : {};
    return {
        host: text(metadata.host) || 'github.com',
        githubLogin: text(metadata.githubLogin),
        name: text(metadata.name),
        email: text(metadata.email),
        savedBy: { id: normalizeUserId(savedBy.id), username: text(savedBy.username) },
        savedAt: text(metadata.savedAt),
    };
}

// The card and selector summary of one robot's credentials.
export function credentialSummary(status) {
    const metadata = status?.configured === true ? publicCredentialMetadata(status.metadata) : null;
    if (!metadata) return { configured: false };
    return {
        configured: true,
        readable: status.readable !== false,
        githubLogin: metadata.githubLogin,
        savedBy: metadata.savedBy,
        savedAt: metadata.savedAt,
    };
}

// The saver of the stored credentials or an administrator may replace or remove them.
export function mayManageCredentials(summary, user) {
    if (!user) return false;
    if (summary?.configured !== true) return true;
    return user.canAdmin === true || (Boolean(summary.savedBy?.id) && summary.savedBy.id === user.id);
}

function occupiedMessage(robot, summary) {
    const login = summary.githubLogin || 'an unknown GitHub account';
    const saver = summary.savedBy?.username || summary.savedBy?.id || 'another user';
    const when = summary.savedAt ? ` on ${summary.savedAt}` : '';
    return `Robot ${robot.name} already holds git credentials for GitHub user ${login}, saved by ${saver}${when}. Only an administrator can overwrite them.`;
}

function field(input, name, { required = false } = {}) {
    const value = input?.[name];
    if (value !== undefined && value !== null && typeof value !== 'string') throw failure(`${name} must be a string`, CREDENTIALS_INVALID, 400);
    const trimmed = text(value);
    if (required && !trimmed) throw failure(`${name} is required`, CREDENTIALS_INVALID, 400);
    if (trimmed.length > FIELD_MAX_LENGTH || CONTROL_CHARACTERS.test(trimmed)) throw failure(`${name} is invalid`, CREDENTIALS_INVALID, 400);
    return trimmed;
}

// The token is checked without ever placing it in a message.
function tokenField(input) {
    const token = input?.token;
    if (typeof token !== 'string' || !token.trim()) throw failure('token is required', CREDENTIALS_INVALID, 400);
    if (token.length > TOKEN_MAX_LENGTH || /\s/u.test(token.trim()) || CONTROL_CHARACTERS.test(token)) {
        throw failure('token is invalid', CREDENTIALS_INVALID, 400);
    }
    return token.trim();
}

function robotReference(robot) {
    return { id: robot.id, name: robot.name, isDefault: robot.name === DEFAULT_ROBOT_NAME };
}

export class RobotGitCredentials {
    constructor({ robotStore, roboWork }) {
        this.robotStore = robotStore;
        this.roboWork = roboWork;
        this.locks = new Map();
    }

    // Save and delete of one robot run one at a time, so a status check and its write cannot interleave.
    async withRobotLock(robotId, action) {
        const previous = this.locks.get(robotId) || Promise.resolve();
        const current = previous.catch(() => {}).then(action);
        const settled = current.catch(() => {});
        this.locks.set(robotId, settled);
        try { return await current; }
        finally { if (this.locks.get(robotId) === settled) this.locks.delete(robotId); }
    }

    async summary(robotId) {
        return credentialSummary(await this.roboWork.call('robot_git_credentials_status', { robotId }));
    }

    async robotByName(robotName) {
        const name = text(robotName);
        if (!name) throw failure('robotName is required', CREDENTIALS_INVALID, 400);
        const robot = await this.robotStore.getByName(name);
        if (!robot) throw failure(`robot ${name} was not found`, ROBOT_NOT_FOUND, 404);
        return robot;
    }

    async targets(user) {
        const robots = await this.robotStore.list();
        const listed = await Promise.all(robots.map(async (robot) => ({ ...robotReference(robot), credentials: await this.summary(robot.id) })));
        return { ok: true, robots: listed, canAdmin: user.canAdmin === true, userId: user.id };
    }

    async save(user, input = {}) {
        const robot = await this.robotByName(input.robotName);
        const token = tokenField(input);
        const githubLogin = field(input, 'githubLogin', { required: true });
        const name = field(input, 'name');
        const email = field(input, 'email');
        return this.withRobotLock(robot.id, async () => {
            const current = await this.summary(robot.id);
            if (!mayManageCredentials(current, user)) throw failure(occupiedMessage(robot, current), CREDENTIALS_OCCUPIED, 409);
            const result = await this.roboWork.call('robot_git_credentials_set', {
                robotId: robot.id, token, githubLogin, name, email,
                savedBy: { id: user.id, username: user.username },
                workspaceDefault: robot.name === DEFAULT_ROBOT_NAME,
            });
            return { ok: true, robot: robotReference(robot), metadata: publicCredentialMetadata(result?.metadata) };
        });
    }

    async remove(user, robot) {
        return this.withRobotLock(robot.id, async () => {
            const current = await this.summary(robot.id);
            const workspaceDefault = robot.name === DEFAULT_ROBOT_NAME;
            if (current.configured !== true) {
                // The default robot's token lives in the workspace file Ploinky reads; if its RoboWork record is gone,
                // an administrator's removal still reaches RoboWork so that file is cleared too.
                if (!(workspaceDefault && user?.canAdmin === true)) return { ok: true, robot: robotReference(robot), deleted: false };
            } else if (!mayManageCredentials(current, user)) {
                throw failure(`Only ${current.savedBy?.username || 'the user who saved them'} or an administrator can remove the git credentials of robot ${robot.name}.`,
                    CREDENTIALS_FORBIDDEN, 403);
            }
            const result = await this.roboWork.call('robot_git_credentials_delete', { robotId: robot.id, workspaceDefault });
            return { ok: true, robot: robotReference(robot), deleted: result?.deleted !== false };
        });
    }

    async removeByName(user, robotName) {
        return this.remove(user, await this.robotByName(robotName));
    }
}
