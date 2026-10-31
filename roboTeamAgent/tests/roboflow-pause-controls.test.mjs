import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { toolConfigFor } from '../server/mcp-tool-list.mjs';

// Decision M-55: the launch-workflow cancellation pauses its flow through a system stop that the worker must accept (a), and the
// MCP pause tool is not offered with the worker configured (b).
const AGENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(AGENT_ROOT, 'tools/roboflow.mjs');
const ID = 'flow_123456789012345678901234';
const WORKER_ENV = { ROBOTEAM_WORKER_COORDINATOR_BASE: 'http://127.0.0.1:1/coordinator' };

async function run(t, operation, { handler, env = {}, input = { workflowTypeId: 'example', objective: 'Work' } } = {}) {
    const server = http.createServer(handler || ((_req, res) => { res.statusCode = 500; res.end('{}'); }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const childEnv = { ...process.env, ROBOTEAM_SERVICE_PORT: String(server.address().port), ROBOTEAM_INTERNAL_TOKEN: 'test', ROBOTEAM_TASK_POLL_INTERVAL_MS: '50' };
    delete childEnv.ROBOTEAM_WORKER_COORDINATOR_BASE;
    const child = spawn(process.execPath, [entry, operation], { env: { ...childEnv, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ input }));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
    return { child, exited, out: () => ({ stdout, stderr }) };
}
const json = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

async function cancelled(t, pauseResponse) {
    let polled, paused;
    const polledPromise = new Promise((resolve) => { polled = resolve; });
    const pausedPromise = new Promise((resolve) => { paused = resolve; });
    const seen = [];
    // The start tool is refused in worker mode (decision M-61), so the cancellation path is exercised without the worker variable.
    const f = await run(t, 'start-flow', { handler: (req, res) => {
        seen.push(`${req.method} ${req.url}`);
        if (req.url === `/api/roboflow/flows/${ID}/pause`) { paused(); return pauseResponse(res); }
        if (req.url.includes('?logs=')) polled();
        json(res, 200, { flow: { id: ID, status: 'running' } });
    } });
    await polledPromise;
    f.child.kill('SIGTERM');
    await pausedPromise;
    const [code] = await f.exited;
    return { code, ...f.out(), seen };
}

test('M-55 (a): when the worker accepts, the cancelled launch task ends with the flow paused and no notice', { timeout: 10000 }, async (t) => {
    const result = await cancelled(t, (res) => json(res, 200, { ok: true, flow: { id: ID, status: 'paused' } }));
    assert.equal(result.code, 143);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /not paused/);
    assert.ok(result.seen.includes(`POST /api/roboflow/flows/${ID}/pause`));
});

test('M-55 (a): when the worker does not accept, the task result carries a notice and says the flow keeps running', { timeout: 10000 }, async (t) => {
    const result = await cancelled(t, (res) => json(res, 409, { ok: false, error: 'Stop not delivered: the worker did not accept it. The task may still be running; press stop again.' }));
    assert.equal(result.code, 143);
    const record = JSON.parse(result.stdout);
    assert.equal(record.taskStatus, 'cancelled');
    assert.equal(record.flowId, ID);
    assert.equal(record.status, 'running');
    assert.match(record.outputText, /^The workflow was not paused: Stop not delivered: the worker did not accept it\./);
    assert.match(record.outputText, /Pause button on the RoboFlow page/);
    assert.match(result.stderr, /The workflow was not paused/);
});

test('M-55 (a): an unreachable service also leaves the notice', { timeout: 10000 }, async (t) => {
    const result = await cancelled(t, (res) => res.socket.destroy());
    assert.equal(result.code, 143);
    assert.match(JSON.parse(result.stdout).outputText, /^The workflow was not paused: .*It is still running; pause it with the Pause button/);
});

test('M-55 (b): with the worker configured a pause-tool call is refused plainly and reaches no service', { timeout: 10000 }, async (t) => {
    let requests = 0;
    const f = await run(t, 'pause-flow', { env: WORKER_ENV, input: { flowId: ID }, handler: (_req, res) => { requests += 1; json(res, 200, {}); } });
    const [code] = await f.exited;
    assert.equal(code, 1);
    assert.equal(f.out().stderr.trim(), 'Pausing a workflow through this tool is not available while the worker runs it. Use the Pause button on the RoboFlow page.');
    assert.equal(requests, 0);
});

test('M-55 (b): without the worker the pause tool still pauses the flow', { timeout: 10000 }, async (t) => {
    const f = await run(t, 'pause-flow', { input: { flowId: ID }, handler: (req, res) => json(res, 200, { ok: true, url: req.url }) });
    const [code] = await f.exited;
    assert.equal(code, 0, f.out().stderr);
    assert.match(f.out().stdout, new RegExp(`/api/roboflow/flows/${ID}/pause`));
});

test('M-55 (b): the tool list omits roboflow_pause_flow only in worker mode', async (t) => {
    const config = JSON.parse(await fs.readFile(path.join(AGENT_ROOT, 'mcp-config.json'), 'utf8'));
    const names = (value) => value.tools.map((tool) => tool.name);
    assert.ok(names(config).includes('roboflow_pause_flow'));
    assert.deepEqual(toolConfigFor(config, { workerMode: false }), config);
    const worker = toolConfigFor(config, { workerMode: true });
    assert.equal(names(worker).includes('roboflow_pause_flow'), false);
    // Decision M-61 also hides roboflow_start_flow in worker mode (tests/m61-start-flow-hidden.test.mjs).
    assert.deepEqual(names(worker), names(config).filter((name) => !['roboflow_pause_flow', 'roboflow_start_flow'].includes(name)), 'every other tool stays, in order');
    // The launcher script writes exactly that list for AgentServer when the worker is configured and writes nothing otherwise.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-list-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const script = path.join(AGENT_ROOT, 'scripts/write-mcp-config.mjs');
    const env = { ...process.env, TMPDIR: dir };
    delete env.ROBOTEAM_WORKER_COORDINATOR_BASE;
    const plain = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, '');
    assert.deepEqual(await fs.readdir(dir), [], 'nothing is written without the worker');
    // The old fixed name, planted as a link to a victim file, is neither followed nor used.
    const victim = path.join(dir, 'victim.json');
    await fs.writeFile(victim, 'untouched');
    await fs.symlink(victim, path.join(dir, 'roboteam-mcp-config.json'));
    const configured = spawnSync(process.execPath, [script], { env: { ...env, ...WORKER_ENV }, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    const target = configured.stdout.trim();
    assert.equal(path.dirname(path.dirname(target)), dir, 'inside a new directory of the temporary directory');
    assert.match(path.basename(path.dirname(target)), /^roboteam-mcp-[A-Za-z0-9]{6}$/u);
    assert.equal((await fs.stat(path.dirname(target))).mode & 0o777, 0o700, 'private directory');
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600, 'private file');
    assert.deepEqual(names(JSON.parse(await fs.readFile(target, 'utf8'))), names(worker));
    assert.equal(await fs.readFile(victim, 'utf8'), 'untouched');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['roboteam-mcp-config.json', path.basename(path.dirname(target)), 'victim.json'].sort(), 'nothing else is created');
    const second = spawnSync(process.execPath, [script], { env: { ...env, ...WORKER_ENV }, encoding: 'utf8' });
    assert.notEqual(second.stdout.trim(), target, 'every launch gets its own directory');
    // A temporary directory that cannot be written is a failure (startAgent.sh runs under set -eu), not an empty answer.
    const failed = spawnSync(process.execPath, [script], { env: { ...env, ...WORKER_ENV, TMPDIR: path.join(dir, 'missing') }, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, '');
});
