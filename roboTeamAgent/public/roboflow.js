import { drawBoard } from './workflow-board.js';
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const api = path => new URL(path, document.baseURI).toString();
async function get(path, text = false) {
    const response = await fetch(api(path), { credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return text ? response.text() : response.json();
}
let selected = new URL(location.href).searchParams.get('flowId') || new URL(location.href).searchParams.get('flow');
async function render() {
    try {
        document.querySelector('#overview').hidden = Boolean(selected);
        document.querySelector('#workflowsPanel').hidden = Boolean(selected);
        document.querySelector('#detail').hidden = !selected;
        if (selected) {
            const { flow } = await get(`api/roboflow/flows/${encodeURIComponent(selected)}?logs=none`);
            document.querySelector('#detail-title').textContent = flow.workflowName;
            const summary = document.querySelector('#flowSummary'); summary.replaceChildren(element('p', `${flow.status} · ${flow.objective}`));
            if (flow.error) summary.append(element('p', flow.error));
            const board = document.createElement('div'); summary.append(board);
            const states = Object.fromEntries(flow.graph.tasks.map(task => [task.id, 'unvisited']));
            for (const task of flow.instances) states[task.taskId] = task.state;
            drawBoard(board, flow.graph, { readOnly: true, states });
            const list = document.querySelector('#invocations'); list.replaceChildren();
            for (const instance of flow.instances) {
                const card = document.createElement('article'); card.className = 'invocation-card';
                const task = flow.graph.tasks.find(task => task.id === instance.taskId);
                card.append(element('h3', `${instance.sequence + 1}. ${task.name}`), element('p', `${instance.robotName || 'Awaiting robot'} · ${instance.executionType || ''} · ${instance.state}`));
                card.append(element('p', `${instance.startedAt || instance.createdAt} ${instance.endedAt ? `→ ${instance.endedAt}` : ''}`));
                if (instance.nextEdgeId) card.append(element('p', `Next edge: ${instance.nextEdgeId}`));
                if (instance.error) card.append(element('p', instance.error));
                if (instance.finalResponse) card.append(element('pre', instance.finalResponse));
                if (instance.outputUnavailable) card.append(element('p', 'Output folder or file is unavailable.'));
                const log = element('button', 'Load task log'); log.className = 'button'; log.onclick = async () => {
                    try { card.append(element('pre', await get(`api/roboflow/flows/${flow.id}/logs/${instance.id}`, true))); log.disabled = true; }
                    catch (error) { card.append(element('p', error.message)); }
                }; card.append(log); list.append(card);
            }
        } else {
            const [{ flows }, { workflows }] = await Promise.all([get('api/roboflow/flows'), get('api/roboflow/workflows')]);
            const list = document.querySelector('#flowsList'); list.replaceChildren();
            document.querySelector('#flowCount').textContent = flows.length;
            for (const flow of flows) { const button = element('button', `${flow.workflowName} · ${flow.status} · ${flow.createdAt}`); button.className = 'button'; button.onclick = () => { selected = flow.id; void render(); }; list.append(button); }
            const types = document.querySelector('#workflowsList'); types.replaceChildren(); document.querySelector('#workflowCount').textContent = workflows.length;
            for (const workflow of workflows) {
                const card = document.createElement('article'); card.className = 'workflow-card'; card.append(element('h3', workflow.name), element('p', workflow.description));
                if (workflow.coverage?.warning) { const warning = element('p', `⚠ ${workflow.coverage.message}`); warning.className = 'workflow-warning'; card.append(warning); }
                card.append(element('p', workflow.tasks.map(task => task.name).join(' · '))); types.append(card);
            }
        }
        document.querySelector('#message').textContent = '';
    } catch (error) { document.querySelector('#message').textContent = error.message; }
}
document.querySelector('#refreshButton').onclick = render;
document.querySelector('#backButton').onclick = () => { selected = null; void render(); };
await render();
setInterval(() => { if (!document.hidden) void render(); }, 5000);
