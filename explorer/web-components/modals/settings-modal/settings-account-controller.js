import { callExplorerTool, parseToolResult } from "../../../services/infrastructure/explorerApi.js";
import { flattenPluginsByKey, getCachedRuntimePlugins } from "./settings-plugin-model.js";
import { ensureSettingsComponentRegistered } from "./settings-component-loader.js";

export const accountController = {
    getAccountScope() {
        if (this.state.activeTab === "account") return "account";
        if (this.state.activeTab === "users" && this.state.usersAccess
            && this.state.activeAdministrationTab === "applications") return "administration";
        return null;
    },

    switchAdministrationTab(_target, tab) {
        if (!this.state.usersAccess || !["users", "applications"].includes(tab)) return;
        this.state.activeAdministrationTab = tab;
        this.updateTabUI();
    },

    updateAdministrationTabs() {
        const selected = this.state.activeAdministrationTab || "users";
        this.usersSection?.querySelectorAll("[data-administration-tab]").forEach((tab) => {
            const active = tab.dataset.administrationTab === selected;
            tab.classList.toggle("active", active);
            tab.setAttribute("aria-selected", String(active));
        });
        this.usersSection?.querySelectorAll("[data-administration-panel]").forEach((panel) => {
            panel.hidden = panel.dataset.administrationPanel !== selected;
        });
    },

    async loadAccountPanel() {
        const scope = this.getAccountScope();
        const section = scope === "account" ? this.accountSection : this.applicationsSection;
        if (!scope || !section || this.accountLoading || this.accountPanel) return;
        this.accountScope = scope;
        const requestId = this.accountRequestId = (this.accountRequestId || 0) + 1;
        const status = section.querySelector('[data-account-status]');
        const retry = section.querySelector('[data-account-retry]');
        const mount = section.querySelector('[data-account-mount]');
        this.accountLoading = true;
        const label = scope === "account" ? "My Account" : "Applications";
        status.textContent = `Loading ${label}…`;
        retry.hidden = true;
        try {
            let plugins = getCachedRuntimePlugins();
            if (!plugins) {
                const payload = await callExplorerTool("collect_ide_plugins", {}, { raw: true, withLoader: false });
                plugins = parseToolResult(payload) || {};
            }
            const item = flattenPluginsByKey(plugins).find((plugin) => plugin.key === "userPersistoAgent/userpersisto-settings");
            if (!item) throw new Error(`${label} is unavailable in this workspace.`);
            const component = await ensureSettingsComponentRegistered(item);
            if (requestId !== this.accountRequestId || this.accountScope !== scope) return;
            const panel = document.createElement(component);
            panel.setAttribute("data-presenter", component);
            panel.setAttribute("data-embedded", "true");
            panel.setAttribute("data-settings-scope", scope);
            panel.setAttribute("data-initial-panel", scope === "account" ? "auth" : "applications");
            this.accountPanel = panel;
            mount.replaceChildren(panel);
            status.textContent = "";
        } catch (error) {
            if (requestId !== this.accountRequestId) return;
            status.textContent = error?.message || `Unable to load ${label}.`;
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
