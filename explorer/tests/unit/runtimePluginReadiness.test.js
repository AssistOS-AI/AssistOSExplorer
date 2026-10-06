import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS,
    scheduleRuntimePluginReady
} from '../../services/runtime/runtimePluginReadiness.js';

test('T3: ready is dispatched within 250 ms of the call even if the browser never goes idle', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const idleOptions = [];
    // An idle callback that only fires at its deadline: the worst case the browser may produce.
    const scheduler = {
        requestIdleCallback(callback, options) {
            idleOptions.push(options);
            return setTimeout(callback, options.timeout);
        },
        setTimeout
    };

    scheduleRuntimePluginReady((event) => events.push(event), scheduler);
    assert.deepEqual(idleOptions, [{ timeout: 250 }]);
    assert.equal(RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS, 250);

    t.mock.timers.tick(249);
    assert.equal(events.length, 0);
    t.mock.timers.tick(1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistos:runtime-plugins-updated');
    assert.deepEqual(events[0].detail, { phase: 'ready' });

    t.mock.timers.tick(5000);
    assert.equal(events.length, 1, 'ready is dispatched once and never at the old 2500 ms grace');
});

test('T3: without requestIdleCallback ready is dispatched from a zero-delay timeout', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const events = [];
    const delays = [];
    const scheduler = {
        setTimeout(callback, delay) {
            delays.push(delay);
            return setTimeout(callback, delay);
        }
    };

    scheduleRuntimePluginReady((event) => events.push(event), scheduler);
    assert.deepEqual(delays, [0]);
    assert.equal(events.length, 0);
    t.mock.timers.tick(0);
    assert.equal(events.length, 1);
    assert.equal(events[0].detail.phase, 'ready');
});

test('T3: an idle browser dispatches ready before the deadline', () => {
    const events = [];
    let pending;
    const scheduler = {
        requestIdleCallback(callback) { pending = callback; return 1; },
        setTimeout() { assert.fail('the idle path must not also arm a timer'); }
    };

    scheduleRuntimePluginReady((event) => events.push(event), scheduler);
    assert.equal(events.length, 0);
    pending();
    assert.deepEqual(events.map((event) => event.detail.phase), ['ready']);
});
