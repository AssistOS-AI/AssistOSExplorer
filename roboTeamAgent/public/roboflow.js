import { drawBoard } from './workflow-board.js';
import { renderLog } from './log-render.js';
import { initPageNavigation } from './page-navigation.js';
import { initRobotMenu } from './robot-controls.js';
import { createPhaseListItem, phasePauseControl } from './workflow-phase-list.js';
import { renderExecutionState, initExecutionStateLegend } from './workflow-execution-state.js';
import { observeWorkflow } from './workflow-live-updates.js';

initPageNavigation({ fallbackUrl: new URL('?tab=workflow-types', document.baseURI).href });
initExecutionStateLegend(document.querySelector('.phase-state-legend'));

const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
const api = path => new URL(path, document.baseURI).toString();
const FLOW_TERMINAL = new Set(['completed', 'failed', 'paused', 'terminated']);

async function get(path, text = false) {
    const response = await fetch(api(path), { credentials: 'include' });
    if (!response.ok) throw Object.assign(new Error(`Request failed (${response.status})`), { statusCode: response.status });
    return text ? response.text() : response.json();
}

async function post(path) {
    const response = await fetch(api(path), { method: 'POST', credentials: 'include' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
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
let phaseSelectionExplicit = false;
let stageView = 'empty';
let logRequest = null;
let liveUpdates = null;
let flowRequest = null;
let graphSignature = null;
// The right side shows one view at a time: the selected phase or the execution graph. Choosing a phase, in the list
// or in the graph, shows the phase; View execution graph shows the graph. Automatic selection keeps the current view.
let rightView = 'phase';
// The phase view's tabs: Logs shows only the log, Status the phase's name, state, prompt and settings. The chosen
// tab stays open when another phase is selected.
let phaseTabChoice = 'Logs';
let flowControlPending = false;
const phaseRows = new Map();

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
    const active = ['running', 'starting', 'pausing'].includes(instance.state || instance.status);
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
    const title = document.querySelector('#detail-title');
    title.textContent = flow.workflowName; title.title = flow.workflowName;
    const objective = document.querySelector('#flowObjective');
    if (objective.textContent !== (flow.objective || '')) objective.textContent = flow.objective || '';
    updateObjectiveToggle();
    const status = document.querySelector('#flowStatus');
    renderExecutionState(status, flow.status);
    status.dataset.status = flow.status;
    document.querySelector('#flowDuration').textContent = duration(flow);
    const error = document.querySelector('#flowError');
    error.hidden = !flow.error;
    if (error.textContent !== (flow.error || '')) error.textContent = flow.error || '';
    const control = document.querySelector('#pauseFlowButton');
    const paused = flow.status === 'paused';
    control.textContent = paused ? 'Resume workflow' : 'Pause workflow';
    control.disabled = flowControlPending || ['completed', 'failed', 'terminated'].includes(flow.status)
        || (paused && flow.humanInput?.status === 'pending');
    control.title = paused && flow.humanInput?.status === 'pending' ? 'Answer the pending question in Observability before resuming' : '';
    control.hidden = ['completed', 'failed', 'terminated'].includes(flow.status);
    document.querySelector('#terminateFlowButton').hidden = ['completed', 'terminated'].includes(flow.status);
    document.querySelector('#flowActionsMenu').hidden = ['completed', 'terminated'].includes(flow.status);
    let parentLink = document.querySelector('#parentFlowLink');
    if (!parentLink && flow.parentFlowId) {
        parentLink = element('a', 'Parent workflow'); parentLink.id = 'parentFlowLink';
        parentLink.className = 'flow-parent-link';
        document.querySelector('.flow-heading').append(parentLink);
    }
    if (parentLink) { parentLink.hidden = !flow.parentFlowId; parentLink.href = api(`flows?flowId=${encodeURIComponent(flow.parentFlowId)}`); }
}

function phaseItem(task, instance) {
    return createPhaseListItem({ task, graph: currentFlow.graph, instance, selected: instance.id === selectedInstanceId,
        repeated: currentFlow.instances.filter(candidate => candidate.taskId === task.id).length > 1,
        elapsed: duration(instance), flow: currentFlow, controlsPending: flowControlPending,
        onSelect: () => { selectPhase(instance.id); scrollToPhaseLogs(); }, onPause: () => void pausePhase(instance.id), onResume: () => void resumePhase(instance.id) });
}

function pendingItem(task) {
    return createPhaseListItem({ task, graph: currentFlow.graph, selected: task.id === selectedTaskId,
        onSelect: () => { selectPending(task.id); scrollToPhaseLogs(); } });
}

function renderPhases(flow) {
    document.querySelector('#phaseCount').textContent = flow.graph.tasks.length;
    const list = document.querySelector('#phaseList');
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.phaseKey : null;
    const focusedTask = focused ? document.activeElement.dataset.taskId : null;
    const entries = [];
    for (const task of flow.graph.tasks) {
        const instances = flow.instances.filter(instance => instance.taskId === task.id);
        for (const instance of instances.length ? instances : [null]) {
            const key = instance ? `instance:${instance.id}` : `task:${task.id}`;
            const signature = JSON.stringify([task, flow.graph.entryTaskId, flow.graph.edges, instance?.state,
                instance?.robotName, instance?.executionType, instance?.sequence, instances.length > 1,
                flow.status, flow.humanInput?.status === 'pending', flowControlPending,
                instance ? instance.id === selectedInstanceId : task.id === selectedTaskId]);
            let row = phaseRows.get(key);
            if (row?.signature !== signature) {
                row = { signature, instanceId: instance?.id, node: instance ? phaseItem(task, instance) : pendingItem(task) };
                phaseRows.set(key, row);
            }
            entries.push({ key, ...row });
        }
    }
    const retained = new Set(entries.map(entry => entry.key));
    for (const [key, row] of phaseRows) if (!retained.has(key)) { row.node.remove(); phaseRows.delete(key); }
    if (!entries.length) {
        if (list.textContent !== 'No phases defined.') list.replaceChildren(element('li', 'No phases defined.'));
    } else {
        for (const child of [...list.children]) if (!entries.some(entry => entry.node === child)) child.remove();
        entries.forEach((entry, index) => { if (list.children[index] !== entry.node) list.insertBefore(entry.node, list.children[index] || null); });
    }
    updateDurations();
    if (focused) {
        const target = [...list.querySelectorAll('[data-phase-key]')].find(control => control.dataset.phaseKey === focused)
            || [...list.querySelectorAll('.phase-select')].find(control => control.dataset.taskId === focusedTask);
        target?.focus({ preventScroll: true });
    }
}

function updateDurations() {
    if (!currentFlow) return;
    document.querySelector('#flowDuration').textContent = duration(currentFlow);
    for (const row of phaseRows.values()) {
        const target = row.node.querySelector('.phase-card-duration');
        const instance = currentFlow.instances.find(item => item.id === row.instanceId);
        if (target && instance) {
            const text = duration(instance);
            if (target.textContent !== text) target.textContent = text;
        }
    }
    const phaseDuration = document.querySelector('#stageBody .phase-view-duration');
    const selectedPhase = currentFlow.instances.find(item => item.id === selectedInstanceId);
    if (phaseDuration && selectedPhase) phaseDuration.textContent = duration(selectedPhase);
}

function renderGraph() {
    const signature = JSON.stringify([currentFlow.graph, currentFlow.instances.map(instance => [instance.taskId, instance.state])]);
    if (signature === graphSignature) return;
    graphSignature = signature;
    const states = Object.fromEntries(currentFlow.graph.tasks.map(task => [task.id, 'unvisited']));
    for (const instance of currentFlow.instances) states[instance.taskId] = instance.state;
    drawBoard(document.querySelector('#executionGraphBoard'), currentFlow.graph, { readOnly: true, states, onSelect: taskId => {
        const instance = instanceForTask(taskId);
        if (instance) selectPhase(instance.id);
        else selectPending(taskId);
        scrollToPanel(document.querySelector('.stage-pane'));
    } });
}

function showRightView(view) {
    rightView = view;
    document.querySelector('.stage-pane').hidden = view !== 'phase';
    document.querySelector('#executionGraph').hidden = view !== 'graph';
    const button = document.querySelector('#graphButton');
    button.classList.toggle('is-active', view === 'graph');
    button.setAttribute('aria-pressed', String(view === 'graph'));
    // The board measures its nodes, so it is drawn again once visible.
    if (view === 'graph' && currentFlow) { graphSignature = null; renderGraph(); }
}

function scrollToPanel(panel) {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    panel.focus({ preventScroll: true });
    panel.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
}

function scrollToPhaseLogs() {
    if (window.matchMedia('(max-width: 720px)').matches) scrollToPanel(document.querySelector('.stage-pane'));
}

function renderStage() {
    const body = document.querySelector('#stageBody');
    const title = document.querySelector('#stageTitle');
    body.replaceChildren();
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
        const status = document.createElement('div');
        status.className = 'phase-status';
        status.append(header, detail);
        const sessionUrl = ['browser', 'desktop'].includes(instance.executionType) ? instance.sessionUrl : null;
        const tabs = document.createElement('div');
        tabs.className = 'phase-tabs';
        const panels = [];
        const open = entry => {
            for (const other of panels) {
                other.panel.hidden = other !== entry;
                other.tab.classList.toggle('is-active', other === entry);
            }
            if (entry.href && !entry.panel.getAttribute('src')) entry.panel.src = entry.href;
        };
        const addTab = (label, panel, href) => {
            const entry = { label, panel, href };
            entry.tab = phaseTab(label, false, () => { phaseTabChoice = label; open(entry); });
            panels.push(entry);
            tabs.append(entry.tab);
        };
        addTab('Logs', logs);
        addTab('Status', status);
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
        open(panels.find(entry => entry.label === phaseTabChoice) || panels[0]);
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
        title.textContent = 'Phase logs';
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
    body.append(element('p', 'Pick a phase from the list, or select a task in the execution graph below.'));
}

function renderSubflows(container, instance) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && (container.contains(selection.anchorNode) || container.contains(selection.focusNode))) return;
    container.replaceChildren();
    const children = instance.subflows || [];
    if (!children.length) { container.append(element('p', 'No sub-flows started for this phase.')); return; }
    const finished = children.filter(child => ['completed', 'failed', 'terminated'].includes(child.status)).length;
    container.append(element('p', `${finished}/${children.length} sub-flows finished`));
    const list = document.createElement('ul');
    for (const child of children) {
        const row = document.createElement('li');
        const link = element('a', child.workflowName || child.id);
        link.href = api(`flows?flowId=${encodeURIComponent(child.id)}`);
        const status = element('span', ''); status.className = 'phase-view-status';
        renderExecutionState(status, child.status);
        row.append(link, status, element('span', duration(child)));
        if (child.error) {
            const error = element('p', child.error); error.className = 'workflow-error';
            row.append(error);
        }
        list.append(row);
    }
    container.append(list);
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
    const status = element('span', '');
    status.className = 'phase-view-status';
    renderExecutionState(status, instance.state);
    const time = element('span', duration(instance));
    time.className = 'phase-view-duration';
    header.append(name, status, time);
    const control = phasePauseControl(instance, currentFlow);
    if (control) {
        const pause = element('button', control.label);
        pause.type = 'button';
        pause.className = 'button secondary phase-pause';
        pause.title = control.title;
        pause.disabled = flowControlPending || control.disabled;
        pause.setAttribute('aria-label', `${control.label} workflow · ${task?.name || instance.taskId}`);
        pause.onclick = () => void (control.action === 'resume' ? resumePhase(instance.id) : pausePhase(instance.id));
        header.append(pause);
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
        ? 'Runs the sub-flows selected by the previous task sequentially. A failed or paused child blocks later children; all must complete before continuing on the selected edge.'
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
    if (currentFlow?.status === 'terminated') return '';
    if (currentFlow?.graph.tasks.find(task => task.id === instance.taskId)?.kind === 'run-workflows') return '';
    if (['queued', 'starting', 'running'].includes(instance.state)) return 'message';
    if (['paused', 'completed', 'failed'].includes(instance.state)) return 'continue';
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


function invocationLogKey(instance) {
    return JSON.stringify([selected, instance.id, instance.runtimeTaskId]);
}

async function loadLog(instance, { force = false } = {}) {
    if (document.hidden) return;
    if (!selected || !instance) return;
    const container = document.querySelector('#stageBody .phase-log');
    if (!container) return;
    const key = invocationLogKey(instance);
    if (logRequest?.key !== key) logRequest = { key, pending: false, attempted: false, failures: 0, nextAt: 0 };
    const request = logRequest;
    if (request.pending) { if (force) request.dirty = true; return; }
    if (!force && terminalStatus(instance.state) && request.attempted) {
        if (request.container !== container || request.finalResponse !== instance.finalResponse) {
            renderLog(container, request.error || request.log || '', request.error ? '' : instance.finalResponse);
            request.container = container;
            request.finalResponse = instance.finalResponse;
        }
        return;
    }
    if (!force && Date.now() < request.nextAt) return;
    request.pending = true;
    request.attempted = true;
    try {
        const log = await get(`api/roboflow/flows/${encodeURIComponent(selected)}/logs/${encodeURIComponent(instance.id)}`, true);
        const latest = currentFlow?.instances.find(item => item.id === instance.id);
        const finalResponse = latest ? latest.finalResponse : instance.finalResponse;
        const changed = request.log !== log || request.error || request.container !== container || request.finalResponse !== finalResponse;
        request.log = log; request.error = ''; request.failures = 0; request.nextAt = Date.now() + 1000;
        if (logRequest !== request || selectedInstanceId !== instance.id || !container.isConnected) return;
        if (changed) renderLog(container, log, finalResponse);
        request.container = container;
        request.finalResponse = finalResponse;
    } catch (error) {
        request.error = error.message;
        if ([401, 403, 404].includes(error.statusCode)) observationError(error);
        request.nextAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(++request.failures, 5));
        if (logRequest !== request || selectedInstanceId !== instance.id || !container.isConnected) return;
        renderLog(container, error.message, '');
        request.container = container;
    } finally {
        request.pending = false;
        if (request.dirty && logRequest === request) {
            request.dirty = false;
            const latest = currentFlow?.instances.find(item => item.id === selectedInstanceId);
            if (latest) void loadLog(latest, { force: true });
        }
    }
}

function selectDefaultPhase() {
    if (phaseSelectionExplicit) return;
    const running = [...currentFlow.instances].reverse().find(instance => instance.state === 'running');
    const taskId = running?.taskId || currentFlow.graph.entryTaskId;
    const instance = running || instanceForTask(taskId);
    if (instance) {
        if (stageView !== 'log' || selectedInstanceId !== instance.id) selectPhase(instance.id, { explicit: false });
    } else if (stageView !== 'pending' || selectedTaskId !== taskId) {
        selectPending(taskId, { explicit: false });
    }
}

function selectPhase(instanceId, { explicit = true } = {}) {
    const instance = currentFlow?.instances.find(item => item.id === instanceId);
    if (!instance) return;
    if (explicit) { phaseSelectionExplicit = true; showRightView('phase'); }
    selectedInstanceId = instanceId;
    selectedTaskId = instance.taskId;
    stageView = 'log';
    renderPhases(currentFlow);
    renderStage();
    liveUpdates?.reconnect();
}

function selectPending(taskId, { explicit = true } = {}) {
    if (!currentFlow?.graph.tasks.some(task => task.id === taskId)) return;
    if (explicit) { phaseSelectionExplicit = true; showRightView('phase'); }
    selectedInstanceId = null;
    selectedTaskId = taskId;
    stageView = 'pending';
    renderPhases(currentFlow);
    renderStage();
    liveUpdates?.reconnect();
}

function showGraph() {
    showRightView('graph');
    scrollToPanel(document.querySelector('#executionGraph'));
}

async function toggleFlowPause() {
    if (!selected) return;
    const action = currentFlow?.status === 'paused' ? 'resume' : 'pause';
    if (action === 'resume' && currentFlow?.humanInput?.status === 'pending') return;
    await changeFlowControl(`api/roboflow/flows/${encodeURIComponent(selected)}/${action}`);
}

async function pausePhase(instanceId) {
    if (!selected) return;
    const control = phasePauseControl(currentFlow?.instances.find(instance => instance.id === instanceId), currentFlow);
    if (!control || control.action !== 'pause' || control.disabled) return;
    await changeFlowControl(`api/roboflow/flows/${encodeURIComponent(selected)}/instances/${encodeURIComponent(instanceId)}/pause`);
}

async function resumePhase(instanceId) {
    if (!selected) return;
    const control = phasePauseControl(currentFlow?.instances.find(instance => instance.id === instanceId), currentFlow);
    if (!control || control.action !== 'resume' || control.disabled) return;
    await changeFlowControl(`api/roboflow/flows/${encodeURIComponent(selected)}/resume`);
}

function renderFlowControls() {
    if (!currentFlow) return;
    renderHeader(currentFlow);
    renderPhases(currentFlow);
    const instance = currentFlow.instances.find(item => item.id === selectedInstanceId);
    const header = document.querySelector('#stageBody .phase-view-header');
    if (instance && header) renderPhaseHeader(header, instance);
}

async function changeFlowControl(path) {
    if (flowControlPending) return;
    flowControlPending = true;
    renderFlowControls();
    try { await post(path); await refresh(); }
    catch (error) { setMessage(error.message, true); }
    finally { flowControlPending = false; renderFlowControls(); }
}

async function refresh() {
    if (!selected) return;
    if (flowRequest) return flowRequest;
    flowRequest = (async () => {
        const { flow } = await get(`api/roboflow/flows/${encodeURIComponent(selected)}?logs=none`);
        applyFlow(flow);
    })();
    try { await flowRequest; } finally { flowRequest = null; }
}

function applyFlow(flow) {
    if (flow.id !== selected || (currentFlow && (flow.revision || 0) < (currentFlow.revision || 0))) return;
    currentFlow = flow;
    renderHeader(flow);
    renderPhases(flow);
    renderGraph();
    selectDefaultPhase();
    if (stageView === 'log') {
        const instance = flow.instances.find(item => item.id === selectedInstanceId);
        const header = document.querySelector('#stageBody .phase-view-header');
        const detail = document.querySelector('#stageBody .phase-view-detail');
        const composer = document.querySelector('#stageBody .phase-composer');
        if (instance && header) renderPhaseHeader(header, instance);
        const children = document.querySelector('#stageBody .phase-subflows');
        if (instance && children) renderSubflows(children, instance);
        if (instance && detail) renderPhaseDetail(detail, instance);
        if (instance && composer && composer.dataset.mode !== composerMode(instance)) renderPhaseComposer(composer, instance);
        if (instance && (logRequest?.key !== invocationLogKey(instance) || logRequest?.finalResponse !== instance.finalResponse)) void loadLog(instance);
    } else if (stageView === 'pending') {
        const instance = [...flow.instances].reverse().find(item => item.taskId === selectedTaskId);
        if (instance) selectPhase(instance.id, { explicit: false });
    }
}

async function pollLog() {
    if (stageView !== 'log' || !selectedInstanceId || !currentFlow) return;
    const instance = currentFlow.instances.find(item => item.id === selectedInstanceId);
    if (!instance) return;
    await loadLog(instance, { force: true });
}

function appendLiveLog(event) {
    if (stageView !== 'log' || event.instanceId !== selectedInstanceId) return;
    const instance = currentFlow?.instances.find(item => item.id === selectedInstanceId);
    if (!instance) return;
    const request = logRequest;
    const key = invocationLogKey(instance);
    const bytes = typeof request?.log === 'string' ? new TextEncoder().encode(request.log).length : -1;
    if (request?.key === key && !request.pending && !request.error && bytes >= event.end) return;
    if (request?.key === key && !request.pending && !request.error && bytes === event.start) {
        request.log += event.chunk;
        const container = document.querySelector('#stageBody .phase-log');
        if (container) { renderLog(container, request.log, instance.finalResponse); request.container = container; request.finalResponse = instance.finalResponse; }
    } else void loadLog(instance, { force: true });
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
        phaseSelectionExplicit = false;
        await refresh();
        if (stageView === 'empty') renderStage();
    } catch (error) {
        setMessage(error.message, true);
    }
}

