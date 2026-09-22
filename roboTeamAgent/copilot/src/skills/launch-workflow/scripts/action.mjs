import { createRoboTeamClient } from './roboTeamClient.mjs';

const MONITOR_BASE = '/base-agent-additional-server/roboTeamAgent/3001/roboflow';
const FLOW_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function monitorLink(flowId) {
    return `${MONITOR_BASE}?flow=${encodeURIComponent(flowId)}`;
}

function remoteTaskId(started) {
    return trim(started?.metadata?.taskId || started?.result?.metadata?.taskId || started?.taskId);
}

function taskResultText(task) {
    const content = task?.result?.content;
    if (Array.isArray(content)) return content.map((entry) => trim(entry?.text)).filter(Boolean).join('\n');
    return trim(task?.result?.outputText || task?.outputText);
}

async function waitForTask(client, taskId) {
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
        const task = await client.getTaskStatus(taskId);
        if (FLOW_TERMINAL.has(trim(task?.status).toLowerCase())) return task;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('the RoboFlow task flow did not finish in time');
}

export function normalizeRequest(promptText) {
    const text = trim(promptText);
    if (!text) throw new Error('a workflow start request is required');
    if (text.startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { throw new Error('the JSON workflow request is invalid'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the JSON workflow request must be an object');
        return parsed;
    }
    const [action, ...rest] = text.split(/\s+/);
    const remainder = rest.join(' ');
    if (action === 'list-workflows') return { action };
    if (action === 'start') {
        const separator = remainder.indexOf('::');
        if (separator < 0) throw new Error('use start <workflowTypeId> :: <objective>');
        return { action, workflowTypeId: trim(remainder.slice(0, separator)), objective: trim(remainder.slice(separator + 2)) };
    }
    throw new Error('unsupported workflow action');
}

export async function action(invocation = {}) {
    try {
        const request = normalizeRequest(invocation.promptText);
        const client = await createRoboTeamClient(invocation);
        const actionName = trim(request.action);

        if (actionName === 'list-workflows') {
            const result = await client.call('roboflow_list_workflows', {});
            const workflows = result.workflows || [];
            if (!workflows.length) return 'No RoboFlow workflow types are defined yet.';
            return workflows.map((workflow) => {
                const members = workflow.members.map((member) => `${member.robotName}/${member.executionType}`).join(', ');
                return `- ${workflow.id} — ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''} (${members})`;
            }).join('\n');
        }

        if (actionName === 'start') {
            const workflowTypeId = trim(request.workflowTypeId);
            if (!workflowTypeId) throw new Error('workflowTypeId is required');
            const objective = trim(request.objective);
            if (!objective) throw new Error('objective is required');
            const started = await client.call('roboflow_start_flow', {
                workflowTypeId,
                objective,
                ...(trim(request.folder || invocation.workingDir) ? { folder: trim(request.folder || invocation.workingDir) } : {}),
            });
            const taskId = remoteTaskId(started);
            if (!taskId) throw new Error('RoboFlow did not return a task id');
            const task = await waitForTask(client, taskId);
            const status = trim(task?.status).toLowerCase();
            if (status !== 'completed') throw new Error(trim(task?.error) || `RoboFlow task flow ${status}`);
            const raw = taskResultText(task);
            let payload = null;
            try { payload = JSON.parse(raw); } catch { /* plain text result */ }
            const summary = trim(payload?.outputText || raw);
            const flowId = trim(payload?.flowId);
            const link = flowId ? ` Monitor it at ${monitorLink(flowId)}.` : '';
            return `RoboFlow task flow finished.${link}\n${summary || '(empty result)'}`;
        }

        throw new Error('unsupported workflow action');
    } catch (error) {
        return `Could not run the workflow action: ${error?.message || 'request failed'}`;
    }
}

export default action;
