import { withoutSummaryBlocks, summaryRanges } from '../../shared/impact-summary.mjs';
import { invalid } from './graph.mjs';
import { parseJsonObject, parseStructuredResponse } from './markdown-response.mjs';

const decisionSchema = {
    fields: {
        nextNodePrompt: { type: 'text', aliases: ['message'] }, nextEdgeId: { type: 'scalar', aliases: ['nextEdge', 'Edge'], normalizeJson: true }, afterWorkflowsEdgeId: 'scalar',
    },
    groups: [{ heading: 'workflow', collection: 'workflows', identity: 'workflowTypeId', fields: {
        workflowTypeId: 'scalar', prompt: 'text', executionType: 'scalar',
    } }],
};
const generationSchema = {
    fields: { id: 'scalar', name: 'scalar', description: 'text', entryTaskId: 'scalar' },
    groups: [
        { heading: 'task', collection: 'tasks', identity: 'id', fields: {
            id: 'scalar', name: 'scalar', prompt: 'text', executionType: 'scalar', skillsets: 'list',
            creator: 'boolean', allowsHumanInput: 'boolean', kind: 'scalar',
        } },
        { heading: 'edge', collection: 'edges', identity: 'id', fields: {
            id: 'scalar', sourceTaskId: 'scalar', targetTaskId: 'scalar', sourcePort: 'scalar', targetPort: 'scalar',
        } },
        { heading: 'position', collection: 'layout', identity: 'id', keyed: true, fields: {
            id: 'scalar', x: 'number', y: 'number',
        } },
    ],
};

// Prefer the payload outside reports; retain legacy payloads inside the markers.
function resultSource(source) {
    const text = String(source || '');
    return withoutSummaryBlocks(text).trim() || summaryRanges(text).map(range => text.slice(range.start, range.end)).join('\n').trim();
}

// Reports are user-only, including historical responses with no separate payload.
// Keep the original response intact on disk for display and debugging.
export function workflowResponseContext(source) {
    return { response: withoutSummaryBlocks(String(source || '')).trim() };
}

export function extractJson(source) {
    return parseJsonObject(resultSource(source).replace(/\r\n?/g, '\n'));
}

export function parseWorkflowResponse(source, { generation = false } = {}) {
    return parseStructuredResponse(resultSource(source), generation ? generationSchema : decisionSchema);
}

export function routeFromResponse(response, graph, taskId) {
    const id = response.nextEdgeId;
    if (typeof id !== 'string' || !id) throw invalid('Branching task must return one unambiguous nextEdgeId');
    const edge = graph.edges.find(entry => entry.id === id && entry.sourceTaskId === taskId);
    if (!edge) throw invalid(`Selected edge is not outgoing from task ${taskId}: ${id}`);
    return { nextNodePrompt: response.nextNodePrompt, nextEdgeId: edge.id, edge };
}

export function parseRoute(source, graph, taskId) {
    return routeFromResponse(parseWorkflowResponse(source), graph, taskId);
}
