import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { registerProject } from '../server/project-storage.mjs';

const headers = () => ({ 'x-ploinky-auth-info': JSON.stringify({ user: { id: 'actor', roles: ['admin'] } }) });

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webchat-logs-'));
    const workspaceRoot = path.join(root, 'workspace');
    const project = path.join(workspaceRoot, 'project');
    const sessionId = randomUUID();
    const messageId = randomUUID();
    await fs.mkdir(path.join(project, '.achilles-cli', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(project, '.achilles-cli', 'sessions', `${sessionId}.json`), '{}');
    await fs.mkdir(path.join(project, '.achilles-cli', 'logs', sessionId), { recursive: true });
    await fs.writeFile(path.join(project, '.achilles-cli', 'logs', sessionId, `${messageId}.log`), 'Reading `src/app.js`\nDone.');
    const dataDir = path.join(root, 'data');
    registerProject({ dataDir, workspaceRoot }, project);

    const robotStore = new RobotStore({ dataDir });
    await robotStore.initialize(); await robotStore.ensureDefaultRobot();
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), resolveCwd: async () => project,
        startTask(robot, type, request) { return { taskId: request.runtimeTaskId, state: 'queued' }; }, stopTask() {}, activePort: () => null };
    const roboflow = new RoboFlowService({ robotStore, runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }) });
    await roboflow.initialize();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: '/rt/' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await roboflow.close(); await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { request: (url) => fetch(base + url, { headers: headers() }), sessionId, messageId };
}

test('the agent serves a persisted conversation log by session and message id', async t => {
    const f = await fixture(t);
    const response = await f.request(`/api/webchat/logs/${f.sessionId}/${f.messageId}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Reading `src\/app\.js`/);
    assert.equal((await f.request(`/api/webchat/logs/${f.sessionId}/${randomUUID()}`)).status, 404);
});

test('the agent serves the request-log page with the injected base', async t => {
    const f = await fixture(t);
    const response = await f.request(`/webchat-logs/${f.sessionId}/${f.messageId}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /webchat-logs\.js/);
    assert.match(html, /log-render\.js|phase-log/);
    assert.match(html, /<base href="\/rt\/">/);
});
