import { createRoboTeamClient } from './roboTeamClient.mjs';

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
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
                const members = (workflow.tasks || []).map(task => task.name).join(', ');
                return `- ${workflow.id} — ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''} (${members})`;
            }).join('\n');
        }

        if (actionName === 'start') {
            const workflowTypeId = trim(request.workflowTypeId);
            if (!workflowTypeId) throw new Error('workflowTypeId is required');
            const objective = trim(request.objective);
            if (!objective) throw new Error('objective is required');
            const folder = trim(request.folder) || trim(invocation.workingDir);
            if (!folder) throw new Error('a working folder is required');
            await client.call('roboflow_start_flow', {
                workflowTypeId,
                ...(request.executionType ? { executionType: request.executionType } : {}),
                objective,
                folder,
            });
            return 'RoboFlow workflow started. It keeps running as a background task in this conversation; open that task to follow the workflow, its phases and their logs.';
        }

        throw new Error('unsupported workflow action');
    } catch (error) {
        return `Could not run the workflow action: ${error?.message || 'request failed'}`;
    }
}

export default action;
