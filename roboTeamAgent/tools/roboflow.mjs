import process from 'node:process';

const TASK_POLL_INTERVAL_MS = Math.max(50, Math.min(5000, Number(process.env.ROBOTEAM_TASK_POLL_INTERVAL_MS) || 500));
const INVOCATION_TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const FLOW_ID = /^flow_[0-9a-f]{24}$/;
const INVOCATION_ID = /^inv_[0-9a-f]{24}$/;

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, { method = 'GET', body, user = {}, timeoutMs = 29000 } = {}) {
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
        signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid service response' }));
    if (!response.ok) throw new Error(result.error || `RoboTeam request failed with ${response.status}`);
    return result;
}

function findInvocation(flow, invocationId) {
    return (flow?.invocations || []).find((invocation) => invocation.id === invocationId) || null;
}

async function invokeUntilTerminal({ flowId, body, user }) {
    const started = await request(`/api/roboflow/flows/${flowId}/invoke`, { method: 'POST', body, user });
    const invocationId = String(started.invocationId || '');
    if (!INVOCATION_ID.test(invocationId)) throw new Error('RoboFlow did not return an invocation id');
    process.stderr.write(`RoboFlow invocation ${invocationId} started for ${started.robotName} (${started.executionType}).\n`);

    let terminating = false;
    process.once('SIGTERM', () => {
        if (terminating) return;
        terminating = true;
        void request(`/api/roboflow/flows/${flowId}/stop`, { method: 'POST', user })
            .catch((error) => process.stderr.write(`Could not stop RoboFlow flow: ${error?.message || error}\n`))
            .finally(() => process.exit(143));
    });

    let previousState = '';
    while (!terminating) {
        const { flow } = await request(`/api/roboflow/flows/${flowId}?logs=none`, { user });
        const invocation = findInvocation(flow, invocationId);
        if (!invocation) throw new Error(`RoboFlow invocation ${invocationId} is unavailable`);
        if (invocation.state !== previousState) {
            process.stderr.write(`RoboFlow invocation state: ${invocation.state}.\n`);
            previousState = invocation.state;
        }
        if (INVOCATION_TERMINAL.has(invocation.state)) {
            const summary = String(invocation.summary || '').trim();
            if (invocation.state !== 'completed') {
                throw new Error(String(invocation.error || '').trim() || `RoboFlow invocation ${invocation.state}`);
            }
            return { outputText: summary, invocationId, robotName: invocation.robotName, executionType: invocation.executionType };
        }
        await sleep(TASK_POLL_INTERVAL_MS);
    }
    throw new Error('RoboFlow invocation was cancelled');
}

const expectedToolNames = {
    'list-workflows': 'roboflow_list_workflows',
    'create-workflow': 'roboflow_create_workflow',
    'delete-workflow': 'roboflow_delete_workflow',
    'create-flow': 'roboflow_create_flow',
    'list-flows': 'roboflow_list_flows',
    'get-flow': 'roboflow_get_flow',
    'invoke-member': 'roboflow_invoke_member',
    'finish-flow': 'roboflow_finish_flow',
    'stop-flow': 'roboflow_stop_flow',
};

async function main() {
    const operation = process.argv[2] || '';
    const payload = await readPayload();
    const invokedToolName = String(payload.tool || payload.toolName || payload.name || '').trim();
    if (invokedToolName && invokedToolName !== expectedToolNames[operation]) throw new Error('MCP tool identity does not match the requested operation');
    const input = payload.input || payload.arguments || {};
    const user = invocationUser(payload);

    if (operation === 'list-workflows') return output(await request('/api/roboflow/workflows', { user }));
    if (operation === 'create-workflow') return output(await request('/api/roboflow/workflows', { method: 'POST', body: input, user }));
    if (operation === 'delete-workflow') return output(await request(`/api/roboflow/workflows/${encodeURIComponent(String(input.workflowId || ''))}`, { method: 'DELETE', user }));
    if (operation === 'create-flow') return output(await request('/api/roboflow/flows', { method: 'POST', body: input, user }));
    if (operation === 'list-flows') {
        const query = input.folder ? `?folder=${encodeURIComponent(String(input.folder))}` : '';
        return output(await request(`/api/roboflow/flows${query}`, { user }));
    }
    if (operation === 'get-flow') {
        if (!FLOW_ID.test(String(input.flowId || ''))) throw new Error('invalid task flow id');
        return output(await request(`/api/roboflow/flows/${input.flowId}?logs=none`, { user }));
    }
    if (operation === 'invoke-member') {
        if (!FLOW_ID.test(String(input.flowId || ''))) throw new Error('invalid task flow id');
        const result = await invokeUntilTerminal({ flowId: input.flowId, body: { member: input.member, instruction: input.instruction, cwd: input.cwd }, user });
        return output(result);
    }
    if (operation === 'finish-flow') {
        if (!FLOW_ID.test(String(input.flowId || ''))) throw new Error('invalid task flow id');
        return output(await request(`/api/roboflow/flows/${input.flowId}/finish`, { method: 'POST', body: { result: input.result }, user }));
    }
    if (operation === 'stop-flow') {
        if (!FLOW_ID.test(String(input.flowId || ''))) throw new Error('invalid task flow id');
        return output(await request(`/api/roboflow/flows/${input.flowId}/stop`, { method: 'POST', user }));
    }
    throw new Error(`unsupported RoboFlow operation: ${operation}`);
}

function output(result) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
});
