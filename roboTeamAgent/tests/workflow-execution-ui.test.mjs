import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { phaseListPresentation, createPhaseListItem, phasePauseControl } from '../public/workflow-phase-list.js';
import { executionStatePresentation, renderExecutionState, renderExecutionStateLegend, fittingLegendCount } from '../public/workflow-execution-state.js';

const graph = { entryTaskId: 'start', tasks: [{ id: 'start', name: 'Research', executionType: 'browser' },
    { id: 'middle', name: 'Write', executionType: 'terminal' }, { id: 'end', name: 'Verify', executionType: 'terminal' }],
    edges: [{ sourceTaskId: 'start', targetTaskId: 'middle' }, { sourceTaskId: 'middle', targetTaskId: 'end' }] };
const read = file => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
function ownerDocument() {
    const create = tag => ({ tag, children: [], attributes: {}, dataset: {},
        setAttribute(name, value) { this.attributes[name] = value; }, append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; } });
    return { createElement: create, createElementNS(namespaceURI, tag) { return { ...create(tag), namespaceURI }; } };
}

test('execution phases retain roles and numbering independently of run status and execution mode', () => {
    assert.deepEqual(graph.tasks.map(task => phaseListPresentation(task, graph).role), ['start', 'intermediate', 'end']);
    assert.deepEqual(graph.tasks.map(task => phaseListPresentation(task, graph).number), [1, 2, 3]);
    const actual = phaseListPresentation(graph.tasks[0], graph, { state: 'failed', executionType: 'desktop' });
    assert.equal(actual.role, 'start'); assert.equal(actual.icons[0].label, 'Desktop'); assert.equal(actual.canPause, false);
    assert.equal(phaseListPresentation(graph.tasks[2], graph).stateLabel, 'Not started');
    for (const state of ['queued', 'starting', 'running', 'pausing']) assert.equal(phaseListPresentation(graph.tasks[0], graph, { state }).canPause, true);
    for (const state of ['completed', 'failed', 'paused', 'terminated']) assert.equal(phaseListPresentation(graph.tasks[0], graph, { state }).canPause, false);
});

test('phase selection shows a state icon instead of a mode icon and keeps pause separate', () => {
    let selections = 0, pauses = 0;
    const item = createPhaseListItem({ task: graph.tasks[0], graph, instance: { id: 'visit', sequence: 3, state: 'running', robotName: 'default' },
        selected: true, repeated: true, elapsed: '1m 20s', onSelect: () => selections++, onPause: () => pauses++, ownerDocument: ownerDocument() });
    const card = item.children[0], [select, pause] = card.children;
    assert.equal(card.dataset.nodeRole, 'start'); assert.equal(card.dataset.state, 'running');
    assert.equal(select.tag, 'button'); assert.equal(select.type, 'button'); assert.equal(select.attributes['aria-pressed'], 'true');
    assert.equal(select.dataset.phaseKey, 'instance:visit'); assert.match(select.attributes['aria-label'], /Browser.*Running.*Visit 4/);
    assert.equal(select.children[0].textContent, '1');
    assert.equal(select.children[2].title, graph.tasks[0].name);
    assert.equal(select.children[1].className, 'phase-card-status-icon');
    const icon = select.children[1].children[0];
    assert.equal(icon.children[0].attributes.d, executionStatePresentation('running').path);
    assert.equal(icon.attributes['aria-hidden'], 'true');
    assert.equal(select.children[1].title, 'Running');
    const meta = select.children[3]; assert.deepEqual(meta.children.map(node => node.children.length ? node.children[1].textContent : node.textContent), ['default', 'Visit 4']);
    assert.equal(meta.children[0].children[0].tag, 'svg');
    assert.equal(meta.children[0].children[0].attributes['aria-hidden'], 'true');
    assert.equal(meta.children[0].title, 'Robot: default');
    assert.match(select.attributes['aria-label'], /Robot: default/);
    assert.equal(select.children[4].className, 'phase-card-duration');
    assert.equal(select.children[4].textContent, '1m 20s');
    assert.equal(pause.tag, 'button'); assert.equal(pause.dataset.phaseKey, 'control:visit');
    pause.onclick(); assert.equal(pauses, 1); assert.equal(selections, 0);
    select.onclick(); assert.equal(selections, 1);
});

