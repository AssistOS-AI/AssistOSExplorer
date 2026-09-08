import {
    callAgentTool,
    parseToolResult
} from "../../../services/infrastructure/explorerApi.js";

export function normalizeCopilotSkillItems(items = []) {
    return (Array.isArray(items) ? items : [])
        .map((entry) => ({
            key: String(entry?.key || "").trim().toLowerCase(),
            name: String(entry?.name || "").trim(),
            type: String(entry?.type || "").trim(),
            isInternal: Boolean(entry?.isInternal)
        }))
        .filter((entry) => entry.key && entry.name)
        .sort((left, right) => left.name.localeCompare(right.name));
}

export const copilotController = {
    renderCopilotSettings() {
        this.renderCopilotSettingsStatus();
        this.renderCopilotSettingsList();
    },

    renderCopilotSettingsStatus() {
        if (!this.copilotSettingsStatusEl) return;
        const status = this.state.copilotStatus || "";
        const isLoading = this.state.copilotStatusType === "loading";
        this.copilotSettingsStatusEl.replaceChildren();
        this.copilotSettingsStatusEl.classList.toggle("loading", isLoading);
        this.copilotSettingsStatusEl.classList.toggle("error", this.state.copilotStatusType === "error");
        if (isLoading) {
            const spinner = document.createElement("span");
            spinner.className = "plugin-settings-inline-spinner";
            spinner.setAttribute("aria-hidden", "true");
            const label = document.createElement("span");
            label.textContent = status;
            this.copilotSettingsStatusEl.append(spinner, label);
            return;
        }
        this.copilotSettingsStatusEl.textContent = status;
    },

    renderCopilotSettingsList() {
        if (!this.copilotSettingsListEl) return;
        if (!this.state.copilotItems.length) {
            this.copilotSettingsListEl.innerHTML = `<div class="plugin-settings-empty">No Copilot skills discovered for this workspace.</div>`;
            return;
        }
        this.copilotSettingsListEl.innerHTML = this.state.copilotItems.map((item) => {
            const enabled = !this.state.copilotDisabledKeys.has(item.key);
            return `
                <div class="plugin-settings-row">
                    <div class="plugin-settings-info">
                        <div class="plugin-settings-key">${item.name}</div>
                        <div class="plugin-settings-meta">${item.key} · Type: ${item.type || 'unknown'}${item.isInternal ? ' · Internal' : ''}</div>
                    </div>
                    <div class="plugin-settings-actions">
                        <button
                            type="button"
                            class="plugin-settings-toggle ${enabled ? "enabled" : ""}"
                            data-local-action="toggleCopilotSkill ${item.key}"
                        >
                            ${enabled ? "Enabled" : "Disabled"}
                        </button>
                    </div>
                </div>
            `;
        }).join("");
    },

    async loadCopilotSettingsData() {
        this.state.copilotStatus = "Loading Copilot skills...";
        this.state.copilotStatusType = "loading";
        this.renderCopilotSettingsStatus();
        try {
            const payload = await callAgentTool("roboTeamAgent", "list_achilles_skills", { robot: "default" }, { raw: true });
            const parsed = parseToolResult(payload) || {};
            this.state.copilotItems = normalizeCopilotSkillItems(parsed.skills);
            this.state.copilotDisabledKeys = new Set();
            this.state.copilotDataLoaded = true;
            this.state.copilotStatus = this.state.copilotItems.length
                ? `${this.state.copilotItems.length} skills loaded. Toggle state is local only.`
                : "No Copilot skills discovered.";
            this.state.copilotStatusType = "";
            this.renderCopilotSettings();
        } catch (error) {
            this.state.copilotStatus = error?.message || "Failed to load Copilot skills.";
            this.state.copilotStatusType = "error";
            this.renderCopilotSettingsStatus();
        }
    },

    toggleCopilotSkill(_target, key) {
        const normalizedKey = String(key || "").trim().toLowerCase();
        if (!normalizedKey) return;
        this.state.copilotDisabledKeys = toggleCopilotDisabledKey(this.state.copilotDisabledKeys, normalizedKey);
        this.state.copilotStatus = "Toggle state is local only and is not saved.";
        this.state.copilotStatusType = "";
        this.renderCopilotSettings();
    }
};

export function toggleCopilotDisabledKey(disabledKeys, key) {
    const normalizedKey = String(key || "").trim().toLowerCase();
    if (!normalizedKey) {
        return disabledKeys instanceof Set ? disabledKeys : new Set();
    }
    const next = disabledKeys instanceof Set ? new Set(disabledKeys) : new Set();
    if (next.has(normalizedKey)) {
        next.delete(normalizedKey);
    } else {
        next.add(normalizedKey);
    }
    return next;
}
