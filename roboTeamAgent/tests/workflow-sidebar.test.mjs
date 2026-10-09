import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { taskSidebarPresentation } from '../public/workflow-editor.js';

const read = file => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
const rule = (css, selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `Missing ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
};

test('sidebar navigation keeps link styling with a subtle task hover border', async () => {
    const css = await read('workflow-editor.css');
    for (const selector of ['.task-list-item']) {
        const styles = rule(css, selector);
        assert.match(styles, /background: transparent;/);
        assert.match(styles, /cursor: pointer;/);
    }
    assert.match(rule(css, '.task-list-item'), /border: 1px solid transparent;/);
    assert.match(css, /\.task-list-item:hover, \.task-list-item.selected \{ border-color: color-mix/);
    assert.match(css, /data-node-role='start'[^{}]*\{ --task-color: var\(--task-start-color\); \}/);
    assert.match(css, /data-node-role='end'\] \{ --task-color: var\(--task-end-color\); \}/);
    assert.match(css, /\.task-list-item:hover strong[^{}]*\{ text-decoration: underline; \}/);
    assert.doesNotMatch(css, /\.task-list-item\.selected \{[^}]*background:/);
    assert.doesNotMatch(css, /\.task-list-item\.coverage-warning\.selected \{[^}]*outline:/);
});

test('link-like navigation retains native controls, drag handling and keyboard focus', async () => {
    const [html, js, css, common] = await Promise.all([
        read('editor.html'), read('workflow-editor.js'), read('workflow-editor.css'), read('styles.css')
    ]);
    assert.doesNotMatch(html, /workflow-page-button|workflow-pages/);
    assert.match(html, /id="addTaskButton" class="button add-task"/);
    assert.match(js, /item\.onclick = \(\) => select\(task\.id\)/);
    assert.match(js, /item\.draggable = !readonly\(\)/);
    assert.match(js, /event\.altKey/);
    assert.match(css, /\.task-list-item:focus:not\(:focus-visible\) \{ outline: none; \}/);
    assert.match(common, /:where\(button, a, summary\):focus-visible \{ outline: 2px solid var\(--accent\)/);
    assert.match(css, /\.task-list-item\.coverage-warning \.task-coverage-icon \{ display: block; \}/);
    assert.match(js, /item\.setAttribute\('aria-describedby',/);
    assert.doesNotMatch(js, /task-drag-grip/);
    assert.match(js, /node\('span', String\(index \+ 1\), 'task-order'\)/);
    assert.match(js, /item\.append\(order, icons, node\('strong', name\), warning\)/);
    assert.match(js, /mode\.onchange = \(\) => \{[^}]*renderList\(\);/);
    assert.match(js, /item\.setAttribute\('aria-pressed', String\(task\.id === selected\)\)/);
});

test('workflow overview unifies description and graph with an inline breadcrumb name', async () => {
    const [html, js, bootstrap, css] = await Promise.all([read('editor.html'), read('workflow-editor.js'), read('editor.js'), read('workflow-editor.css')]);
    assert.match(html, /id="breadcrumbLeaf"[^>]*><input id="workflowName" name="name" form="workflowForm"/);
    assert.match(html, /data-embed-field="workflow-name" maxlength="120"/);
    assert.doesNotMatch(html, /<span>Name<\/span><input name="name"|flowSettingsPage|data-workflow-page/);
    assert.match(html, /name="description" class="workflow-description"/);
    assert.match(html, /id="descriptionReviewText" role="status"/);
    assert.match(js, /description\.addEventListener\('focusout'/);
    assert.match(js, /if \(!await descriptionRevision\.check\(\)\) return;/);
    assert.match(html, /<details class="workflow-help">[\s\S]*<summary[^>]*aria-label="Graph editing help"/);
    assert.match(html, /id="graphPage" class="workflow-graph" aria-label="Graph"><div id="workflowBoard"/);
    assert.doesNotMatch(js, /showPage|currentPage|workflow-page-button/);
    assert.doesNotMatch(bootstrap, /leaf\.textContent/);
    assert.match(js, /nameControl\.disabled = readonly\(\)/);
    assert.match(js, /nameControl\.addEventListener\('keydown'/);
    assert.match(js, /event\.key === 'Escape'\) updateWorkflowName\(nameBeforeEditing\)/);
    assert.match(js, /nameControl\.value\.trim\(\)/);
    assert.match(js, /nameControl\.setAttribute\('aria-invalid', 'true'\)/);
    assert.match(js, /querySelector\('#closeTaskEditor'\)\.disabled = false/);
    assert.match(css, /\.workflow-content.has-task-details \{ grid-template-columns:/);
});

test('workflow metadata advertises editing without suggesting readonly fields can be changed', async () => {
    const [html, css] = await Promise.all([read('editor.html'), read('workflow-editor.css')]);
    for (const selector of ['.workflow-name', '.workflow-description']) {
        assert.match(rule(css, selector), /border: 1px solid var\(--border-strong\);/);
        assert.match(rule(css, selector), /background: var\(--surface(?:-soft)?\);/);
        assert.match(rule(css, selector), /cursor: text;/);
    }
    assert.match(html, /class="workflow-edit-icon" data-embed-edit-icon[^>]*aria-hidden="true"/);
    assert.match(html, /<label class="workflow-description-field">/);
    assert.match(css, /\.workflow-name-field:has\(input:is\(:disabled, \[readonly\]\)\) > \.workflow-edit-icon \{ display: none; \}/);
    assert.match(css, /\.workflow-description-field:has\(textarea:is\(:disabled, \[readonly\]\)\) \.workflow-edit-icon \{ display: none; \}/);
    for (const selector of ['.workflow-name:is(:disabled, [readonly])', '.workflow-description:is(:disabled, [readonly])']) {
        assert.match(rule(css, selector), /border-color: transparent;/);
        assert.match(rule(css, selector), /background: transparent;/);
        assert.match(rule(css, selector), /cursor: default;/);
    }
});

test('graph, sidebar and legend share the selected turquoise, olive-gold and navy palette', async () => {
    const [css, board, editor] = await Promise.all([read('workflow-editor.css'), read('workflow-board.js'), read('workflow-editor.js')]);
    assert.match(rule(css, ':root'), /--task-start-color: #0f766e; --task-intermediate-color: #8a7800; --task-end-color: #1e3a8a;/);
    for (const selector of ['.theme-dark', ':root:not(.theme-light)']) {
        assert.match(rule(css, selector), /--task-start-color: #5eead4; --task-intermediate-color: #e2d15c; --task-end-color: #93c5fd;/);
    }
    assert.match(css, /\.graph-node\[data-node-role='end'\] \{ --task-color: var\(--task-end-color\); \}/);
    assert.match(css, /\.graph-node\[data-node-role='start'\][^{}]*\{ --task-color: var\(--task-start-color\); \}/);
    assert.match(rule(css, '.task-list-item'), /--task-color: var\(--task-intermediate-color\);/);
    assert.match(css, /\.graph-node \{ --task-color: var\(--task-intermediate-color\);/);
    assert.match(rule(css, '.task-role-legend .legend-start::before'), /background: var\(--task-start-color\);/);
    assert.match(rule(css, '.task-role-legend span::before'), /background: var\(--task-intermediate-color\);/);
    assert.match(rule(css, '.task-role-legend .legend-end::before'), /background: var\(--task-end-color\);/);
    assert.match(board, /node\.dataset\.nodeRole = workflowNodeRole\(task, graph\)/);
    assert.match(editor, /const role = workflowNodeRole\(task, graph\)/);
    assert.doesNotMatch(css, /\.graph-node\.graph-terminal \{[^}]*var\(--danger/);
});

test('task details fill the same row as the narrow graph without changing the user-defined order', async () => {
    const [html, css] = await Promise.all([read('editor.html'), read('workflow-editor.css')]);
    assert.ok(html.indexOf('id="taskPage"') < html.indexOf('id="graphPage"'));
    assert.match(rule(css, '.workflow-content.has-task-details'), /grid-template-columns: minmax\(0, 1fr\) 340px;/);
    assert.match(rule(css, '.workflow-content'), /grid-template-rows: minmax\(0, 1fr\); align-items: stretch;/);
    for (const selector of ['.workflow-task-details', '.task-editor-panel']) {
        assert.match(rule(css, selector), /display: flex;/);
        assert.match(rule(css, selector), /min-height: 0;/);
    }
    const card = rule(css, '.task-editor-panel > .task-editor');
    assert.match(card, /flex: 1 1 auto;/);
    assert.match(card, /overflow: auto;/);
    assert.match(card, /box-sizing: border-box;/);
    assert.match(css, /\.workflow-content.has-task-details \.workflow-task-details \{ height: 340px; flex: 0 0 auto; \}/);
});

test('sidebar roles follow entry and outgoing edges independently of list order', () => {
    const tasks = ['finish', 'start', 'middle', 'alternative-end'].map(id => ({ id }));
    const graph = { tasks, entryTaskId: 'start', edges: [{ sourceTaskId: 'start', targetTaskId: 'middle' }, { sourceTaskId: 'middle', targetTaskId: 'finish' }] };
    const before = structuredClone(graph);
    assert.deepEqual(tasks.map(task => taskSidebarPresentation(task, graph).role), ['end', 'start', 'intermediate', 'end']);
    tasks.reverse();
    assert.deepEqual(tasks.map(task => taskSidebarPresentation(task, graph).role), ['end', 'intermediate', 'start', 'end']);
    tasks.reverse();
    assert.deepEqual(graph, before);
    graph.edges.push({ sourceTaskId: 'finish', targetTaskId: 'middle' });
    assert.equal(taskSidebarPresentation(tasks[0], graph).role, 'intermediate');
    graph.edges = [];
    assert.equal(taskSidebarPresentation(tasks[1], graph).role, 'start-end');
    assert.equal(taskSidebarPresentation(tasks[1], graph).roleLabel, 'Start / End node');
});

test('execution modes and special task capabilities have distinct accessible icons', () => {
    const graph = { entryTaskId: 'task', edges: [] };
    const icons = ['browser', 'terminal', 'desktop', undefined].map(executionType => taskSidebarPresentation({ id: 'task', executionType }, graph).icons[0]);
    assert.equal(new Set(icons.map(icon => icon.path)).size, 4);
    assert.deepEqual(icons.slice(0, 3).map(icon => icon.label), ['Browser', 'Terminal', 'Desktop']);
    assert.match(icons[3].label, /Automatic execution/);
    const creator = taskSidebarPresentation({ id: 'task', executionType: 'browser', creator: true }, graph);
    assert.deepEqual(creator.icons.map(icon => icon.label), ['Browser', 'Allows sub-flows']);
    const coordinator = taskSidebarPresentation({ id: 'task', kind: 'run-workflows', executionType: 'browser' }, graph);
    assert.deepEqual(coordinator.icons.map(icon => icon.label), ['RoboFlow coordinator']);
});
