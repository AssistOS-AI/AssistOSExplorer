import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { workflowsForTab, elapsedMs, executedNodes, formatDuration, workflowUrl, fetchWorkflows, answerHumanInput } from '../IDE-plugins/observability/components/observability-panel/workflow-model.js';
import { ObservabilityPanel } from '../IDE-plugins/observability/components/observability-panel/observability-panel.js';

const pluginDirectory = path.resolve(import.meta.dirname, '../IDE-plugins/observability');

test('Observability declares a fullscreen toolbar plugin immediately after RoboTeam', async () => {
    const plugin = JSON.parse(await fs.readFile(path.join(pluginDirectory, 'config.json'), 'utf8'));
    const roboTeam = JSON.parse(await fs.readFile(path.join(pluginDirectory, '../roboteam-tool-button/config.json'), 'utf8'));
    assert.equal(plugin.id, 'observability');
    assert.equal(plugin.pluginCategory, 'application');
    assert.deepEqual(plugin.location, ['file-exp:toolbar']);
    assert.equal(plugin.locationOrder, roboTeam.locationOrder + 10);
    assert.equal(plugin.toolbarModal.fullscreen, true);
    assert.equal(plugin.toolbarModal.component, 'observability-panel');
    assert.equal(plugin.dependencies[0].presenter, 'ObservabilityPanel');
    for (const asset of [plugin.icon, `${plugin.component}.js`, `${plugin.component}.html`, `${plugin.component}.css`,
        ...['js', 'html', 'css'].map(ext => `components/observability-panel/observability-panel.${ext}`)]) {
        await fs.access(path.join(pluginDirectory, asset));
    }
});

test('Tabs separate active and terminal executions; human input lists paused and failed flows', () => {
    const flows = ['running', 'pending', 'completed', 'failed', 'paused', 'requires_human_input'].map((status, i) => ({ id: status, status, createdAt: `2026-10-01T00:00:0${i}Z` }));
    assert.deepEqual(workflowsForTab(flows, 'human').map(flow => flow.id), ['paused', 'failed']);
    assert.deepEqual(workflowsForTab(flows, 'running').map(flow => flow.id), ['pending', 'running']);
    assert.deepEqual(workflowsForTab(flows, 'history').map(flow => flow.id), ['paused', 'failed', 'completed']);
});

test('Duration accumulates active execution time and freezes when finished', () => {
    const activeSince = '2026-10-01T01:00:00Z';
    const now = Date.parse(activeSince) + 5000;
    assert.equal(elapsedMs({ status: 'running', elapsedMs: 10000, activeSince }, now), 15000);
    assert.equal(elapsedMs({ status: 'paused', elapsedMs: 10000, activeSince }, now), 10000);
    assert.equal(elapsedMs({ status: 'pending', createdAt: activeSince }, now), 0);
    assert.equal(elapsedMs({ status: 'completed', createdAt: activeSince, finishedAt: '2026-10-01T01:01:00Z' }, now), 60000);
    assert.equal(elapsedMs({ status: 'completed' }, now), null);
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(90061000), '1d 1h 1m 1s');
});

test('Node counts include finished loop visits, excluding queued and active work', () => {
    assert.equal(executedNodes({ instances: [
        { nodeId: 'a', state: 'completed' }, { nodeId: 'a', state: 'completed' },
        { nodeId: 'b', state: 'failed', startedAt: '2026-10-01' },
        { state: 'paused', startedAt: '2026-10-01' },
        { state: 'failed' }, { state: 'running', startedAt: '2026-10-01' }, { state: 'pending' },
    ] }), 4);
    assert.equal(executedNodes({}), 0);
    assert.equal(new URL(workflowUrl('a/b?x=&'), 'https://example.test').searchParams.get('flowId'), 'a/b?x=&');
});

test('Fetch uses the authenticated same-origin list and propagates abort signal', async () => {
    const signal = new AbortController().signal;
    const flows = [{ id: 'flow' }];
    assert.deepEqual(await fetchWorkflows({ signal, fetchImpl: async (url, options) => {
        assert.equal(url, '/base-agent-additional-server/roboTeamAgent/3001/api/roboflow/flows');
        assert.equal(options.credentials, 'include');
        assert.equal(options.signal, signal);
        return { ok: true, json: async () => ({ flows }) };
    } }), flows);
    await assert.rejects(fetchWorkflows({ fetchImpl: async () => ({ ok: false, status: 403 }) }), { status: 403 });
    await assert.rejects(fetchWorkflows({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /invalid list/);
});

test('Closing aborts outstanding requests and prevents late refresh scheduling', async () => {
    const originalFetch = globalThis.fetch;
    let signal;
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    try {
        const panel = new ObservabilityPanel({ removeEventListener() {} }, () => {});
        panel.render = () => {};
        const pending = panel.refresh();
        assert.equal(signal.aborted, false);
        panel.afterUnload();
        await pending;
        assert.equal(signal.aborted, true);
        assert.equal(panel.poll, undefined);
        assert.deepEqual(panel.flows, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});


test('answer submission includes the question identity, choice and custom text through the authenticated route', async () => {
    const input = { requestId: 'question-1', option: 3, text: 'Partners' };
    const flow = { id: 'flow-1', status: 'running' };
    assert.deepEqual(await answerHumanInput('flow-1', input, { fetchImpl: async (url, options) => {
        assert.equal(url, '/base-agent-additional-server/roboTeamAgent/3001/api/roboflow/flows/flow-1/human-input/answer');
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, 'include');
        assert.deepEqual(JSON.parse(options.body), input);
        return { ok: true, json: async () => ({ flow }) };
    } }), flow);
    await assert.rejects(answerHumanInput('flow-1', input, { fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'Already answered' }) }) }), /Already answered/);
});

test('terminated workflows appear only in history', () => {
    const flows = [{ id: 'dead', status: 'terminated' }];
    assert.deepEqual(workflowsForTab(flows, 'human'), []);
    assert.deepEqual(workflowsForTab(flows, 'running'), []);
    assert.deepEqual(workflowsForTab(flows, 'history'), flows);
});
