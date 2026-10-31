import { createRoboTeamClient } from './roboTeamClient.mjs';

export function formatWorkflows(workflows, { workerMode = false } = {}) {
    if (!workflows.length) return 'No RoboFlow workflow types are defined yet.';
    return workflows.map((workflow) => {
        const tasks = (workflow.tasks || []).map((task) => `${task.name}${task.executionType ? ` (${task.executionType})` : ''}`).join(', ');
        const mode = workflow.kind === 'default'
            ? (workerMode ? ' Supported modes: terminal, desktop or browser.' : ' Accepts executionType terminal (default), desktop or browser.') : '';
        const hasDefaultObjective = workflow.hasDefaultObjective ?? Boolean(workflow.defaultObjective);
        const objective = workerMode
            ? (hasDefaultObjective ? ' A saved default prompt is available.' : ' No saved default prompt.')
            : (hasDefaultObjective ? ' A saved default prompt is available; omit the prompt only to run the workflow unchanged.' : ' Requires a prompt when starting.');
        return `- ${workflow.id} — ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''} Tasks: ${tasks}.${mode}${objective}`;
    }).join('\n') + (workerMode ? '\nStart workflows from the RoboFlow page.' : '');
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
