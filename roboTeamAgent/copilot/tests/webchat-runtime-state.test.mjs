import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearWebchatRuntimeModel, selectWebchatRuntimeModel } from '../src/lib/webchatRuntimeState.mjs';
import { getCodingAgentModels, getSelectedModel, setCodingAgentModel, setSelectedModel } from '../src/lib/achillesSettings.mjs';

test('native model selection and reset preserve other backends and legacy stored data', async (t) => {
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'achilles-native-model-state-'));
    t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
    await setSelectedModel(workingDir, 'legacy-gateway-model');
    await setCodingAgentModel(workingDir, 'pi', 'provider/pi-model');
    const state = { pinnedModel: null };
    const emissions = [];
    const publish = (model, { backend }) => emissions.push({ backend, model, persisted: getCodingAgentModels(workingDir) });
    await selectWebchatRuntimeModel({ workingDir, backend: 'codex', model: 'native-codex-model', slashState: state, emitRuntimeState: publish });
    assert.deepEqual(emissions[0], {
        backend: 'codex', model: 'native-codex-model', persisted: { pi: 'provider/pi-model', codex: 'native-codex-model' },
    });
    await clearWebchatRuntimeModel({ workingDir, backend: 'codex', slashState: state, emitRuntimeState: publish });
    assert.deepEqual(emissions[1], { backend: 'codex', model: null, persisted: { pi: 'provider/pi-model' } });
    assert.equal(getSelectedModel(workingDir), 'legacy-gateway-model');
});