test('paused phase cards replace Pause with Resume without selecting the phase or restarting completed work', () => {
    let resumed = 0, selected = 0;
    const flow = { status: 'paused' }, instance = { id: 'visit', state: 'paused' };
    const item = createPhaseListItem({ task: graph.tasks[0], graph, instance, flow, selected: true,
        onSelect: () => selected++, onResume: () => resumed++, ownerDocument: ownerDocument() });
    const control = item.children[0].children[1];
    assert.equal(control.textContent, 'Resume'); assert.equal(control.disabled, false);
    assert.equal(control.dataset.phaseKey, 'control:visit');
    assert.equal(control.attributes['aria-label'], 'Resume workflow · Research');
    control.onclick(); assert.equal(resumed, 1); assert.equal(selected, 0);
    assert.equal(phasePauseControl({ state: 'completed' }, flow), null);
    assert.equal(phasePauseControl({ state: 'failed' }, flow), null);
    assert.equal(phasePauseControl(instance, { status: 'terminated' }), null);
    assert.equal(phasePauseControl({ state: 'pausing' }, { status: 'running' }).disabled, true);
});

test('pending human answers and in-flight mutations disable Resume on paused phase cards', () => {
    const args = { task: graph.tasks[0], graph, instance: { id: 'visit', state: 'paused' }, ownerDocument: ownerDocument() };
    const blocked = createPhaseListItem({ ...args, flow: { status: 'paused', humanInput: { status: 'pending' } } }).children[0].children[1];
    assert.equal(blocked.disabled, true); assert.match(blocked.title, /Answer the pending question in Observability/);
    const pending = createPhaseListItem({ ...args, flow: { status: 'paused' }, controlsPending: true }).children[0].children[1];
    assert.equal(pending.disabled, true);
    const ready = phasePauseControl(args.instance, { status: 'paused', humanInput: { status: 'answered' } });
    assert.equal(ready.disabled, false);
});

test('phase controls pause through the phase endpoint and resume through workflow endpoint with duplicate protection', async () => {
    const js = await read('roboflow.js');
    const handlers = js.slice(js.indexOf('async function toggleFlowPause('), js.indexOf('async function refresh('));
    let complete, count = 0, redraws = 0;
    const context = { selected: 'flow_test', currentFlow: { status: 'running', instances: [{ id: 'visit', state: 'running' }] },
        flowControlPending: false, selectedInstanceId: null, phasePauseControl,
        document: { querySelector: () => null }, renderHeader() { redraws++; }, renderPhases() {},
        setMessage(message) { this.error = message; },
        post: async route => { count++; context.route = route; await new Promise(resolve => { complete = resolve; }); }, refresh: async () => {},
    };
    vm.runInNewContext(handlers, context);
    const pause = context.pausePhase('visit');
    assert.equal(context.flowControlPending, true);
    assert.equal(context.route, 'api/roboflow/flows/flow_test/instances/visit/pause');
    await context.pausePhase('visit'); assert.equal(count, 1);
    complete(); await pause; assert.equal(context.flowControlPending, false);
    context.currentFlow = { status: 'paused', instances: [{ id: 'visit', state: 'paused' }] };
    const resume = context.resumePhase('visit');
    assert.equal(context.route, 'api/roboflow/flows/flow_test/resume');
    await context.toggleFlowPause(); await context.resumePhase('visit'); assert.equal(count, 2);
    complete(); await resume;
    context.currentFlow.humanInput = { status: 'pending' };
    await context.resumePhase('visit'); await context.toggleFlowPause(); assert.equal(count, 2);
    context.currentFlow.humanInput.status = 'answered';
    context.post = async () => { throw new Error('Resume the parent workflow first'); };
    context.setMessage = message => { context.error = message; };
    await context.resumePhase('visit');
    assert.equal(context.error, 'Resume the parent workflow first'); assert.equal(context.flowControlPending, false);
    assert.ok(redraws >= 6);
});

