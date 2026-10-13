import { createRoboTeamClient } from './roboTeamClient.mjs';

// Only the Standard development workflow takes an execution mode; it runs in a terminal unless one is given.
const DEFAULT_WORKFLOW_ID = 'default';
const EXECUTION_TYPES = ['terminal', 'desktop', 'browser'];
const REQUIRES_PROMPT = ['default', 'code-development'];

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Accepts `<workflow>`, `<workflow> :: <prompt>` or {"workflow":"<id>","prompt":"<task>","executionType":"<mode>"}.
export function normalizeRequest(promptText) {
    const text = trim(promptText);
    if (!text) throw new Error('a workflow name is required');
    if (text.startsWith('{')) {
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { throw new Error('the JSON workflow request is invalid'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the JSON workflow request must be an object');
        if (parsed.prompt !== undefined && typeof parsed.prompt !== 'string') throw new Error('prompt must be text');
        if (parsed.executionType !== undefined && typeof parsed.executionType !== 'string') throw new Error('executionType must be text');
        return { workflow: trim(parsed.workflow), prompt: trim(parsed.prompt),
            ...(trim(parsed.executionType) ? { executionType: trim(parsed.executionType) } : {}) };
    }
    const separator = text.indexOf('::');
    if (separator < 0) return { workflow: text, prompt: '' };
    return { workflow: trim(text.slice(0, separator)), prompt: trim(text.slice(separator + 2)) };
}

export async function action(invocation = {}) {
    try {
        const { workflow, prompt, executionType } = normalizeRequest(invocation.promptText);
        if (!workflow) throw new Error('a workflow name is required');
        if (/\s/.test(workflow)) throw new Error('the workflow name must be a single id from list-workflows');
        if (executionType && workflow !== DEFAULT_WORKFLOW_ID) throw new Error('executionType is only for the default workflow');
        if (executionType && !EXECUTION_TYPES.includes(executionType)) throw new Error(`executionType must be one of ${EXECUTION_TYPES.join(', ')}`);
        if (!prompt && REQUIRES_PROMPT.includes(workflow)) throw new Error('This workflow requires a prompt');
        const folder = trim(invocation.workingDir);
        if (!folder) throw new Error('a working folder is required');
        const client = await createRoboTeamClient(invocation);
        await client.call('roboflow_start_flow', {
            workflowTypeId: workflow,
            ...(workflow === DEFAULT_WORKFLOW_ID ? { executionType: executionType || 'terminal' } : {}),
            ...(prompt ? { objective: prompt } : {}),
            folder,
        });
        return 'RoboFlow workflow started. It keeps running as a background task in this conversation; open that task to follow the workflow, its phases and their logs.';
    } catch (error) {
        return `Could not start the workflow: ${error?.message || 'request failed'}`;
    }
}

export default action;
