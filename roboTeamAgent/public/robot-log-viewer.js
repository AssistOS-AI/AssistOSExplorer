export function initRobotLogViewer({ output, status, loadLogs, schedule = setInterval,
    cancel = clearInterval, frame = requestAnimationFrame }) {
    let enabled = false;
    let timer = null;
    let request = null;
    let loaded = false;

    function stopTimer() {
        if (timer !== null) cancel(timer);
        timer = null;
    }

    async function refresh() {
        if (!enabled || request) return;
        const controller = new AbortController();
        request = controller;
        const followLatest = !loaded || output.scrollHeight - output.clientHeight - output.scrollTop <= 12;
        const previousScrollTop = output.scrollTop;
        try {
            const result = await loadLogs(controller.signal);
            if (!enabled || request !== controller) return;
            const nextText = result.logs || 'No container output yet.';
            if (output.textContent !== nextText) {
                output.textContent = nextText;
                frame(() => {
                    if (!enabled || output.textContent !== nextText) return;
                    output.scrollTop = followLatest ? output.scrollHeight : Math.min(previousScrollTop, output.scrollHeight);
                });
            }
            loaded = true;
            status.textContent = 'Live · last 200 lines · refreshes every second';
            if (timer === null) timer = schedule(() => { void refresh(); }, 1000);
        } catch (error) {
            if (!enabled || request !== controller) return;
            stopTimer();
            status.textContent = `Could not refresh logs: ${error.message}. Use Refresh to retry.`;
            if (!loaded) output.textContent = 'Logs are unavailable.';
        } finally {
            if (request === controller) request = null;
        }
    }

    return {
        start() {
            enabled = true;
            return refresh();
        },
        pause() {
            enabled = false;
            stopTimer();
            request?.abort();
            request = null;
        },
    };
}
