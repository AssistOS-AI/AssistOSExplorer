import assert from 'node:assert/strict';
import test from 'node:test';
import { observeWorkflow } from '../public/workflow-live-updates.js';

function fixture(t, supported = true) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const connections = [], calls = [];
    class Source extends EventTarget {
        constructor(url) { super(); this.url = url; this.readyState = 0; connections.push(this); }
        open() { this.readyState = 1; this.onopen(); }
        fail() { this.onerror(); }
        close() { this.readyState = 2; }
        send(name, data) { const event = new Event(name); event.data = JSON.stringify(data); this.dispatchEvent(event); }
    }
    const doc = new EventTarget(); doc.hidden = false;
    const win = new EventTarget();
    let instanceId = '';
    const observer = observeWorkflow({ url: () => `/events${instanceId}`, ownerDocument: doc, ownerWindow: win,
        EventSourceImpl: supported ? Source : null, onFlow: flow => calls.push(['flow', flow]), onLog: log => calls.push(['log', log]),
        onResync: async () => { calls.push(['resync']); }, onError: error => calls.push(['error', error.message]),
        fallback: async () => { calls.push(['fallback']); } });
    t.after(() => observer.dispose());
    return { observer, connections, calls, doc, win, select(id) { instanceId = id; observer.reconnect(); } };
}
test('a healthy workflow stream receives snapshots and logs without periodic requests', t => {
    const f = fixture(t), source = f.connections[0]; source.open();
    source.send('snapshot', { flow: { revision: 1 } }); source.send('log', { chunk: 'Progress' });
    t.mock.timers.tick(120_000);
    assert.equal(f.connections.length, 1); assert.equal(f.observer.connected, true);
    assert.deepEqual(f.calls, [['flow', { revision: 1 }], ['resync'], ['log', { chunk: 'Progress' }]]);
});
test('disconnects back off, use rare fallback polling and resynchronize after reconnecting', t => {
    const f = fixture(t); f.connections[0].fail();
    t.mock.timers.tick(5000); assert.equal(f.connections.length, 2); f.connections[1].fail();
    t.mock.timers.tick(10_000); assert.equal(f.connections.length, 3); f.connections[2].fail();
    t.mock.timers.tick(15_000); assert.equal(f.calls.filter(call => call[0] === 'fallback').length, 1);
    t.mock.timers.tick(5000); const source = f.connections.at(-1); source.open(); source.send('snapshot', { flow: { revision: 4 } });
    t.mock.timers.tick(60_000); assert.equal(f.calls.filter(call => call[0] === 'fallback').length, 1);
    assert.deepEqual(f.calls.slice(-2), [['flow', { revision: 4 }], ['resync']]);
});
test('visibility, navigation and phase selection retain only one live connection', t => {
    const f = fixture(t); f.connections[0].open(); f.select('?instanceId=one');
    assert.equal(f.connections[0].readyState, 2); assert.equal(f.connections[1].url, '/events?instanceId=one');
    f.connections[0].send('flow', { flow: { revision: 9 } }); assert.equal(f.calls.length, 0);
    f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.connections[1].readyState, 2);
    t.mock.timers.tick(120_000); assert.equal(f.connections.length, 2);
    f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); assert.equal(f.connections.length, 3);
    f.win.dispatchEvent(new Event('pagehide')); assert.equal(f.connections[2].readyState, 2);
    f.win.dispatchEvent(new Event('pageshow')); assert.equal(f.connections.length, 4);
    f.observer.dispose(); f.win.dispatchEvent(new Event('pageshow')); assert.equal(f.connections.length, 4);
});
test('browsers without EventSource use a 30-second fallback, not one-second polling', t => {
    const f = fixture(t, false); t.mock.timers.tick(29_999); assert.equal(f.calls.length, 0);
    t.mock.timers.tick(1); assert.deepEqual(f.calls, [['fallback']]);
    f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); t.mock.timers.tick(60_000);
    assert.equal(f.calls.length, 1);
});
test('slow fallback reads never overlap and disposal stops authorization retries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const doc = new EventTarget(); doc.hidden = false;
    const win = new EventTarget(); let calls = 0, finish;
    const observer = observeWorkflow({ url: () => '/events', ownerDocument: doc, ownerWindow: win, EventSourceImpl: null,
        onFlow() {}, onLog() {}, onResync: async () => {}, onError() {},
        fallback: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    t.after(() => observer.dispose());
    t.mock.timers.tick(120_000); assert.equal(calls, 1);
    finish(); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(30_000); assert.equal(calls, 2);
    observer.dispose(); finish(); t.mock.timers.tick(120_000); assert.equal(calls, 2);
});
