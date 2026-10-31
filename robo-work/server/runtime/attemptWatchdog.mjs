// The time bounds of one task attempt (decision M-33): an inactivity bound and a maximum duration. Both run only while the attempt is
// starting or running (`suspend()` stops them, `resume()` continues; time spent suspended counts for neither). `touch()` is activity: it
// only records the time, so a stream of thousands of records costs nothing, and one timer re-arms itself for the remaining time.
//
//   timers  { setTimeout, clearTimeout }  injected (tests drive them with a fake scheduler)
//   now     () => milliseconds             injected clock, the same one the timers follow
//   onTimeout(reason, { runningMs })       called once, with 'inactive_timeout' or 'deadline_exceeded'
//
// `holdInactivity()` / `releaseInactivity()` (T2, SPEC delta M3, decision M-52 Q3): a counter of open approval requests. While it is above
// zero only the INACTIVITY bound is paused (the owner may take minutes to answer); the maximum duration keeps counting, so a robot that keeps
// asking cannot hold its slot for ever. The release that brings the counter back to zero restarts the inactivity bound from that moment
// (like `resume()`). A release without a hold does nothing.
export function createAttemptWatchdog({ inactivityMs, maxMs, onTimeout, timers = { setTimeout, clearTimeout }, now = Date.now }) {
    for (const [name, value] of Object.entries({ inactivityMs, maxMs })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
    }
    let timer = null;
    let fired = false;
    let stopped = false;
    let suspended = false;
    let held = 0; // open approval requests: the inactivity bound is paused while this is above zero
    let ranMs = 0; // running time accumulated before the current stretch
    let stretchStart = now();
    let lastActivity = stretchStart;

    const running = () => ranMs + (suspended ? 0 : now() - stretchStart);
    const clear = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };

    function arm() {
        clear();
        if (fired || stopped || suspended) return;
        const sinceActivity = now() - lastActivity;
        const untilInactive = held > 0 ? Number.POSITIVE_INFINITY : Math.max(0, inactivityMs - sinceActivity);
        const untilDeadline = Math.max(0, maxMs - running());
        const wait = Math.min(untilInactive, untilDeadline);
        timer = timers.setTimeout(check, wait);
        timer.unref?.();
    }

    function check() {
        timer = null;
        if (fired || stopped || suspended) return;
        const elapsed = running();
        // The maximum duration wins over inactivity when both are due: it is the bound that activity cannot move.
        const reason = elapsed >= maxMs ? 'deadline_exceeded' : (held === 0 && now() - lastActivity >= inactivityMs ? 'inactive_timeout' : null);
        if (reason === null) { arm(); return; }
        fired = true;
        try { onTimeout(reason, { runningMs: elapsed }); } catch { /* the owner logs its own failures */ }
    }

    arm();
    return Object.freeze({
        touch() { if (!suspended) lastActivity = now(); },
        suspend() {
            if (suspended || fired || stopped) return;
            ranMs += now() - stretchStart;
            suspended = true;
            clear();
        },
        resume() {
            if (!suspended || fired || stopped) return;
            suspended = false;
            stretchStart = now();
            lastActivity = stretchStart;
            arm();
        },
        holdInactivity() {
            held += 1;
            if (held === 1) arm();
        },
        releaseInactivity() {
            if (held === 0) return;
            held -= 1;
            if (held > 0) return;
            if (!suspended) lastActivity = now();
            arm();
        },
        get held() { return held; },
        stop() { stopped = true; clear(); },
        get fired() { return fired; },
        get runningMs() { return running(); }
    });
}
