import { createRoboTeamClient } from './roboTeamClient.mjs';

const MONITOR_BASE = '/base-agent-additional-server/roboTeamAgent/3001/roboflow';

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function monitorLink(flowId) {
    return `${MONITOR_BASE}?flow=${encodeURIComponent(flowId)}`;
}

const INVOCATION_TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function remoteTaskId(started) {
    return trim(started?.metadata?.taskId || started?.result?.metadata?.taskId || started?.taskId);
}

function taskResultText(task) {
    const content = task?.result?.content;
    if (Array.isArray(content)) return content.map((entry) => trim(entry?.text)).filter(Boolean).join('\n');
    return trim(task?.result?.outputText || task?.outputText);
}

async function waitForTask(client, taskId) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
        const task = await client.getTaskStatus(taskId);
        if (INVOCATION_TERMINAL.has(trim(task?.status).toLowerCase())) return task;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('the RoboFlow invocation did not finish in time');
}

export function normalizeRequest(promptText) {
    const text = trim(promptText);
    if (!text) throw new Error('roboflow action is required');
    if (text.startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { throw new Error('the JSON RoboFlow request is invalid'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the JSON RoboFlow request must be an object');
        return parsed;
    }
    const [action, ...rest] = text.split(/\s+/);
    const remainder = rest.join(' ');
    if (action === 'list-workflows' || action === 'list-flows') return { action };
    if (action === 'create-flow') {
        const separator = remainder.indexOf('::');
        if (separator < 0) throw new Error('use create-flow <workflowTypeId> :: <objective>');
        return { action, workflowTypeId: trim(remainder.slice(0, separator)), objective: trim(remainder.slice(separator + 2)) };
    }
    if (action === 'invoke') {
        const [flowId, member, ...instruction] = remainder.split(/\s+/);
        return { action, flowId, member, instruction: instruction.join(' ') };
    }
    if (action === 'get' || action === 'finish' || action === 'stop') {
        const [flowId, ...result] = remainder.split(/\s+/);
        return { action, flowId, ...(result.length ? { result: result.join(' ') } : {}) };
    }
    throw new Error('unsupported RoboFlow action');
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

        if (actionName === 'create-flow') {
            const result = await client.call('roboflow_create_flow', {
                workflowTypeId: trim(request.workflowTypeId),
                objective: trim(request.objective),
                ...(trim(request.folder) ? { folder: trim(request.folder) } : {}),
            });
            const flow = result.flow;
            return `Task flow ${flow.id} created. Monitor it at [RoboFlow](${monitorLink(flow.id)}).`;
        }

        if (actionName === 'list-flows') {
            const result = await client.call('roboflow_list_flows', trim(request.folder) ? { folder: trim(request.folder) } : {});
            const flows = result.flows || [];
            if (!flows.length) return 'No task flows exist.';
            return flows.map((flow) => `- ${flow.id} — ${flow.status} — ${flow.objective} ([monitor](${monitorLink(flow.id)}))`).join('\n');
        }

        if (actionName === 'get') {
            const result = await client.call('roboflow_get_flow', { flowId: trim(request.flowId) });
            const flow = result.flow;
            const lines = [`${flow.workflowName} — ${flow.status} — ${flow.objective}`, `Monitor: ${monitorLink(flow.id)}`];
            for (const invocation of flow.invocations) {
                lines.push(`- ${invocation.robotName}/${invocation.executionType} [${invocation.state}]: ${invocation.summary || invocation.error || '(no summary yet)'}`);
            }
            return lines.join('\n');
        }

        if (actionName === 'invoke') {
            const started = await client.call('roboflow_invoke_member', {
                flowId: trim(request.flowId),
                member: trim(request.member),
                instruction: trim(request.instruction),
                ...(trim(request.cwd) ? { cwd: trim(request.cwd) } : {}),
            });
            const taskId = remoteTaskId(started);
            if (!taskId) throw new Error('RoboFlow did not return a task id');
            const task = await waitForTask(client, taskId);
            const status = trim(task?.status).toLowerCase();
            if (status !== 'completed') throw new Error(trim(task?.error) || `RoboFlow invocation ${status}`);
            const summary = taskResultText(task);
            return `Robot run finished. Summary:\n${summary || '(empty result)'}`;
        }

        if (actionName === 'finish') {
            await client.call('roboflow_finish_flow', { flowId: trim(request.flowId), result: trim(request.result) });
            return `Task flow ${trim(request.flowId)} finished.`;
        }

        if (actionName === 'stop') {
            await client.call('roboflow_stop_flow', { flowId: trim(request.flowId) });
            return `Task flow ${trim(request.flowId)} stopped.`;
        }

        throw new Error('unsupported RoboFlow action');
    } catch (error) {
        return `Could not run the RoboFlow action: ${error?.message || 'request failed'}`;
    }
}

export default action;