function updateObjectiveToggle() {
    const objective = document.querySelector('#flowObjective');
    const toggle = document.querySelector('#toggleFlowObjective');
    const expanded = objective.classList.contains('is-expanded');
    toggle.hidden = objective.scrollHeight <= parseFloat(getComputedStyle(objective).lineHeight) * 2 + 1;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'View less' : 'View more');
    toggle.title = expanded ? 'View less' : 'View more';
}

document.querySelector('#toggleFlowObjective').onclick = () => {
    document.querySelector('#flowObjective').classList.toggle('is-expanded');
    updateObjectiveToggle();
};
new ResizeObserver(updateObjectiveToggle).observe(document.querySelector('#flowObjective'));
document.querySelector('#graphButton').onclick = () => { if (currentFlow) showGraph(); };
showRightView(rightView);
const terminateDialog = document.querySelector('#terminateFlowDialog');
const confirmTerminateButton = document.querySelector('#confirmTerminateButton');
const cancelTerminateButton = document.querySelector('#cancelTerminateButton');
const terminateDialogError = document.querySelector('#terminateDialogError');
let terminating = false;
document.querySelector('#terminateFlowButton').onclick = () => {
    if (!selected || terminating || terminateDialog.open) return;
    terminateDialogError.hidden = true;
    terminateDialogError.textContent = '';
    terminateDialog.showModal();
};
cancelTerminateButton.onclick = () => terminateDialog.close();
terminateDialog.addEventListener('cancel', event => { if (terminating) event.preventDefault(); });
confirmTerminateButton.onclick = async () => {
    if (!selected || terminating) return;
    terminating = true;
    confirmTerminateButton.disabled = cancelTerminateButton.disabled = true;
    confirmTerminateButton.textContent = 'Terminating…';
    terminateDialogError.hidden = true;
    try {
        await post(`api/roboflow/flows/${encodeURIComponent(selected)}/terminate`);
        terminateDialog.close();
        await refresh().catch(error => setMessage(error.message, true));
    } catch (error) {
        terminateDialogError.textContent = error.message;
        terminateDialogError.hidden = false;
    } finally {
        terminating = false;
        confirmTerminateButton.disabled = cancelTerminateButton.disabled = false;
        confirmTerminateButton.textContent = 'Terminate workflow';
    }
};
document.querySelector('#pauseFlowButton').onclick = () => void toggleFlowPause();
const flowMenu = document.querySelector('#flowActionsMenu');
const closeFlowMenu = () => {
    flowMenu.querySelector('[data-robot-menu-options]').hidden = true;
    flowMenu.querySelector('[data-robot-menu-toggle]').setAttribute('aria-expanded', 'false');
};
initRobotMenu({ menu: flowMenu, id: 'flow-menu-options', label: 'More workflow actions', closeMenus: closeFlowMenu });
document.addEventListener('click', event => { if (!flowMenu.contains(event.target)) closeFlowMenu(); });
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && flowMenu.querySelector('[data-robot-menu-toggle]').getAttribute('aria-expanded') === 'true') {
        closeFlowMenu(); flowMenu.querySelector('[data-robot-menu-toggle]').focus();
    }
});

await render();
function observationError(error) {
    setMessage(error.message, true);
    if ([401, 403, 404].includes(error.statusCode)) liveUpdates?.dispose();
}
liveUpdates = observeWorkflow({
    url: () => api(`api/roboflow/flows/${encodeURIComponent(selected)}/events${stageView === 'log' && selectedInstanceId ? `?instanceId=${encodeURIComponent(selectedInstanceId)}` : ''}`),
    onFlow: applyFlow,
    onLog: appendLiveLog, onResync: pollLog, onError: observationError,
    fallback: async () => { await refresh(); await pollLog(); },
});
setInterval(() => { if (!document.hidden) updateDurations(); }, 1000);
