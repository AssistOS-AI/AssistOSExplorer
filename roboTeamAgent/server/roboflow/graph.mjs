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
export function workflowDefaultObjective(graph) {
    if (!graph || ['default', 'code-development'].includes(graph.id)) return '';
    const configured = textField(graph.defaultObjective, 'defaultObjective', 32768);
    if (configured) return configured;
    const description = textField(graph.description, 'description', 4000);
    if (description) return description;
    const instructions = (graph.tasks || []).filter(task => !isCoordinator(task)).map(task => `${task.name}\n${task.prompt}`).join('\n\n');
    // Do not silently truncate instructions or invent an objective for oversized definitions.
    return instructions.length <= 32768 ? instructions.trim() : '';
}
export function resolveWorkflowObjective(graph, value) {
    const objective = textField(value, 'objective', 32768) || workflowDefaultObjective(graph);
    if (!objective) throw invalid('This workflow requires an explicit objective');
    return objective;
}
export function normalizeWorkflow(input, { id, builtin = false } = {}) {
    const name = textField(input?.name, 'name', 120, true);
    const workflowId = id || input.id || slugifyWorkflow(name);
    if (!WORKFLOW_ID_PATTERN.test(workflowId)) throw invalid('invalid workflow id');
    if (!builtin && (workflowId === 'default' || input.kind || input.members || input.decisionMemberId)) throw invalid('reserved or obsolete workflow fields');
    // Loading accepts an unfinished definition; assertSavable guards Save and assertRunnable guards a run.
    if (!Array.isArray(input.tasks) || input.tasks.length > 100) throw invalid('workflow allows at most 100 tasks');
    const ids = new Set();
    const tasks = input.tasks.map(task => {
        if (!task || !identifier.test(task.id) || ids.has(task.id)) throw invalid('task IDs must be valid and unique');
        ids.add(task.id);
        if (task.kind !== undefined && task.kind !== 'run-workflows') throw invalid('invalid task kind');
        if (task.allowsHumanInput !== undefined && typeof task.allowsHumanInput !== 'boolean') throw invalid('allowsHumanInput must be boolean');
        if (task.effort !== undefined && (typeof task.effort !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(task.effort))) throw invalid('task effort must be a native effort name');
        if (task.creator !== undefined && typeof task.creator !== 'boolean') throw invalid('creator must be boolean');
        if (isCoordinator(task)) {
            if (task.allowsHumanInput || builtin || task.id !== RUN_WORKFLOWS_ID || task.creator || task.robotId || task.robotName || task.executionType || task.effort || task.prompt || task.skillsets?.length) throw invalid('Run workflows is a managed node without a robot, prompt or skills');
            return { id: RUN_WORKFLOWS_ID, name: 'Run workflows', kind: 'run-workflows', skillsets: [] };
        }
        if (task.id === RUN_WORKFLOWS_ID) throw invalid('reserved coordinator task id');
        if (builtin && task.creator) throw invalid('Standard development workflow cannot allow sub-flows');
        if (task.robotName || task.robotId) throw invalid('tasks cannot select robots');
        if (!builtin && !EXECUTION_TYPES.includes(task.executionType)) throw invalid('invalid execution type');
        if (!Array.isArray(task.skillsets) || task.skillsets.length > 100 || task.skillsets.some(s => typeof s !== 'string' || !s || s.length > 512)) throw invalid('invalid task skillsets');
        return { id: task.id, name: textField(task.name, 'task name', 120),
            ...(task.effort ? { effort: task.effort } : {}),
            ...(task.creator ? { creator: true } : {}), ...(task.allowsHumanInput ? { allowsHumanInput: true } : {}), prompt: textField(task.prompt, 'task prompt', 16000), skillsets: [...new Set(task.skillsets)],
            ...(builtin ? { supportedExecutionTypes: [...EXECUTION_TYPES] } : { executionType: task.executionType }) };
    });
    const creators = tasks.filter(task => task.creator);
    if (creators.length && !ids.has(RUN_WORKFLOWS_ID)) {
        if (tasks.length >= 100) throw invalid('workflow requires room for its Run workflows node');
        tasks.push({ id: RUN_WORKFLOWS_ID, name: 'Run workflows', kind: 'run-workflows', skillsets: [] });
        ids.add(RUN_WORKFLOWS_ID);
    }
    if (input.entryTaskId === RUN_WORKFLOWS_ID) throw invalid('Run workflows cannot be the entry task');
    if (input.entryTaskId && !ids.has(input.entryTaskId)) throw invalid('entryTaskId must identify a task');
    if (!Array.isArray(input.edges) || input.edges.length > 1000) throw invalid('edges must contain at most 1000 entries');
    const edgeIds = new Set();
    const edges = input.edges.map(edge => {
        if (!edge || !identifier.test(edge.id) || edgeIds.has(edge.id)) throw invalid('edge IDs must be valid and unique');
        if (!ids.has(edge.sourceTaskId) || !ids.has(edge.targetTaskId)) throw invalid('edge endpoints must identify tasks');
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
    const graph = { schemaVersion: 2, id: workflowId, name, description: textField(input.description, 'description', 4000),
        ...(builtin ? { kind: 'default' } : {}), entryTaskId: input.entryTaskId || '', tasks, edges, layout };
    graph.defaultObjective = workflowDefaultObjective({ ...graph, defaultObjective: textField(input.defaultObjective, 'defaultObjective', 32768) });
    return graph;
}
// What a run needs that a saved draft may still lack. Starting a run refuses the first problem found.
export function runProblems(graph) {
    const problems = [];
    const work = graph.tasks.filter(task => !isCoordinator(task));
    if (!work.length) problems.push('Add at least one task');
    else if (!graph.entryTaskId) problems.push('Choose the entry task');
    for (const task of work) {
        if (!task.name?.trim()) problems.push(`Task ${task.id} needs a name`);
        if (!task.prompt?.trim()) problems.push(`Task ${task.name?.trim() || task.id} needs a prompt`);
    }
    if (graph.tasks.some(isCoordinator) && !hasCreators(graph)) problems.push('Run workflows needs a task that allows sub-flows');
    for (const edge of graph.edges) {
        if (edge.targetTaskId === RUN_WORKFLOWS_ID && !graph.tasks.find(task => task.id === edge.sourceTaskId)?.creator) {
            problems.push('Only a task that allows sub-flows can enter Run workflows');
        }
    }
    return problems;
}
// Save needs a description, at least one task and a prompt on every task. Other gaps (a task without a name, Run
// workflows without a task that allows sub-flows) are warnings until a run starts.
export function assertSavable(graph) {
    if (!graph.description?.trim()) throw invalid('Add a workflow description before saving');
    const work = graph.tasks.filter(task => !isCoordinator(task));
    if (!work.length) throw invalid('Add at least one task before saving');
    const missing = work.find(task => !task.prompt?.trim());
    if (missing) throw invalid(`Task ${missing.name?.trim() || missing.id} needs a prompt before saving`);
}
export function assertRunnable(graph) {
    const [problem] = runProblems(graph);
    if (problem) throw invalid(`This workflow is not ready to run: ${problem}`);
}
export function graphDiagnostics(graph) {
    const diagnostics = runProblems(graph).map(message => ({ message }));
    if (!graph.entryTaskId) return diagnostics;
    const seen = new Set([graph.entryTaskId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of graph.edges) if (seen.has(edge.sourceTaskId) && !seen.has(edge.targetTaskId)) { seen.add(edge.targetTaskId); changed = true; }
    }
    diagnostics.push(...graph.tasks.filter(task => !seen.has(task.id)).map(task => ({ taskId: task.id, message: 'Task is unreachable from the entry task' })));
    if (hasCreators(graph) && !graph.edges.some(edge => edge.sourceTaskId === RUN_WORKFLOWS_ID)) diagnostics.push({ taskId: RUN_WORKFLOWS_ID, message: 'Run workflows needs an outgoing continuation edge before a task that allows sub-flows can delegate.' });
    return diagnostics;
}
export function workflowCatalogEntry(workflow) {
    return { id: workflow.id, name: workflow.name, description: workflow.description,
        ...(workflow.kind === 'default' ? { supportedExecutionTypes: [...EXECUTION_TYPES], requiresExecutionType: true } : {}),
        tasks: workflow.tasks.map(({ id, name, prompt, executionType, creator, kind }) => ({ id, name, prompt, executionType, creator, kind })) };
}
