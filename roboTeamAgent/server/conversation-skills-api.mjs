import { skillCatalogRequest } from './skill-catalog-api.mjs';
import { skillError } from './skill-files.mjs';

const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SESSION_ID = /^[a-f0-9-]{36}$/;
const PATCH_FIELDS = ['identity', 'enabled', 'policyVersion'];
const failure = (message, statusCode) => Object.assign(skillError(message), { statusCode });

// Matches the path only; the ids are validated by the operations so that a malformed
// id is reported as a client error instead of falling through to another route.
export function matchConversationSkillsPath(pathname) {
    const match = /^\/api\/robots\/([^/]+)\/conversations\/([^/]+)\/skills$/.exec(String(pathname || ''));
    return match ? { robotId: match[1], sessionId: match[2] } : null;
}

async function resolveRobot(robotStore, robotId, sessionId) {
    if (!ROBOT_ID.test(robotId)) throw failure('invalid robot id', 400);
    if (!SESSION_ID.test(sessionId)) throw failure('invalid conversation id', 400);
    const robot = await robotStore.get(robotId);
    if (!robot) throw failure('robot not found', 404);
    return robot;
}

// The conversation is always named by its session id and never by a directory: the
// catalog function falls back to robot defaults when the session id is missing.
async function conversationCatalog(catalogRequest, request) {
    try {
        return await catalogRequest(request);
    } catch (error) {
        if (/Project record exists in multiple folders/.test(String(error?.message))) throw failure(error.message, 409);
        throw error;
    }
}

function validatedChange(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('JSON object body is required', 400);
    for (const key of Object.keys(body)) if (!PATCH_FIELDS.includes(key)) throw failure(`unexpected field: ${key}`, 400);
    if (PATCH_FIELDS.some((key) => body[key] === undefined)) throw failure('identity, enabled and policyVersion are required', 400);
    if (typeof body.identity !== 'string' || !body.identity) throw failure('identity must be a non-empty string', 400);
    if (typeof body.enabled !== 'boolean') throw failure('enabled must be a boolean', 400);
    if (!Number.isSafeInteger(body.policyVersion) || body.policyVersion < 0) throw failure('policyVersion must be a non-negative integer', 400);
    return { identity: body.identity, enabled: body.enabled, policyVersion: body.policyVersion };
}

export async function readConversationSkills({ robotStore, skillsets, catalogRequest = skillCatalogRequest }, { robotId, sessionId }) {
    const robot = await resolveRobot(robotStore, robotId, sessionId);
    return conversationCatalog(catalogRequest, { skillsets, robot, input: { sessionId } });
}

export async function setConversationSkill({ robotStore, skillsets, catalogRequest = skillCatalogRequest }, { robotId, sessionId, body }) {
    const robot = await resolveRobot(robotStore, robotId, sessionId);
    const change = validatedChange(body);
    return conversationCatalog(catalogRequest, { skillsets, robot, input: { sessionId, ...change }, mutate: true });
}
