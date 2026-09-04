import process from 'node:process';

const TASK_POLL_INTERVAL_MS = Math.max(25, Math.min(5000, Number(process.env.ROBOTEAM_TASK_POLL_INTERVAL_MS) || 500));
const ROBOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROBOT_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTINUATION_TOOL = 'resumeTaskForRobot';

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

function encodeContinuationHandle(robotId, taskId) {
    if (!ROBOT_ID_PATTERN.test(String(robotId || '')) || !ROBOT_TASK_ID_PATTERN.test(String(taskId || ''))) {
        throw new Error('RoboTeam returned an invalid resumable task identity');
    }
    return Buffer.from(JSON.stringify({ robotId, taskId }), 'utf8').toString('base64url');
}

function decodeContinuationHandle(handle) {
    const value = String(handle || '').trim();
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(value)) throw new Error('invalid RoboTeam continuation handle');
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw new Error('invalid RoboTeam continuation handle');
    }
    if (!ROBOT_ID_PATTERN.test(String(decoded?.robotId || ''))
        || !ROBOT_TASK_ID_PATTERN.test(String(decoded?.taskId || ''))
        || encodeContinuationHandle(decoded.robotId, decoded.taskId) !== value) {
        throw new Error('invalid RoboTeam continuation handle');
    }
    return decoded;
}

function continuationFor(started, robotTaskId) {
    if (!['desktop', 'browser'].includes(started.type)) return null;
    return {
        version: 1,
        handle: encodeContinuationHandle(started.robotId, robotTaskId),
        toolName: CONTINUATION_TOOL,
    };
}

async function runTaskUntilTerminal({ operation, input, user }) {
    const startInput = operation === 'resume-task'
        ? { operation, ...decodeContinuationHandle(input.handle) }
        : { operation, ...input };
    const started = await request('/api/control', { method: 'POST', body: startInput, user });
    const robotTaskId = String(started.taskId || '').trim();
    if (!robotTaskId) throw new Error('RoboTeam did not return a task id');
    if (started.sessionUrl) process.stderr.write(`RoboTeam live session: ${started.sessionUrl}\n`);
    process.stderr.write(`RoboTeam task ${robotTaskId} queued.\n`);

    const stopOperation = ['desktop', 'browser'].includes(started.type)
        ? 'take-control'
        : 'stop-simple-task';
    const continuation = continuationFor(started, robotTaskId);
    let terminating = false;
    process.once('SIGTERM', () => {
        if (terminating) return;
        terminating = true;
        void request('/api/control', {
            method: 'POST',
            body: { operation: stopOperation, robotId: started.robotId, taskId: robotTaskId },
            user,
        }).then(() => new Promise((resolve) => {
            if (!continuation) return resolve();
            process.stdout.write(`${JSON.stringify({ outputText: '', continuation })}\n`, resolve);
        })).catch((error) => {
            process.stderr.write(`Could not stop RoboTeam task: ${error?.message || error}\n`);
        }).finally(() => process.exit(143));
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
    'resume-task': CONTINUATION_TOOL,
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
    else if (['start-desktop-task', 'start-browser-task', 'start-simple-task', 'resume-task'].includes(operation)) result = await runTaskUntilTerminal({ operation, input, user });
    else result = await request('/api/control', { method: 'POST', body: { operation, ...input }, user });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
});
