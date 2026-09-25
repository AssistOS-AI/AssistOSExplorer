import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';

const headers = () => ({ 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'actor', roles: ['admin'] } }) });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roboflow-pages-'));
    const robotStore = new RobotStore({ dataDir: path.join(root, 'data') });
    await robotStore.initialize(); await robotStore.ensureDefaultRobot();
    const runtimeManager = { workspaceRoot: root, status: () => ({ state: 'stopped' }), resolveCwd: async () => root,
        startTask(robot, type, request) { return { taskId: request.runtimeTaskId, state: 'queued' }; }, stopTask() {}, activePort: () => null };
    const roboflow = new RoboFlowService({ robotStore, runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }) });
    await roboflow.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: '/rt/' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await roboflow.close(); await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return (url) => fetch(base + url, { headers: headers() });
}

test('the main page renders the RoboTeam breadcrumb and page links', async t => {
    const request = await fixture(t);
    const response = await request('/');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /class="breadcrumbs"[\s\S]*aria-current="page"[^>]*>RoboTeam</);
    assert.match(html, /id="flowsHistoryButton"[^>]*href="flows"/);
    assert.match(html, /id="addWorkflowButton"[^>]*href="flow-types\/generate-new"[^>]*>Create</);
    assert.equal(html.includes('id="workflowDialog"'), false);
    assert.equal(html.includes('id="flowsHistoryDialog"'), false);
});

test('the flows list and flow execution pages are served under /flows', async t => {
    const request = await fixture(t);
    const list = await request('/flows');
    assert.equal(list.status, 200);
    const listHtml = await list.text();
    assert.match(listHtml, /flows\.js/);
    assert.match(listHtml, /class="breadcrumbs"[\s\S]*href="\.\/"[^>]*>RoboTeam</);

    const execution = await request('/flows?flowId=flow_123456789012345678901234');
    assert.equal(execution.status, 200);
    const executionHtml = await execution.text();
    assert.match(executionHtml, /roboflow\.js/);
    assert.match(executionHtml, /id="breadcrumbLeaf"/);
    assert.match(executionHtml, /href="flows"[^>]*>flows</);

    assert.equal((await request('/roboflow')).status, 404);
});

test('flow type pages are served for new and existing editors', async t => {
    const request = await fixture(t);
    for (const url of ['/flow-types', '/flow-types/new', '/flow-types?id=example']) {
        const response = await request(url);
        assert.equal(response.status, 200, url);
        const html = await response.text();
        assert.match(html, /editor\.js/);
        assert.match(html, /flow-types/);
        assert.match(html, /id="breadcrumbLeaf"/);
        assert.equal(html.includes('id="generationPage"'), false);
        assert.equal(html.includes('id="generateWorkflow"'), false);
    }
});

test('the flow type generation step is a separate page', async t => {
    const request = await fixture(t);
    const response = await request('/flow-types/generate-new');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /generate\.js/);
    assert.match(html, /id="generationDescription"/);
    assert.match(html, /id="skipButton"/);
    assert.match(html, /id="cancelButton"/);
    assert.match(html, /id="generationLog"/);
    assert.equal(html.includes('id="generationPage"'), false);
});

test('page modules are served as javascript', async t => {
    const request = await fixture(t);
    for (const asset of ['/flows.js', '/editor.js', '/generate.js', '/roboflow.js', '/roboflow-api.js', '/app.js']) {
        const response = await request(asset);
        assert.equal(response.status, 200, asset);
        assert.match(response.headers.get('content-type') || '', /javascript/, asset);
    }
});
