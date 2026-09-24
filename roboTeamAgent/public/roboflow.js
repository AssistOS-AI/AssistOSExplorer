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
let selectedTaskId = null;
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

function phaseItem(task, instance) {
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
    head.append(element('strong', `${instance.sequence + 1}. ${task.name}`));
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
    return item;
}

function pendingItem(task) {
    const item = document.createElement('li');
    const card = document.createElement('div');
    card.className = 'phase-card is-pending';
    card.dataset.state = 'pending';
    if (task.id === selectedTaskId) card.classList.add('is-selected');
    card.tabIndex = 0;
    card.onclick = () => selectPending(task.id);
    card.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPending(task.id); } };
    const head = document.createElement('div');
    head.className = 'phase-card-head';
    head.append(element('strong', task.name));
    const meta = element('span', `${task.executionType || ''} · not started`);
    meta.className = 'phase-card-meta';
    card.append(head, meta);
    item.append(card);
    return item;
}

function renderPhases(flow) {
    document.querySelector('#phaseCount').textContent = flow.graph.tasks.length;
    const list = document.querySelector('#phaseList');
    list.replaceChildren();
    for (const task of flow.graph.tasks) {
        const instances = flow.instances.filter(instance => instance.taskId === task.id);
        if (!instances.length) {
            list.append(pendingItem(task));
            continue;
        }
        for (const instance of instances) list.append(phaseItem(task, instance));
    }
    if (!flow.graph.tasks.length) list.append(element('li', 'No phases defined.'));
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
            else selectPending(taskId);
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
        const detail = document.createElement('div');
        detail.className = 'phase-view-detail';
        const log = document.createElement('div');
        log.className = 'phase-log';
        view.append(header, detail, log);
        body.append(view);
        renderPhaseHeader(header, instance);
        renderPhaseDetail(detail, instance);
        void loadLog(instance);
        return;
    }
    if (stageView === 'pending') {
        const task = currentFlow.graph.tasks.find(item => item.id === selectedTaskId);
        title.textContent = 'Task details';
        if (!task) {
            body.append(element('p', 'This task is no longer available.'));
            return;
        }
        const view = document.createElement('div');
        view.className = 'phase-view';
        const header = document.createElement('header');
        header.className = 'phase-view-header';
        const detail = document.createElement('div');
        detail.className = 'phase-view-detail';
        const log = document.createElement('div');
        log.className = 'phase-log';
        const empty = element('div', 'This task has not started yet.');
        empty.className = 'phase-log-empty';
        log.append(empty);
        view.append(header, detail, log);
        body.append(view);
        renderPhaseHeader(header, { id: null, taskId: task.id, state: 'pending', executionType: task.executionType, robotName: null, startedAt: null, endedAt: null });
        renderPhaseDetail(detail, { taskId: task.id });
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
    const status = element('span', instance.state);
    status.className = `phase-view-status is-${phaseStatusClass(instance.state)}`;
    const time = element('span', duration(instance));
    time.className = 'phase-view-duration';
    header.append(name, status, time);
    if (instance.id && !terminalStatus(instance.state)) {
        const stop = element('button', 'Stop');
        stop.type = 'button';
        stop.className = 'button danger phase-stop';
        stop.onclick = () => void stopPhase(instance.id);
        header.append(stop);
    }
}

function skillsetLabel(id) {
    const text = String(id || '');
    const parts = text.split('::');
    return parts.length > 1 ? parts[parts.length - 1] : text;
}

function renderPhaseDetail(container, instance) {
    const task = currentFlow.graph.tasks.find(candidate => candidate.id === instance.taskId);
    container.replaceChildren();
    const description = element('p', task?.description || 'No description.');
    description.className = 'phase-description';
    container.append(description);
    const skillsets = Array.isArray(task?.skillsets) ? task.skillsets : [];
    const rows = [
        { label: 'Execution type', value: instance.executionType || task?.executionType || '—' },
        { label: 'Skillsets', value: skillsets.length ? skillsets.map(skillsetLabel).join(', ') : 'None', title: skillsets.join(', ') },
    ];
    if (instance.robotName) rows.push({ label: 'Robot', value: instance.robotName });
    const list = document.createElement('dl');
    list.className = 'phase-meta';
    for (const { label, value, title } of rows) {
        const row = document.createElement('div');
        row.className = 'phase-meta-row';
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        if (title) detail.title = title;
        row.append(term, detail);
        list.append(row);
    }
    container.append(list);
    if (instance.sessionUrl && ['browser', 'desktop'].includes(instance.executionType)) {
        const link = document.createElement('a');
        link.className = 'phase-live-link';
        link.href = instance.sessionUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = instance.executionType === 'desktop' ? 'Open live desktop' : 'Open live browser';
        container.append(link);
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
    const instance = currentFlow?.instances.find(item => item.id === instanceId);
    if (!instance) return;
    selectedInstanceId = instanceId;
    selectedTaskId = instance.taskId;
    stageView = 'log';
    renderPhases(currentFlow);
    renderStage();
}

function selectPending(taskId) {
    if (!currentFlow?.graph.tasks.some(task => task.id === taskId)) return;
    selectedInstanceId = null;
    selectedTaskId = taskId;
    stageView = 'pending';
    renderPhases(currentFlow);
    renderStage();
}

function showGraph() {
    stageView = 'graph';
    selectedInstanceId = null;
    selectedTaskId = null;
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
        const detail = document.querySelector('#stageBody .phase-view-detail');
        if (instance && header) renderPhaseHeader(header, instance);
        if (instance && detail) renderPhaseDetail(detail, instance);
    } else if (stageView === 'pending') {
        const instance = [...flow.instances].reverse().find(item => item.taskId === selectedTaskId);
        if (instance) selectPhase(instance.id);
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
    if (!selected) {
        location.replace(new URL('.', document.baseURI).toString());
        return;
    }
    try {
        setMessage('');
        stageView = 'empty';
        selectedInstanceId = null;
        selectedTaskId = null;
        await refresh();
        renderStage();
    } catch (error) {
        setMessage(error.message, true);
    }
}

document.querySelector('#graphButton').onclick = () => { if (currentFlow) showGraph(); };
document.querySelector('#stopFlowButton').onclick = () => void stopFlow();

await render();
setInterval(() => { if (!document.hidden && selected) void refresh().catch(() => {}); }, 2000);
setInterval(() => { if (!document.hidden) void pollLog(); }, 1000);