test('pending and coordinator phases remain selectable without offering invalid pause controls', () => {
    const pending = createPhaseListItem({ task: graph.tasks[2], graph, onSelect() {}, ownerDocument: ownerDocument() });
    const card = pending.children[0]; assert.equal(card.children.length, 1); assert.equal(card.children[0].dataset.phaseKey, 'task:end');
    assert.equal(card.children[0].children[3].children.length, 0);
    assert.match(card.children[0].attributes['aria-label'], /Not started/);
    const coordinator = { ...graph.tasks[1], kind: 'run-workflows' };
    assert.equal(phaseListPresentation(coordinator, graph).icons[0].label, 'RoboFlow coordinator');
    const finished = createPhaseListItem({ task: coordinator, graph, instance: { id: 'join', state: 'completed', sequence: 1 }, ownerDocument: ownerDocument() });
    assert.equal(finished.children[0].children.length, 1);
});

test('every phase state supplies one leading icon, a tooltip and an accessible label without duplicate state text', () => {
    for (const state of ['pending', 'queued', 'starting', 'running', 'completed', 'failed', 'pausing', 'paused', 'terminated']) {
        const item = createPhaseListItem({ task: graph.tasks[1], graph, instance: { id: 'visit', state }, ownerDocument: ownerDocument() });
        const select = item.children[0].children[0], icon = select.children[1].children[0];
        assert.equal(icon.children[0].attributes.d, executionStatePresentation(state).path);
        assert.equal(select.children[1].title, executionStatePresentation(state).label);
        assert.ok(select.attributes['aria-label'].includes(executionStatePresentation(state).label));
        assert.equal(select.children[3].children.some(node => node.className === 'phase-card-state'), false);
    }
});

test('phase legend uses the same icons, labels and state colors as the phase list', () => {
    const doc = ownerDocument(), list = doc.createElement('ul');
    renderExecutionStateLegend(list, doc);
    const more = doc.createElement('ul'); renderExecutionStateLegend(more, doc, 'more');
    assert.deepEqual(list.children.map(item => item.dataset.executionState), ['running', 'completed', 'failed', 'paused', 'pending']);
    assert.deepEqual(more.children.map(item => item.dataset.executionState), ['queued', 'starting', 'pausing', 'terminated']);
    for (const item of [...list.children, ...more.children]) {
        assert.equal(item.tag, 'li');
        const state = executionStatePresentation(item.dataset.executionState);
        assert.equal(item.children[0].children[0].attributes.d, state.path);
        assert.equal(item.children[1].textContent, state.label);
    }
    renderExecutionStateLegend(list, doc);
    assert.equal(list.children.length, 5);
    renderExecutionStateLegend(more, doc, 'all');
    assert.deepEqual(more.children.map(item => item.dataset.executionState),
        ['running', 'completed', 'failed', 'paused', 'pending', 'queued', 'starting', 'pausing', 'terminated']);
});

test('single-line legend fits whole labels and reserves space for its More control', () => {
    assert.equal(fittingLegendCount([70, 90, 50], 168), 2);
    assert.equal(fittingLegendCount([70, 90, 50], 167), 1);
    assert.equal(fittingLegendCount([70, 90, 50], 226), 3);
    assert.equal(fittingLegendCount([70, 90, 50], 69), 0);
    assert.equal(fittingLegendCount([], 200), 0);
});

test('phase title aligns with its number and icon, timing stays below and legend opens in an overlay', async () => {
    const [html, css] = await Promise.all([read('roboflow.html'), read('workflow-execution.css')]);
    assert.match(html, /id="phaseList"[^]*class="phase-state-legend"[^]*id="phaseStateLegend"/);
    assert.match(css, /\.phase-card-duration \{[^}]*grid-column: 4; grid-row: 2;[^}]*white-space: nowrap/);
    assert.match(css, /\.phase-card-name \{[^}]*grid-column: 3 \/ -1; grid-row: 1;[^}]*-webkit-line-clamp: 2/);
    assert.match(html, /popovertarget="phaseLegendPopover"[^>]*>More…<\/button>/);
    assert.match(html, /id="phaseLegendPopover"[^>]*popover[^>]*aria-labelledby="phaseLegendTitle"/);
    assert.match(css, /#phaseStateLegend \{[^}]*display: flex;[^}]*overflow: hidden/);
    assert.match(css, /\.phase-legend-popover \{[^}]*position: fixed/);
    assert.doesNotMatch(html, /phase-state-legend-more|phase-legend-collapse|phase-state-legend-content/);
});

