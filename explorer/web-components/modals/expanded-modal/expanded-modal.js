import { ensureMarketplaceAgentRunning } from "../../../services/infrastructure/marketplaceAgentRuntime.js";
import assistosSDK from "../../../services/assistosSDK.js";
import {
    probeAgentRuntimeMcp,
    probeAgentRuntimeRouteStability,
    probeAgentRuntimeTarget
} from "../../../shared/ui/agent-runtime-loader/agent-runtime-wait-route.js";
import { waitForAgentRuntimeAvailability, readMarketplaceAgent } from "../../../shared/ui/agent-runtime-loader/agent-runtime-loader.js";

const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 90;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const DEFAULT_ALLOW = "camera; microphone; display-capture; autoplay; fullscreen; clipboard-write";
const AGENT_REF_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parsePropsAttribute(rawValue) {
    if (!rawValue) return {};
    try {
        const parsed = JSON.parse(rawValue);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export class ExpandedModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.dialog = null;
        this.body = null;
        this.stateNode = null;
        this.frame = null;
        this.retryTimer = null;
        this.retryCount = 0;
        this.prevRect = null;
        this.closed = false;
        this.runId = 0;
        this.loadController = new AbortController();
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.dialog = this.element.closest("dialog");
        if (this.dialog) {
            this.dialog.dataset.expandedKey = this.attr("key");
        }
        this.body = this.element.querySelector("#expandedModalBody");
        this.stateNode = this.element.querySelector("#expandedModalState");
        this.stateMessage = this.element.querySelector("#expandedModalStateMessage");
        this.fullscreenButton = this.element.querySelector("#expandedModalFullscreen");
        this.mode = this.attr("mode") || (this.attr("component") ? "component" : "iframe");
        const reloadButton = this.element.querySelector("#expandedModalReload");
        if (reloadButton) reloadButton.hidden = this.mode !== "iframe";

        this.bindResizeHandles();
        this.bindHeaderDrag();
        this.setState("Loading…");
    }

    startContent() {
        if (this.closed) return;
        if (this.mode === "component") {
            this.contentReady = this.mountComponentContent();
        } else if (this.frameUrl()) {
            this.contentReady = this.startFrameContent();
        } else {
            this.setState("No content configured.");
        }
    }

    afterUnload() {
        this.closed = true;
        this.cancelLoading();
    }

    cancelLoading() {
        this.loadController.abort();
        this.finishWait?.();
        if (this.frame) {
            this.frame.removeAttribute("src");
            this.frame.remove();
            this.frame = null;
        }
        this.runId += 1;
        this.stopResize?.();
        this.stopDrag?.();
        this.clearRetry();
    }

    attr(name) {
        const value = this.element.getAttribute(`data-${name}`);
        return value === null ? "" : value;
    }

    frameUrl() {
        return this.attr("iframe-url") || this.attr("url");
    }

    componentProps() {
        return parsePropsAttribute(this.attr("props"));
    }

    setState(message) {
        this.loadingMessage = message;
        this.renderLoadingState();
    }

    renderLoadingState() {
        if (!this.stateNode) return;
        const message = this.loadingMessage || (this.element.expandedLoaderCount > 0 ? "Loading…" : "");
        this.stateNode.hidden = !message;
        this.body?.setAttribute("aria-busy", message ? "true" : "false");
        if (this.stateMessage) this.stateMessage.textContent = message;
    }

    clearRetry() {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    ensurePositioned() {
        if (!this.dialog) return;
        if (!this.dialog.dataset.expandedPositioned) {
            const rect = this.dialog.getBoundingClientRect();
            this.dialog.style.left = `${rect.left}px`;
            this.dialog.style.top = `${rect.top}px`;
            this.dialog.classList.add("expanded-modal-positioned");
            this.dialog.dataset.expandedPositioned = "true";
        }
    }

    setFullscreen(value) {
        if (!this.dialog) return;
        this.ensurePositioned();
        const isFullscreen = typeof value === "boolean"
            ? value
            : !this.dialog.classList.contains("is-fullscreen");
        if (isFullscreen) this.stopDrag?.();
        if (isFullscreen && !this.dialog.classList.contains("is-fullscreen")) {
            const rect = this.dialog.getBoundingClientRect();
            this.prevRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
        this.dialog.classList.toggle("is-fullscreen", isFullscreen);
        if (!isFullscreen && this.prevRect) {
            this.dialog.style.left = `${this.prevRect.left}px`;
            this.dialog.style.top = `${this.prevRect.top}px`;
            const width = Math.min(this.prevRect.width, window.innerWidth);
            const height = Math.min(this.prevRect.height, window.innerHeight);
            this.dialog.style.width = `${width}px`;
            this.dialog.style.height = `${height}px`;
            this.dialog.style.left = `${Math.max(0, Math.min(this.prevRect.left, window.innerWidth - width))}px`;
            this.dialog.style.top = `${Math.max(0, Math.min(this.prevRect.top, window.innerHeight - height))}px`;
        }
        this.fullscreenButton?.setAttribute("aria-pressed", isFullscreen ? "true" : "false");
    }

    toggleFullscreen() {
        this.setFullscreen();
    }

    startResize(event, dir) {
        if (!this.dialog) return;
        this.ensurePositioned();
        if (this.dialog.classList.contains("is-fullscreen")) return;
        event.preventDefault();
        event.stopPropagation();
        this.stopResize?.();
        const dialog = this.dialog;
        const startRect = dialog.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            let { left, top, width, height } = startRect;
            if (dir.includes("e")) width = startRect.width + dx;
            if (dir.includes("s")) height = startRect.height + dy;
            if (dir.includes("w")) { width = startRect.width - dx; left = startRect.left + dx; }
            if (dir.includes("n")) { height = startRect.height - dy; top = startRect.top + dy; }
            width = Math.max(MIN_WIDTH, width);
            height = Math.max(MIN_HEIGHT, height);
            if (dir.includes("w") && width === MIN_WIDTH) left = startRect.right - MIN_WIDTH;
            if (dir.includes("n") && height === MIN_HEIGHT) top = startRect.bottom - MIN_HEIGHT;
            dialog.style.left = `${left}px`;
            dialog.style.top = `${top}px`;
            dialog.style.width = `${width}px`;
            dialog.style.height = `${height}px`;
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onUp, true);
            this.stopResize = null;
        };
        this.stopResize = onUp;
        window.addEventListener("pointercancel", onUp, true);
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
    }

    bindResizeHandles() {
        const handles = this.element.querySelectorAll(".expanded-modal-resize-handle");
        for (const handle of handles) {
            handle.addEventListener("pointerdown", (event) => this.startResize(event, handle.dataset.resizeDir));
        }
    }

    bindHeaderDrag() {
        const header = this.element.querySelector(".expanded-modal-header");
        header?.addEventListener("pointerdown", (event) => this.startDrag(event));
    }

    startDrag(event) {
        if (!this.dialog || event.button !== 0) return;
        if (this.dialog.classList.contains("is-fullscreen")) return;
        if (event.target?.closest?.("button, a, input, select, textarea, [data-local-action]")) return;
        event.preventDefault();
        this.ensurePositioned();
        this.stopResize?.();
        const dialog = this.dialog;
        const startRect = dialog.getBoundingClientRect();
        const offsetX = event.clientX - startRect.left;
        const offsetY = event.clientY - startRect.top;

        const onMove = (moveEvent) => {
            const maxLeft = Math.max(0, window.innerWidth - dialog.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - dialog.offsetHeight);
            const left = Math.min(Math.max(0, moveEvent.clientX - offsetX), maxLeft);
            const top = Math.min(Math.max(0, moveEvent.clientY - offsetY), maxTop);
            dialog.style.left = `${left}px`;
            dialog.style.top = `${top}px`;
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onUp, true);
            this.stopDrag = null;
        };
        this.stopDrag = onUp;
        window.addEventListener("pointercancel", onUp, true);
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
    }

    isFrameReady() {
        try {
            const doc = this.frame?.contentDocument;
            if (!doc) return false;
            const expectedTitle = this.attr("ready-title");
            if (expectedTitle) {
                return String(doc.title || "").trim() === expectedTitle;
            }
            return Boolean(doc.body) && !/upstream_unavailable/.test(doc.body.textContent || "");
        } catch {
            return false;
        }
    }

    loadFrame(query = "") {
        if (!this.frame) return;
        const base = this.frameUrl();
        this.frame.setAttribute("src", query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base);
    }

    scheduleRetry() {
        if (this.loadController.signal.aborted) return;
        this.clearRetry();
        if (this.retryCount >= MAX_RETRIES) {
            this.setState("Not responding. Use Reload to try again.");
            return;
        }
        this.retryCount += 1;
        this.setState("Loading…");
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.loadFrame(`expandedRetry=${Date.now()}`);
        }, RETRY_DELAY_MS);
    }

    async startFrameContent() {
        const signal = this.loadController.signal;
        const runId = ++this.runId;
        this.setState("Loading…");
        const agentRef = this.attr("agent-ref");
        if (agentRef) {
            await this.ensureAgentRuntime(agentRef, signal);
            if (runId !== this.runId || !this.element.isConnected) return;
            if (AGENT_REF_PATTERN.test(agentRef)) {
                const ready = await this.waitForAgent(agentRef, runId, signal);
                if (!ready || runId !== this.runId || !this.element.isConnected) return;
            }
        }
        this.setState("Loading…");
        this.mountFrameContent();
    }

    waitForNextProbe(milliseconds) {
        if (this.closed) return Promise.resolve();
        return new Promise(resolve => {
            const timer = setTimeout(() => finish(), milliseconds);
            const finish = () => {
                clearTimeout(timer);
                this.finishWait = null;
                resolve();
            };
            this.finishWait = finish;
        });
    }

    async waitForAgent(agentRef, runId, signal) {
        const fetchImpl = (url, options) => fetch(url, { ...options, signal });
        const label = this.attr("title") || "Panel";
        this.setState("Loading…");
        try {
            await waitForAgentRuntimeAvailability({
                agentRef,
                label,
                cancelled: () => signal.aborted || runId !== this.runId,
                readRuntime: ref => readMarketplaceAgent(ref, { signal }),
                wait: ms => this.waitForNextProbe(ms),
                operation: async () => {
                    signal.throwIfAborted();
                    await probeAgentRuntimeRouteStability(agentRef, { fetchImpl, wait: ms => this.waitForNextProbe(ms) });
                    signal.throwIfAborted();
                    await probeAgentRuntimeTarget(new URL(this.frameUrl(), window.location.origin), fetchImpl);
                    signal.throwIfAborted();
                    await probeAgentRuntimeMcp(agentRef, assistosSDK);
                    return null;
                }
            });
            return true;
        } catch (error) {
            if (!signal.aborted && runId === this.runId) {
                console.error(`[expanded-modal] Failed to start ${agentRef}:`, error);
                this.setState(String(error?.message || `${label} is unavailable.`));
            }
            return false;
        }
    }

    mountFrameContent() {
        if (!this.body || this.loadController.signal.aborted) return;
        const frame = document.createElement("iframe");
        frame.className = "expanded-modal-frame";
        frame.setAttribute("title", this.attr("title") || "Panel");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("allow", this.attr("allow") || DEFAULT_ALLOW);
        frame.addEventListener("load", () => {
            if (this.loadController.signal.aborted || frame !== this.frame) return;
            if (this.isFrameReady()) {
                this.clearRetry();
                this.setState("");
            } else {
                this.scheduleRetry();
            }
        });
        this.frame = frame;
        this.body.insertBefore(frame, this.body.firstChild);
        this.loadFrame();
    }

    async mountComponentContent() {
        const componentName = this.attr("component");
        if (!componentName || !this.body) return;
        const props = this.componentProps();
        const host = document.createElement("div");
        host.className = "expanded-modal-component";
        this.body.appendChild(host);
        this.setState("Loading…");
        try {
            const webSkel = assistOS?.UI;
            if (typeof webSkel?.ensureComponentRegistered === "function") {
                await webSkel.ensureComponentRegistered(componentName);
            }
            if (this.closed || !host.isConnected) return;
            const attributes = { "data-presenter": componentName };
            for (const [key, value] of Object.entries(props)) {
                attributes[`data-${key}`] = value === null || value === undefined ? "" : String(value);
            }
            const element = webSkel.createElement(componentName, host, props, attributes, true);
            this.contentProxy = element;
            this.appliedProps = JSON.stringify(props);
            const node = element.element?.deref?.();
            if (node) {
                await node.presenterReadyPromise;
                if (this.closed) return;
                await node.renderCompletePromise;
                if (this.closed) return;
                await node.webSkelPresenter?.initialLoad;
                if (this.closed) return;
            }
            this.setState("");
        } catch (error) {
            if (this.closed) return;
            console.error(`[expanded-modal] Failed to mount ${componentName}:`, error);
            this.setState("This panel could not be loaded.");
        }
    }

    async updateDescriptor(descriptor) {
        const revision = this.descriptorRevision = (this.descriptorRevision || 0) + 1;
        if (descriptor.title) {
            this.element.querySelector("#expandedModalTitle").textContent = descriptor.title;
            this.frame?.setAttribute("title", descriptor.title);
        }
        if (!this.initialSizeApplied) {
            this.initialSizeApplied = true;
            this.setFullscreen(descriptor.fullscreen !== false && descriptor.fullscreen !== "false");
            // Allow the shell and its loader to paint before importing plugin content.
            this.startReady = new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)))
                .then(() => {
                    if (this.element.isConnected) this.startContent();
                });
        }
        await this.startReady;
        await this.contentReady;
        if (!this.element.isConnected || revision !== this.descriptorRevision || !descriptor.props) return;
        const serialized = JSON.stringify(descriptor.props);
        if (serialized === this.appliedProps) return;
        this.appliedProps = serialized;
        const presenter = this.contentProxy?.element?.deref?.()?.webSkelPresenter;
        try {
            if (typeof presenter?.updateModalProps === "function") {
                await presenter.updateModalProps(descriptor.props);
            } else if (this.contentProxy) {
                Object.assign(this.contentProxy, descriptor.props);
            }
        } catch (error) {
            console.error("[expanded-modal] Failed to update panel:", error);
            this.setState("This panel could not be updated.");
        }
    }

    async ensureAgentRuntime(agentRef, signal) {
        try {
            await ensureMarketplaceAgentRunning(agentRef, { signal });
        } catch (error) {
            if (!signal.aborted) console.error(`[expanded-modal] Failed to start ${agentRef}:`, error);
        }
    }

    reloadContent() {
        if (this.mode !== "iframe") return;
        this.cancelLoading();
        this.loadController = new AbortController();
        this.retryCount = 0;
        this.clearRetry();
        if (this.frame) {
            this.frame.remove();
            this.frame = null;
        }
        void this.startFrameContent();
    }

    openInNewTab() {
        if (typeof window === "undefined") return;
        window.open(window.location.href, "_blank", "noopener,noreferrer");
    }

    async notifyFrameUserClose() {
        try {
            const frameWindow = this.frame?.contentWindow;
            const hook = frameWindow?.__onExpandedModalClose;
            if (typeof hook !== "function") return;
            // The hook resolves after it stops local media and disconnects the room. It performs
            // no unbounded network waits, so closing stays prompt.
            await hook();
        } catch (_) {
            // Cross-origin, unloaded, or failing hooks must never block closing the panel.
        }
    }

    async closeModal() {
        // Disconnect and release embedded content (room, tracks) before the frame is removed.
        await this.notifyFrameUserClose();
        this.closed = true;
        this.cancelLoading();
        assistOS.UI.closeModal(this.element);
    }
}
