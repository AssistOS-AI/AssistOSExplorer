import {
    callExplorerTool,
    parseToolResult
} from "../../../services/infrastructure/explorerApi.js";
import {
    flattenPluginsByKey,
    getCachedRuntimePlugins,
    normalizeSettingsMap
} from "./settings-plugin-model.js";
import {
    applyAgentRuntimeStatuses,
    buildAgentSettingsItems,
    normalizeAgentRuntimeStatus
} from "./settings-agent-model.js";
import {
    ensureSettingsComponentRegistered,
    openPluginSettingsUrl
} from "./settings-component-loader.js";

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function marketplaceAgents(payload) {
    const marketplace = payload?.marketplace || payload;
    return Array.isArray(marketplace?.agents) ? marketplace.agents : [];
}

function runtimeStatusLabel(status) {
    const normalized = String(status || "unknown").trim().toLowerCase() || "unknown";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export const runtimeSettingsController = {
    renderPluginSettings() {
        this.renderPluginSettingsStatus();
        this.renderPluginSettingsList();
    },

    renderAgentSettings() {
        this.renderAgentSettingsStatus();
        this.renderAgentSettingsList();
    },

    renderPluginSettingsStatus() {
        if (!this.pluginSettingsStatusEl) return;
        this.pluginSettingsStatusEl.textContent = this.state.pluginStatus || "";
        this.pluginSettingsStatusEl.classList.toggle("error", this.state.pluginStatusType === "error");
    },

    renderAgentSettingsStatus() {
        if (!this.agentSettingsStatusEl) return;
        this.agentSettingsStatusEl.textContent = this.state.agentSettingsStatus || "";
        this.agentSettingsStatusEl.classList.toggle("error", this.state.agentSettingsStatusType === "error");
    },

    renderPluginSettingsList() {
        if (!this.pluginSettingsListEl) return;
        if (!this.state.pluginItems.length) {
            this.pluginSettingsListEl.innerHTML = `<div class="plugin-settings-empty">No plugins discovered for this workspace.</div>`;
            return;
        }
        const visibleItems = this.state.usersAccess
            ? this.state.pluginItems
            : this.state.pluginItems.filter((item) => !item.adminOnly);
        this.pluginSettingsListEl.innerHTML = visibleItems.map((item) => {
            const enabled = this.isPluginEnabled(item.key);
            const busyToggle = this.state.pluginBusyActionKey === `${item.key}::toggle`;
            const locations = item.locations.filter(Boolean).join(", ") || "(hidden)";
            const contributionTypes = Array.isArray(item.contributionTypes) ? item.contributionTypes.join(", ") : "";
            return `
                <div class="plugin-settings-row">
                    <div class="plugin-settings-info">
                        <div class="plugin-settings-key">${item.label || item.component}</div>
                        <div class="plugin-settings-meta">${item.key} · Category: ${item.pluginCategory} · Types: ${contributionTypes} · Locations: ${locations}</div>
                    </div>
                    <div class="plugin-settings-actions">
                        <button
                            type="button"
                            class="plugin-settings-toggle ${enabled ? "enabled" : ""}"
                            data-local-action="togglePlugin ${item.key}"
                            aria-pressed="${enabled ? "true" : "false"}"
                            ${busyToggle ? "disabled" : ""}
                        >
                            <span class="plugin-settings-switch-track" aria-hidden="true">
                                <span class="plugin-settings-switch-thumb"></span>
                            </span>
                        </button>
                    </div>
                </div>
            `;
        }).join("");
    },

    renderAgentSettingsList() {
        if (!this.agentSettingsListEl) return;
        if (!this.state.agentSettingsItems.length) {
            this.agentSettingsListEl.innerHTML = `<div class="plugin-settings-empty">No configurable agents discovered for this workspace.</div>`;
            return;
        }
        const visibleItems = this.state.usersAccess
            ? this.state.agentSettingsItems
            : this.state.agentSettingsItems.filter((item) => !item.adminOnly);
        if (!visibleItems.length) {
            this.agentSettingsListEl.innerHTML = `<div class="plugin-settings-empty">No configurable agents are available for your account.</div>`;
            return;
        }
        this.agentSettingsListEl.innerHTML = visibleItems.map((item) => {
            const busy = this.state.agentSettingsBusyKey === item.key;
            const runtimeStatus = item.available ? (item.runtimeStatus || "checking") : "unavailable";
            const buttonLabel = busy
                ? (runtimeStatus === "starting" ? "Starting..." : "Opening...")
                : "Configure";
            return `
                <div class="plugin-settings-row">
                    <div class="plugin-settings-info">
                        <div class="plugin-settings-key">${escapeHtml(item.label)}</div>
                        <div class="plugin-settings-meta">
                            ${escapeHtml(item.key)} · Package: ${escapeHtml(item.ownerAgent)}${item.component ? ` · Plugin: ${escapeHtml(item.component)}` : ''} · Scope: ${escapeHtml(item.scope)}
                            · <span class="agent-settings-runtime-status ${escapeHtml(runtimeStatus)}">${escapeHtml(runtimeStatusLabel(runtimeStatus))}</span>
                        </div>
                    </div>
                    <div class="plugin-settings-actions">
                        <button
                            type="button"
                            class="plugin-settings-open"
                            data-local-action="openAgentSettings ${escapeHtml(item.key)}"
                            ${busy || !item.available ? "disabled" : ""}
                        >
                            ${busy ? '<span class="plugin-settings-inline-spinner" aria-hidden="true"></span>' : ''}
                            <span>${buttonLabel}</span>
                        </button>
                    </div>
                </div>
            `;
        }).join("");
    },

    isPluginEnabled(key) {
        const entry = this.state.pluginSettings[key];
        if (!entry || typeof entry !== "object") {
            return true;
        }
        return entry.enabled !== false;
    },

    async loadPluginSettingsData() {
        this.state.pluginStatus = "Loading plugins...";
        this.state.pluginStatusType = "";
        this.renderPluginSettingsStatus();
        try {
            let pluginsByLocation = getCachedRuntimePlugins();
            if (!pluginsByLocation) {
                const pluginsPayload = await callExplorerTool("collect_ide_plugins", {}, { raw: true, withLoader: false });
                pluginsByLocation = parseToolResult(pluginsPayload) || {};
            }
            const settingsPayload = await callExplorerTool("get_plugin_settings", {}, { raw: true, withLoader: false });
            const settings = normalizeSettingsMap(parseToolResult(settingsPayload));
            this.state.agentSettingsRaw = Array.isArray(pluginsByLocation?.agentSettings)
                ? pluginsByLocation.agentSettings
                : [];
            this.state.pluginItems = flattenPluginsByKey(pluginsByLocation);
            this.state.agentSettingsItems = buildAgentSettingsItems(this.state.agentSettingsRaw, this.state.pluginItems);
            this.state.pluginSettings = settings;
            this.state.pluginDataLoaded = true;
            if (window.assistOS) {
                window.assistOS.pluginSettings = settings;
            }
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("assistos:plugin-settings-updated", {
                    detail: { settings: this.state.pluginSettings }
                }));
            }
            this.state.pluginStatus = this.state.pluginItems.length
                ? `${this.state.pluginItems.length} plugins loaded.`
                : "No plugins discovered.";
            this.state.pluginStatusType = "";
            this.renderPluginSettings();
        } catch (error) {
            this.state.pluginStatus = error?.message || "Failed to load plugin settings.";
            this.state.pluginStatusType = "error";
            this.renderPluginSettingsStatus();
        }
    },

    async loadAgentSettingsData() {
        this.state.agentSettingsStatus = "Loading agent settings...";
        this.state.agentSettingsStatusType = "";
        this.renderAgentSettingsStatus();
        if (!this.state.pluginDataLoaded) {
            await this.loadPluginSettingsData();
        } else {
            this.state.agentSettingsItems = buildAgentSettingsItems(this.state.agentSettingsRaw, this.state.pluginItems);
        }
        this.state.agentSettingsDataLoaded = true;
        this.state.agentSettingsStatus = this.state.agentSettingsItems.length
            ? `${this.state.agentSettingsItems.length} agent settings entries loaded.`
            : "No configurable agents discovered.";
        this.state.agentSettingsStatusType = "";
        this.renderAgentSettings();
        void this.refreshAgentRuntimeStatuses();
    },

    async refreshAgentRuntimeStatuses() {
        const requestId = ++this.state.agentRuntimeStatusRequestId;
        try {
            const response = await fetch("/api/marketplace", {
                credentials: "same-origin",
                headers: { accept: "application/json" },
                cache: "no-store"
            });
            if (!response.ok) {
                throw new Error(`Unable to load agent runtime status (${response.status}).`);
            }
            const payload = await response.json();
            if (requestId !== this.state.agentRuntimeStatusRequestId) return;
            this.state.agentSettingsItems = applyAgentRuntimeStatuses(
                this.state.agentSettingsItems,
                marketplaceAgents(payload)
            );
            this.renderAgentSettingsList();
        } catch (_) {
            if (requestId !== this.state.agentRuntimeStatusRequestId) return;
            this.state.agentSettingsItems = this.state.agentSettingsItems.map((item) => ({
                ...item,
                runtimeAvailable: null,
                runtimeStatus: "unknown"
            }));
            this.renderAgentSettingsList();
        }
    },

    async togglePlugin(_target, key) {
        if (!key) return;
        const nextEnabled = !this.isPluginEnabled(key);
        this.state.pluginBusyActionKey = `${key}::toggle`;
        this.state.pluginStatus = `Saving ${key}...`;
        this.state.pluginStatusType = "";
        this.renderPluginSettings();
        try {
            const payload = await callExplorerTool("set_plugin_enabled", {
                key,
                enabled: nextEnabled
            }, { raw: true, withLoader: false });
            const parsed = parseToolResult(payload) || {};
            this.state.pluginSettings = normalizeSettingsMap(parsed.settings || { plugins: this.state.pluginSettings });
            if (window.assistOS) {
                window.assistOS.pluginSettings = this.state.pluginSettings;
            }
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("assistos:plugin-settings-updated", {
                    detail: { settings: this.state.pluginSettings }
                }));
            }
            this.state.pluginStatus = `${key} ${nextEnabled ? "enabled" : "disabled"} in workspace settings.`;
            this.state.pluginStatusType = "";
        } catch (error) {
            this.state.pluginStatus = error?.message || `Failed to update ${key}.`;
            this.state.pluginStatusType = "error";
        } finally {
            this.state.pluginBusyActionKey = "";
            this.renderPluginSettings();
        }
    },

    async openAgentSettings(_target, key) {
        if (!key) return;
        const item = this.state.agentSettingsItems.find((entry) => entry?.key === key);
        if (!item || !item.available || !item.sourcePlugin || (!item.settingsUrl && !item.settingsComponent)) {
            return;
        }

        this.state.agentSettingsBusyKey = key;
        this.state.agentRuntimeStatusRequestId += 1;
        item.runtimeStatus = item.runtimeStatus === "running" ? "running" : "starting";
        this.state.agentSettingsStatus = item.runtimeStatus === "starting"
            ? `Starting ${item.label || item.ownerAgent}...`
            : `Opening settings for ${key}...`;
        this.state.agentSettingsStatusType = "";
        this.renderAgentSettings();

        try {
            const module = await import("/MCPBrowserClient.js");
            if (typeof module?.ensureAgentRunning !== "function") {
                throw new Error("Agent runtime lifecycle is unavailable.");
            }
            const runtime = await module.ensureAgentRunning(item.agentRef || item.ownerAgent);
            item.agentRef = String(runtime?.ref || item.agentRef || "").trim();
            item.runtimeAvailable = true;
            item.runtimeStatus = normalizeAgentRuntimeStatus(runtime);
            this.state.agentSettingsStatus = `Opening settings for ${key}...`;
            this.renderAgentSettings();

            if (item.settingsUrl) {
                if (!openPluginSettingsUrl(item)) {
                    throw new Error(`Invalid settings URL for ${key}.`);
                }
                this.state.agentSettingsStatus = `${item.label || item.component} settings opened.`;
                this.state.agentSettingsStatusType = "";
                return;
            }

            await ensureSettingsComponentRegistered({
                ...item.sourcePlugin,
                settingsComponent: item.settingsComponent
            });
            await assistOS.UI.createReactiveModal(item.settingsComponent, {
                agentSettings: {
                    key: item.key,
                    label: item.label,
                    ownerAgent: item.ownerAgent,
                    scope: item.scope,
                    settingsComponent: item.settingsComponent,
                    settingsUrl: item.settingsUrl,
                    assetRootPath: item.assetRootPath
                }
            }, true);
            this.state.agentSettingsStatus = `${item.label} settings opened.`;
            this.state.agentSettingsStatusType = "";
        } catch (error) {
            item.runtimeStatus = "failed";
            this.state.agentSettingsStatus = error?.message || `Failed to open settings for ${key}.`;
            this.state.agentSettingsStatusType = "error";
        } finally {
            this.state.agentSettingsBusyKey = "";
            this.renderAgentSettings();
        }
    }
};
