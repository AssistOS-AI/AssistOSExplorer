import test from 'node:test';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkerControl } from '../server/worker-control.mjs';
import { request } from '../scripts/worker-mcp.mjs';

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp('/tmp/rwc-');
    const service = createWorkerControl({ root, ...options });
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    const { id } = await service.create('user:owner');
    const socket = path.join(service.claim(id, 'user:owner', 'supervisor-profile'), 'control.sock');
    const call = (method, params) => request({ jsonrpc: '2.0', id: 1, method, params }, socket);
    return { service, id, call };
}

test('MCP exposes only paired worker tools and refuses other owners, targets and offline relays', async t => {
    const { service, id, call } = await fixture(t);
    const init = await call('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(init.result.capabilities.tools !== undefined, true);
    assert.deepEqual((await call('tools/list')).result.tools.map(t => t.name), ['worker_status', 'worker_interrupt', 'worker_send']);
    assert.throws(() => service.poll(id, 'user:other'), /unavailable/u);
    assert.throws(() => service.claim(id, 'user:owner', 'another-profile'), /already belongs/u);
    assert.equal((await call('tools/call', { name: 'worker_status', arguments: { terminalId: 'other' } })).error.code, -32602);
    assert.equal((await call('tools/call', { name: 'worker_status', arguments: {} })).result.isError, true);
    assert.equal((await call('tools/call', { name: 'worker_send', arguments: { message: '\u0003' } })).error.code, -32602);
});

test('requests dispatch once, return acknowledged results and are revoked with their channel', async t => {
    const { service, id, call } = await fixture(t);
    service.poll(id, 'user:owner');
    const response = call('tools/call', { name: 'worker_send', arguments: { message: 'Read tasks.md' } });
    let queued;
    for (let attempt = 0; attempt < 50 && !queued; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2));
        queued = service.poll(id, 'user:owner').requests[0];
    }
    assert.equal(queued.operation, 'worker_send');
    assert.deepEqual(service.poll(id, 'user:owner').requests, []);
    service.poll(id, 'user:owner', [{ requestId: queued.requestId, result: { delivered: true } }]);
    assert.deepEqual(JSON.parse((await response).result.content[0].text), { delivered: true });
    await service.remove(id, 'user:owner');
    assert.throws(() => service.poll(id, 'user:owner'), /unavailable/u);
});

test('native stdio bridge completes initialization and tools discovery without non-protocol output', async t => {
    const { service, id } = await fixture(t);
    const directory = service.claim(id, 'user:owner', 'supervisor-profile');
    const child = spawn(process.execPath, [path.join(directory, 'mcp.mjs'), path.join(directory, 'control.sock')], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const output = [];
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => output.push(JSON.parse(line)));
    const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    assert.equal(await exited, 0, errors);
    assert.equal(output.length, 2);
    assert.equal(output.find(item => item.id === 2).result.tools.length, 3);
    assert.equal(errors, '');
});

test('server relay poll must name the claimed supervisor and validation never dequeues requests', async t => {
    const { service, id, call } = await fixture(t);
    assert.throws(() => service.poll(id, 'user:owner', [], 'another-profile'), /does not own/u);
    service.poll(id, 'user:owner', [], 'supervisor-profile');
    const response = call('tools/call', { name: 'worker_status', arguments: {} });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(service.poll(id, 'user:owner', [], 'supervisor-profile', true).requests, []);
    const queued = service.poll(id, 'user:owner', [], 'supervisor-profile').requests;
    assert.equal(queued.length, 1);
    service.poll(id, 'user:owner', [{ requestId: queued[0].requestId, result: { running: true } }], 'supervisor-profile');
    assert.equal(JSON.parse((await response).result.content[0].text).running, true);
});
