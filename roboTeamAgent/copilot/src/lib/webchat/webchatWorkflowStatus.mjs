import { executionTiming } from '../../../../shared/execution-timing.mjs';

export function workflowIdForTask(task) {
    if (task?.targetAgent !== 'roboTeamAgent' || task.toolName !== 'roboflow_start_flow') return null;
    try {
        const url = new URL(task.details?.url, 'http://localhost');
        const id = url.searchParams.get('flowId');
        return /^flow_[0-9a-f]{24}$/.test(id || '') ? id : null;
    } catch { return null; }
}

export async function readWorkflowTask(task, agentClientModule, { pause = false } = {}) {
    const flowId = workflowIdForTask(task);
    if (!flowId) throw new Error('workflow_task_reference_missing');
    const client = await agentClientModule.createAgentClient(task.targetAgent);
    const result = await client.callTool(pause ? 'roboflow_pause_flow' : 'roboflow_flow_state', { flowId });
    if (result?.isError) throw new Error('workflow_status_unavailable');
    const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const payload = text ? JSON.parse(text) : result;
    const flow = payload?.flow;
    if (flow?.id !== flowId || !['running', 'paused', 'failed', 'completed', 'terminated'].includes(flow.status)) {
        throw new Error('invalid_workflow_status');
    }
    return { flow, timing: executionTiming(flow, flow.status === 'running', flow.createdAt, flow.finishedAt) };
}
