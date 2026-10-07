// Same event name that main.js dispatches for the `discovered` phase and that the file-exp plugin host listens to.
const RUNTIME_PLUGINS_UPDATED_EVENT = 'assistos:runtime-plugins-updated';
export const RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS = 250;

// The `ready` phase mounts plugin components. It follows `discovered` as soon as the browser is idle, and never
// later than RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS after the call, so no fixed delay separates the two phases.
// `dispatch` receives the ready event; `scheduler` supplies the timers so tests can drive them.
export function scheduleRuntimePluginReady(dispatch, scheduler = globalThis) {
    const run = () => dispatch(new CustomEvent(RUNTIME_PLUGINS_UPDATED_EVENT, {
        detail: { phase: 'ready' }
    }));
    if (typeof scheduler?.requestIdleCallback === 'function') {
        return scheduler.requestIdleCallback(run, { timeout: RUNTIME_PLUGIN_READY_IDLE_TIMEOUT_MS });
    }
    return scheduler.setTimeout(run, 0);
}
