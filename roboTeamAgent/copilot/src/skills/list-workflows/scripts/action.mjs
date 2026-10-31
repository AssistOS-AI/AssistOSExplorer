import { createRoboTeamClient } from './roboTeamClient.mjs';

export function formatWorkflows(workflows) {
    if (!workflows.length) return 'No RoboFlow workflow types are defined yet.';
    return workflows.map((workflow) => {
        const tasks = (workflow.tasks || []).map((task) => `${task.name}${task.executionType ? ` (${task.executionType})` : ''}`).join(', ');
        const mode = workflow.kind === 'default' ? ' Accepts executionType terminal (default), desktop or browser.' : '';
        const objective = (workflow.hasDefaultObjective ?? Boolean(workflow.defaultObjective)) ? ' A saved default prompt is available; omit the prompt only to run the workflow unchanged.' : ' Requires a prompt when starting.';
        return `- ${workflow.id} — ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''} Tasks: ${tasks}.${mode}${objective}`;
    }).join('\n');
}

// Lists the workspace RoboFlow workflow types with their tasks.
export async function action(invocation = {}) {
    try {
        const client = await createRoboTeamClient(invocation);
        const result = await client.call('roboflow_list_workflows', {});
        return formatWorkflows(result.workflows || []);
    } catch (error) {
        return `Could not list the workflows: ${error?.message || 'request failed'}`;
    }
}

export default action;
