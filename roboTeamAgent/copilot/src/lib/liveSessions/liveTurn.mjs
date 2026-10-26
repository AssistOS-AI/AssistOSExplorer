import { codingAgentLabel } from '../webchat/webchatProgressState.mjs';

// One copilot turn as a Live Session run: ALA events rendered as run output,
// and owner messages delivered to the running ALA child with their receipts.
// A message resolves only from the message-accepted or message-rejected event
// that carries its id; without one it is unknown after the timeout, and it is
// run_ended once the child has exited.
export const LIVE_TURN_RECEIPT_TIMEOUT_MS = 35 * 1000;

function line(text) {
    const value = String(text ?? '').replace(/\s+$/u, '');
    return value ? `${value}\n` : '';
}

export function createLiveTurn(publisher, { title, cwd, robot, owner = null, transcriptUrl = '', abort,
    receiptTimeoutMs = LIVE_TURN_RECEIPT_TIMEOUT_MS } = {}) {
    if (!publisher) return null;
    const waiters = new Map();
    let writer = null;
    let exited = false;
    const settle = (id, outcome, detail) => {
        const waiter = waiters.get(id);
        if (!waiter) return false;
        waiters.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve(detail ? { outcome, detail } : outcome);
        return true;
    };
    const exitAll = () => {
        exited = true;
        for (const id of [...waiters.keys()]) settle(id, 'run_ended');
    };
    const onControl = ({ action, requestId, message }) => {
        if (action === 'stop') {
            if (exited) return 'run_ended';
            abort?.();
            return 'delivered';
        }
        if (exited) return 'run_ended';
        // Before the child holds its turn prompt, a message would be taken as
        // the prompt; it is refused rather than written or held.
        if (!writer) return { outcome: 'rejected', detail: 'the turn is not ready for messages yet' };
        if (typeof message !== 'string' || !message.trim()) return { outcome: 'rejected', detail: 'empty message' };
        return new Promise((resolve) => {
            const timer = setTimeout(() => settle(requestId, 'unknown'), receiptTimeoutMs);
            timer.unref?.();
            waiters.set(requestId, { resolve, timer, text: message });
            let written = false;
            try { written = writer({ type: 'message', id: requestId, message }) !== false; } catch { written = false; }
            if (!written) settle(requestId, 'run_ended');
        });
    };
    const run = publisher.startRun({ kind: 'copilot-turn', title, cwd, robot, owner, transcriptUrl, onControl });
    return {
        // The control writer of the spawned child, after its prompt record.
        attach(write) { if (!exited) writer = typeof write === 'function' ? write : null; },
        event(event) {
            if (!event || typeof event.type !== 'string') return;
            switch (event.type) {
                case 'coding-agent-message': {
                    const text = typeof event.message === 'string' ? event.message : '';
                    const value = event.outputComplete && !text.endsWith('\n') ? `${text}\n` : text;
                    if (value) run.output(value, event.outputKind === 'assistant' ? 'assistant' : 'output');
                    return;
                }
                case 'coding-agent-selected':
                    run.output(line(`Coding agent: ${codingAgentLabel(event.agent)}${event.model ? ` (${event.model})` : ''}`), 'status');
                    return;
                case 'progress':
                    if (event.reason) run.output(line(event.reason), 'status');
                    return;
                case 'diagnostic':
                    if (event.message) run.output(line(event.message), 'status');
                    return;
                case 'coding-agent-request':
                    run.output('permission requested — answer in WebChat\n', 'status');
                    return;
                case 'message-accepted': {
                    const text = waiters.get(event.id)?.text;
                    const delivery = event.delivery === 'queued' ? 'queued' : 'delivered';
                    run.output(line(text === undefined ? `Message ${delivery}` : `> ${text} (${delivery})`), 'user');
                    if (event.id !== undefined) settle(event.id, delivery);
                    return;
                }
                case 'message-rejected': {
                    const text = waiters.get(event.id)?.text;
                    const reason = typeof event.error === 'string' && event.error ? event.error : 'rejected';
                    run.output(line(text === undefined ? `Message rejected: ${reason}` : `> ${text} (rejected: ${reason})`), 'user');
                    if (event.id !== undefined) settle(event.id, 'rejected', reason);
                    return;
                }
                default:
            }
        },
        // The ALA child exited: pending and later messages are run_ended.
        childExited() { writer = null; exitAll(); },
        end(result) { writer = null; exitAll(); run.end(result); },
    };
}
