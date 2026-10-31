// Decision M-61: with the worker configured `roboflow_start_flow` is hidden exactly as `roboflow_pause_flow` is (M-55 (b)): a
// workflow is started from the RoboFlow page, because an internal-token request carries no user grant for the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { toolConfigFor, WORKER_HIDDEN_TOOLS } from '../server/mcp-tool-list.mjs';

const AGENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(AGENT_ROOT, 'tools/roboflow.mjs');
const WORKER_ENV = { ROBOTEAM_WORKER_COORDINATOR_BASE: 'http://127.0.0.1:1/coordinator' };
const REFUSAL = 'Start workflows from the RoboFlow page.';

async function startFlow(t, env) {
    let requests = 0;
    const server = http.createServer((_req, res) => { requests += 1; res.statusCode = 500; res.end('{}'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    const childEnv = { ...process.env, ROBOTEAM_SERVICE_PORT: String(server.address().port), ROBOTEAM_INTERNAL_TOKEN: 'test' };
    delete childEnv.ROBOTEAM_WORKER_COORDINATOR_BASE;
    const child = spawn(process.execPath, [entry, 'start-flow'], { env: { ...childEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ input: { workflowTypeId: 'example', objective: 'Work' } }));
    const [code] = await exited;
    return { code, stderr, requests: () => requests };
}

test('M-61: the worker-mode tool list omits roboflow_start_flow and roboflow_pause_flow, and the other tools stay in order', async () => {
    const config = JSON.parse(await fs.readFile(path.join(AGENT_ROOT, 'mcp-config.json'), 'utf8'));
    const names = (value) => value.tools.map((tool) => tool.name);
    assert.ok(names(config).includes('roboflow_start_flow'));
    assert.deepEqual(toolConfigFor(config, { workerMode: false }), config, 'non-worker is unchanged');
    const worker = toolConfigFor(config, { workerMode: true });
    assert.equal(names(worker).includes('roboflow_start_flow'), false);
    assert.equal(names(worker).includes('roboflow_pause_flow'), false);
    assert.deepEqual(names(worker), names(config).filter((name) => !WORKER_HIDDEN_TOOLS.includes(name)));
    // M-67 adds the Browser and Desktop tools, which need RoboTeam's own GUI container.
    assert.deepEqual([...WORKER_HIDDEN_TOOLS].sort(), ['getSessionUrlForRobotBrowser', 'getSessionUrlForRobotDesktop', 'openDesktopForRobot', 'roboflow_pause_flow', 'roboflow_start_flow',
        'startBrowserTaskForRobot', 'startDesktopTaskForRobot', 'stopBrowserContainerForRobot', 'stopBrowserTaskForRobot', 'stopDesktopContainerForRobot', 'stopDesktopTaskForRobot']);
});

test('M-61: with the worker configured a direct start-flow call is refused plainly before any request', { timeout: 10000 }, async (t) => {
    const result = await startFlow(t, WORKER_ENV);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), REFUSAL);
    assert.equal(result.requests(), 0);
});

test('M-61: without the worker the start tool still reaches the service', { timeout: 10000 }, async (t) => {
    const result = await startFlow(t, {});
    assert.equal(result.code, 1, 'the stub service answers 500, so the start fails after the request');
    assert.notEqual(result.stderr.trim(), REFUSAL);
    assert.equal(result.requests(), 1);
});
