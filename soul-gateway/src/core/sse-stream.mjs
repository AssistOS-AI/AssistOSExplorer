/**
 * Create an SSE (Server-Sent Events) writer on a response object.
 *
 * Returns an object with:
 *   - send(event, data)   — write one SSE event
 *   - comment(text)       — write an SSE comment (keepalive)
 *   - close()             — end the stream
 *   - onClose(fn)         — register a cleanup callback
 */
export function createSseStream(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const cleanupFns = [];
    let closed = false;

    function runCleanup() {
        if (closed) return;
        closed = true;
        for (const fn of cleanupFns) fn();
    }

    return {
        send(event, data) {
            if (res.destroyed || closed) return;
            const serialized =
                typeof data === 'string' ? data : JSON.stringify(data);
            res.write(`event: ${event}\ndata: ${serialized}\n\n`);
        },

        comment(text) {
            if (res.destroyed || closed) return;
            res.write(`: ${text}\n\n`);
        },

        close() {
            if (!res.destroyed) res.end();
            runCleanup();
        },

        onClose(fn) {
            cleanupFns.push(fn);
            res.on('close', runCleanup);
        },
    };
}
