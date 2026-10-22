import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { workflowNodeRole, workflowRoleIcons } from '../public/workflow-board.js';

test('graph roles have distinct play, step and finish icons with accessible labels', () => {
    const icons = ['start', 'intermediate', 'end'].map(role => workflowRoleIcons(role)[0]);
    assert.deepEqual(icons.map(icon => icon.label), ['Start node', 'Intermediate step', 'End node']);
    assert.equal(new Set(icons.map(icon => icon.path)).size, 3);
    assert.deepEqual(workflowRoleIcons('start-end').map(icon => icon.role), ['start', 'end']);
});

test('connection points match node borders and metadata sits discreetly on the top edge', async () => {
    const [board, css] = await Promise.all(['workflow-board.js', 'workflow-editor.css'].map(file => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
    assert.match(css, /\.graph-port \{[^}]*background: var\(--graph-node-surface\); color: var\(--task-color\);/);
    assert.match(css, /data-node-role='start-end'\] \.graph-port-right \{ color: var\(--task-end-color\); \}/);
    assert.match(css, /\.graph-node \.graph-node-detail \{ position: absolute; top: 0; left: 10px; transform: translateY\(-50%\);/);
    assert.match(css, /\.graph-node \.graph-node-detail \{[^}]*max-width: calc\(100% - 24px\);[^}]*background: var\(--graph-node-surface\);/);
    assert.match(css, /\.graph-node \.graph-node-detail-text \{[^}]*font-size: 10px;[^}]*text-overflow: ellipsis;/);
    assert.match(board, /detail\.title = detailText\.textContent;/);
    assert.match(css, /\.theme-dark \.graph-node \{ --graph-node-surface: #20242b; \}/);
    assert.match(css, /\.graph-port:focus-visible \{ outline: 3px solid var\(--accent\); \}/);
});

test('role icons follow entry and connections rather than runtime state or display order', () => {
    const start = { id: 'start' }, middle = { id: 'middle' }, end = { id: 'end' };
    const graph = { entryTaskId: 'start', tasks: [end, middle, start], edges: [{ sourceTaskId: 'start', targetTaskId: 'middle' }, { sourceTaskId: 'middle', targetTaskId: 'end' }] };
    const roles = () => graph.tasks.map(task => workflowRoleIcons(workflowNodeRole(task, graph)).map(icon => icon.role));
    assert.deepEqual(roles(), [['end'], ['intermediate'], ['start']]);
    graph.edges.push({ sourceTaskId: 'end', targetTaskId: 'middle' });
    assert.deepEqual(roles(), [['intermediate'], ['intermediate'], ['start']]);
    graph.edges = [];
    assert.deepEqual(roles(), [['end'], ['end'], ['start', 'end']]);
});

test('corner icons reserve title space and do not introduce controls that intercept graph gestures', async () => {
    const [board, css] = await Promise.all(['workflow-board.js', 'workflow-editor.css'].map(file => fs.readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')));
    assert.match(board, /node\.append\(graphRoleIcons\(node\.dataset\.nodeRole\), label, detail\)/);
    assert.match(board, /const group = document\.createElement\('span'\)/);
    assert.match(board, /'aria-label': definition\.label, focusable: 'false'/);
    assert.match(board, /title\.textContent = definition\.label/);
    assert.match(css, /\.graph-node \.graph-role-icons \{ position: absolute; top: 12px; right: 8px;/);
    assert.match(css, /\.graph-node \{[^}]*padding: 12px 36px 12px 12px;/);
    assert.match(css, /data-node-role='start-end'\] \{[^}]*padding-right: 56px;/);
    assert.match(css, /\.graph-role-icon-end \{ color: var\(--task-end-color\); \}/);
});
