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

function updatePanel(record) {
    if (!record.dialog || record.controller.signal.aborted) return;
    const presenter = record.dialog.querySelector(EXPANDED_MODAL_COMPONENT)?.webSkelPresenter;
    void presenter?.updateDescriptor(record.descriptor);
}

export function openExpandedModal(descriptor = {}) {
    const ui = globalThis.assistOS?.UI;
    if (typeof ui?.showModal !== "function") return Promise.resolve();
    const key = descriptorKey(descriptor);
    if (activePanel?.key === key && !activePanel.controller.signal.aborted) {
        activePanel.descriptor = {
            ...activePanel.descriptor,
            ...descriptor,
            props: { ...activePanel.descriptor.props, ...descriptor.props }
        };
        persistResume(activePanel.descriptor, activePanel.key);
        updatePanel(activePanel);
        return activePanel.closed;
    }
    activePanel?.controller.abort();
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
    activePanel = record;
    persistResume(descriptor, key);
    const payload = { ...toModalPayload(descriptor), key };
    Promise.resolve().then(() => ui.showModal(EXPANDED_MODAL_COMPONENT, payload, false, {
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
