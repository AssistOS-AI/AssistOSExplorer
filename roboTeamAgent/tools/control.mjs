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

// robot_list is the only internal listing exception: the AgentServer-verified
// grant must name an agent acting for itself, with no delegated or forwarded
// user identity. Any other caller is rejected before an HTTP request is made.
function agentOwnBehalf(payload) {
    const grant = payload?.metadata?.invocation;
    if (!grant || typeof grant !== 'object') return false;
    const subject = typeof grant.sub === 'string' ? grant.sub : '';
    return grant.actor?.kind === 'agent'
        && /^agent:.+/.test(subject)
        && grant.actor.id === subject
        && !grant.usr && !grant.user && !grant.delegation
        && !payload.metadata.user;
}

const GIT_CREDENTIALS_OPERATIONS = {
    'git-credentials-targets': 'targets',
    'git-credentials-save': 'save',
    'git-credentials-delete': 'delete',
};

// The only caller of the robot git credential tools: gitAgent of RoboTeam's own repository, named from
// RoboTeam's principal (agent:<repo>/roboTeamAgent) unless ROBOTEAM_GIT_CREDENTIALS_CALLER names it exactly.
function gitCredentialsCaller(env = process.env) {
    const override = String(env.ROBOTEAM_GIT_CREDENTIALS_CALLER || '').trim();
    if (override) return override;
    const own = String(env.PLOINKY_AGENT_PRINCIPAL || env.PLOINKY_AGENT_ID || '').trim();
    const repository = own.match(/^agent:([^/]+)\/[^/]+$/u)?.[1];
    return repository ? `agent:${repository}/gitAgent` : '';
}

// The AgentServer-verified grant must name gitAgent acting as itself (sub === actor.id) for a delegated
// user that is not a guest. A direct user, another agent, an agent without a delegated user, or a
// delegation that does not list the invoked tool is refused before any HTTP request is made.
function gitCredentialsUser(payload, toolName, env = process.env) {
    const grant = payload?.metadata?.invocation;
    const caller = gitCredentialsCaller(env);
    if (!caller || !grant || typeof grant !== 'object') return null;
    if (grant.actor?.kind !== 'agent' || grant.sub !== caller || grant.actor.id !== caller) return null;
    const delegated = grant.usr;
    if (!delegated || typeof delegated !== 'object' || !grant.delegation || typeof grant.delegation !== 'object') return null;
    if (Array.isArray(grant.delegation.tools) && !grant.delegation.tools.includes(toolName)) return null;
    const id = String(delegated.id || '').replace(/^user:/iu, '').trim();
    const roles = Array.isArray(delegated.roles) ? delegated.roles.map((role) => String(role || '').trim()) : [];
    if (!id || roles.some((role) => role.toLowerCase() === 'guest')) return null;
    const username = String(delegated.username || delegated.displayName || delegated.email || id).trim();
    return { id, username, roles };
}

