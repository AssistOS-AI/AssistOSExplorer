// Why an execution was aborted. Detaching is not stopping (plan sections 9 and 10.2): a RoboTeam
// shutdown or a closed engine detaches from work the worker owns, while only a user's stop ends it.
// An abort with any other reason is a stop.

export function detachReason() {
    return Object.assign(new Error('Execution detached; the worker keeps running it.'), { name: 'AbortError', code: 'ROBOTEAM_DETACH', exitCode: 130 });
}

// A user stop, optionally carrying the owner evidence of the envelope that requested it.
export function stopReason({ owner = null } = {}) {
    return Object.assign(new Error('Execution stopped.'), { name: 'AbortError', code: 'ROBOTEAM_STOP', exitCode: 130, owner });
}

export const isDetach = (reason) => reason?.code === 'ROBOTEAM_DETACH';
