import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initDashboardTabs } from '../public/dashboard-tabs.js';

function fixture(initialTabId) {
    const panels = ['robotsPanel', 'workflowTypesPanel', 'kronJobsPanel'].map(id => ({ id, hidden: false, draft: 'unsaved' }));
    const tabs = panels.map((panel, index) => {
        const attributes = new Map([['aria-controls', panel.id]]);
        const listeners = new Map();
        return {
            attributes, listeners, focused: false,
            getAttribute: name => attributes.get(name),
            setAttribute: (name, value) => attributes.set(name, value),
            addEventListener: (name, listener) => listeners.set(name, listener),
            removeEventListener: (name, listener) => { if (listeners.get(name) === listener) listeners.delete(name); },
            focus() { this.focused = true; },
            key(key) {
                let prevented = false;
                listeners.get('keydown')({ key, preventDefault() { prevented = true; } });
                return prevented;
            },
            index,
            id: ['robotsTab', 'workflowTypesTab', 'kronJobsTab'][index],
        };
    });
    const root = {
        querySelector: () => ({ querySelectorAll: () => tabs }),
        getElementById: id => panels.find(panel => panel.id === id),
    };
    let changes = 0;
    const controller = initDashboardTabs({ root, initialTabId, onChange: () => { changes++; } });
    return { panels, tabs, controller, changes: () => changes };
}

function assertSelected({ tabs, panels }, selected) {
    tabs.forEach((tab, index) => {
        assert.equal(tab.attributes.get('aria-selected'), String(index === selected));
        assert.equal(tab.tabIndex, index === selected ? 0 : -1);
        assert.equal(panels[index].hidden, index !== selected);
    });
}

test('dashboard tabs start with Robots and preserve panel state while switching', () => {
    const state = fixture();
    assertSelected(state, 0);
    const originalPanels = [...state.panels];
    for (const selected of [1, 2, 0]) {
        state.tabs[selected].listeners.get('click')();
        assertSelected(state, selected);
    }
    state.panels.forEach((panel, index) => {
        assert.equal(panel, originalPanels[index]);
        assert.equal(panel.draft, 'unsaved');
    });
    assert.equal(state.changes(), 4);
});

test('dashboard restores a saved Workflow types tab and ignores unknown tab identifiers', () => {
    assertSelected(fixture('workflowTypesTab'), 1);
    assertSelected(fixture('missingTab'), 0);
});

test('dashboard tabs support wrapped arrows, Home, End and listener cleanup', () => {
    const state = fixture();
    for (const [current, key, selected] of [[0, 'ArrowLeft', 2], [2, 'ArrowRight', 0], [0, 'End', 2], [2, 'Home', 0], [0, 'ArrowRight', 1]]) {
        assert.equal(state.tabs[current].key(key), true);
        assertSelected(state, selected);
        assert.equal(state.tabs[selected].focused, true);
    }
    assert.equal(state.tabs[1].key('Tab'), false);
    assertSelected(state, 1);
    state.controller.destroy();
    state.tabs.forEach(tab => assert.equal(tab.listeners.size, 0));
});

test('dashboard markup groups robot, workflow and scheduling controls into exactly three linked tabs', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.equal((html.match(/role="tab"/g) || []).length, 3);
    assert.equal((html.match(/role="tabpanel"/g) || []).length, 3);
    for (const [tab, panel, label] of [['robotsTab', 'robotsPanel', 'Robots'], ['workflowTypesTab', 'workflowTypesPanel', 'Workflow types'], ['kronJobsTab', 'kronJobsPanel', 'Cron jobs']]) {
        assert.match(html, new RegExp(`id="${tab}"[^>]*aria-controls="${panel}"[^>]*>\\s*${label}\\s*</button>`));
        assert.match(html, new RegExp(`id="${panel}"[^>]*aria-labelledby="${tab}"`));
    }
    const robots = html.slice(html.indexOf('<div id="robotsPanel"'), html.indexOf('<div id="workflowTypesPanel"'));
    const workflows = html.slice(html.indexOf('<div id="workflowTypesPanel"'), html.indexOf('<div id="kronJobsPanel"'));
    const kron = html.slice(html.indexOf('<div id="kronJobsPanel"'), html.indexOf('</main>'));
    for (const id of ['createForm', 'formMessage', 'robotsList', 'robotCount']) assert.ok(robots.includes(`id="${id}"`));
    for (const id of ['workflowsList', 'workflowCount', 'workflowListMessage', 'addWorkflowButton', 'flowsHistoryButton']) assert.ok(workflows.includes(`id="${id}"`));
    assert.doesNotMatch(robots, /id="workflowsList"/);
    assert.doesNotMatch(workflows, /id="createForm"/);
    for (const id of ['cronList', 'cronCount', 'createCronButton', 'cronDialog', 'cronForm']) assert.ok(kron.includes(`id="${id}"`));
    assert.doesNotMatch(kron, /Functionality will be defined later/);
});
