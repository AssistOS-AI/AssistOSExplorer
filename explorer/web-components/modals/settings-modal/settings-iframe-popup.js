const STYLE_ID = "settings-iframe-popup-styles";
const RETRY_DELAY_MS = 2000;
const MAX_RETRIES = 90;

const POPUP_CSS = `
dialog.modal.settings-iframe-popup-dialog {
    padding: 0;
    border: none;
    background: transparent;
    width: min(1280px, 94vw);
    height: 90vh;
    max-width: 96vw;
    max-height: 94vh;
    min-width: min(720px, 94vw);
    min-height: 480px;
    overflow: hidden;
}
dialog.modal.settings-iframe-popup-dialog.sg-positioned {
    position: fixed;
    margin: 0;
}
dialog.modal.settings-iframe-popup-dialog.is-fullscreen {
    left: 0 !important;
    top: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    max-width: 100vw !important;
    max-height: 100vh !important;
    min-width: 0 !important;
    min-height: 0 !important;
    border-radius: 0 !important;
}
.settings-iframe-popup {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--surface, #191a1c);
    border: 1px solid var(--border, #393b42);
    border-radius: 12px;
    overflow: hidden;
}
dialog.modal.settings-iframe-popup-dialog.is-fullscreen .settings-iframe-popup {
    border-radius: 0;
}
.settings-iframe-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex: 0 0 auto;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, #393b42);
}
.settings-iframe-popup-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text, #cfd1d6);
}
.settings-iframe-popup-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}
.settings-iframe-popup-icon {
    width: 16px;
    height: 16px;
    display: block;
}
.settings-iframe-popup-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    background: var(--bg, #26282c);
}
.settings-iframe-popup-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: var(--surface, #191a1c);
}
.settings-iframe-popup-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    color: var(--text-soft, #9fa2a8);
    font-size: 0.9rem;
    background: var(--bg, #26282c);
}
.settings-iframe-popup-state[hidden] {
    display: none;
}
.settings-iframe-popup-spinner {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    border: 2px solid color-mix(in srgb, var(--text-soft, #9fa2a8) 28%, transparent);
    border-top-color: var(--accent, #60a5fa);
    border-radius: 50%;
    animation: settings-iframe-popup-spin 0.8s linear infinite;
}
@keyframes settings-iframe-popup-spin {
    to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
    .settings-iframe-popup-spinner { animation: none; }
}
@media (max-width: 720px) {
    dialog.modal.settings-iframe-popup-dialog,
    dialog.modal.settings-iframe-popup-dialog.is-fullscreen {
        width: 100vw !important;
        height: 100svh !important;
        max-width: 100vw !important;
        max-height: 100svh !important;
        min-width: 0 !important;
        min-height: 0 !important;
        border-radius: 0 !important;
    }
}`;

function ensureStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = POPUP_CSS;
    document.head.appendChild(style);
}

