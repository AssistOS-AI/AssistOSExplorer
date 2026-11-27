export async function readCodingSessionsReadiness({ fetchImpl = globalThis.fetch, signal } = {}) {
    try {
        const response = await fetchImpl('/webtty/coding-sessions/readiness', {
            credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        });
        if (!response.ok) return { ready: false, message: 'Coding-session services are unavailable.' };
        const result = await response.json();
        return { ready: result.ok === true && result.ready === true, message: result.message || 'Waiting for coding-session services…' };
    } catch { return { ready: false, message: 'Waiting for coding-session services…' }; }
}

// Observe only while the folder action menu is open; closing it aborts the request and timer.
export function watchCodingSessionsReadiness({ onChange, allowed = () => true, read = readCodingSessionsReadiness,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    const controller = new AbortController();
    let timer;
    const check = async () => {
        if (controller.signal.aborted) return;
        const result = allowed() ? await read({ signal: controller.signal }) : { ready: false };
        if (controller.signal.aborted) return;
        onChange(result);
        timer = schedule(check, result.ready ? 15000 : 2000);
    };
    void check();
    return () => { controller.abort(); cancel(timer); };
}
