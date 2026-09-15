import http from 'node:http';

const INACTIVE_URL = 'http://[::1]:8000/internal/cluster/inactive';
const MAX_DISCONNECT_MS = 2_000;

export async function disconnectOnlyOfficeEditors({
  editorSockets,
  deadline,
  now = () => Date.now(),
  requestImpl = http.request,
} = {}) {
  const remainingMs = Math.min(MAX_DISCONNECT_MS, deadline - now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error('OnlyOffice graceful editor shutdown has no remaining drain budget.');
  }
  const pending = new Set([...editorSockets].filter((socket) => !socket.destroyed));
  const editorCount = pending.size;
  if (!editorCount) return { disconnectedEditors: 0 };

  await new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const listeners = new Map();
    const timer = setTimeout(() => finish(new Error(
      `OnlyOffice graceful editor shutdown timed out waiting for ${pending.size} socket(s).`,
    )), remainingMs);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [socket, listener] of listeners) socket.off('close', listener);
      // The native HTTP handler waits at least 30 seconds. Socket closure is
      // the delivery acknowledgement; cancel its outstanding HTTP wait safely.
      request?.destroy();
      if (error) reject(error);
      else resolve();
    }

    for (const socket of pending) {
      const listener = () => {
        pending.delete(socket);
        if (!pending.size) finish();
      };
      listeners.set(socket, listener);
      socket.once('close', listener);
    }

    try {
      request = requestImpl(INACTIVE_URL, { method: 'PUT' });
      request.on('error', () => {
        if (!settled) finish(new Error('OnlyOffice native graceful shutdown request failed.'));
      });
      request.on('response', (response) => {
        const onResponseFailure = () => {
          if (!settled) finish(new Error('OnlyOffice native graceful shutdown response failed.'));
        };
        response.on('error', onResponseFailure);
        response.on('aborted', onResponseFailure);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new Error(`OnlyOffice native graceful shutdown returned HTTP ${response.statusCode}.`));
          return;
        }
        response.resume();
      });
      request.end();
    } catch {
      finish(new Error('OnlyOffice native graceful shutdown request failed.'));
    }
  });
  return { disconnectedEditors: editorCount };
}
