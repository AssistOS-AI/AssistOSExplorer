// The plain messages for the two ways the worker stops an attempt on its own (decision M-33): no activity from the model for the
// allowed time (`inactive_timeout`) and the maximum duration (`deadline_exceeded`). Both end the attempt `failed`; RoboFlow treats
// either as a phase failure, dispatches no successor and retries nothing. Used by the worker engine (a live turn or phase) and by
// the restart reconciliation (a phase that ended while RoboTeam was down), so the user reads the same words either way.

const minutesOf = (data) => {
    for (const key of ['minutes', 'inactiveMinutes', 'afterMinutes']) {
        const value = data?.[key];
        if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
    return null;
};

// The user-facing message for a worker end reason, or null for any other reason. `data` is the result's data, which may carry the
// worker's minutes.
export function plainStopMessage(reason, data = null) {
    if (reason === 'inactive_timeout') {
        const minutes = minutesOf(data);
        return minutes ? `Stopped: no activity from the model for ${minutes} minutes` : 'Stopped: no activity from the model for the allowed time';
    }
    if (reason === 'deadline_exceeded') return 'Stopped: the task exceeded its maximum duration';
    return null;
}

// A task child that stopped this way prints the message on its own line; the manager keeps that line as the task's error.
export const STOP_MESSAGE_LINE = /^Stopped: (?:no activity from the model .+|the task exceeded its maximum duration)$/mu;
