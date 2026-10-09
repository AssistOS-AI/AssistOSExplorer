import { createRoboTeamClient } from './roboTeamClient.mjs';

// Lists the workspace RoboFlow workflow types with their tasks.
export async function action(invocation = {}) {
    try {
        const client = await createRoboTeamClient(invocation);
        const result = await client.call('roboflow_list_workflows', {});
        const workflows = result.workflows || [];
        if (!workflows.length) return 'No RoboFlow workflow types are defined yet.';
        return workflows.map((workflow) => {
            const tasks = (workflow.tasks || []).map((task) => `${task.name}${task.executionType ? ` (${task.executionType})` : ''}`).join(', ');
            // A workflow whose tasks support several modes needs executionType when started.
            const modes = [...new Set([...(workflow.supportedExecutionTypes || []),
                ...(workflow.tasks || []).flatMap((task) => task.supportedExecutionTypes || [])])];
            const choice = modes.length ? ` Choose executionType when starting: ${modes.join(', ')}.` : '';
            const objective = workflow.defaultObjective ? ' A saved default objective is available; omit objective only to run the workflow unchanged.' : ' Requires an explicit objective when starting.';
            return `- ${workflow.id} — ${workflow.name}${workflow.description ? ` — ${workflow.description}` : ''} Tasks: ${tasks}.${choice}${objective}`;
        }).join('\n');
    } catch (error) {
        return `Could not list the workflows: ${error?.message || 'request failed'}`;
    }
}

export default action;
