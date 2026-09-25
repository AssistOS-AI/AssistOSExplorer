import { invalid } from './graph.mjs';
const alias = /^(nextEdgeId|nextEdge|Edge)$/i;
const scalar = value => typeof value === 'string' ? value.trim().replace(/^`+|`+$/g, '').trim() : '';
export function extractJson(source) {
    const text = String(source).trim();
    try { return JSON.parse(text); } catch { /* Native responses may wrap JSON in a fence. */ }
    const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map(match => match[1]);
    if (blocks.length === 1) { try { return JSON.parse(blocks[0]); } catch { /* Report the contract failure below. */ } }
    throw invalid('Expected one JSON object');
}
export function parseRoute(source, graph, taskId) {
    const values = [];
    let message;
    let json;
    try { json = extractJson(source); } catch { /* Markdown is the preferred response. */ }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const [key, value] of Object.entries(json)) {
            if (alias.test(key)) values.push(scalar(value));
            if (key.toLowerCase() === 'message' && typeof value === 'string') message = value;
        }
    } else {
        const text = String(source).replace(/\r\n?/g, '\n');
        const headings = [...text.matchAll(/^\s*#{1,6}\s*(message|nextEdgeId|nextEdge|Edge)\s*\n/gmi)];
        for (let index = 0; index < headings.length; index++) {
            const match = headings[index];
            const body = text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length).trim();
            if (alias.test(match[1])) values.push(scalar(body.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '')));
            else message = body;
        }
    }
    const unique = [...new Set(values)];
    if (unique.length !== 1 || !unique[0]) throw invalid('Branching task must return one unambiguous nextEdgeId');
    const edge = graph.edges.find(entry => entry.id === unique[0] && entry.sourceTaskId === taskId);
    if (!edge) throw invalid(`Selected edge is not outgoing from task ${taskId}: ${unique[0]}`);
    return { message, nextEdgeId: edge.id, edge };
}
export function routingPrompt(graph, taskId) {
    return `You are a robot executing one task in a directed workflow graph. Execute the current task, then choose exactly one of its outgoing edges. Return Markdown with optional # message and required # nextEdgeId sections. The latter must contain only the edge ID. Do not select incoming edges or edges from another node. Task prompts explain the work at each destination.\nCurrent node: ${taskId}\nComplete graph:\n${JSON.stringify(graph)}\nAllowed outgoing edges:\n${JSON.stringify(graph.edges.filter(edge => edge.sourceTaskId === taskId))}`;
}
