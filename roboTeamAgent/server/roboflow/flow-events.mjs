// Observation is post-commit and best-effort. Reconnection always sends a fresh
// snapshot; log offsets let the client detect gaps without a durable event queue.
export async function streamFlowEvents({ req, res, roboflow, flowId, instanceId = null }) {
    const initial = await roboflow.getFlow(flowId, { logMode: 'none' });
    if (instanceId && !initial.instances.some(instance => instance.id === instanceId)) {
        throw Object.assign(new Error('task instance not found'), { statusCode: 404 });
    }
    let closed = false, timer = null, heartbeat = null, lifetime = null, sending = false, dirty = true, first = true;
    let pendingLog = null, resetLog = false;
    let unsubscribe = () => {};
    function close() {
        if (closed) return;
        closed = true; clearTimeout(timer); clearInterval(heartbeat); clearTimeout(lifetime);
        unsubscribe(); pendingLog = null; res.off('close', close); res.off('error', close);
        if (!res.writableEnded && !res.destroyed) res.end();
    }
    function send(event, data) {
        if (closed) return;
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // Slow readers reconnect and resynchronize rather than retaining an
        // unbounded queue. Exceptionally large snapshots use the existing GET.
        if (Buffer.byteLength(frame) > 1024 * 1024) return send('resync', {});
        if (!res.write(frame)) { res.destroy(); close(); }
    }
    async function flush() {
        timer = null;
        if (closed || sending) return;
        sending = true;
        try {
            if (dirty) {
                dirty = false;
                const flow = await roboflow.getFlow(flowId, { logMode: 'none' });
                if (!closed) { send(first ? 'snapshot' : 'flow', { flow }); first = false; }
            }
            if (resetLog) { resetLog = false; pendingLog = null; send('log-reset', { instanceId }); }
            else if (pendingLog) { const log = pendingLog; pendingLog = null; send('log', log); }
        } catch (error) { send('stream-error', { message: error.message }); close(); }
        finally { sending = false; if (!closed && (dirty || pendingLog || resetLog)) schedule(); }
    }
    function schedule() { if (!closed && !timer && !sending) timer = setTimeout(() => void flush(), 200); }
    unsubscribe = roboflow.subscribeFlow(flowId, event => {
        if (event.kind === 'close') return close();
        if (event.kind === 'flow' || (event.kind === 'output' && event.suffix === 'result')) dirty = true;
        if (event.kind === 'output' && event.suffix === 'log' && event.instanceId === instanceId) {
            if (!resetLog) {
                if (pendingLog && pendingLog.end !== event.start) resetLog = true;
                else pendingLog = pendingLog ? { ...pendingLog, end: event.end, chunk: pendingLog.chunk + event.chunk }
                    : { instanceId, start: event.start, end: event.end, chunk: event.chunk };
                if (pendingLog && Buffer.byteLength(pendingLog.chunk) > 64 * 1024) { resetLog = true; pendingLog = null; }
            }
        }
        if (dirty || pendingLog || resetLog) schedule();
    });
    res.on('close', close); res.on('error', close);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.flushHeaders(); res.write('retry: 5000\n\n');
    heartbeat = setInterval(() => { if (!closed && !res.write(': keepalive\n\n')) { res.destroy(); close(); } }, 15_000);
    // Renew before Ploinky's default 30-minute stream lifetime.
    lifetime = setTimeout(close, 25 * 60_000);
    heartbeat.unref?.(); lifetime.unref?.();
    if (res.destroyed) close();
    else await flush();
}
