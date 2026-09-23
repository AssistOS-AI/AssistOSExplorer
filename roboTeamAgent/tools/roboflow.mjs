import process from 'node:process';

const TASK_POLL_INTERVAL_MS = Math.max(50, Math.min(5000, Number(process.env.ROBOTEAM_TASK_POLL_INTERVAL_MS) || 500));
const FLOW_TERMINAL = new Set(['completed', 'failed', 'stopped']);
const lifetime = new AbortController();
process.once('SIGTERM', () => lifetime.abort());
const FLOW_ID = /^flow_[0-9a-f]{24}$/;
const MONITOR_BASE = String(process.env.ROBOTEAM_MONITOR_BASE || '/base-agent-additional-server/roboTeamAgent/3001/roboflow');

function monitorUrl(flowId) {
    return `${MONITOR_BASE}?flowId=${encodeURIComponent(flowId)}`;
}

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

async function request(pathname, { method = 'GET', body, user = {}, timeoutMs = 29000, ignoreCancellation = false } = {}) {
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
        signal: ignoreCancellation ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const result = await response.json().catch(() => ({ ok: false, error: 'invalid service response' }));
    if (!response.ok) throw new Error(result.error || `RoboTeam request failed with ${response.status}`);
    return result;
}

async function startFlowUntilTerminal({ body, user }) {
    const started = await request('/api/roboflow/flows', { method: 'POST', body, user, ignoreCancellation: true });
    const flowId = String(started.flow?.id || '');
    if (!FLOW_ID.test(flowId)) throw new Error('RoboFlow did not return a task flow id');
    const link = monitorUrl(flowId);
    process.stderr.write(`@@PLOINKY_TASK_CONTROL@@${JSON.stringify({ details: { url: link, label: 'Open workflow page', logsLabel: 'View workflow logs' } })}\n`);
    process.stderr.write(`RoboFlow task flow ${flowId} started.\n`);

    let terminating = false;
    const cancelFlow = () => {
        if (terminating) return;
        terminating = true;
        void request(`/api/roboflow/flows/${flowId}/stop`, { method: 'POST', user, ignoreCancellation: true })
            .catch((error) => process.stderr.write(`Could not stop RoboFlow flow: ${error?.message || error}\n`))
            .finally(() => process.exit(143));
    };
    process.once('SIGTERM', cancelFlow);
    if (lifetime.signal.aborted) cancelFlow();

    let previousStatus = '';
    while (!terminating) {
        const { flow } = await request(`/api/roboflow/flows/${flowId}?logs=none`, { user });
        if (flow.status !== previousStatus) {
            process.stderr.write(`RoboFlow task flow status: ${flow.status}.\n`);
            previousStatus = flow.status;
        }
        if (FLOW_TERMINAL.has(flow.status)) {
            if (flow.status !== 'completed') {
                throw new Error(String(flow.error || '').trim() || `RoboFlow task flow ended ${flow.status}`);
            }
            return { outputText: String(flow.result || '').trim(), flowId, status: flow.status };
        }
        await sleep(TASK_POLL_INTERVAL_MS);
    }
    throw new Error('RoboFlow task flow was cancelled');
}

const expectedToolNames = {
    'list-workflows': 'roboflow_list_workflows',
    'create-workflow': 'roboflow_create_workflow',
    'update-workflow': 'roboflow_update_workflow',
    'delete-workflow': 'roboflow_delete_workflow',
    'start-flow': 'roboflow_start_flow',
    'flow-state': 'roboflow_flow_state',
    'generate-workflow': 'roboflow_generate_workflow',
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
    if (operation === 'update-workflow') return output(await request(`/api/roboflow/workflows/${encodeURIComponent(String(input.workflowId || ''))}`, { method: 'PUT', body: input, user }));
    if (operation === 'delete-workflow') return output(await request(`/api/roboflow/workflows/${encodeURIComponent(String(input.workflowId || ''))}`, { method: 'DELETE', user }));
    if (operation === 'start-flow') {
        const result = await startFlowUntilTerminal({ body: { workflowTypeId: input.workflowTypeId, objective: input.objective, folder: input.folder, executionType: input.executionType }, user });
        return output(result);
    }
    if (operation === 'flow-state') {
        if (!FLOW_ID.test(String(input.flowId || ''))) throw new Error('invalid task flow id');
        return output(await request(`/api/roboflow/flows/${input.flowId}?logs=none`, { user }));
    }
    if (operation === 'generate-workflow') {
        return output(await request('/api/roboflow/generate', { method: 'POST', body: input, user, timeoutMs: 3600000 }));
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
