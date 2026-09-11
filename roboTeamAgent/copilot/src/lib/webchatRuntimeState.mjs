import { getCodingAgentModels, setCodingAgentModel } from './achillesSettings.mjs';

export function createWebchatRuntimeStateEnvelope(model, { backend = null } = {}) {
    return {
        __webchatRuntimeState: 1,
        version: 1,
        backend,
        ...(process.env.ROBOTEAM_COPILOT_ROBOT_NAME ? { robotName: process.env.ROBOTEAM_COPILOT_ROBOT_NAME } : {}),
        model: typeof model === 'string' && model.trim() ? model.trim() : null,
    };
}

export function emitWebchatRuntimeState(model, { backend = null, write = (value) => process.stdout.write(value) } = {}) {
    const envelope = createWebchatRuntimeStateEnvelope(model, { backend });
    write(`${JSON.stringify(envelope)}\n`);
    return envelope;
}

export async function selectWebchatRuntimeModel({ workingDir, backend, model, slashState, emitRuntimeState = emitWebchatRuntimeState }) {
    await setCodingAgentModel(workingDir, backend, model);
    slashState.pinnedModel = getCodingAgentModels(workingDir)[backend] || null;
    emitRuntimeState(slashState.pinnedModel, { backend });
    return slashState.pinnedModel;
}

export async function clearWebchatRuntimeModel(options) {
    return selectWebchatRuntimeModel({ ...options, model: null });
}
