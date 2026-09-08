import { CliApprovalController } from '../permissions/CliApprovalController.mjs';

function snapshotRequest(event) {
    if (event?.type !== 'coding-agent-request' || event.kind !== 'permission'
        || typeof event.id !== 'string' || !event.id
        || !Array.isArray(event.options) || !event.options.length) {
        throw new Error('Invalid native permission request.');
    }
    const ids = new Set();
    const options = event.options.map((option) => {
        if (typeof option?.id !== 'string' || !option.id || ids.has(option.id)
            || typeof option.label !== 'string' || !option.label) {
            throw new Error('Native permission options require unique IDs and labels.');
        }
        ids.add(option.id);
        return {
            id: option.id,
            label: option.label,
            description: String(option.description || ''),
        };
    });
    return {
        id: event.id,
        title: String(event.title || 'Native permission required'),
        message: String(event.message || ''),
        detail: typeof event.detail === 'string' ? event.detail
            : event.detail == null ? '' : JSON.stringify(event.detail, null, 2),
        options,
    };
}

export function createNativeInteractions({ webchatController = null, selector, output } = {}) {
    const terminal = webchatController ? null : new CliApprovalController({ selector, output });
    const pending = new Map();
    let disposed = false;

    async function request(event, { context = {}, signal, turnId } = {}) {
        if (disposed || signal?.aborted) return null;
        const snapshot = snapshotRequest(event);
        if (pending.has(snapshot.id)) throw new Error(`Duplicate native request: ${snapshot.id}`);
        const controller = new AbortController();
        const entry = { controller, turnId };
        pending.set(snapshot.id, entry);
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        try {
            const selection = webchatController
                ? webchatController.select({
                    title: snapshot.title,
                    message: snapshot.message,
                    detail: snapshot.detail,
                    options: snapshot.options.map((option) => ({
                        value: option.id,
                        label: option.label,
                        description: option.description,
                    })),
                    targetTabId: context.sourceTabId || '',
                    targetPageInstanceId: context.sourcePageInstanceId || '',
                }, { signal: controller.signal })
                : terminal.select(snapshot, { signal: controller.signal });
            const optionId = await selection;
            if (controller.signal.aborted || pending.get(snapshot.id) !== entry) return null;
            return snapshot.options.some((option) => option.id === optionId) ? optionId : null;
        } catch (error) {
            if (controller.signal.aborted || /^interaction_(cancelled|expired|controller_closed)$/.test(error.message)) {
                return null;
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', abort);
            if (pending.get(snapshot.id) === entry) pending.delete(snapshot.id);
        }
    }

    function resolve(id, _reason) {
        const entry = pending.get(id);
        if (!entry) return false;
        pending.delete(id);
        entry.controller.abort();
        return true;
    }

    function cancelTurn(turnId) {
        for (const [id, entry] of [...pending].reverse()) {
            if (entry.turnId === turnId) resolve(id, 'cancelled');
        }
    }

    function dispose() {
        disposed = true;
        for (const id of [...pending.keys()].reverse()) resolve(id, 'cancelled');
    }

    return {
        request,
        resolve,
        cancelTurn,
        setInputControls(controls) { terminal?.setInputControls(controls); },
        dispose,
    };
}
