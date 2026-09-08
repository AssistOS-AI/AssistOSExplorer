import { callExplorerTool, parseToolResult } from "../../../services/infrastructure/explorerApi.js";
import { flattenPluginsByKey, getCachedRuntimePlugins } from "./settings-plugin-model.js";
import { ensureSettingsComponentRegistered } from "./settings-component-loader.js";

export const accountController = {
    async loadAccountPanel() {
        const scope = this.state.activeTab === "account" ? "account"
            : this.state.activeTab === "users" && this.state.usersAccess ? "administration" : null;
        const section = scope === "account" ? this.accountSection : this.usersSection;
        if (!scope || !section || this.accountLoading || this.accountPanel) return;
        this.accountScope = scope;
        const requestId = this.accountRequestId = (this.accountRequestId || 0) + 1;
        const status = section.querySelector('[data-account-status]');
        const retry = section.querySelector('[data-account-retry]');
        const mount = section.querySelector('[data-account-mount]');
        this.accountLoading = true;
        status.textContent = "Loading My Account…";
        retry.hidden = true;
        try {
            let plugins = getCachedRuntimePlugins();
            if (!plugins) {
                const payload = await callExplorerTool("collect_ide_plugins", {}, { raw: true, withLoader: false });
                plugins = parseToolResult(payload) || {};
            }
            const item = flattenPluginsByKey(plugins).find((plugin) => plugin.key === "userPersistoAgent/userpersisto-settings");
            if (!item) throw new Error("My Account is unavailable in this workspace.");
            const component = await ensureSettingsComponentRegistered(item);
            if (requestId !== this.accountRequestId || this.accountScope !== scope) return;
            const panel = document.createElement(component);
            panel.setAttribute("data-presenter", component);
            panel.setAttribute("data-embedded", "true");
            panel.setAttribute("data-settings-scope", scope);
            panel.setAttribute("data-initial-panel", scope === "account" ? "auth" : "policy");
            this.accountPanel = panel;
            mount.replaceChildren(panel);
            status.textContent = "";
        } catch (error) {
            if (requestId !== this.accountRequestId) return;
            status.textContent = error?.message || "Unable to load My Account.";
            retry.hidden = false;
        } finally {
            if (requestId === this.accountRequestId) this.accountLoading = false;
        }
    },

    unloadAccountPanel() {
        this.accountRequestId = (this.accountRequestId || 0) + 1;
        this.accountLoading = false;
        this.accountPanel?.webSkelPresenter?.afterUnload?.();
        this.accountPanel?.remove();
        this.accountPanel = null;
        this.accountScope = null;
    },
};
