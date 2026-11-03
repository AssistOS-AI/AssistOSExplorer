import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const entry = fileURLToPath(new URL('../tools/roboflow.mjs', import.meta.url));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
async function fixture(t, operation, handler, extra = {}) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [entry, operation], { env: { ...process.env,
        ROBOTEAM_SERVICE_PORT: String(server.address().port), ROBOTEAM_INTERNAL_TOKEN: 'test', ROBOTEAM_TASK_POLL_INTERVAL_MS: '50' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ input: { workflowTypeId: 'example', objective: 'Work', description: 'Generate', ...extra } }));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { child, exited };
}

test('cancelling the MCP start tool stops its flow despite aborted polling', { timeout: 10000 }, async t => {
    const polled = deferred(), paused = deferred();
    const id = 'flow_123456789012345678901234';
    const f = await fixture(t, 'start-flow', (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === `/api/roboflow/flows/${id}/pause`) { paused.resolve(); return res.end('{}'); }
        if (req.url.includes('?logs=')) polled.resolve();
        res.end(JSON.stringify({ flow: { id, status: 'running' } }));
    });
    await polled.promise; f.child.kill('SIGTERM');
    await paused.promise; const [code] = await f.exited; assert.equal(code, 143);
});

test('cancelling MCP generation closes the HTTP request that owns its robot task', { timeout: 10000 }, async t => {
    const started = deferred(), closed = deferred();
    const f = await fixture(t, 'generate-workflow', (req, res) => {
        assert.equal(req.url, '/api/roboflow/generate');
        res.on('close', closed.resolve); started.resolve();
    });
    await started.promise; f.child.kill('SIGTERM'); await closed.promise;
    const [code] = await f.exited; assert.equal(code, 1);
});

test('the start tool publishes a flow-page details link on stderr', { timeout: 10000 }, async t => {
    const id = 'flow_123456789012345678901234';
    const f = await fixture(t, 'start-flow', (req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ flow: { id, status: 'running' } }));
    });
    let stderr = '';
    f.child.stderr.on('data', chunk => { stderr += chunk; });
    const link = `/base-agent-additional-server/roboTeamAgent/3001/flows?flowId=${id}`;
    const deadline = Date.now() + 5000;
    while (!stderr.includes(link) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const line = stderr.split('\n').find(entry => entry.startsWith('@@PLOINKY_TASK_CONTROL@@'));
    assert.ok(line, `stderr did not contain a task control line: ${stderr}`);
    assert.deepEqual(JSON.parse(line.slice('@@PLOINKY_TASK_CONTROL@@'.length)), {
        details: { url: link, label: 'Open workflow page', logsLabel: 'View workflow logs' },
    });
});

test('the start tool passes the relay\'s robot constraint to RoboFlow', { timeout: 10000 }, async t => {
    const posted = deferred();
    const f = await fixture(t, 'start-flow', async (req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/api/roboflow/flows') {
            let text = ''; for await (const chunk of req) text += chunk;
            posted.resolve(JSON.parse(text));
        }
        res.end(JSON.stringify({ flow: { id: 'flow_123456789012345678901234', status: 'running' } }));
    }, { restrictToRobot: 'robot-one' });
    assert.equal((await posted.promise).restrictToRobot, 'robot-one');
    f.child.kill('SIGTERM');
});

test('the start tool forwards the relay\'s owner only from RoboTeam acting for itself', { timeout: 10000 }, async t => {
    const own = 'agent:AchillesIDE/roboTeamAgent';
    const grant = (sub) => ({ invocation: { sub, actor: { kind: 'agent', id: sub } } });
    for (const [metadata, expected] of [[grant(own), 'user:alice'], [grant('agent:other/agent'), undefined],
        [undefined, undefined], [{ ...grant(own), user: { id: 'bob' } }, undefined]]) {
        const posted = deferred();
        const server = http.createServer(async (req, res) => {
            res.setHeader('content-type', 'application/json');
            if (req.method === 'POST' && req.url === '/api/roboflow/flows') {
                let text = ''; for await (const chunk of req) text += chunk;
                posted.resolve(JSON.parse(text));
            }
            res.end(JSON.stringify({ flow: { id: 'flow_123456789012345678901234', status: 'running' } }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const child = spawn(process.execPath, [entry, 'start-flow'], { env: { ...process.env, ROBOTEAM_SERVICE_PORT: String(server.address().port),
            ROBOTEAM_INTERNAL_TOKEN: 'test', ROBOTEAM_TASK_POLL_INTERVAL_MS: '50' }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.end(JSON.stringify({ input: { workflowTypeId: 'example', ownerPrincipal: 'user:alice' }, ...(metadata ? { metadata } : {}) }));
        assert.equal((await posted.promise).ownerPrincipal, expected);
        child.kill('SIGKILL'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
});
