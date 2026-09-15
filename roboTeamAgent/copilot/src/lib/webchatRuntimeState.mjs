import { setCodingAgentModel } from './achillesSettings.mjs';

export function createWebchatRuntimeStateEnvelope(model, { backend = null, effort = null } = {}) {
    return {
        __webchatRuntimeState: 1,
        version: 1,
        backend,
        ...(process.env.ROBOTEAM_COPILOT_ROBOT_NAME ? { robotName: process.env.ROBOTEAM_COPILOT_ROBOT_NAME } : {}),
        model: typeof model === 'string' && model.trim() ? model.trim() : null,
        effort: typeof effort === 'string' && effort.trim() ? effort.trim() : null,
    };
}

export function emitWebchatRuntimeState(model, { backend = null, effort = null, write = (value) => process.stdout.write(value) } = {}) {
    const envelope = createWebchatRuntimeStateEnvelope(model, { backend, effort });
    write(`${JSON.stringify(envelope)}\n`);
    return envelope;
}

export async function selectWebchatRuntimeModel({ workingDir, backend, model, effort = null, persist = null, slashState, emitRuntimeState = emitWebchatRuntimeState }) {
    if (persist) await persist({ backend, model, effort });
    else await setCodingAgentModel(workingDir, backend, model);
    slashState.pinnedModel = model || null;
    emitRuntimeState(slashState.pinnedModel, { backend, effort });
    return slashState.pinnedModel;
}

export async function clearWebchatRuntimeModel(options) {
    return selectWebchatRuntimeModel({ ...options, model: null, effort: null });
}