test('execution header groups controls and retains confirmation, objective expansion and polling selection', async () => {
    const [html, js, css] = await Promise.all([read('roboflow.html'), read('roboflow.js'), read('workflow-execution.css')]);
    assert.match(html, /href="styles.css"/); assert.match(html, /class="flow-execution-page"/);
    assert.match(html, /class="flow-run-meta">[\s\S]*id="flowStatus"[\s\S]*id="flowDuration"/);
    assert.match(html, /id="flowActionsMenu"[\s\S]*data-robot-menu-options hidden>[\s\S]*id="pauseFlowButton"[\s\S]*robot-danger-actions[\s\S]*id="terminateFlowButton"/);
    assert.match(html, /id="phaseCount" class="robot-count"/);
    assert.match(js, /initRobotMenu\(\{ menu: flowMenu/); assert.match(js, /terminateDialog\.showModal\(\)/);
    assert.match(js, /const action = currentFlow\?\.status === 'paused' \? 'resume' : 'pause'/);
    assert.match(js, /document\.activeElement\.dataset\.phaseKey/); assert.match(js, /focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /id="graphButton"[^>]*aria-controls="executionGraph"/);
    assert.match(js, /classList\.toggle\('is-expanded'\)/);
    assert.match(css, /\.flow-execution-page \.phase-card \{[^}]*border: 1px solid transparent/);
    assert.match(css, /\.flow-execution-page \.phase-card\[data-node-role='end'\] \{ --task-color: var\(--task-end-color\)/);
    assert.match(css, /\.phase-select:focus:not\(:focus-visible\)/);
    assert.match(css, /@media \(max-width: 720px\)/);
});

test('workflow header keeps status and duration beside the first title line without truncating metadata', async () => {
    const [html, js, css] = await Promise.all([read('roboflow.html'), read('roboflow.js'), read('workflow-execution.css')]);
    assert.match(html, /class="flow-title-row">\s*<h2 id="detail-title">Flow<\/h2>\s*<div class="flow-run-meta">/);
    assert.match(css, /\.flow-title-row \{[^}]*align-items: flex-start/);
    assert.match(css, /\.flow-heading h2 \{[^}]*min-width: 0;[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden/);
    assert.match(css, /\.flow-run-meta \{[^}]*flex: 0 0 auto;[^}]*flex-wrap: nowrap;[^}]*white-space: nowrap/);
    assert.match(js, /title.title = flow.workflowName/);
    assert.match(js, /querySelector\('\.flow-heading'\)\.append\(parentLink\)/);
    assert.doesNotMatch(js, /querySelector\('\.flow-run-meta'\)\.append\(parentLink\)/);
});

test('execution workspace fills the available viewport with bounded panel scrolling', async () => {
    const css = await read('workflow-execution.css');
    assert.match(css, /\.flow-execution-page \{[^}]*height: 100dvh; min-height: 0; overflow: hidden/);
    assert.match(css, /\.flow-execution-page \.shell \{[^}]*height: 100%; min-height: 0/);
    assert.match(css, /\.flow-execution-page \.flow-workspace \{ flex: 1; height: 100%; min-height: 0;[^}]*overflow: auto/);
    assert.match(css, /\.flow-execution-page \.stage-body \{ min-height: 0; overflow: auto/);
    assert.match(css, /\.flow-execution-page \.phase-list \{ flex: 1; min-height: 0/);
    assert.match(css, /grid-template-rows: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /grid-template-rows: auto 420px 420px/);
    assert.doesNotMatch(css, /max-height: min\(35dvh/);
});

test('execution states have distinct icons, readable labels and stable live updates', () => {
    const doc = ownerDocument(), badge = doc.createElement('span');
    const names = ['pending', 'queued', 'starting', 'running', 'completed', 'failed', 'paused', 'pausing', 'terminated'];
    assert.equal(new Set(names.map(state => executionStatePresentation(state).path)).size, names.length);
    for (const state of names) {
        renderExecutionState(badge, state, doc);
        assert.equal(badge.dataset.executionState, state);
        assert.equal(badge.children[0].attributes['aria-hidden'], 'true');
        assert.equal(badge.children[1].textContent, executionStatePresentation(state).label);
        const children = badge.children; renderExecutionState(badge, state, doc); assert.equal(badge.children, children);
    }
    assert.equal(executionStatePresentation('unvisited').label, 'Not started');
    assert.equal(executionStatePresentation('future-state').label, 'future-state');
});

test('list, detail, flow and graph share state presentation without changing server state names', async () => {
    const [js, board, css, graphCss] = await Promise.all([read('roboflow.js'), read('workflow-board.js'), read('workflow-execution.css'), read('workflow-editor.css')]);
    assert.match(js, /renderExecutionState\(status, flow.status\)/);
    assert.match(js, /renderExecutionState\(status, instance.state\)/);
    assert.match(js, /renderExecutionState\(status, child.status\)/);
    assert.match(board, /renderExecutionState\(status, states\[task.id\]\)/);
    assert.match(css, /\.flow-execution-page \.phase-card \{[^}]*border-left: 3px solid var\(--execution-color\);[^}]*background: color-mix/);
    assert.match(css, /\.phase-select \{[^}]*color: var\(--execution-color\)/);
    assert.match(graphCss, /\.graph-node\[data-execution-state\] \{[^}]*--graph-node-surface: color-mix[^}]*border-color: var\(--execution-color\)/);
    assert.match(graphCss, /\.graph-node\[data-execution-state\] strong \{ color: var\(--execution-text\)/);
    assert.match(graphCss, /\.graph-node \.graph-execution-state \.execution-state-icon \{ width: 18px/);
    assert.match(graphCss, /@keyframes execution-state-pulse[^}]*var\(--execution-color\)/);
    assert.match(graphCss, /prefers-reduced-motion: reduce/);
    for (const state of ['queued', 'starting', 'running', 'completed', 'failed', 'paused', 'terminated']) assert.match(graphCss, new RegExp(`data-execution-state='${state}'`));
    assert.match(graphCss, /\.theme-dark \{ --execution-pending/);
});

test('execution monitoring reconciles keyed phase entries and keeps its one-second timer local', async () => {
    const js = await read('roboflow.js');
    assert.match(js, /const phaseRows = new Map\(\)/);
    assert.match(js, /row\?\.signature !== signature/);
    assert.match(js, /if \(list.children\[index\] !== entry.node\) list.insertBefore/);
    assert.match(js, /if \(signature === graphSignature\) return/);
    assert.match(js, /setInterval\(\(\) => \{ if \(!document.hidden\) updateDurations\(\); \}, 1000\)/);
    assert.doesNotMatch(js, /setInterval\([^\n]*(?:refresh|pollLog)\(/);
    assert.match(js, /new TextEncoder\(\)\.encode\(request.log\).length/);
    assert.match(js, /bytes >= event.end/);
    assert.match(js, /bytes === event.start/);
    assert.match(js, /request.log \+= event.chunk/);
});

test('execution graph shares the columns container and navigation preserves the selected log stream', async () => {
    const [html, js] = await Promise.all([read('roboflow.html'), read('roboflow.js')]);
    assert.match(html, /id="stageBody"[^]*<\/section>\s*<section id="executionGraph"/);
    assert.match(html, /id="executionGraph"[^>]*tabindex="-1"/);
    const graphPanel = { focus(args) { this.focusArgs = args; }, scrollIntoView(args) { this.scrollArgs = args; } };
    const context = { selectedInstanceId: 'visit', selectedTaskId: 'start', stageView: 'log',
        document: { querySelector: () => graphPanel }, window: { matchMedia: () => ({ matches: false }) } };
    vm.runInNewContext(js.slice(js.indexOf('function scrollToPanel('), js.indexOf('function renderStage(')), context);
    vm.runInNewContext(js.slice(js.indexOf('function showGraph('), js.indexOf('async function toggleFlowPause(')), context);
    context.showGraph();
    assert.equal(context.selectedInstanceId, 'visit'); assert.equal(context.selectedTaskId, 'start'); assert.equal(context.stageView, 'log');
    assert.equal(graphPanel.focusArgs.preventScroll, true); assert.equal(graphPanel.scrollArgs.behavior, 'smooth');
    context.window.matchMedia = () => ({ matches: true }); context.showGraph();
    assert.equal(graphPanel.scrollArgs.behavior, 'instant');
});

test('wide views split logs and graph equally beside phases; stacked phases use their content height', async () => {
    const [css, js] = await Promise.all([read('workflow-execution.css'), read('roboflow.js')]);
    assert.match(css, /\.phase-pane \{ grid-column: 1; grid-row: 1 \/ -1/);
    assert.match(css, /\.stage-pane \{ grid-column: 2; grid-row: 1/);
    assert.match(css, /\.execution-graph-pane \{ grid-column: 2; grid-row: 2/);
    const stacked = css.slice(css.indexOf('@media (max-width: 720px)'));
    assert.match(stacked, /\.phase-pane \{ grid-column: 1; grid-row: 1; height: auto; max-height: none; overflow: visible/);
    assert.match(stacked, /\.phase-list \{ flex: 0 0 auto; max-height: none; overflow: visible/);
    assert.match(stacked, /\.stage-pane \{ grid-column: 1; grid-row: 2/);
    assert.match(stacked, /\.execution-graph-pane \{ grid-column: 1; grid-row: 3/);
    assert.doesNotMatch(js, /updatePhaseListHeight|--phase-list-height/);
});

test('separate execution graph updates only for graph or state changes and returns to phase details on selection', async () => {
    const js = await read('roboflow.js');
    let draws = 0, options, scrolled, chosen;
    const context = { currentFlow: { graph, instances: [{ id: 'visit', taskId: 'start', state: 'running' }] }, graphSignature: null,
        document: { querySelector: selector => selector }, drawBoard(board, captured, args) { draws++; options = args; assert.equal(board, '#executionGraphBoard'); },
        instanceForTask: () => ({ id: 'visit' }), selectPhase: id => { chosen = id; }, selectPending() {}, scrollToPanel: panel => { scrolled = panel; } };
    vm.runInNewContext(js.slice(js.indexOf('function renderGraph('), js.indexOf('function scrollToPanel(')), context);
    context.renderGraph(); context.renderGraph(); assert.equal(draws, 1);
    assert.equal(options.readOnly, true); assert.equal(options.states.start, 'running');
    context.currentFlow.instances[0].state = 'completed'; context.renderGraph(); assert.equal(draws, 2);
    options.onSelect('start'); assert.equal(chosen, 'visit'); assert.equal(scrolled, '.stage-pane');
});

async function selectionFixture() {
    const js = await read('roboflow.js');
    let redraws = 0, reconnects = 0;
    const context = { selected: 'flow', currentFlow: null, selectedInstanceId: null, selectedTaskId: null,
        phaseSelectionExplicit: false, stageView: 'empty', logRequest: null,
        document: { querySelector: () => null }, renderHeader() {}, renderPhases() {}, renderGraph() {},
        renderStage() { redraws++; }, liveUpdates: { reconnect() { reconnects++; } },
        invocationLogKey: instance => instance.id, loadLog(instance) { context.logRequest = { key: instance.id, finalResponse: instance.finalResponse }; } };
    context.instanceForTask = taskId => [...context.currentFlow.instances].reverse().find(instance => instance.taskId === taskId);
    vm.runInNewContext(js.slice(js.indexOf('function selectDefaultPhase('), js.indexOf('function showGraph(')), context);
    vm.runInNewContext(js.slice(js.indexOf('function applyFlow('), js.indexOf('async function pollLog(')), context);
    return { context, apply: instances => context.applyFlow({ id: 'flow', graph, instances }),
        counts: () => ({ redraws, reconnects }) };
}

test('explicit phase-list choices scroll to logs only in stacked layout, including pending phases', async () => {
    const js = await read('roboflow.js');
    let stacked = true, scrolls = 0, chosen;
    const panel = { focus(args) { assert.equal(args.preventScroll, true); }, scrollIntoView(args) { scrolls++; assert.equal(args.block, 'start'); } };
    const context = { currentFlow: { graph, instances: [{ id: 'visit', taskId: 'start' }] }, selectedInstanceId: null, selectedTaskId: null,
        flowControlPending: false, duration: () => '', createPhaseListItem: args => args,
        selectPhase: id => { chosen = id; }, selectPending: id => { chosen = id; }, pausePhase() {}, resumePhase() {},
        document: { querySelector: selector => { assert.equal(selector, '.stage-pane'); return panel; } },
        window: { matchMedia: query => ({ matches: query === '(max-width: 720px)' && stacked }) } };
    vm.runInNewContext(js.slice(js.indexOf('function phaseItem('), js.indexOf('function renderPhases(')), context);
    vm.runInNewContext(js.slice(js.indexOf('function scrollToPanel('), js.indexOf('function renderStage(')), context);
    context.phaseItem(graph.tasks[0], context.currentFlow.instances[0]).onSelect();
    assert.equal(chosen, 'visit'); assert.equal(scrolls, 1);
    context.pendingItem(graph.tasks[2]).onSelect(); assert.equal(chosen, 'end'); assert.equal(scrolls, 2);
    stacked = false;
    context.phaseItem(graph.tasks[0], context.currentFlow.instances[0]).onSelect();
    context.pendingItem(graph.tasks[2]).onSelect(); assert.equal(scrolls, 2);
    const automatic = js.slice(js.indexOf('function selectDefaultPhase('), js.indexOf('function showGraph('));
    assert.doesNotMatch(automatic, /scrollToPhaseLogs|scrollToPanel/);
});

test('implicit phase selection opens the running visit and follows execution changes without redundant redraws', async () => {
    const { context, apply, counts } = await selectionFixture();
    apply([{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'second', taskId: 'middle', state: 'running' }]);
    assert.equal(context.selectedInstanceId, 'second'); assert.equal(context.stageView, 'log');
    assert.equal(context.phaseSelectionExplicit, false);
    const before = counts();
    apply([{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'second', taskId: 'middle', state: 'running' }]);
    assert.deepEqual(counts(), before);
    apply([{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'second', taskId: 'middle', state: 'completed' }, { id: 'third', taskId: 'end', state: 'running' }]);
    assert.equal(context.selectedInstanceId, 'third'); assert.equal(counts().redraws, before.redraws + 1);
    apply([{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'third', taskId: 'end', state: 'completed' }]);
    assert.equal(context.selectedInstanceId, 'first');
});

test('no running visit defaults to the actual start node and shows its pending details or latest visit', async () => {
    const { context, apply } = await selectionFixture();
    context.applyFlow({ id: 'flow', graph: { ...graph, tasks: [graph.tasks[2], graph.tasks[0], graph.tasks[1]] }, instances: [] });
    assert.equal(context.selectedTaskId, 'start'); assert.equal(context.selectedInstanceId, null); assert.equal(context.stageView, 'pending');
    apply([{ id: 'old-start', taskId: 'start', state: 'completed' }, { id: 'new-start', taskId: 'start', state: 'paused' }]);
    assert.equal(context.selectedInstanceId, 'new-start'); assert.equal(context.phaseSelectionExplicit, false);
    apply([{ id: 'new-start', taskId: 'start', state: 'running' }, { id: 'next-start', taskId: 'start', state: 'running' }]);
    assert.equal(context.selectedInstanceId, 'next-start');
});

test('explicit selection from a phase or graph remains pinned while other phases run', async () => {
    const { context, apply } = await selectionFixture();
    const instances = [{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'second', taskId: 'middle', state: 'running' }];
    apply(instances); context.selectPhase('first');
    assert.equal(context.phaseSelectionExplicit, true);
    apply([...instances, { id: 'third', taskId: 'end', state: 'running' }]);
    assert.equal(context.selectedInstanceId, 'first');
    context.selectPending('end');
    apply(instances); assert.equal(context.selectedTaskId, 'end'); assert.equal(context.stageView, 'pending');
    apply([...instances, { id: 'third', taskId: 'end', state: 'starting' }]);
    assert.equal(context.selectedInstanceId, 'third'); assert.equal(context.phaseSelectionExplicit, true);
    apply(instances.map(instance => ({ ...instance, state: 'running' })));
    assert.equal(context.selectedInstanceId, 'third');
});

test('clicking the already-defaulted phase explicitly pins it and invalid clicks do not disable following', async () => {
    const { context, apply } = await selectionFixture();
    apply([{ id: 'first', taskId: 'start', state: 'running' }]);
    context.selectPhase('missing'); context.selectPending('missing');
    assert.equal(context.phaseSelectionExplicit, false);
    context.selectPhase('first');
    apply([{ id: 'first', taskId: 'start', state: 'completed' }, { id: 'second', taskId: 'middle', state: 'running' }]);
    assert.equal(context.selectedInstanceId, 'first'); assert.equal(context.phaseSelectionExplicit, true);
});
