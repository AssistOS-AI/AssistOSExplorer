// Why an execution was aborted. Detaching is not stopping (plan sections 9 and 10.2): a RoboTeam
// shutdown or a closed engine detaches from work the worker owns, while only a user's stop ends it.
// An abort with any other reason is a stop.

export function detachReason() {
    return Object.assign(new Error('Execution detached; the worker keeps running it.'), { name: 'AbortError', code: 'ROBOTEAM_DETACH', exitCode: 130 });
}

// A stop, optionally carrying the owner evidence of the request that asked for it. `userInitiated` marks a stop that a person
// asked for (stop button, pause, terminate): it needs that request's own grant, whatever the execution's authority mode. A stop
// that is not user-initiated (a flow failure, a recovery) is system-initiated and may use the flow binding.
export function stopReason({ owner = null, userInitiated = false } = {}) {
    return Object.assign(new Error('Execution stopped.'), { name: 'AbortError', code: 'ROBOTEAM_STOP', exitCode: 130, owner, userInitiated });
}

export const isDetach = (reason) => reason?.code === 'ROBOTEAM_DETACH';