async function request(pathname, { method = 'GET', body, user = {}, listingOrigin = '', timeoutMs = 29000 }) {
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
            ...(user.username ? { 'x-roboteam-user-name': encodeURIComponent(user.username) } : {}),
            ...(listingOrigin ? { 'x-roboteam-listing-origin': listingOrigin } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid service response' }));
    if (!response.ok) {
        throw Object.assign(new Error(result.error || `RoboTeam request failed with ${response.status}`), {
            statusCode: response.status, ...(typeof result.code === 'string' ? { code: result.code } : {}),
        });
    }
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
    if (!['desktop', 'browser', 'simple'].includes(started.type)) return null;
    return {
        version: 1,
        handle: encodeContinuationHandle(started.robotId, robotTaskId),
        toolName: CONTINUATION_TOOL,
        messageToolName: 'sendMessageToRobotTask',
    };
}

async function runTaskUntilTerminal({ operation, input, user }) {
    const startInput = operation === 'resume-task'
        ? { operation, ...decodeContinuationHandle(input.handle), prompt: input.prompt }
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
    if (continuation) process.stderr.write(`\n@@PLOINKY_TASK_CONTROL@@${JSON.stringify(continuation)}\n`);
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
    let previousBlockedReason = '';
    while (!terminating) {
        const statusResult = await request('/api/control', {
            method: 'POST',
            body: { operation: 'task-status', robotId: started.robotId, robotName: input.robotName, taskId: robotTaskId },
            user,
        });
        const task = statusResult.task;
        if (!task) throw new Error(`RoboTeam task ${robotTaskId} is unavailable`);
        const nextTail = typeof task.logTail === 'string' ? task.logTail : '';
        const delta = logDelta(previousTail, nextTail);
        if (delta) process.stderr.write(delta);
        previousTail = nextTail;
        if (task.state !== previousState && task.state !== 'completed') {
            process.stderr.write(`RoboTeam task state: ${task.state}.\n`);
            previousState = task.state;
        }
        if (task.blockedReason === 'manual-control' && previousBlockedReason !== task.blockedReason) {
            process.stderr.write('RoboTeam queue is paused for manual control. Resume the interrupted task, or stop the remaining queued GUI tasks and launch a new one.\n');
        }
        previousBlockedReason = task.blockedReason || '';
        if (task.state === 'completed') {
            const outputText = String(task.result || '').trim();
            return { outputText, ...(continuation ? { continuation } : {}) };
        }
        if (task.state === 'failed' || task.state === 'paused') {
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
    'message-task': 'sendMessageToRobotTask',
    'task-status': 'getTaskStatusForRobot', 'desktop-url': 'getSessionUrlForRobotDesktop',
    'browser-url': 'getSessionUrlForRobotBrowser', 'stop-desktop-container': 'stopDesktopContainerForRobot',
    'stop-browser-container': 'stopBrowserContainerForRobot',
    'git-credentials-targets': 'robot_git_credentials_targets',
    'git-credentials-save': 'robot_git_credentials_save',
    'git-credentials-delete': 'robot_git_credentials_delete',
};

async function main() {
    const payload = await readPayload();
    const invokedToolName = String(payload.tool || payload.toolName || payload.name || '').trim();
    if (invokedToolName && invokedToolName !== expectedToolNames[operation]) throw new Error('MCP tool identity does not match the requested operation');
    const input = payload.input || payload.arguments || {};
    const user = invocationUser(payload);
    let result;

    if (GIT_CREDENTIALS_OPERATIONS[operation]) {
        const delegated = gitCredentialsUser(payload, expectedToolNames[operation]);
        if (!delegated) {
            throw Object.assign(new Error('Access denied: robot git credentials are available only to gitAgent acting for a signed-in user.'), {
                code: 'ROBOT_CREDENTIALS_CALLER_REFUSED', statusCode: 403,
            });
        }
        // Only the documented fields are forwarded; the token is never written to output or logs.
        const body = operation === 'git-credentials-save'
            ? { robotName: input.robotName, token: input.token, githubLogin: input.githubLogin, name: input.name, email: input.email }
            : operation === 'git-credentials-delete' ? { robotName: input.robotName } : {};
        result = await request(`/api/git-credentials/${GIT_CREDENTIALS_OPERATIONS[operation]}`, { method: 'POST', body, user: delegated, timeoutMs: 55000 });
    }
    else if (operation === 'robot-create') result = await request('/api/robots', { method: 'POST', body: { name: input.robotName, codingAgents: input.codingAgents }, user });
    else if (operation === 'robot-list') {
        if (!agentOwnBehalf(payload)) throw new Error('Access denied: robot_list is available only to an agent acting on its own behalf.');
        result = await request('/api/robots', { listingOrigin: 'agent' });
        // Repository management includes disabled combinations; discovery must omit them.
        for (const robot of result.robots || []) {
            for (const repo of robot.repositories || []) {
                repo.skillsets = (repo.skillsets || []).filter(set => set.enabled !== false);
                repo.skills = (repo.skills || []).filter(skill => skill.enabled !== false);
            }
        }
    }
    else if (operation === 'message-task') result = await request('/api/control', {
        method: 'POST', body: { operation, ...decodeContinuationHandle(input.handle), prompt: input.prompt }, user,
        timeoutMs: 40000,
    });
    else if (['start-desktop-task', 'start-browser-task', 'start-simple-task', 'resume-task'].includes(operation)) result = await runTaskUntilTerminal({ operation, input, user });
    else result = await request('/api/control', { method: 'POST', body: { operation, ...input }, user });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    // Robot git credential tools report a structured failure that gitAgent can show; it never contains the token.
    if (GIT_CREDENTIALS_OPERATIONS[operation]) {
        process.stderr.write(`${JSON.stringify({ ok: false, code: typeof error?.code === 'string' ? error.code : 'ROBOT_CREDENTIALS_FAILED',
            statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 500, error: String(error?.message || 'robot git credentials request failed') })}\n`);
    } else {
        process.stderr.write(`${error?.message || error}\n`);
    }
    process.exitCode = 1;
});
