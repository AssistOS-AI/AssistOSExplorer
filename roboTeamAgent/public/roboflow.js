import { drawBoard } from './workflow-board.js';
import { renderLog } from './log-render.js';

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

async function postJson(path, body) {
    const response = await fetch(api(path), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
}

const params = new URL(location.href).searchParams;
let selected = params.get('flowId') || params.get('flow');
let currentFlow = null;
let selectedInstanceId = null;
let selectedTaskId = null;
let stageView = 'empty';
let logRequest = null;

function setMessage(text, error = false) {
    const message = document.querySelector('#message');
    if (message.textContent !== (text || '')) message.textContent = text || '';
    message.classList.toggle('is-error', Boolean(error));
}

function terminalStatus(status) {
    return FLOW_TERMINAL.has(status);
}

function duration(instance) {
    if (!instance) return '';
    const active = ['running', 'starting', 'stopping'].includes(instance.state || instance.status);
    const start = instance.startedAt || instance.createdAt;
    const end = instance.endedAt || instance.finishedAt;
    const ms = Number.isFinite(instance.elapsedMs)
        ? instance.elapsedMs + (active && instance.activeSince ? Math.max(0, Date.now() - Date.parse(instance.activeSince)) : 0)
        : (end ? Date.parse(end) : active ? Date.now() : Date.parse(start)) - Date.parse(start);
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
    document.querySelector('#flowDuration').textContent = duration(flow);
    const error = document.querySelector('#flowError');
    error.hidden = !flow.error;
    if (error.textContent !== (flow.error || '')) error.textContent = flow.error || '';
    const control = document.querySelector('#stopFlowButton');
    const paused = ['stopped', 'interrupted'].includes(flow.status);
    control.textContent = paused ? 'Resume workflow' : 'Stop workflow';
    control.classList.toggle('danger', !paused);
    control.classList.toggle('primary', paused);
    control.disabled = ['completed', 'failed'].includes(flow.status);
    let parentLink = document.querySelector('#parentFlowLink');
    if (!parentLink && flow.parentFlowId) {
        parentLink = element('a', 'Parent workflow'); parentLink.id = 'parentFlowLink';
        control.parentElement.prepend(parentLink);
    }
    if (parentLink) parentLink.href = api(`flows?flowId=${encodeURIComponent(flow.parentFlowId)}`);
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
    const meta = element('span', task.kind === 'run-workflows' ? `Sequential workflows · ${instance.state}`
        : `${instance.robotName || 'Awaiting robot'} · ${instance.executionType || ''} · ${instance.state}`);
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
        const logs = document.createElement('div');
        logs.className = 'phase-logs-section';
        const log = document.createElement('div');
        log.className = 'phase-log';
        const composer = document.createElement('div');
        composer.className = 'phase-composer';
        logs.append(composer, log);
        view.append(header, detail);
        const sessionUrl = ['browser', 'desktop'].includes(instance.executionType) ? instance.sessionUrl : null;
        const tabs = document.createElement('div');
        tabs.className = 'phase-tabs';
        const panels = [];
        const addTab = (label, panel, href) => {
            const tab = phaseTab(label, panels.length === 0, () => {
                for (const entry of panels) {
                    entry.panel.hidden = entry.panel !== panel;
                    entry.tab.classList.toggle('is-active', entry.panel === panel);
                }
                if (href && !panel.getAttribute('src')) panel.src = href;
            });
            panel.hidden = panels.length > 0;
            panels.push({ tab, panel });
            tabs.append(tab);
        };
        addTab('Logs', logs);
        const definition = currentFlow.graph.tasks.find(task => task.id === instance.taskId);
        if (definition?.creator || definition?.kind === 'run-workflows') {
            const children = document.createElement('div'); children.className = 'phase-subflows';
            addTab('Sub-flows', children); renderSubflows(children, instance);
        }
        const summary = document.createElement('iframe');
        summary.className = 'phase-session-frame';
        summary.title = 'human-report';
        addTab('human-report', summary, api(`summary?flow=${encodeURIComponent(selected)}&instance=${encodeURIComponent(instance.id)}`));
        if (sessionUrl) {
            const frame = document.createElement('iframe');
            frame.className = 'phase-session-frame';
            frame.title = `${instance.executionType} session`;
            addTab(instance.executionType === 'desktop' ? 'Desktop' : 'Browser', frame, sessionUrl);
        }
        view.append(tabs, ...panels.map(entry => entry.panel));
        body.append(view);
        renderPhaseHeader(header, instance);
        renderPhaseDetail(detail, instance);
        renderPhaseComposer(composer, instance);
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

function renderSubflows(container, instance) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && (container.contains(selection.anchorNode) || container.contains(selection.focusNode))) return;
    container.replaceChildren();
    const children = instance.subflows || [];
    if (!children.length) { container.append(element('p', 'No sub-flows started for this phase.')); return; }
    const finished = children.filter(child => ['completed', 'failed'].includes(child.status)).length;
    container.append(element('p', `${finished}/${children.length} sub-flows finished`));
    const list = document.createElement('ul');
    for (const child of children) {
        const row = document.createElement('li');
        const link = element('a', child.workflowName || child.id);
        link.href = api(`flows?flowId=${encodeURIComponent(child.id)}`);
        const status = element('span', child.status); status.className = `phase-view-status is-${phaseStatusClass(child.status)}`;
        row.append(link, status, element('span', duration(child)));
        if (child.error) {
            const error = element('p', child.error); error.className = 'workflow-error';
            row.append(error);
        }
        list.append(row);
    }
    container.append(list);
}

