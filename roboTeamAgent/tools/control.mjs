import process from 'node:process';

const TASK_POLL_INTERVAL_MS = Math.max(25, Math.min(5000, Number(process.env.ROBOTEAM_TASK_POLL_INTERVAL_MS) || 500));

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDelta(previousTail, nextTail) {
    if (!nextTail) return '';
    if (!previousTail) return nextTail;
    if (nextTail.startsWith(previousTail)) return nextTail.slice(previousTail.length);
    const maximum = Math.min(previousTail.length, nextTail.length);
    for (let size = maximum; size > 0; size -= 1) {
        if (previousTail.slice(-size) === nextTail.slice(0, size)) return nextTail.slice(size);
    }
    return `\n[RoboTeam task log restarted or was truncated]\n${nextTail}`;
}

async function runTaskUntilTerminal({ operation, input, user }) {
    const started = await request('/api/control', { method: 'POST', body: { operation, ...input }, user });
    const robotTaskId = String(started.taskId || '').trim();
    if (!robotTaskId) throw new Error('RoboTeam did not return a task id');
    if (started.sessionUrl) process.stderr.write(`RoboTeam live session: ${started.sessionUrl}\n`);
    process.stderr.write(`RoboTeam task ${robotTaskId} queued.\n`);

    const stopOperations = {
        'start-desktop-task': 'stop-desktop-task',
        'start-browser-task': 'stop-browser-task',
        'start-simple-task': 'stop-simple-task',
    };
    let terminating = false;
    process.once('SIGTERM', () => {
        if (terminating) return;
        terminating = true;
        void request('/api/control', {
            method: 'POST',
            body: { operation: stopOperations[operation], robotName: input.robotName, taskId: robotTaskId },
            user,
        }).catch(() => {}).finally(() => process.exit(143));
    });

    let previousTail = '';
    let previousState = '';
    while (!terminating) {
        const statusResult = await request('/api/control', {
            method: 'POST',
            body: { operation: 'task-status', robotName: input.robotName, taskId: robotTaskId },
            user,
        });
        const task = statusResult.task;
        if (!task) throw new Error(`RoboTeam task ${robotTaskId} is unavailable`);
        const nextTail = typeof task.logTail === 'string' ? task.logTail : '';
        const delta = logDelta(previousTail, nextTail);
        if (delta) process.stderr.write(delta);
        previousTail = nextTail;
        if (task.state !== previousState) {
            process.stderr.write(`RoboTeam task state: ${task.state}.\n`);
            previousState = task.state;
        }
        if (task.state === 'completed') {
            const outputText = String(task.result || '').trim() || `RoboTeam ${task.type} task completed.`;
            return { outputText };
        }
        if (task.state === 'failed' || task.state === 'stopped') {
            throw new Error(String(task.error || '').trim() || `RoboTeam task ${task.state}`);
        }
        await sleep(TASK_POLL_INTERVAL_MS);
    }
    throw new Error('RoboTeam task was cancelled');
}

const operation = process.argv[2] || '';
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

async function main() {
    const payload = await readPayload();
    const invokedToolName = String(payload.tool || payload.toolName || payload.name || '').trim();
    if (invokedToolName && invokedToolName !== expectedToolNames[operation]) throw new Error('MCP tool identity does not match the requested operation');
    const input = payload.input || payload.arguments || {};
    const user = invocationUser(payload);
    let result;

    if (operation === 'robot-create') result = await request('/api/robots', { method: 'POST', body: { name: input.robotName, specialization: input.specialization || '' }, user });
    else if (operation === 'robot-list') result = await request('/api/robots', { user });
    else if (['start-desktop-task', 'start-browser-task', 'start-simple-task'].includes(operation)) result = await runTaskUntilTerminal({ operation, input, user });
    else result = await request('/api/control', { method: 'POST', body: { operation, ...input }, user });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
});
