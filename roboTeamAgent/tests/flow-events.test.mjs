import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { streamFlowEvents } from '../server/roboflow/flow-events.mjs';

async function fixture(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const listeners = new Set(), frames = [];
    let reads = 0;
    class Response extends EventEmitter {
        writeHead(status, headers) { this.status = status; this.headers = headers; }
        flushHeaders() {}
        write(frame) { frames.push(frame); return !this.slow; }
        end() { this.writableEnded = true; }
        destroy() { this.destroyed = true; this.emit('close'); }
    }
    const res = new Response();
    const flow = { id: 'flow', instances: [{ id: 'one' }, { id: 'two' }], revision: 1 };
    const roboflow = { getFlow: async () => { reads++; return structuredClone(flow); },
        subscribeFlow(id, listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    await streamFlowEvents({ req: {}, res, roboflow, flowId: 'flow', instanceId: 'one' });
    t.after(() => res.destroy());
    return { res, flow, frames, listeners, reads: () => reads,
        publish(event) { for (const listener of listeners) listener(event); },
        async tick(ms) { t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); } };
}
test('idle SSE sends only heartbeat frames, never polls storage, and disconnect releases listeners', async t => {
    const f = await fixture(t); assert.equal(f.res.status, 200); assert.equal(f.reads(), 2);
    await f.tick(60_000); assert.equal(f.reads(), 2);
    assert.ok(f.frames.includes(': keepalive\n\n')); assert.equal(f.listeners.size, 1);
    f.res.destroy(); assert.equal(f.listeners.size, 0);
    const count = f.frames.length; await f.tick(60_000); assert.equal(f.frames.length, count);
});
test('SSE coalesces changes and selected UTF-8 log chunks, without exposing other phase logs', async t => {
    const f = await fixture(t);
    f.flow.revision = 2; f.publish({ kind: 'flow' }); f.publish({ kind: 'flow' });
    f.publish({ kind: 'output', suffix: 'log', instanceId: 'two', start: 0, end: 6, chunk: 'SECRET' });
    f.publish({ kind: 'output', suffix: 'log', instanceId: 'one', start: 0, end: 3, chunk: 'șa' });
    f.publish({ kind: 'output', suffix: 'log', instanceId: 'one', start: 3, end: 5, chunk: 're' });
    await f.tick(200);
    assert.equal(f.reads(), 3);
    const frames = f.frames.join(''); assert.doesNotMatch(frames, /SECRET/);
    assert.match(frames, /event: log\ndata: .*"start":0,"end":5,"chunk":"șare"/);
    assert.equal(f.frames.filter(frame => frame.startsWith('event: flow')).length, 1);
});
test('oversized logs request resynchronization and slow readers close instead of buffering forever', async t => {
    const f = await fixture(t), chunk = 'x'.repeat(65 * 1024);
    f.publish({ kind: 'output', suffix: 'log', instanceId: 'one', start: 0, end: chunk.length, chunk });
    await f.tick(200); assert.ok(f.frames.some(frame => frame.startsWith('event: log-reset')));
    assert.ok(!f.frames.some(frame => frame.includes(chunk)));
    f.res.slow = true; f.publish({ kind: 'flow' }); await f.tick(200);
    assert.equal(f.res.destroyed, true); assert.equal(f.listeners.size, 0);
});
test('stream lifetime releases all subscriptions and timers', async t => {
    const f = await fixture(t); await f.tick(25 * 60_000);
    assert.equal(f.res.writableEnded, true); assert.equal(f.listeners.size, 0);
});
test('service shutdown ends an open stream immediately', async t => {
    const f = await fixture(t); f.publish({ kind: 'close' });
    assert.equal(f.res.writableEnded, true); assert.equal(f.listeners.size, 0);
    const count = f.frames.length; await f.tick(60_000); assert.equal(f.frames.length, count);
});
