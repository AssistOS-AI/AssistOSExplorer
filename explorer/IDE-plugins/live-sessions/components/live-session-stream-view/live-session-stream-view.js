import { agentSessionPath, AGENT_STATUSES, ENDED_STATUSES, messageAgentSession, validAgentExit } from '../../live-sessions-api.js';

const OUTPUT_LIMIT = 1024 * 1024;
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const STYLES = new Set(['assistant', 'output', 'status', 'user', 'error']);

export class LiveSessionStreamView {
    constructor(element, invalidate) {
        this.element = element;
        this.closed = false;
        this.parts = [];
        this.bytes = 0;
        this.retryCount = 0;
        this.recoveryStartedAt = null;
        this.sendMessage = this.sendMessage.bind(this);
        invalidate();
    }

    beforeRender() {}

    afterRender() {
        if (this.closed || !this.element.isConnected) return;
        this.output = this.element.querySelector('.live-session-output');
        this.status = this.element.querySelector('.live-session-stream-status');
        this.form = this.element.querySelector('.live-session-message-form');
        this.input = this.element.querySelector('textarea');
        this.sendButton = this.element.querySelector('button');
        this.form.removeEventListener('submit', this.sendMessage);
        this.form.addEventListener('submit', this.sendMessage);
        if (this.row) this.start();
    }

    updateSession(row, source) {
        if (this.closed) return;
        this.row = row;
        this.source = source;
        if (this.output) this.start();
    }

    start() {
        this.form.hidden = !this.row.isOwner || !this.row.capabilities.message;
        this.stopStream();
        this.retryCount = 0;
        this.recoveryStartedAt = null;
        this.ended = false;
        this.clearOutput();
        this.connect();
    }

    connect() {
        if (this.closed || this.ended) return;
        this.status.textContent = 'Connecting…';
        const stream = new EventSource(agentSessionPath(this.source, this.row.id, 'stream'));
        this.stream = stream;
        stream.onopen = () => {
            if (this.stream !== stream || this.closed) return;
            this.retryCount = 0;
            this.recoveryStartedAt = null;
            this.status.textContent = this.row.status;
        };
        for (const name of ['output', 'status', 'replay-truncated', 'resync', 'exit']) {
            stream.addEventListener(name, (event) => {
                if (this.closed || this.stream !== stream) return;
                try {
                    const data = JSON.parse(event.data);
                    if (name === 'output') {
                        if (!data || Object.keys(data).some((key) => !['text', 'style'].includes(key))
                            || typeof data.text !== 'string' || typeof data.style !== 'string'
                            || !STYLES.has(data.style) || new TextEncoder().encode(data.text).length > OUTPUT_LIMIT) throw new Error('Invalid output.');
                        this.appendText(data.text, data.style);
                    } else if (name === 'status') {
                        if (!data || Object.keys(data).some((key) => !['status', 'text'].includes(key))
                            || !AGENT_STATUSES.includes(data.status)
                            || (data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 1024))) throw new Error('Invalid status.');
                        this.status.textContent = data.text || data.status;
                    } else if (name === 'exit') {
                        if (!data || Object.keys(data).some((key) => !['status', 'exit'].includes(key))
                            || !ENDED_STATUSES.includes(data.status) || !validAgentExit(data.exit)) throw new Error('Invalid exit.');
                        this.ended = true;
                        this.status.textContent = `${data.status}: ${data.exit.reason}`;
                        this.form.hidden = true;
                        this.stopStream();
                    } else {
                        this.clearOutput();
                        this.status.textContent = 'Replay restarted. Earlier output may be unavailable.';
                    }
                } catch {
                    this.status.textContent = 'The session stream returned invalid data. Reopen the view.';
                    this.stopStream();
                }
            });
        }
        stream.onerror = () => {
            if (this.closed || this.stream !== stream || this.ended) return;
            this.status.textContent = 'Reconnecting…';
            if (stream.readyState !== EventSource.CLOSED) return;
            stream.close();
            this.stream = null;
            if (this.recoveryStartedAt === null) this.recoveryStartedAt = Date.now();
            const remaining = RECOVERY_WINDOW_MS - (Date.now() - this.recoveryStartedAt);
            if (remaining <= 0) {
                this.status.textContent = 'Disconnected — reopen from Live Sessions.';
                return;
            }
            const delay = Math.min(1000 * 2 ** Math.min(this.retryCount++, 4), 15000, remaining);
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                if (this.closed) return;
                if (Date.now() - this.recoveryStartedAt >= RECOVERY_WINDOW_MS) {
                    this.status.textContent = 'Disconnected — reopen from Live Sessions.';
                    return;
                }
                // A fresh EventSource has no cursor. Clear the old view before replay.
                this.clearOutput();
                this.connect();
            }, delay);
        };
    }

    appendText(text, style) {
        const node = document.createElement('span');
        node.className = `live-session-${style}`;
        node.textContent = text;
        const bytes = new TextEncoder().encode(text).length;
        this.parts.push({ node, bytes });
        this.bytes += bytes;
        this.output.appendChild(node);
        while (this.bytes > OUTPUT_LIMIT || this.parts.length > 2048) {
            const part = this.parts.shift();
            this.bytes -= part.bytes;
            part.node.remove();
        }
        this.output.scrollTop = this.output.scrollHeight;
    }

    clearOutput() {
        this.output.replaceChildren();
        this.parts = [];
        this.bytes = 0;
    }

    async sendMessage(event) {
        event?.preventDefault?.();
        if (this.closed || this.messagePending || this.ended || !this.row.isOwner || !this.row.capabilities.message) return;
        const message = this.input.value;
        if (!message || message.length > 32768) return;
        this.messagePending = true;
        this.sendButton.disabled = true;
        this.messageController = new AbortController();
        const timer = setTimeout(() => this.messageController?.abort(), 40000);
        try {
            const outcome = await messageAgentSession(this.source, this.row, message, { signal: this.messageController.signal });
            if (this.closed) return;
            this.status.textContent = {
                delivered: 'Message delivered.', queued: 'Message queued.', rejected: 'Message rejected.',
                run_ended: 'The run ended before receiving the message.',
                unknown: 'Delivery is unknown. Check the run before sending again.',
            }[outcome];
            if (outcome === 'delivered' || outcome === 'queued') this.input.value = '';
        } catch {
            if (!this.closed) this.status.textContent = 'Delivery is unknown. Check the run before sending again.';
        } finally {
            clearTimeout(timer);
            this.messageController = null;
            this.messagePending = false;
            if (!this.closed) this.sendButton.disabled = false;
        }
    }

    stopStream() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.stream?.close();
        this.stream = null;
    }

    afterUnload() {
        this.closed = true;
        this.stopStream();
        this.messageController?.abort();
        this.form?.removeEventListener('submit', this.sendMessage);
    }
}
