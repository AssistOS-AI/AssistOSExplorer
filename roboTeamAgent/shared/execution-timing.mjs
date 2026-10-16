// Persist completed active intervals separately from the current interval.
export function executionTiming(record, active, start, end) {
    if (Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) {
        return { elapsedMs: record.elapsedMs, activeSince: active ? record.activeSince || start || null : null };
    }
    const from = Date.parse(start || '');
    const to = Date.parse(end || '');
    return {
        elapsedMs: !active && Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : 0,
        activeSince: active && Number.isFinite(from) ? start : null,
    };
}

export function transitionTiming(timing, active, now) {
    const from = Date.parse(timing.activeSince || '');
    const to = Date.parse(now);
    return {
        elapsedMs: timing.elapsedMs + (!active && Number.isFinite(from) ? Math.max(0, to - from) : 0),
        activeSince: active ? timing.activeSince || now : null,
    };
}
