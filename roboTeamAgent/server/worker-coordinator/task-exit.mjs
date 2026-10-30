import { stopReason } from '../../copilot/src/lib/execution/abortReasons.mjs';

// What a robot-task child does with a stop and how it reports it (decisions M-12 (b), M-21).

// The exit code of a child whose stop the worker did not confirm (EX_TEMPFAIL): the execution may still be running
// there, so the task is reported as `stop_not_confirmed`, never as paused.
export const STOP_NOT_CONFIRMED_EXIT = 75;

// The abort reason of a `{type:'stop'}` stdin record. The stopping request's own grant, when the record carries one,
// is the evidence that authorizes the worker stop; it arrived over stdin only and is kept nowhere.
export function stopReasonFromRecord(message) {
    const grant = typeof message?.ownerGrant === 'string' && message.ownerGrant ? message.ownerGrant : null;
    return stopReason({ owner: grant ? { evidence: { ok: true, grant } } : null });
}

export function taskExitCode(error, aborted) {
    if (error?.execution === 'may_still_run' && String(error.code || '').startsWith('worker_stop')) return STOP_NOT_CONFIRMED_EXIT;
    return aborted ? 130 : 1;
}
