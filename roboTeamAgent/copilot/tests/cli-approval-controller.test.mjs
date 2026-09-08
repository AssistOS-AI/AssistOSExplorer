import test from 'node:test';
import assert from 'node:assert/strict';

import { createNativeInteractions } from '../src/lib/nativeInteractions.mjs';

const event = (id) => ({
    type: 'coding-agent-request', id, kind: 'permission',
    title: 'Change scratch file', message: 'Native approval required', detail: '/workspace/scratch',
    options: [
        { id: 'reject', label: 'Do not change it' },
        { id: 'acceptForSession', label: 'Native session grant', description: 'This backend session' },
    ],
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('native denial and cancellation do not authorize an effect, and restore terminal input', async () => {
    const calls = [];
    let selected = 'reject';
    let effects = 0;
    const interactions = createNativeInteractions({
        output: { write() {} },
        selector: async (options) => {
            assert.deepEqual(options.map((option) => option.value), ['reject', 'acceptForSession']);
            return selected === null ? null : options.find((option) => option.value === selected);
        },
    });
    interactions.setInputControls({
        pause: () => calls.push('pause'), suspendInput: () => calls.push('suspend'),
        restoreInput: () => calls.push('restore'), resume: () => calls.push('resume'),
    });
    const execute = async (id) => {
        const choice = await interactions.request(event(id), { turnId: 'turn' });
        if (choice === 'acceptForSession') effects++;
        return choice;
    };
    assert.equal(await execute('denial'), 'reject');
    selected = null;
    assert.equal(await execute('cancel'), null);
    assert.equal(effects, 0);
    selected = 'acceptForSession';
    assert.equal(await execute('grant'), 'acceptForSession');
    assert.equal(effects, 1);
    assert.deepEqual(calls, Array(3).fill(['pause', 'suspend', 'restore', 'resume']).flat());
    interactions.dispose();
});

test('terminal requests queue without overwriting and cancellation dismisses only its turn', async () => {
    const shown = [];
    const selectors = [];
    const controls = [];
    const interactions = createNativeInteractions({
        output: { write() {} },
        selector: (_options, { signal }) => {
            const choice = deferred();
            shown.push(signal);
            selectors.push(choice);
            return choice.promise;
        },
    });
    interactions.setInputControls({
        pause: () => controls.push('pause'), restoreInput: () => controls.push('restore'),
    });
    const first = interactions.request(event('first'), { turnId: 'one' });
    const queued = interactions.request(event('queued'), { turnId: 'two' });
    const third = interactions.request(event('third'), { turnId: 'three' });
    await tick();
    assert.equal(shown.length, 1);
    interactions.cancelTurn('two');
    assert.equal(await queued, null);
    assert.equal(shown[0].aborted, false);
    interactions.resolve('first', 'backend-resolved');
    assert.equal(await first, null);
    await tick();
    assert.equal(shown[0].aborted, true);
    assert.equal(shown.length, 2);
    assert.deepEqual(controls, ['pause', 'restore', 'pause']);
    selectors[0].resolve({ value: 'acceptForSession' });
    assert.equal(interactions.resolve('first', 'answered'), false);
    selectors[1].resolve({ value: 'reject' });
    assert.equal(await third, 'reject');
    assert.deepEqual(controls, ['pause', 'restore', 'pause', 'restore']);
    interactions.dispose();
});

test('selector failure and an unadvertised answer fail closed with input restoration', async () => {
    let restored = 0;
    let failure = true;
    const interactions = createNativeInteractions({
        output: { write() {} },
        selector: async () => {
            if (failure) throw new Error('selector unavailable');
            return { value: 'invented-grant' };
        },
    });
    interactions.setInputControls({ restoreInput: () => restored++ });
    assert.equal(await interactions.request(event('failure')), null);
    failure = false;
    assert.equal(await interactions.request(event('invalid')), null);
    assert.equal(restored, 2);
    interactions.dispose();
});