function phaseStatusClass(state) {
    if (['running', 'queued', 'starting'].includes(state)) return 'running';
    if (state === 'completed') return 'finished';
    if (state === 'failed') return 'error';
    if (['stopped', 'interrupted'].includes(state)) return 'stopped';
    return 'ongoing';
}

function phaseTab(label, active, onClick) {
    const tab = element('button', label);
    tab.type = 'button';
    tab.className = `phase-tab${active ? ' is-active' : ''}`;
    tab.onclick = onClick;
    return tab;
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
    const segment = String(id || '').split('/').pop();
    try { return decodeURIComponent(segment); } catch { return segment; }
}

function renderPhaseDetail(container, instance) {
    const task = currentFlow.graph.tasks.find(candidate => candidate.id === instance.taskId);
    const signature = JSON.stringify([task, instance.executionType, instance.robotName, instance.error]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.replaceChildren();
    if (instance.error) {
        const error = element('p', instance.error); error.className = 'workflow-error';
        container.append(error);
    }
    const description = element('p', task?.kind === 'run-workflows'
        ? 'Runs the creator’s selected workflows sequentially. A failed or stopped child blocks later children; all must complete before continuing on the selected edge.'
        : task?.prompt || 'No prompt.');
    description.className = 'phase-description';
    container.append(description);
    if (task?.kind === 'run-workflows') return;
    const skillsets = [...(Array.isArray(task?.skillsets) ? task.skillsets : []), ...(task?.creator ? ['workflow-creator (required)'] : [])];
    const rows = [
        { label: 'Execution type', value: instance.executionType || task?.executionType || '—' },
        { label: 'Skills', value: skillsets.length ? skillsets.map(skillsetLabel).join(', ') : 'None', title: skillsets.join(', ') },
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
}

const COMPOSER_MIN_HEIGHT = 40;
const COMPOSER_MAX_HEIGHT = 132;

function composerMode(instance) {
    if (currentFlow?.graph.tasks.find(task => task.id === instance.taskId)?.kind === 'run-workflows') return '';
    if (['queued', 'starting', 'running'].includes(instance.state)) return 'message';
    if (['stopped', 'completed', 'failed'].includes(instance.state)) return 'continue';
    return '';
}

function autoGrowInput(input) {
    input.style.height = 'auto';
    const scrollHeight = Math.ceil(input.scrollHeight);
    input.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, scrollHeight))}px`;
    input.style.overflowY = scrollHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
    if (scrollHeight <= COMPOSER_MAX_HEIGHT) input.scrollTop = 0;
}

function renderPhaseComposer(container, instance) {
    const mode = composerMode(instance);
    container.dataset.mode = mode;
    container.replaceChildren();
    if (!mode) {
        container.hidden = true;
        return;
    }
    container.hidden = false;
    const running = mode === 'message';
    const label = document.createElement('label');
    label.textContent = running ? 'Send a message to the running phase' : 'Continue this phase with a prompt';
    const row = document.createElement('div');
    row.className = 'phase-composer-row';
    const input = document.createElement('textarea');
    input.rows = 1;
    input.maxLength = 32768;
    input.placeholder = running ? 'Message the running agent…' : 'Prompt the agent to continue…';
    input.addEventListener('input', () => autoGrowInput(input));
    const button = element('button', running ? 'Send' : 'Continue');
    button.type = 'button';
    button.className = 'button primary';
    const status = document.createElement('p');
    status.className = 'phase-composer-status';
    const submit = async () => {
        const prompt = input.value.trim();
        if (button.disabled || (running && !prompt)) return;
        button.disabled = true;
        status.classList.remove('is-error');
        status.textContent = running ? 'Sending…' : 'Continuing…';
        try {
            if (running) {
                const result = await postJson(`api/roboflow/flows/${encodeURIComponent(selected)}/instances/${encodeURIComponent(instance.id)}/message`, { prompt });
                status.textContent = `Delivered: ${result.delivery || 'sent'}`;
            } else {
                await postJson(`api/roboflow/flows/${encodeURIComponent(selected)}/instances/${encodeURIComponent(instance.id)}/resume`, { prompt });
                status.textContent = 'Continuing…';
            }
            input.value = '';
            autoGrowInput(input);
            await refresh();
        } catch (error) {
            status.textContent = error.message;
            status.classList.add('is-error');
        } finally {
            button.disabled = false;
        }
    };
    button.onclick = () => void submit();
    input.onkeydown = event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        void submit();
    };
    row.append(input, button);
    container.append(label, row, status);
    autoGrowInput(input);
}


async function loadLog(instance) {
    if (!selected || !instance) return;
    const container = document.querySelector('#stageBody .phase-log');
    if (!container) return;
    const key = JSON.stringify([selected, instance.id, instance.runtimeTaskId, instance.state, instance.endedAt]);
    if (logRequest?.key !== key) logRequest = { key, pending: false, attempted: false, failures: 0, nextAt: 0 };
    const request = logRequest;
    if (request.pending) return;
    if (terminalStatus(instance.state) && request.attempted) {
        if (request.container !== container) {
            renderLog(container, request.error || request.log || '', request.error ? '' : instance.finalResponse);
            request.container = container;
        }
        return;
    }
    if (Date.now() < request.nextAt) return;
    request.pending = true;
    request.attempted = true;
    try {
        const log = await get(`api/roboflow/flows/${encodeURIComponent(selected)}/logs/${encodeURIComponent(instance.id)}`, true);
        const changed = request.log !== log || request.error || request.container !== container;
        request.log = log; request.error = ''; request.failures = 0; request.nextAt = Date.now() + 1000;
        if (logRequest !== request || selectedInstanceId !== instance.id || !container.isConnected) return;
        if (changed) renderLog(container, log, instance.finalResponse);
        request.container = container;
    } catch (error) {
        request.error = error.message;
        request.nextAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(++request.failures, 5));
        if (logRequest !== request || selectedInstanceId !== instance.id || !container.isConnected) return;
        renderLog(container, error.message, '');
        request.container = container;
    } finally {
        request.pending = false;
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
    const action = ['stopped', 'interrupted'].includes(currentFlow?.status) ? 'resume' : 'stop';
    const button = document.querySelector('#stopFlowButton'); button.disabled = true;
    try { await post(`api/roboflow/flows/${encodeURIComponent(selected)}/${action}`); await refresh(); }
    catch (error) { setMessage(error.message, true); }
    finally { if (currentFlow) renderHeader(currentFlow); }
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
        const composer = document.querySelector('#stageBody .phase-composer');
        if (instance && header) renderPhaseHeader(header, instance);
        const children = document.querySelector('#stageBody .phase-subflows');
        if (instance && children) renderSubflows(children, instance);
        if (instance && detail) renderPhaseDetail(detail, instance);
        if (instance && composer && composer.dataset.mode !== composerMode(instance)) renderPhaseComposer(composer, instance);
    } else if (stageView === 'pending') {
        const instance = [...flow.instances].reverse().find(item => item.taskId === selectedTaskId);
        if (instance) selectPhase(instance.id);
    }
}

async function pollLog() {
    if (stageView !== 'log' || !selectedInstanceId || !currentFlow) return;
    const instance = currentFlow.instances.find(item => item.id === selectedInstanceId);
    if (!instance) return;
    await loadLog(instance);
}

async function render() {
    if (!selected) {
        location.replace(new URL('.', document.baseURI).toString());
        return;
    }
    const leaf = document.querySelector('#breadcrumbLeaf');
    if (leaf) leaf.textContent = selected;
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
