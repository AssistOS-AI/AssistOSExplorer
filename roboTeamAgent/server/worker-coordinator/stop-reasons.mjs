// The plain messages for the ways the worker ends an attempt on its own: no activity from the model for the allowed time
// (`inactive_timeout`, decision M-33), the maximum duration (`deadline_exceeded`), and a Soul Gateway model that cannot be served
// (`model_unavailable`, `model_channel_unavailable`, decision M-26). All end the attempt `failed`; RoboFlow treats any of them as a phase
// failure, dispatches no successor and retries nothing. Used by the worker engine (a live turn or phase) and by the restart reconciliation
// (a phase that ended while RoboTeam was down), so the user reads the same words either way.

const minutesOf = (data) => {
    for (const key of ['minutes', 'inactiveMinutes', 'afterMinutes']) {
        const value = data?.[key];
        if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
    return null;
};

// The last error the worker's model channel saw before an inactivity stop (decision M-43 (a)): `{ status, message }` with a status that is
// an HTTP code and a message that is already short, but is cleaned here again because it ends up on one line that people and the task
// child's output matcher read. Null when there is nothing usable.
export function lastModelErrorText(data) {
    const error = data?.lastModelError;
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
    const message = typeof error?.message === 'string'
        ? error.message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, ' ').replace(/ {2,}/gu, ' ').trim().slice(0, 300) : '';
    if (status === null && !message) return null;
    return `Last model error: ${status === null ? '' : `HTTP ${status}`}${status !== null && message ? ': ' : ''}${message}`;
}

// The user-facing message for a worker end reason, or null for any other reason. `data` is the result's data, which may carry the
// worker's minutes and, for an inactivity stop, the model channel's last error.
export function plainStopMessage(reason, data = null) {
    if (reason === 'inactive_timeout') {
        const minutes = minutesOf(data);
        const base = minutes ? `Stopped: no activity from the model for ${minutes} minutes` : 'Stopped: no activity from the model for the allowed time';
        const last = lastModelErrorText(data);
        return last ? `${base}. ${last}` : base;
    }
    if (reason === 'deadline_exceeded') return 'Stopped: the task exceeded its maximum duration';
    if (reason === 'model_unavailable') return 'Stopped: the selected Soul Gateway model is not available';
    if (reason === 'model_channel_unavailable') return 'Stopped: Soul Gateway could not be reached for the model. Try again in a moment';
    return null;
}

// A task child that stopped this way prints the message on its own line; the manager keeps that line as the task's error.
export const STOP_MESSAGE_LINE = /^Stopped: (?:no activity from the model .+|the task exceeded its maximum duration|the selected Soul Gateway model is not available|Soul Gateway could not be reached .+)$/mu;
