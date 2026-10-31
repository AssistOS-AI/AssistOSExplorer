import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttemptWatchdog } from '../../server/runtime/attemptWatchdog.mjs';
import { observed } from '../../server/runtime/executionFactory.mjs';

// The attempt time bounds (M-33) with an injected clock: the timers and the clock are one fake scheduler.
function fakeClock() {
    let time = 0;
    let sequence = 0;
    let queue = [];
    return {
        now: () => time,
        timers: {
            setTimeout: (fn, ms) => { const handle = { fn, at: time + ms, id: (sequence += 1), unref() {} }; queue.push(handle); return handle; },
            clearTimeout: (handle) => { queue = queue.filter((entry) => entry !== handle); }
        },
        advance(ms) {
            const target = time + ms;
            for (;;) {
                const due = queue.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                queue = queue.filter((entry) => entry !== due);
                time = due.at;
                due.fn();
            }
            time = target;
        },
        get pending() { return queue.length; }
    };
}
const MIN = 60 * 1000;
function watch(options = {}) {
    const clock = fakeClock();
    const fired = [];
    const watchdog = createAttemptWatchdog({ inactivityMs: 20 * MIN, maxMs: 240 * MIN, timers: clock.timers, now: clock.now, onTimeout: (reason, info) => fired.push([reason, info.runningMs, clock.now()]), ...options });
    return { clock, fired, watchdog };
}

test('inactivity fires after the bound with no activity, once', () => {
    const { clock, fired } = watch();
    clock.advance(19 * MIN + 59_000);
    assert.deepEqual(fired, []);
    clock.advance(1_000);
    assert.deepEqual(fired, [['inactive_timeout', 20 * MIN, 20 * MIN]]);
    clock.advance(500 * MIN);
    assert.equal(fired.length, 1, 'only once');
});

test('activity resets the inactivity bound', () => {
    const { clock, fired, watchdog } = watch();
    for (let minute = 0; minute < 60; minute += 10) { clock.advance(10 * MIN); watchdog.touch(); }
    assert.deepEqual(fired, [], 'an hour of activity every ten minutes: nothing fires');
    clock.advance(19 * MIN);
    assert.deepEqual(fired, []);
    clock.advance(1 * MIN);
    assert.deepEqual(fired.map((entry) => entry[0]), ['inactive_timeout']);
    assert.equal(fired[0][2], 80 * MIN, 'twenty minutes after the last activity');
});

test('the maximum duration fires despite continuous activity', () => {
    const { clock, fired, watchdog } = watch();
    for (let minute = 0; minute < 240; minute += 1) { clock.advance(MIN); watchdog.touch(); }
    assert.deepEqual(fired, [['deadline_exceeded', 240 * MIN, 240 * MIN]]);
});

test('a suspended watchdog (a human-input wait or a pause) counts neither bound; resuming restarts both from where they were', () => {
    const { clock, fired, watchdog } = watch();
    clock.advance(10 * MIN);
    watchdog.suspend();
    clock.advance(1000 * MIN);
    assert.deepEqual(fired, [], 'a long wait does not fire');
    assert.equal(watchdog.runningMs, 10 * MIN, 'and does not count toward the maximum');
    watchdog.touch();
    watchdog.resume();
    clock.advance(19 * MIN);
    assert.deepEqual(fired, []);
    clock.advance(1 * MIN);
    assert.deepEqual(fired.map((entry) => [entry[0], entry[1]]), [['inactive_timeout', 30 * MIN]], 'running time excludes the suspension');
    const second = watch();
    for (let minute = 0; minute < 100; minute += 1) { second.clock.advance(MIN); second.watchdog.touch(); }
    second.watchdog.suspend();
    second.clock.advance(500 * MIN);
    second.watchdog.resume();
    for (let minute = 0; minute < 139; minute += 1) { second.clock.advance(MIN); second.watchdog.touch(); }
    assert.deepEqual(second.fired, []);
    second.clock.advance(MIN);
    assert.deepEqual(second.fired.map((entry) => [entry[0], entry[1]]), [['deadline_exceeded', 240 * MIN]], 'the maximum is 240 minutes of running time, not of wall time');
});

test('stop cancels everything; touch after suspend is ignored; the bounds are validated', () => {
    const { clock, fired, watchdog } = watch();
    watchdog.stop();
    assert.equal(clock.pending, 0);
    clock.advance(1000 * MIN);
    assert.deepEqual(fired, []);
    assert.throws(() => createAttemptWatchdog({ inactivityMs: 0, maxMs: 1, onTimeout() {} }), TypeError);
    assert.throws(() => createAttemptWatchdog({ inactivityMs: 1, maxMs: 1.5, onTimeout() {} }), TypeError);
});

test('provider requests and workload exits are activity of the attempt', () => {
    let touches = 0;
    const calls = [];
    const sandbox = {
        inventory: async () => { calls.push('inventory'); return []; }, tempdir: async () => { calls.push('tempdir'); return '/tmp/x'; },
        start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); },
        setExitHandler(handler) { this.handler = handler; }
    };
    const wrapped = observed(sandbox, () => { touches += 1; });
    wrapped.inventory(); wrapped.tempdir(); wrapped.start({}); wrapped.stop({});
    assert.deepEqual(calls, ['inventory', 'tempdir', 'start', 'stop']);
    assert.equal(touches, 4);
    let exits = 0;
    wrapped.setExitHandler(() => { exits += 1; });
    sandbox.handler(1, 0, null);
    assert.deepEqual([touches, exits], [5, 1]);
});

// ---- T2 (SPEC delta M3): holdInactivity / releaseInactivity ----------------------------------------------------------------------

test('M3: two pending requests, one answered, idle far past the bound: no timeout until the last is released, then the bound restarts', () => {
    const { clock, fired, watchdog } = watch();
    clock.advance(5 * MIN);
    watchdog.holdInactivity();
    watchdog.holdInactivity();
    clock.advance(30 * MIN);
    watchdog.releaseInactivity();
    assert.equal(watchdog.held, 1);
    clock.advance(60 * MIN);
    assert.deepEqual(fired, [], 'one request is still open: idle time does not count');
    watchdog.releaseInactivity();
    assert.equal(watchdog.held, 0);
    clock.advance(20 * MIN - 1);
    assert.deepEqual(fired, [], 'the release reset the last activity');
    clock.advance(1);
    assert.deepEqual(fired.map(([reason]) => reason), ['inactive_timeout']);
    watchdog.releaseInactivity();
    assert.equal(watchdog.held, 0, 'a release without a hold does nothing');
});

test('M3: the maximum duration keeps counting while a request is pending', () => {
    const { clock, fired, watchdog } = watch();
    clock.advance(10 * MIN);
    watchdog.holdInactivity();
    clock.advance(230 * MIN - 1);
    assert.deepEqual(fired, []);
    clock.advance(1);
    assert.deepEqual(fired.map(([reason, runningMs]) => [reason, runningMs]), [['deadline_exceeded', 240 * MIN]]);
});

test('M3: a hold does not touch a human-input suspension, and suspension still stops both bounds', () => {
    const { clock, fired, watchdog } = watch();
    watchdog.holdInactivity();
    watchdog.suspend();
    clock.advance(500 * MIN);
    watchdog.releaseInactivity();
    clock.advance(100 * MIN);
    assert.deepEqual(fired, [], 'suspended: neither bound runs');
    watchdog.resume();
    clock.advance(20 * MIN);
    assert.deepEqual(fired.map(([reason]) => reason), ['inactive_timeout']);
});
