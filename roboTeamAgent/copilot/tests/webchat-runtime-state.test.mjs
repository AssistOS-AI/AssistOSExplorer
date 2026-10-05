import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebchatRuntimeStateEnvelope, clearWebchatRuntimeModel, selectWebchatRuntimeModel } from '../src/lib/webchat/webchatRuntimeState.mjs';

test('model selection and reset are persisted through the robot config before publishing', async () => {
    const state = { pinnedModel: null };
    const saved = [];
    const emissions = [];
    const persist = async (selection) => saved.push(selection);
    const publish = (model, { backend }) => emissions.push({ backend, model, saved: saved.length });
    await selectWebchatRuntimeModel({ backend: 'codex', model: 'native-codex-model', persist, slashState: state, emitRuntimeState: publish });
    await clearWebchatRuntimeModel({ backend: 'codex', persist, slashState: state, emitRuntimeState: publish });
    assert.deepEqual(saved, [
        { backend: 'codex', model: 'native-codex-model', effort: null },
        { backend: 'codex', model: null, effort: null },
    ]);
    assert.deepEqual(emissions, [
        { backend: 'codex', model: 'native-codex-model', saved: 1 },
        { backend: 'codex', model: null, saved: 2 },
    ]);
});

test('runtime state publishes effort after persistence and clears it on model reset', async () => {
    const state = {};
    const emitted = [];
    const saved = [];
    const options = { backend: 'codex', slashState: state,
        persist: async (selection) => saved.push(selection),
        emitRuntimeState: (model, metadata) => {
            assert.equal(saved.length, emitted.length + 1);
            emitted.push(createWebchatRuntimeStateEnvelope(model, metadata));
        },
    };
    await selectWebchatRuntimeModel({ ...options, model: 'native-model', effort: 'high' });
    assert.equal(emitted[0].model, 'native-model');
    assert.equal(emitted[0].effort, 'high');
    await clearWebchatRuntimeModel({ ...options, effort: 'high' });
    assert.equal(emitted[1].model, null);
    assert.equal(emitted[1].effort, null);
    assert.equal(saved[1].effort, null);
    assert.equal(createWebchatRuntimeStateEnvelope('native-model').effort, null);
});
