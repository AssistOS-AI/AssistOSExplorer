import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from './robot-paths.mjs';
import { CODING_AGENT_NAMES } from './coding-agents.mjs';

// A coding session is one interactive conversation of a coding agent. Its native session catalog is ALA's (DS004 of
// AdvancedLanguageAgent): RoboWork asks it for the conversations a person started in a folder and for the arguments
// that resume one. The catalog of a robot is read only inside the confined home helper, which sees that one home.

export const NATIVE_SESSION_ID = /^[A-Za-z0-9_-]{1,96}$/u;
export const SESSION_LIST_LIMIT = 50;

// An agent whose ALA descriptor declares no catalog has no resumable conversations: it lists none and only opens
// new ones.
export async function loadSessionCatalog(alaRoot, codingAgent) {
    if (!CODING_AGENT_NAMES.includes(codingAgent)) throw fail('UNKNOWN_CODING_AGENT', 'Unknown coding agent', 404);
    const { getAgent } = await import(pathToFileURL(path.join(alaRoot, 'src', 'coding-agents', 'registry.mjs')).href);
    const loader = getAgent(codingAgent)?.sessions;
    return typeof loader === 'function' ? loader() : null;
}

// Runs in the home helper: `home` is the robot home at its visible path, `cwd` the absolute folder as the
// coding agent records it. The folder is only compared, never opened.
export async function listCodingSessions(home, input, { alaRoot }) {
    const { codingAgent, cwd } = input || {};
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.length > 4096) throw fail('INVALID_INPUT', 'Invalid folder');
    const catalog = await loadSessionCatalog(alaRoot, codingAgent);
    if (!catalog) return { sessions: [] };
    const sessions = await catalog.listInteractiveSessions({ home, cwd, limit: SESSION_LIST_LIMIT });
    return { sessions: sessions.filter(session => NATIVE_SESSION_ID.test(session.id)) };
}

// The native arguments that open a new conversation, under an identifier chosen in advance when the coding
// agent allows one, or resume an existing one.
export async function codingSessionArguments(alaRoot, codingAgent, { resume = null, sessionId = null } = {}) {
    const catalog = await loadSessionCatalog(alaRoot, codingAgent);
    if (!catalog) {
        if (resume || sessionId) throw fail('SESSIONS_UNAVAILABLE', `${codingAgent} conversations cannot be resumed`, 409);
        return [];
    }
    const args = catalog.interactiveArguments(resume ? { resume } : sessionId ? { sessionId } : {});
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(arg))) {
        throw fail('SESSIONS_UNAVAILABLE', 'Invalid coding session arguments', 500);
    }
    return args;
}

export async function presetsSessionId(alaRoot, codingAgent) {
    return (await loadSessionCatalog(alaRoot, codingAgent))?.presetSessionId === true;
}
