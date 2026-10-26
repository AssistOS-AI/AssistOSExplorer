const EXPANDED_MODAL_COMPONENT = "expanded-modal";

function toKebabCase(name) {
    return String(name || "")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .toLowerCase();
}

function toModalPayload(descriptor = {}) {
    const payload = {};
    for (const [key, value] of Object.entries(descriptor)) {
        if (value === null || value === undefined) continue;
        payload[toKebabCase(key)] = typeof value === "object" ? JSON.stringify(value) : value;
    }
    if (!payload.title) payload.title = "Panel";
    if (payload.fullscreen === undefined) payload.fullscreen = "true";
    return payload;
}

function descriptorKey(descriptor = {}) {
    return String(descriptor.component || descriptor.url || descriptor.iframeUrl || descriptor.title || "expanded");
}

let activePanel = null;
// The different panel waiting while the active one prepares to be replaced. It owns the transition.
let pendingReplacement = null;
let pageUnloading = false;
const RESUME_STORAGE_KEY = "explorer.expandedModal.resume";

if (typeof globalThis.window !== "undefined") {
    const markPageUnloading = () => { pageUnloading = true; };
    globalThis.window.addEventListener("pagehide", markPageUnloading, { once: true });
    globalThis.window.addEventListener("beforeunload", markPageUnloading, { once: true });
}

function isResumableDescriptor(descriptor = {}) {
    return descriptor.resume === true;
}

function persistResume(descriptor = {}, key = "") {
    if (!isResumableDescriptor(descriptor)) return;
    try {
        globalThis.sessionStorage?.setItem(RESUME_STORAGE_KEY, JSON.stringify({
            key,
            resume: true,
            mode: descriptor.mode || (descriptor.component ? "component" : "iframe"),
            component: descriptor.component || "",
            url: descriptor.url || descriptor.iframeUrl || "",
            agentRef: descriptor.agentRef || "",
            allow: descriptor.allow || "",
            readyTitle: descriptor.readyTitle || "",
            title: descriptor.title || "",
            fullscreen: descriptor.fullscreen
        }));
    } catch (_) {
        // Persisting the resume record is best-effort.
    }
}

function clearResume(recordKey = "") {
    try {
        const raw = globalThis.sessionStorage?.getItem(RESUME_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (recordKey && parsed?.key && parsed.key !== recordKey) return;
        globalThis.sessionStorage?.removeItem(RESUME_STORAGE_KEY);
    } catch (_) {
        // Ignore storage failures while clearing the resume record.
    }
}

export function restoreExpandedModal() {
    let descriptor = null;
    try {
        const raw = globalThis.sessionStorage?.getItem(RESUME_STORAGE_KEY);
        if (!raw) return null;
        descriptor = JSON.parse(raw);
    } catch (_) {
        descriptor = null;
    }
    if (!descriptor || typeof descriptor !== "object") return null;
    if (!descriptor.component && !descriptor.url) return null;
    const { key: _key, ...openDescriptor } = descriptor;
    return openExpandedModal(openDescriptor);
}

function panelPresenter(record) {
    return record?.dialog?.querySelector(EXPANDED_MODAL_COMPONENT)?.webSkelPresenter;
}

function updatePanel(record) {
    if (!record.dialog || record.controller.signal.aborted) return;
    void panelPresenter(record)?.updateDescriptor(record.descriptor);
}

function mergeDescriptor(record, descriptor) {
    record.descriptor = {
        ...record.descriptor,
        ...descriptor,
        props: { ...record.descriptor.props, ...descriptor.props }
    };
}

// The returned close promise also carries isClosed() and opened, which resolves with the dialog or null.
function createPanelRecord(key, descriptor) {
    const record = { key, descriptor, controller: new AbortController(), dialog: null };
    record.closed = new Promise((resolve) => { record.resolve = resolve; });
    record.closed.isClosed = () => record.controller.signal.aborted;
    record.closed.opened = new Promise((resolve) => { record.resolveOpened = resolve; });
    record.controller.signal.addEventListener("abort", () => {
        record.dialog?.close();
        record.dialog?.remove();
        record.resolveOpened(null);
        record.resolve();
    }, { once: true });
    return record;
}

function isOpen(record) {
    return Boolean(record) && !record.controller.signal.aborted;
}

export function openExpandedModal(descriptor = {}) {
    const ui = globalThis.assistOS?.UI;
    if (typeof ui?.showModal !== "function") return Promise.resolve();
    const key = descriptorKey(descriptor);
    if (activePanel?.key === key && !activePanel.controller.signal.aborted) {
        mergeDescriptor(activePanel, descriptor);
        persistResume(activePanel.descriptor, activePanel.key);
        updatePanel(activePanel);
        return activePanel.closed;
    }
    if (isOpen(pendingReplacement)) {
        // The first replacement owns the transition: the same request shares it, and a different one is cancelled
        // without touching the active panel.
        if (pendingReplacement.key === key) {
            mergeDescriptor(pendingReplacement, descriptor);
            return pendingReplacement.closed;
        }
        const cancelled = createPanelRecord(key, descriptor);
        cancelled.controller.abort();
        return cancelled.closed;
    }
    const record = createPanelRecord(key, descriptor);
    const previous = activePanel;
    const guard = isOpen(previous) && previous.dialog ? panelPresenter(previous) : null;
    if (typeof guard?.hasCloseGuard === "function" && typeof guard.prepareClose === "function" && guard.hasCloseGuard()) {
        // A mounted panel whose content guards its closing stays until it approves the replacement.
        pendingReplacement = record;
        Promise.resolve().then(() => guard.prepareClose("replace")).catch(() => false).then((approved) => {
            if (pendingReplacement === record) pendingReplacement = null;
            if (!isOpen(record)) return;
            if (activePanel === previous && isOpen(previous)) {
                if (approved !== true) {
                    record.controller.abort();
                    return;
                }
                previous.controller.abort();
            } else if (isOpen(activePanel)) {
                record.controller.abort();
                return;
            }
            launchPanel(ui, record);
        });
        return record.closed;
    }
    // Nothing mounted, or nothing guarded: replace at once.
    activePanel?.controller.abort();
    launchPanel(ui, record);
    return record.closed;
}

function launchPanel(ui, record) {
    const { key, descriptor } = record;
    activePanel = record;
    persistResume(descriptor, key);
    const payload = { ...toModalPayload(descriptor), key };
    // Explorer preloads the shell component without blocking startup; no panel opens before it. A failed preload is
    // retried by the next launch (ui.ensureExpandedModalReady), and overlapping launches share one attempt.
    Promise.resolve().then(() => ui.ensureExpandedModalReady?.()).then(() => ui.showModal(EXPANDED_MODAL_COMPONENT, payload, false, {
        signal: record.controller.signal
    })).then((dialog) => {
        if (!dialog) return;
        if (record.controller.signal.aborted) {
            dialog.close();
            dialog.remove();
            return;
        }
        record.dialog = dialog;
        record.resolveOpened(dialog);
        dialog.addEventListener("close", (event) => {
            dialog.remove();
            if (activePanel === record) activePanel = null;
            if (!pageUnloading) clearResume(record.key);
            record.resolve(event.data);
            record.controller.abort();
        }, { once: true });
        updatePanel(record);
    }).catch((error) => {
        console.error("[expanded-modal] Failed to open panel:", error);
        record.controller.abort();
        if (activePanel === record) activePanel = null;
    });
    return record.closed;
}
