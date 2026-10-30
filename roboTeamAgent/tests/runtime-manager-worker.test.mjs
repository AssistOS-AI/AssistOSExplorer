import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RuntimeManager } from '../server/runtime-manager.mjs';

// A user stop of a robot-task child. Through the worker it is an explicit stdin record (a signal would
// only detach the child, which leaves the worker execution running); locally it is the signal.
function child() {
    const emitter = new EventEmitter();
    const written = [];
    const signals = [];
    emitter.stdin = { write: (value) => { written.push(value); return true; } };
    emitter.kill = (signal) => { signals.push(signal); return true; };
    return { child: emitter, written, signals };
}

test('with the worker a stop is the stdin record and the signal is only a delayed backstop', async () => {
    const c = child();
    RuntimeManager.prototype._stopChild.call({ workerMode: true }, c.child);
    assert.deepEqual(c.written.map((line) => JSON.parse(line)), [{ type: 'stop' }]);
    assert.deepEqual(c.signals, [], 'no immediate SIGTERM, which would only detach');
    c.child.emit('close');
});

test('without the worker a stop is SIGTERM as before', () => {
    const c = child();
    RuntimeManager.prototype._stopChild.call({ workerMode: false }, c.child);
    assert.deepEqual(c.signals, ['SIGTERM']);
    assert.deepEqual(c.written, []);
    RuntimeManager.prototype._stopChild.call({ workerMode: true }, null);
});
