// The provider endpoint's side of ALA's provider channel (fd 3, Node IPC with JSON serialization).
//
// Three rules live here, because they decide whether the transport is safe:
//   1. A connected socket is passed to ALA only while it is still unread (passPausedSocket).
//   2. A message that arrives with a handle is a channel-wide failure and the handle is closed at once.
//   3. The endpoint counts what it has sent and ALA has not yet taken. Past a fixed bound the endpoint ends its
//      execution, because an ALA that stops reading must not make the endpoint grow without limit.
//
// The backlog is counted here, from send callbacks that have not fired yet. It does not rely on any Node internal.

export const PROTOCOL_ERROR = 'protocol';

// A handle that ALA sent is closed whatever it is. Sockets have destroy(); servers and datagram sockets have only
// close(), and a listener that is not closed would keep accepting until the process ends.
export function closeHandle(handle) {
    try {
        if (typeof handle?.destroy === 'function') handle.destroy();
        else if (typeof handle?.close === 'function') handle.close();
    } catch { /* the handle is already gone */ }
}

// Passes a connected, unread socket. The caller must have accepted it with pauseOnConnect (or paused it before it
// connected). A socket that already holds bytes read into JavaScript, or has seen end-of-stream, would lose them in the
// transfer, so it is refused instead of passed.
export function assertUnreadSocket(socket) {
    if (!socket || typeof socket.destroy !== 'function' || socket.destroyed) throw new TypeError('Not a live socket');
    if (socket.bytesRead > 0 || socket.readableLength > 0 || socket.readableEnded) {
        throw new Error('The socket has been read and cannot be passed unread');
    }
}

export function passPausedSocket(channel, message, socket) {
    assertUnreadSocket(socket);
    return new Promise((resolve, reject) => {
        try {
            channel.send(message, socket, (error) => (error ? reject(error) : resolve()));
        } catch (error) { reject(error); }
    });
}

// Node defers the 'disconnect' event for as long as a handle that it sent is waiting for its acknowledgement. When ALA
// dies with such a handle outstanding, `connected` turns false and the event never arrives. The endpoint therefore
// also watches `connected`, so that the death of ALA always ends its execution.
export const CONNECTED_POLL_MS = 100;

export function createAlaChannel(channel, { limits, onMessage, onFailure, onClose, pollMs = CONNECTED_POLL_MS }) {
    let pendingMessages = 0;
    let pendingBytes = 0;
    let failed = false;
    let closed = false;

    const stats = () => ({ pendingMessages, pendingBytes, failed, closed });

    // The channel is not closed while a failure message is still being written: closing would cancel the write.
    let flushingFailure = false;
    function disconnect() {
        if (closed) return;
        if (flushingFailure) return;
        closed = true;
        try { if (channel.connected) channel.disconnect(); } catch { /* already disconnected */ }
    }

    // A channel-wide failure: ALA is told once, then the channel is closed.
    function fail(code, message, detail = code) {
        if (failed) return;
        failed = true;
        flushingFailure = true;
        const flushed = () => { flushingFailure = false; disconnect(); };
        try {
            channel.send({ type: 'failure', error: { code, message } }, flushed);
        } catch { flushed(); }
        onFailure?.(detail);
    }

    // The endpoint ends its execution without writing anything more: ALA is not reading.
    function abandon(detail) {
        if (failed) return;
        failed = true;
        disconnect();
        onFailure?.(detail);
    }

    function send(message, handle) {
        if (failed || closed || !channel.connected) return Promise.resolve(false);
        const bytes = Buffer.byteLength(JSON.stringify(message));
        pendingMessages += 1;
        pendingBytes += bytes;
        const settled = new Promise((resolve) => {
            const done = (error) => {
                pendingMessages -= 1;
                pendingBytes -= bytes;
                resolve(!error);
            };
            try {
                if (handle === undefined) channel.send(message, done); else channel.send(message, handle, done);
            } catch { done(true); }
        });
        if (pendingMessages > limits.maxOutboundBacklogMessages || pendingBytes > limits.maxOutboundBacklogBytes) {
            abandon('outbound_backlog');
        }
        return settled;
    }

    channel.on('message', (message, handle) => {
        if (failed) { closeHandle(handle); return; }
        if (handle !== undefined) {
            closeHandle(handle);
            fail(PROTOCOL_ERROR, 'client messages carry no handles', 'handle_from_ala');
            return;
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
            fail(PROTOCOL_ERROR, 'malformed message', 'malformed_message');
            return;
        }
        if (Buffer.byteLength(JSON.stringify(message)) > limits.maxMessageBytes) {
            fail(PROTOCOL_ERROR, 'message too large', 'message_too_large');
            return;
        }
        onMessage(message);
    });
    let lostReported = false;
    const reportLost = () => {
        if (lostReported) return;
        lostReported = true;
        clearInterval(watchdog);
        closed = true;
        onClose?.();
    };
    const watchdog = setInterval(() => { if (channel.connected === false && !flushingFailure) reportLost(); }, pollMs);
    watchdog.unref?.();
    channel.on('disconnect', reportLost);
    channel.on('error', () => { abandon('channel_error'); });

    return { send, fail, abandon, disconnect, stats };
}
