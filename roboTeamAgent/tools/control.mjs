import process from 'node:process';

async function readPayload() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    return JSON.parse(raw || '{}');
}

function invocationUser(payload) {
    const grant = payload?.metadata?.invocation;
    const delegated = grant?.usr || grant?.user;
    const actor = grant?.actor?.kind === 'user' ? grant.actor : null;
    const user = payload?.metadata?.user || delegated || actor;
    return {
        id: String(user?.id || user?.sub || '').replace(/^user:/i, '').trim(),
        roles: Array.isArray(user?.roles) ? user.roles.map(String) : [],
    };
}

async function request(pathname, { method = 'GET', body, user = {} }) {
    const port = Number(process.env.ROBOTEAM_SERVICE_PORT || 3001);
    const token = String(process.env.ROBOTEAM_INTERNAL_TOKEN || '');
    if (!token) throw new Error('RoboTeam internal token is unavailable');
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
            'content-type': 'application/json',
            'x-roboteam-internal-token': token,
            ...(user.id ? { 'x-roboteam-user-id': user.id } : {}),
            ...(user.roles?.length ? { 'x-roboteam-user-roles': JSON.stringify(user.roles) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(29000),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid service response' }));
    if (!response.ok) throw new Error(result.error || `RoboTeam request failed with ${response.status}`);
    return result;
}

const operation = process.argv[2] || '';
const payload = await readPayload();
const expectedToolNames = {
    'robot-create': 'robot_create', 'robot-list': 'robot_list', 'robot-delete': 'robot_delete',
    'open-desktop': 'openDesktopForRobot',
    'start-desktop-task': 'startDesktopTaskForRobot', 'stop-desktop-task': 'stopDesktopTaskForRobot',
    'start-browser-task': 'startBrowserTaskForRobot', 'stop-browser-task': 'stopBrowserTaskForRobot',
    'start-simple-task': 'startSimpleALATaskForRobot', 'stop-simple-task': 'stopSimpleALATaskForRobot',
    'task-status': 'getTaskStatusForRobot', 'desktop-url': 'getSessionUrlForRobotDesktop',
    'browser-url': 'getSessionUrlForRobotBrowser', 'stop-desktop-container': 'stopDesktopContainerForRobot',
    'stop-browser-container': 'stopBrowserContainerForRobot',
};
const invokedToolName = String(payload.tool || payload.toolName || payload.name || '').trim();
if (invokedToolName && invokedToolName !== expectedToolNames[operation]) throw new Error('MCP tool identity does not match the requested operation');
const input = payload.input || payload.arguments || {};
const user = invocationUser(payload);
let result;

if (operation === 'robot-create') result = await request('/api/robots', { method: 'POST', body: { name: input.robotName, specialization: input.specialization || '' }, user });
else if (operation === 'robot-list') result = await request('/api/robots', { user });
else result = await request('/api/control', { method: 'POST', body: { operation, ...input }, user });

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
