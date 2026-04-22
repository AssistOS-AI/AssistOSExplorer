import {
    sendTextFrame,
    sendPing,
    sendCloseFrame,
    OPCODE_TEXT,
    OPCODE_CLOSE,
    OPCODE_PING,
    OPCODE_PONG,
    decodeFrame,
} from '../core/websocket-frame-codec.mjs';
import { redactLogEntry } from './redaction.mjs';

/**
 * BroadcastHub — real-time log distribution to SSE and WebSocket subscribers.
 *
 * Publishing flow:
 *  1. AuditLogWriter.write() calls hub.publish(logRow)
 *  2. Hub tests each subscriber's filters
 *  3. Normal streams receive redacted payloads
 *  4. Soul-specific streams receive unredacted payloads for their soul only
 */
const MAX_WS_BUFFER_SIZE = 64 * 1024; // 64KB

export class BroadcastHub {
    constructor(appCtx) {
        this.appCtx = appCtx;
        this.sseClients = new Map();
        this.wsClients = new Map();
        this._subscriberId = 0;
        this._heartbeatTimer = null;
    }

    startHeartbeat(intervalMs) {
        this._heartbeatTimer = setInterval(
            () => this._sendHeartbeats(),
            intervalMs
        );
        this._heartbeatTimer.unref();
    }

    stop() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        // Close all connections
        for (const [id, client] of this.sseClients) {
            client.stream.close();
        }
        for (const [id, client] of this.wsClients) {
            try {
                sendCloseFrame(client.socket, 1001, 'server shutting down');
            } catch {}
            client.socket.destroy();
        }
        this.sseClients.clear();
        this.wsClients.clear();
    }

    /** Add an SSE subscriber. Returns subscriberId for removal. */
    addSseSubscriber(stream, filters = {}, soulSpecific = false) {
        const id = ++this._subscriberId;
        this.sseClients.set(id, {
            stream,
            filters,
            soulSpecific,
            addedAt: Date.now(),
        });
        stream.onClose(() => this.sseClients.delete(id));
        return id;
    }

    /** Add a WebSocket subscriber. Returns subscriberId for removal. */
    addWsSubscriber(socket, filters = {}, soulSpecific = false) {
        const id = ++this._subscriberId;
        this.wsClients.set(id, {
            socket,
            filters,
            soulSpecific,
            addedAt: Date.now(),
        });

        let buf = Buffer.alloc(0);
        socket.on('data', (data) => {
            buf = Buffer.concat([buf, data]);
            if (buf.length > MAX_WS_BUFFER_SIZE) {
                sendCloseFrame(socket, 1009, 'message too big');
                socket.destroy();
                this.wsClients.delete(id);
                return;
            }
            while (true) {
                const frame = decodeFrame(buf);
                if (!frame) break;
                buf = buf.subarray(frame.bytesConsumed);
                this._handleWsFrame(id, frame);
            }
        });

        socket.on('close', () => this.wsClients.delete(id));
        socket.on('error', () => this.wsClients.delete(id));
        return id;
    }

    /** Update filters for a subscriber. */
    updateFilters(subscriberId, filters) {
        const sse = this.sseClients.get(subscriberId);
        if (sse) {
            sse.filters = filters;
            return;
        }
        const ws = this.wsClients.get(subscriberId);
        if (ws) ws.filters = filters;
    }

    /** Publish a completed audit log entry to all matching subscribers. */
    publish(logRow) {
        const redacted = redactLogEntry(logRow);
        const redactedJson = JSON.stringify(redacted);
        const fullJson = JSON.stringify(logRow);

        for (const [, client] of this.sseClients) {
            if (!matchesFilters(logRow, client.filters, client.soulSpecific))
                continue;
            const payload = client.soulSpecific ? fullJson : redactedJson;
            client.stream.send('log', payload);
        }

        for (const [, client] of this.wsClients) {
            if (!matchesFilters(logRow, client.filters, client.soulSpecific))
                continue;
            const payload = client.soulSpecific ? fullJson : redactedJson;
            try {
                sendTextFrame(client.socket, payload);
            } catch {}
        }
    }

    get subscriberCount() {
        return this.sseClients.size + this.wsClients.size;
    }

    _handleWsFrame(subscriberId, frame) {
        if (frame.opcode === OPCODE_PING) {
            const client = this.wsClients.get(subscriberId);
            if (client) {
                try {
                    const { encodeFrame } = {
                        encodeFrame: (op, data) => {
                            // inline pong — reuse codec
                            const len = data.length;
                            const header = Buffer.alloc(2);
                            header[0] = 0x80 | OPCODE_PONG;
                            header[1] = len;
                            client.socket.write(Buffer.concat([header, data]));
                        },
                    };
                    encodeFrame(OPCODE_PONG, frame.payload);
                } catch {}
            }
            return;
        }

        if (frame.opcode === OPCODE_CLOSE) {
            const client = this.wsClients.get(subscriberId);
            if (client) {
                try {
                    sendCloseFrame(client.socket, 1000);
                } catch {}
                client.socket.destroy();
            }
            this.wsClients.delete(subscriberId);
            return;
        }

        if (frame.opcode === OPCODE_TEXT) {
            try {
                const msg = JSON.parse(frame.payload.toString());
                if (msg.type === 'set_filters' && msg.filters) {
                    this.updateFilters(subscriberId, msg.filters);
                }
            } catch {}
        }
    }

    _sendHeartbeats() {
        for (const [, client] of this.sseClients) {
            client.stream.comment('keepalive');
        }
        for (const [, client] of this.wsClients) {
            try {
                sendPing(client.socket);
            } catch {}
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────

function matchesFilters(logRow, filters, soulSpecific) {
    if (soulSpecific) {
        // Soul-specific streams only accept logs for their soul
        return filters.soul_id && logRow.soul_id === filters.soul_id;
    }
    if (filters.soul_id && logRow.soul_id !== filters.soul_id) return false;
    if (filters.model && logRow.requested_model !== filters.model) return false;
    if (filters.status && logRow.status !== filters.status) return false;
    return true;
}
