import { drawBoard } from './workflow-board.js';

const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const api = path => new URL(path, document.baseURI).toString();
const FLOW_TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);

async function get(path, text = false) {
    const response = await fetch(api(path), { credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return text ? response.text() : response.json();
}

async function post(path) {
    const response = await fetch(api(path), { method: 'POST', credentials: 'include' });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
}

const params = new URL(location.href).searchParams;
let selected = params.get('flowId') || params.get('flow');
let currentFlow = null;
let selectedInstanceId = null;
let stageView = 'empty';
let logCache = '';

function setMessage(text, error = false) {
    const message = document.querySelector('#message');
    message.textContent = text || '';
    message.classList.toggle('is-error', Boolean(error));
}

function terminalStatus(status) {
    return FLOW_TERMINAL.has(status);
}

function duration(instance) {
    if (!instance?.startedAt) return '';
    const end = instance.endedAt ? new Date(instance.endedAt) : new Date();
    const ms = end - new Date(instance.startedAt);
    if (!Number.isFinite(ms) || ms < 0) return '';
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function instanceForTask(taskId) {
    return [...(currentFlow?.instances || [])].reverse().find(instance => instance.taskId === taskId) || null;
}

function renderOverview(flows, workflows) {
    const list = document.querySelector('#flowsList');
    list.replaceChildren();
    document.querySelector('#flowCount').textContent = flows.length;
    if (!flows.length) list.append(element('p', 'No task flows yet.'));
    for (const flow of flows) {
        const button = document.createElement('button');
        button.className = 'flow-card';
        button.type = 'button';
        button.append(
            element('span', `${flow.workflowName} · ${flow.status}`),
            element('span', `${flow.objective} · ${flow.createdAt}`),
        );
        button.onclick = () => { selected = flow.id; void render(); };
        list.append(button);
    }
    const types = document.querySelector('#workflowsList');
    types.replaceChildren();
    document.querySelector('#workflowCount').textContent = workflows.length;
    for (const workflow of workflows) {
        const card = document.createElement('article');
        card.className = 'workflow-card';
        card.append(element('h3', workflow.name), element('p', workflow.description));
        if (workflow.coverage?.warning) {
            const warning = element('p', `⚠ ${workflow.coverage.message}`);
            warning.className = 'workflow-warning';
            card.append(warning);
        }
        card.append(element('p', workflow.tasks.map(task => task.name).join(' · ')));
        types.append(card);
    }
}

function renderHeader(flow) {
    document.querySelector('#detail-title').textContent = flow.workflowName;
    document.querySelector('#flowObjective').textContent = flow.objective || '';
    const status = document.querySelector('#flowStatus');
    status.textContent = flow.status;
    status.dataset.status = flow.status;
    const error = document.querySelector('#flowError');
    error.hidden = !flow.error;
    error.textContent = flow.error || '';
    document.querySelector('#stopFlowButton').disabled = terminalStatus(flow.status);
}

function renderPhases(flow) {
    document.querySelector('#phaseCount').textContent = flow.instances.length;
    const list = document.querySelector('#phaseList');
    list.replaceChildren();
    for (const instance of flow.instances) {
        const task = flow.graph.tasks.find(candidate => candidate.id === instance.taskId);
        const item = document.createElement('li');
        const card = document.createElement('div');
        card.className = 'phase-card';
        card.dataset.state = instance.state;
        if (instance.id === selectedInstanceId) card.classList.add('is-selected');
        card.tabIndex = 0;
        card.onclick = () => selectPhase(instance.id);
        card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPhase(instance.id); } };
        const head = document.createElement('div');
        head.className = 'phase-card-head';
        head.append(element('strong', `${instance.sequence + 1}. ${task?.name || instance.taskId}`));
        head.append(element('span', duration(instance)));
        const meta = element('span', `${instance.robotName || 'Awaiting robot'} · ${instance.executionType || ''} · ${instance.state}`);
        meta.className = 'phase-card-meta';
        card.append(head, meta);
        if (!terminalStatus(instance.state)) {
            const stop = element('button', 'Stop');
            stop.type = 'button';
            stop.className = 'button danger phase-stop';
            stop.onclick = event => { event.stopPropagation(); void stopPhase(instance.id); };
            card.append(stop);
        }
        item.append(card);
        list.append(item);
    }
    if (!flow.instances.length) list.append(element('li', 'No phases started yet.'));
}

function renderStage() {
    const body = document.querySelector('#stageBody');
    const title = document.querySelector('#stageTitle');
    body.replaceChildren();
    if (stageView === 'graph') {
        title.textContent = 'Workflow graph — click a task to open its log';
        const board = document.createElement('div');
        board.className = 'stage-board';
        body.append(board);
        const states = Object.fromEntries(currentFlow.graph.tasks.map(task => [task.id, 'unvisited']));
        for (const instance of currentFlow.instances) states[instance.taskId] = instance.state;
        drawBoard(board, currentFlow.graph, { readOnly: true, states, onSelect: taskId => {
            const instance = instanceForTask(taskId);
            if (instance) selectPhase(instance.id);
        } });
        return;
    }
    if (stageView === 'log') {
        const instance = currentFlow.instances.find(item => item.id === selectedInstanceId);
        title.textContent = 'Phase logs';
        if (!instance) {
            body.append(element('p', 'This phase is no longer available.'));
            return;
        }
        const view = document.createElement('div');
        view.className = 'phase-view';
        const header = document.createElement('header');
        header.className = 'phase-view-header';
        view.append(header);
        const log = document.createElement('div');
        log.className = 'phase-log';
        view.append(log);
        body.append(view);
        renderPhaseHeader(header, instance);
        void loadLog(instance);
        return;
    }
    title.textContent = 'Select a phase to view its log';
    body.append(element('p', 'Pick a phase on the left, or open the graph to follow the running tasks.'));
}

function phaseStatusClass(state) {
    if (['running', 'queued', 'starting'].includes(state)) return 'running';
    if (state === 'completed') return 'finished';
    if (state === 'failed') return 'error';
    if (['stopped', 'interrupted'].includes(state)) return 'stopped';
    return 'ongoing';
}

function renderPhaseHeader(header, instance) {
    const task = currentFlow.graph.tasks.find(candidate => candidate.id === instance.taskId);
    header.replaceChildren();
    const name = element('strong', task?.name || instance.taskId);
    name.className = 'phase-view-name';
    const meta = element('span', `${instance.robotName || 'Awaiting robot'} · ${instance.executionType || ''}`);
    meta.className = 'phase-view-meta';
    const status = element('span', instance.state);
    status.className = `phase-view-status is-${phaseStatusClass(instance.state)}`;
    const time = element('span', duration(instance));
    time.className = 'phase-view-duration';
    header.append(name, meta, status, time);
    if (!terminalStatus(instance.state)) {
        const stop = element('button', 'Stop');
        stop.type = 'button';
        stop.className = 'button danger phase-stop';
        stop.onclick = () => void stopPhase(instance.id);
        header.append(stop);
    }
}

function splitLogLines(text) {
    const lines = [];
    let start = 0;
    for (const chunk of text.split('\n')) {
        lines.push({ text: chunk, start, end: start + chunk.length });
        start += chunk.length + 1;
    }
    return lines;
}

function renderLog(container, log, finalResponse) {
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    container.replaceChildren();
    if (!log) {
        const empty = element('div', 'No log output yet.');
        empty.className = 'phase-log-empty';
        container.append(empty);
    } else {
        const start = finalResponse ? log.lastIndexOf(finalResponse) : -1;
        const end = start >= 0 ? start + finalResponse.length : -1;
        for (const line of splitLogLines(log)) {
            const row = document.createElement('span');
            row.className = 'phase-log-line';
            if (start >= 0 && line.end > start && line.start < end) row.classList.add('is-final');
            row.textContent = line.text;
            container.append(row);
        }
    }
    if (atBottom) container.scrollTop = container.scrollHeight;
}

async function loadLog(instance) {
    if (!selected || !instance) return;
    const container = document.querySelector('#stageBody .phase-log');
    if (!container) return;
    try {
        const log = await get(`api/roboflow/flows/${encodeURIComponent(selected)}/logs/${encodeURIComponent(instance.id)}`, true);
        logCache = log;
        renderLog(container, log, instance.finalResponse);
    } catch (error) {
        renderLog(container, error.message, '');
    }
}

function selectPhase(instanceId) {
    if (!currentFlow?.instances.some(instance => instance.id === instanceId)) return;
    selectedInstanceId = instanceId;
    stageView = 'log';
    renderPhases(currentFlow);
    renderStage();
}

function showGraph() {
    stageView = 'graph';
    selectedInstanceId = null;
    renderPhases(currentFlow);
    renderStage();
}

async function stopFlow() {
    if (!selected) return;
    try { await post(`api/roboflow/flows/${encodeURIComponent(selected)}/stop`); await refresh(); }
    catch (error) { setMessage(error.message, true); }
}

async function stopPhase(instanceId) {
    if (!selected) return;
    try { await post(`api/roboflow/flows/${encodeURIComponent(selected)}/instances/${encodeURIComponent(instanceId)}/stop`); await refresh(); }
    catch (error) { setMessage(error.message, true); }
}

async function refresh() {
    if (!selected) return;
    const { flow } = await get(`api/roboflow/flows/${encodeURIComponent(selected)}?logs=none`);
    currentFlow = flow;
    renderHeader(flow);
    renderPhases(flow);
    if (stageView === 'graph') renderStage();
    else if (stageView === 'log') {
        const instance = flow.instances.find(item => item.id === selectedInstanceId);
        const header = document.querySelector('#stageBody .phase-view-header');
        if (instance && header) renderPhaseHeader(header, instance);
    }
}

async function pollLog() {
    if (stageView !== 'log' || !selectedInstanceId || !currentFlow) return;
    const instance = currentFlow.instances.find(item => item.id === selectedInstanceId);
    if (!instance) return;
    const container = document.querySelector('#stageBody .phase-log');
    if (!container) return;
    try {
        const log = await get(`api/roboflow/flows/${encodeURIComponent(selected)}/logs/${encodeURIComponent(instance.id)}`, true);
        if (log === logCache) return;
        logCache = log;
        renderLog(container, log, instance.finalResponse);
    } catch { }
}

async function render() {
    try {
        const detail = document.querySelector('#detail');
        const overview = document.querySelector('#overview');
        const workflowsPanel = document.querySelector('#workflowsPanel');
        setMessage('');
        if (selected) {
            overview.hidden = true;
            workflowsPanel.hidden = true;
            detail.hidden = false;
            stageView = 'empty';
            selectedInstanceId = null;
            await refresh();
            renderStage();
        } else {
            detail.hidden = true;
            overview.hidden = false;
            workflowsPanel.hidden = false;
            const [{ flows }, { workflows }] = await Promise.all([get('api/roboflow/flows'), get('api/roboflow/workflows')]);
            renderOverview(flows, workflows);
        }
    } catch (error) {
        setMessage(error.message, true);
    }
}

document.querySelector('#refreshButton').onclick = () => render();
document.querySelector('#backButton').onclick = () => { selected = null; currentFlow = null; stageView = 'empty'; logCache = ''; void render(); };
document.querySelector('#graphButton').onclick = () => { if (currentFlow) showGraph(); };
document.querySelector('#stopFlowButton').onclick = () => void stopFlow();

await render();
setInterval(() => { if (!document.hidden && selected) void refresh().catch(() => {}); }, 2000);
setInterval(() => { if (!document.hidden) void pollLog(); }, 1000);
