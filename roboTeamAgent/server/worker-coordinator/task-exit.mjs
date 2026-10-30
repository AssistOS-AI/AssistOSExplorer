import { stopReason } from '../../copilot/src/lib/execution/abortReasons.mjs';

// What a robot-task child does with a stop and how it reports it (decisions M-12 (b), M-21).

// The exit code of a child whose stop the worker did not confirm (EX_TEMPFAIL): the execution may still be running
// there, so the task is reported as `stop_not_confirmed`, never as paused.
export const STOP_NOT_CONFIRMED_EXIT = 75;

// The abort reason of a `{type:'stop'}` stdin record. The stopping request's own grant, when the record carries one,
// is the evidence that authorizes the worker stop; it arrived over stdin only and is kept nowhere.
export function stopReasonFromRecord(message) {
    const grant = typeof message?.ownerGrant === 'string' && message.ownerGrant ? message.ownerGrant : null;
    return stopReason({ owner: grant ? { evidence: { ok: true, grant } } : null, userInitiated: message?.user === true });
}

// A live `message` record from the parent: the messaging request's own grant, when the record carries one, becomes the owner
// evidence of this one worker `message` control. It arrived over stdin only and is not kept in the record passed on.
export function messageForEngine(message) {
    const { ownerGrant, ...record } = message ?? {};
    return typeof ownerGrant === 'string' && ownerGrant ? { ...record, owner: { evidence: { ok: true, grant: ownerGrant } } } : record;
}

// Any requested stop whose outcome is `may_still_run` is not confirmed, whatever failed (the control was refused, the
// transport broke, the reference was not found, the evidence expired, or the worker accepted the stop but never reached
// a terminal state): exit 75. A stop that ended in a terminal state is an interruption (130); anything else is a failure.
export function taskExitCode(error, aborted) {
    if (aborted && error?.execution === 'may_still_run') return STOP_NOT_CONFIRMED_EXIT;
    return aborted ? 130 : 1;
}
