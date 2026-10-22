export const CODING_AGENTS = Object.freeze([
    ['codex', 'Codex'], ['opencode', 'OpenCode'], ['pi', 'Pi'], ['claude', 'Claude Code'],
]);
const AGENT_NAMES = new Set(CODING_AGENTS.map(([name]) => name));
const LOGIN_FILTERS = new Set(['any', 'none', ...AGENT_NAMES]);

// Filters live in the dashboard URL (?q=&login=&agent=) so a reload or a return keeps them.
export function readRobotFilters(search) {
    const params = new URLSearchParams(search);
    const login = params.get('login') || '';
    const agent = params.get('agent') || '';
    return {
        query: (params.get('q') || '').slice(0, 200),
        login: LOGIN_FILTERS.has(login) ? login : '',
        agent: AGENT_NAMES.has(agent) ? agent : '',
    };
}

export function writeRobotFilters(url, filters) {
    const next = new URL(url);
    for (const [key, value] of [['q', filters.query.trim()], ['login', filters.login], ['agent', filters.agent]]) {
        if (value) next.searchParams.set(key, value);
        else next.searchParams.delete(key);
    }
    return next;
}

export const filtersActive = filters => Boolean(filters.query.trim() || filters.login || filters.agent);

export function loggedInAgents(robot) {
    const logins = robot.codingAgentLogins || {};
    return CODING_AGENTS.filter(([name]) => logins[name] === true);
}

// The card shows nothing for a robot without logins; most robots have none, and a "0/4" on every
// card would bury the few that do.
export function loginSummary(robot) {
    if (!robot.codingAgentLogins) return null;
    const logged = loggedInAgents(robot);
    if (!logged.length) return null;
    const missing = CODING_AGENTS.filter(([name]) => robot.codingAgentLogins[name] !== true);
    return {
        text: `Logged in ${logged.length}/${CODING_AGENTS.length}`,
        title: [`Logged in: ${logged.map(([, label]) => label).join(', ')}`,
            missing.length ? `Not logged in: ${missing.map(([, label]) => label).join(', ')}` : ''].filter(Boolean).join('\n'),
    };
}

export function filterRobots(robots, filters) {
    const words = filters.query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return robots.filter(robot => {
        const haystack = `${robot.name} ${robot.id}`.toLocaleLowerCase();
        if (!words.every(word => haystack.includes(word))) return false;
        if (filters.agent && robot.codingAgent !== filters.agent) return false;
        if (!filters.login || !robot.codingAgentLogins) return true;
        const logged = loggedInAgents(robot).length;
        if (filters.login === 'any') return logged > 0;
        if (filters.login === 'none') return logged === 0;
        return robot.codingAgentLogins[filters.login] === true;
    });
}
