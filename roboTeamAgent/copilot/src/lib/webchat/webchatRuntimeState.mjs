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

// Persist changes only this session; resets return the inherited robot default.
export async function selectWebchatRuntimeModel({ backend, model, effort = null, persist, slashState, emitRuntimeState = emitWebchatRuntimeState }) {
    const effective = await persist({ backend, model, effort });
    if (effective && typeof effective === 'object' && typeof effective.backend === 'string') ({ backend, model, effort } = effective);
    slashState.pinnedModel = model || null;
    slashState.pinnedEffort = effort || null;
    emitRuntimeState(slashState.pinnedModel, { backend, effort });
    return slashState.pinnedModel;
}

export async function clearWebchatRuntimeModel(options) {
    return selectWebchatRuntimeModel({ ...options, model: null, effort: null });
}
