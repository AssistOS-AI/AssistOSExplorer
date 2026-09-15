import { setCodingAgentModel } from './achillesSettings.mjs';

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

export async function selectWebchatRuntimeModel({ workingDir, backend, model, effort = null, persist = null, slashState, emitRuntimeState = emitWebchatRuntimeState }) {
    if (persist) await persist({ backend, model, effort });
    else await setCodingAgentModel(workingDir, backend, model);
    slashState.pinnedModel = model || null;
    emitRuntimeState(slashState.pinnedModel, { backend });
    return slashState.pinnedModel;
}

export async function clearWebchatRuntimeModel(options) {
    return selectWebchatRuntimeModel({ ...options, model: null });
}
