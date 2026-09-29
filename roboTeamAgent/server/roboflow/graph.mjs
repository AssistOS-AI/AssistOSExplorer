import { EXECUTION_TYPES, WORKFLOW_ID_PATTERN } from './constants.mjs';

export const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
export const slugifyWorkflow = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow';
export const RUN_WORKFLOWS_ID = 'run-workflows';
export const isCoordinator = task => task?.kind === 'run-workflows';
export const hasCreators = graph => graph.tasks.some(task => task.creator === true);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
export function textField(value, name, max, required = false) {
    if (typeof value !== 'string' && value !== undefined) throw invalid(`${name} must be text`);
    const text = (value || '').trim();
    if ((required && !text) || text.length > max) throw invalid(`${name} requires ${required ? '1' : '0'} to ${max} characters`);
    return text;
}
export function normalizeWorkflow(input, { id, builtin = false } = {}) {
    const name = textField(input?.name, 'name', 120, true);
    const workflowId = id || input.id || slugifyWorkflow(name);
    if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw invalid('invalid workflow id');
    if (!builtin && (workflowId === 'default' || input.kind || input.members || input.decisionMemberId)) throw invalid('reserved or obsolete workflow fields');
    if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 100) throw invalid('workflow requires 1 to 100 tasks');
    const ids = new Set();
    const tasks = input.tasks.map(task => {
        if (!task || !identifier.test(task.id) || ids.has(task.id)) throw invalid('task IDs must be valid and unique');
        ids.add(task.id);
        if (task.kind !== undefined && task.kind !== 'run-workflows') throw invalid('invalid task kind');
        if (task.creator !== undefined && typeof task.creator !== 'boolean') throw invalid('creator must be boolean');
        if (isCoordinator(task)) {
            if (builtin || task.id !== RUN_WORKFLOWS_ID || task.creator || task.robotId || task.robotName || task.executionType || task.prompt || task.skillsets?.length) throw invalid('Run workflows is a managed node without a robot, prompt or skills');
            return { id: RUN_WORKFLOWS_ID, name: 'Run workflows', kind: 'run-workflows', skillsets: [] };
        }
        if (task.id === RUN_WORKFLOWS_ID) throw invalid('reserved coordinator task id');
        if (builtin && task.creator) throw invalid('default workflow cannot contain creators');
        if (task.robotName || task.robotId) throw invalid('tasks cannot select robots');
        if (!builtin && !EXECUTION_TYPES.includes(task.executionType)) throw invalid('invalid execution type');
        if (!Array.isArray(task.skillsets) || task.skillsets.length > 100 || task.skillsets.some(s => typeof s !== 'string' || !s || s.length > 512)) throw invalid('invalid task skillsets');
        return { id: task.id, name: textField(task.name, 'task name', 120, true),
            ...(task.creator ? { creator: true } : {}), prompt: textField(task.prompt, 'task prompt', 16000, true), skillsets: [...new Set(task.skillsets)],
            ...(builtin ? { supportedExecutionTypes: [...EXECUTION_TYPES] } : { executionType: task.executionType }) };
    });
    const creators = tasks.filter(task => task.creator);
    if (creators.length && !ids.has(RUN_WORKFLOWS_ID)) {
        if (tasks.length >= 100) throw invalid('workflow requires room for its Run workflows node');
        tasks.push({ id: RUN_WORKFLOWS_ID, name: 'Run workflows', kind: 'run-workflows', skillsets: [] });
        ids.add(RUN_WORKFLOWS_ID);
    }
    if (!creators.length && ids.has(RUN_WORKFLOWS_ID)) throw invalid('Run workflows requires a creator');
    if (input.entryTaskId === RUN_WORKFLOWS_ID) throw invalid('Run workflows cannot be the entry task');
    if (!ids.has(input.entryTaskId)) throw invalid('entryTaskId must identify a task');
    if (!Array.isArray(input.edges) || input.edges.length > 1000) throw invalid('edges must contain at most 1000 entries');
    const edgeIds = new Set();
    const edges = input.edges.map(edge => {
        if (!edge || !identifier.test(edge.id) || edgeIds.has(edge.id)) throw invalid('edge IDs must be valid and unique');
        if (!ids.has(edge.sourceTaskId) || !ids.has(edge.targetTaskId)) throw invalid('edge endpoints must identify tasks');
        if (edge.targetTaskId === RUN_WORKFLOWS_ID && !tasks.find(task => task.id === edge.sourceTaskId)?.creator) throw invalid('Only a creator can enter Run workflows');
        const sourcePort = edge.sourcePort === undefined ? 'right' : edge.sourcePort;
        const targetPort = edge.targetPort === undefined ? 'left' : edge.targetPort;
        if (!['left', 'right'].includes(sourcePort) || !['left', 'right'].includes(targetPort)) throw invalid('edge ports must be left or right');
        edgeIds.add(edge.id);
        return { id: edge.id, sourceTaskId: edge.sourceTaskId, targetTaskId: edge.targetTaskId, sourcePort, targetPort };
    });
    const layout = Object.fromEntries(tasks.map((task, index) => {
        const point = input.layout?.[task.id];
        return [task.id, { x: Number.isFinite(point?.x) ? Math.max(0, Math.min(10000, point.x)) : 60 + index % 4 * 240,
            y: Number.isFinite(point?.y) ? Math.max(0, Math.min(10000, point.y)) : 60 + Math.floor(index / 4) * 140 }];
    }));
    return { schemaVersion: 2, id: workflowId, name, description: textField(input.description, 'description', 4000),
        ...(builtin ? { kind: 'default' } : {}), entryTaskId: input.entryTaskId, tasks, edges, layout };
}
export function graphDiagnostics(graph) {
    const seen = new Set([graph.entryTaskId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of graph.edges) if (seen.has(edge.sourceTaskId) && !seen.has(edge.targetTaskId)) { seen.add(edge.targetTaskId); changed = true; }
    }
    const diagnostics = graph.tasks.filter(task => !seen.has(task.id)).map(task => ({ taskId: task.id, message: 'Task is unreachable from the entry task' }));
    if (hasCreators(graph) && !graph.edges.some(edge => edge.sourceTaskId === RUN_WORKFLOWS_ID)) diagnostics.push({ taskId: RUN_WORKFLOWS_ID, message: 'Run workflows needs an outgoing continuation edge before a creator can delegate.' });
    return diagnostics;
}
export function workflowCatalogEntry(workflow) {
    return { id: workflow.id, name: workflow.name, description: workflow.description,
        ...(workflow.kind === 'default' ? { supportedExecutionTypes: [...EXECUTION_TYPES], requiresExecutionType: true } : {}),
        tasks: workflow.tasks.map(({ id, name, prompt, executionType, creator, kind }) => ({ id, name, prompt, executionType, creator, kind })) };
}
