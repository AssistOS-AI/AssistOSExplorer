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
        view.append(header, detail);
        const sessionUrl = ['browser', 'desktop'].includes(instance.executionType) ? instance.sessionUrl : null;
        if (sessionUrl) {
            const frame = document.createElement('iframe');
            frame.className = 'phase-session-frame';
            frame.title = `${instance.executionType} session`;
            frame.hidden = true;
            const tabs = document.createElement('div');
            tabs.className = 'phase-tabs';
            const logsTab = phaseTab('Logs', true, () => {
                logsTab.classList.add('is-active');
                sessionTab.classList.remove('is-active');
                log.hidden = false;
                frame.hidden = true;
            });
            const sessionTab = phaseTab(instance.executionType === 'desktop' ? 'Desktop' : 'Browser', false, () => {
                sessionTab.classList.add('is-active');
                logsTab.classList.remove('is-active');
                log.hidden = true;
                frame.hidden = false;
                if (!frame.getAttribute('src')) frame.src = sessionUrl;
            });
            tabs.append(logsTab, sessionTab);
            view.append(tabs, log, frame);
        } else {
            view.append(log);
        }
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
}

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const LOG_STREAM_PREFIX_RE = /^\[([^\]]+)\s+(stdout|stderr)\]\s?/i;
const LOG_INLINE_CODE_RE = /`[^`\r\n]+`/gu;
const LOG_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\/|~\/|\.{1,2}\/)[^\s"'`<>|]+|[\p{L}\p{N}_+.-]+(?:[\\/][\p{L}\p{N}_+.@-]+)+(?::\d+(?::\d+)?)?)/gu;
const LOG_FILE_RE = /(?:^|[\s([{<"'`])([\p{L}\p{N}_+-]+\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|htm|html|java|jpeg|jpg|js|json|jsx|log|md|mdx|mjs|pdf|php|png|py|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|webp|xml|yaml|yml)(?::\d+(?::\d+)?)?)(?=$|[\s)\]}>.,'";!?`])/giu;
const LOG_TRAILING_PUNCTUATION_RE = /[),.;!?}\]]+$/u;
const LOG_MARKDOWN_LINK_RE = /\[([^\]\r\n]+)\]\(([^)\s]+)\)/gu;
const LOG_SERVICE_PATH_RE = /(^|\s)(\/base-agent-additional-server\/[A-Za-z0-9/_-]+)(?=\s|$)/gu;

function addLogHighlight(matches, start, end, kind) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return;
    if (matches.some(match => start < match.end && end > match.start)) return;
    matches.push({ start, end, kind });
}

function logPathLength(value) {
    const trimmed = value.replace(LOG_TRAILING_PUNCTUATION_RE, '');
    if (!trimmed) return 0;
    if (trimmed.startsWith('/') && !trimmed.slice(1).includes('/')
        && !/\.[\p{L}\p{N}]{1,10}(?::\d+(?::\d+)?)?$/u.test(trimmed)) return 0;
    return trimmed.length;
}

function logTokens(text) {
    const matches = [];
    let match;
    LOG_INLINE_CODE_RE.lastIndex = 0;
    while ((match = LOG_INLINE_CODE_RE.exec(text))) addLogHighlight(matches, match.index, match.index + match[0].length, 'code');
    LOG_PATH_RE.lastIndex = 0;
    while ((match = LOG_PATH_RE.exec(text))) {
        const length = logPathLength(match[0]);
        addLogHighlight(matches, match.index, match.index + length, 'path');
    }
    LOG_FILE_RE.lastIndex = 0;
    while ((match = LOG_FILE_RE.exec(text))) {
        const start = match.index + match[0].indexOf(match[1]);
        addLogHighlight(matches, start, start + match[1].length, 'path');
    }
    matches.sort((left, right) => left.start - right.start);
    const tokens = [];
    let cursor = 0;
    for (const highlight of matches) {
        if (highlight.start > cursor) tokens.push({ text: text.slice(cursor, highlight.start), kind: null });
        tokens.push({ text: text.slice(highlight.start, highlight.end), kind: highlight.kind });
        cursor = highlight.end;
    }
    if (cursor < text.length) tokens.push({ text: text.slice(cursor), kind: null });
    return tokens.length ? tokens : [{ text, kind: null }];
}

function tokenFragments(text) {
    return logTokens(text).map(token => {
        if (!token.kind) return document.createTextNode(token.text);
        const span = element('span', token.text);
        span.className = `phase-log-token is-${token.kind}`;
        return span;
    });
}

function safeLogUrl(raw) {
    try {
        const url = new URL(raw, location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
}

function lineFragments(text) {
    const linkified = text.replace(LOG_SERVICE_PATH_RE, (_match, prefix, path) => `${prefix}[${path}](${path})`);
    const fragments = [];
    let cursor = 0;
    let found = false;
    let match;
    LOG_MARKDOWN_LINK_RE.lastIndex = 0;
    while ((match = LOG_MARKDOWN_LINK_RE.exec(linkified))) {
        fragments.push(...tokenFragments(linkified.slice(cursor, match.index)));
        const href = safeLogUrl(match[2]);
        if (href) {
            const link = document.createElement('a');
            link.className = 'phase-log-inline-link';
            link.href = href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = match[1] === match[2] ? href : match[1];
            fragments.push(link);
            found = true;
        } else {
            fragments.push(document.createTextNode(match[0]));
        }
        cursor = match.index + match[0].length;
    }
    if (!found) return tokenFragments(text);
    fragments.push(...tokenFragments(linkified.slice(cursor)));
    return fragments;
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

function logLine(rawText, isFinal) {
    const row = document.createElement('span');
    let text = String(rawText || '').replace(ANSI_RE, '');
    let stream = 'stdout';
    const streamMatch = LOG_STREAM_PREFIX_RE.exec(text);
    if (streamMatch) {
        stream = streamMatch[2].toLowerCase();
        text = text.slice(streamMatch[0].length);
    }
    row.className = `phase-log-line is-${stream} ${isFinal ? 'is-final' : 'is-intermediate'}`;
    for (const fragment of lineFragments(text)) row.append(fragment);
    return row;
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
            container.append(logLine(line.text, start >= 0 && line.end > start && line.start < end));
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