export function openSettingsIframePopup({ url, title = "Settings", readyTitle = "", fullscreen = true } = {}) {
    if (typeof document === "undefined") {
        return Promise.resolve();
    }
    ensureStyles();

    const targetUrl = String(url || "").trim();
    const expectedTitle = String(readyTitle || "").trim();
    const existing = document.querySelector("dialog.settings-iframe-popup-dialog[open]");
    if (existing) {
        existing.close();
        existing.remove();
    }

    const dialog = document.createElement("dialog");
    dialog.className = "modal settings-iframe-popup-dialog";
    dialog.innerHTML = `
        <div class="settings-iframe-popup" role="dialog" aria-label="${title}">
            <div class="settings-iframe-popup-header">
                <div class="settings-iframe-popup-title"></div>
                <div class="settings-iframe-popup-actions">
                    <button type="button" class="icon-button" data-popup-reload aria-label="Reload" title="Reload">
                        <img src="/explorer/assets/icons/refresh.svg" alt="" class="settings-iframe-popup-icon" aria-hidden="true">
                    </button>
                    <button type="button" class="icon-button" data-popup-fullscreen aria-label="Toggle fullscreen" title="Toggle fullscreen">
                        <img src="/explorer/assets/icons/fullscreen.svg" alt="" class="settings-iframe-popup-icon" aria-hidden="true">
                    </button>
                    <button type="button" class="icon-button" data-popup-close aria-label="Close" title="Close">
                        <img src="/explorer/assets/icons/x-mark.svg" alt="" class="settings-iframe-popup-icon" aria-hidden="true">
                    </button>
                </div>
            </div>
            <div class="settings-iframe-popup-body">
                <iframe class="settings-iframe-popup-frame" title="${title}" referrerpolicy="no-referrer"></iframe>
                <div class="settings-iframe-popup-state" hidden>
                    <span class="settings-iframe-popup-spinner" aria-hidden="true"></span>
                    <span data-popup-state-message>Starting…</span>
                </div>
            </div>
        </div>
    `;
    dialog.querySelector(".settings-iframe-popup-title").textContent = title;

    const frame = dialog.querySelector("iframe");
    const stateNode = dialog.querySelector(".settings-iframe-popup-state");
    const stateMessage = dialog.querySelector("[data-popup-state-message]");
    const fullscreenButton = dialog.querySelector("[data-popup-fullscreen]");
    let retryTimer = null;
    let retryCount = 0;

    const setState = (message) => {
        if (message) {
            stateMessage.textContent = message;
            stateNode.hidden = false;
        } else {
            stateNode.hidden = true;
        }
    };

    const clearRetry = () => {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    };

    const isReady = () => {
        try {
            const doc = frame.contentDocument;
            if (!doc) return false;
            if (expectedTitle) {
                return String(doc.title || "").trim() === expectedTitle;
            }
            return Boolean(doc.body) && !/upstream_unavailable/.test(doc.body.textContent || "");
        } catch {
            return false;
        }
    };

    const loadFrame = (query = "") => {
        if (!frame) return;
        if (query) {
            frame.setAttribute("src", `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}${query}`);
        } else {
            frame.setAttribute("src", targetUrl);
        }
    };

    const scheduleRetry = () => {
        clearRetry();
        if (retryCount >= MAX_RETRIES) {
            setState("Settings are not responding. Use Reload to try again.");
            return;
        }
        retryCount += 1;
        setState(`Starting… (attempt ${retryCount})`);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            loadFrame(`sgRetry=${Date.now()}`);
        }, RETRY_DELAY_MS);
    };

    frame.addEventListener("load", () => {
        if (isReady()) {
            clearRetry();
            setState("");
        } else {
            scheduleRetry();
        }
    });

    const setFullscreen = (value) => {
        const isFullscreen =
            typeof value === "boolean" ? value : !dialog.classList.contains("is-fullscreen");
        if (!dialog.dataset.sgPositioned) {
            const rect = dialog.getBoundingClientRect();
            dialog.style.left = `${rect.left}px`;
            dialog.style.top = `${rect.top}px`;
            dialog.classList.add("sg-positioned");
            dialog.dataset.sgPositioned = "true";
        }
        dialog.classList.toggle("is-fullscreen", isFullscreen);
        fullscreenButton.setAttribute("aria-pressed", isFullscreen ? "true" : "false");
    };

    dialog.querySelector("[data-popup-close]").addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-popup-reload]").addEventListener("click", () => {
        retryCount = 0;
        clearRetry();
        loadFrame("");
    });
    fullscreenButton.addEventListener("click", () => setFullscreen());

    const closePromise = new Promise((resolve) => {
        dialog.addEventListener("close", () => {
            clearRetry();
            dialog.remove();
            resolve();
        }, { once: true });
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    if (fullscreen) {
        setFullscreen(true);
    }
    loadFrame("");

    return closePromise;
}
