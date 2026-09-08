import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendRecoveringTask,
    runBoundedCleanup,
} from '../src/lib/webchatTurnQueue.mjs';

test('WebChat prompt queue runs the next task after the previous task rejected', async () => {
    const errors = [];
    const previousTask = Promise.reject(new Error('post-turn failure'));
    let nextTaskRan = false;

    const nextTask = appendRecoveringTask(previousTask, async () => {
        nextTaskRan = true;
        return 'completed';
    }, {
        onPreviousError: (error) => errors.push(error.message),
    });

    assert.equal(await nextTask, 'completed');
    assert.equal(nextTaskRan, true);
    assert.deepEqual(errors, ['post-turn failure']);
});

test('WebChat post-turn cleanup errors do not reject the prompt queue', async () => {
    const errors = [];
    const result = await runBoundedCleanup(
        async () => {
            throw new Error('refresh failed');
        },
        { onError: (error) => errors.push(error.message) },
    );

    assert.equal(result, null);
    assert.deepEqual(errors, ['refresh failed']);
});

test('WebChat post-turn cleanup has a bounded wait', async () => {
    const timeouts = [];
    const startedAt = Date.now();
    const result = await runBoundedCleanup(
        () => new Promise(() => {}),
        {
            timeoutMs: 20,
            onTimeout: (timeoutMs) => timeouts.push(timeoutMs),
        },
    );

    assert.equal(result, null);
    assert.deepEqual(timeouts, [20]);
    assert.ok(Date.now() - startedAt < 1000);
});
