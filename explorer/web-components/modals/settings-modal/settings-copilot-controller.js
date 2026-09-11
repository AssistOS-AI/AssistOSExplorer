import {
    callAgentTool,
    ensureSuccess,
    parseToolResult
} from "../../../services/infrastructure/explorerApi.js";

function escapeHtml(value = "") {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function normalizeCopilotContext(context = {}) {
    const robot = String(context?.robot || "default").trim() || "default";
    const sessionId = String(context?.sessionId || "").trim();
    const dir = String(context?.dir || "").trim();
    // RoboTeam resolves a conversation's saved cwd. A browser directory is only a defaults hint.
    return { robot, ...(sessionId ? { sessionId } : (dir ? { dir } : {})) };
}

export function normalizeCopilotSkillItems(items = []) {
    return (Array.isArray(items) ? items : []).map((entry) => ({
        identity: String(entry?.identity || entry?.key || "").trim(),
        name: String(entry?.name || "").trim(),
        description: String(entry?.description || ""),
        sourcePath: String(entry?.sourcePath || ""),
        state: String(entry?.state || "unknown"),
        enabled: entry?.enabled === true,
        diagnostic: String(entry?.diagnostic || entry?.reason || "")
    })).filter((entry) => entry.identity && entry.name)
        .sort((left, right) => left.name.localeCompare(right.name) || left.identity.localeCompare(right.identity));
}

export function createCopilotController(tool = callAgentTool) {
    return {
        getCopilotContext() {
            return normalizeCopilotContext(this.props?.copilotContext);
        },

        invalidateCopilotRequests() {
            this.copilotRequestId = (this.copilotRequestId || 0) + 1;
        },

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
            const context = this.getCopilotContext();
            const scope = context.sessionId ? `Conversation ${context.sessionId}` : `Robot ${context.robot} defaults`;
            const active = this.state.copilotActiveRevision;
            const activeId = typeof active === "string" ? active : (active?.revision || active?.digest || active?.catalogId);
            const revision = context.sessionId
                ? (activeId ? `Active execution revision: ${activeId}` : "No active execution.")
                : "Defaults apply to future conversations. No active conversation is selected.";
            const enabled = this.state.copilotItems.filter((item) => item.enabled).length;
            const summary = `<div class="plugin-settings-description">${escapeHtml(scope)} · Policy version: ${escapeHtml(this.state.copilotPolicyVersion ?? "unavailable")}<br>Workspace inventory: ${this.state.copilotItems.length} · Effective selection: ${enabled}<br>${escapeHtml(revision)}</div>`;
            const diagnostics = (this.state.copilotDiagnostics || []).map((entry) => typeof entry === "string" ? entry : entry.message || entry.reason || JSON.stringify(entry));
            const warnings = diagnostics.length ? `<div class="plugin-settings-description" role="status">${diagnostics.map(escapeHtml).join("<br>")}</div>` : "";
            const rows = this.state.copilotItems.map((item, index) => {
                const disabled = this.state.copilotBusy || !Number.isSafeInteger(this.state.copilotPolicyVersion) || item.state === "invalid";
                return `<div class="plugin-settings-row">
                    <div class="plugin-settings-info">
                        <div class="plugin-settings-key">${escapeHtml(item.name)}</div>
                        <div class="plugin-settings-meta">${escapeHtml(item.identity)} · ${escapeHtml(item.state)}<br>${escapeHtml(item.sourcePath)}${item.diagnostic ? `<br>${escapeHtml(item.diagnostic)}` : ""}</div>
                    </div>
                    <div class="plugin-settings-actions">
                        <button type="button" class="plugin-settings-toggle ${item.enabled ? "enabled" : ""}"
                            data-local-action="toggleCopilotSkill ${index}" aria-pressed="${item.enabled}" ${disabled ? "disabled" : ""}>${item.enabled ? "Enabled" : "Disabled"}</button>
                    </div>
                </div>`;
            }).join("");
            this.copilotSettingsListEl.innerHTML = summary + warnings + (rows || '<div class="plugin-settings-empty">No skills in the current inventory.</div>');
        },

        applyCopilotCatalog(parsed, context) {
            if (!parsed || !Array.isArray(parsed.skills) || parsed.scope !== (context.sessionId ? "conversation" : "defaults")
                || !Number.isSafeInteger(parsed.policyVersion) || parsed.policyVersion < 0) {
                throw new Error("RoboTeam returned an invalid or mismatched skill policy. Refresh before changing settings.");
            }
            const contextKey = JSON.stringify(context);
            if (this.state.copilotCatalogContext === contextKey && parsed.policyVersion < this.state.copilotPolicyVersion) return false;
            this.state.copilotCatalogContext = contextKey;
            this.state.copilotItems = normalizeCopilotSkillItems(parsed.skills);
            this.state.copilotPolicyVersion = parsed.policyVersion;
            this.state.copilotPolicy = parsed.policy;
            this.state.copilotActiveRevision = parsed.activeRevision ?? null;
            this.state.copilotDiagnostics = Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
            this.state.copilotDataLoaded = true;
            this.state.copilotStatus = context.sessionId
                ? "Current selection loaded. Changes apply at the next execution; active work keeps its revision."
                : `Robot ${context.robot} defaults loaded. Changes are saved for future conversations.`;
            this.state.copilotStatusType = "";
            return true;
        },

        async loadCopilotSettingsData() {
            if (this.state.copilotBusy) return;
            const context = this.getCopilotContext();
            const contextKey = JSON.stringify(context);
            this.invalidateCopilotRequests();
            const requestId = this.copilotRequestId;
            this.state.copilotStatus = "Loading Copilot skills...";
            this.state.copilotStatusType = "loading";
            this.renderCopilotSettingsStatus();
            try {
                const payload = await tool("roboTeamAgent", "list_achilles_skills", context, { raw: true });
                if (requestId !== this.copilotRequestId || contextKey !== JSON.stringify(this.getCopilotContext())) return;
                ensureSuccess(payload);
                if (!this.applyCopilotCatalog(parseToolResult(payload), context)) {
                    this.state.copilotStatus = "An older catalog response was ignored. Refresh to load the current selection.";
                    this.state.copilotStatusType = "error";
                }
                this.renderCopilotSettings();
            } catch (error) {
                if (requestId !== this.copilotRequestId || contextKey !== JSON.stringify(this.getCopilotContext())) return;
                this.state.copilotStatus = error?.message || "Failed to load Copilot skills.";
                this.state.copilotStatusType = "error";
                this.renderCopilotSettingsStatus();
            }
        },

        async toggleCopilotSkill(_target, indexValue) {
            const index = Number(indexValue);
            const item = Number.isInteger(index) ? this.state.copilotItems[index] : null;
            const context = this.getCopilotContext();
            const contextKey = JSON.stringify(context);
            if (!item || item.state === "invalid" || this.state.copilotBusy || !Number.isSafeInteger(this.state.copilotPolicyVersion)
                || this.state.copilotCatalogContext !== contextKey) return;
            this.invalidateCopilotRequests();
            const requestId = this.copilotRequestId;
            this.state.copilotBusy = true;
            this.state.copilotStatus = "Saving skill selection...";
            this.state.copilotStatusType = "loading";
            this.renderCopilotSettings();
            try {
                const payload = await tool("roboTeamAgent", "set_achilles_skill_enabled", {
                    ...context, identity: item.identity, enabled: !item.enabled, policyVersion: this.state.copilotPolicyVersion
                }, { raw: true });
                if (requestId !== this.copilotRequestId || contextKey !== JSON.stringify(this.getCopilotContext())) return;
                ensureSuccess(payload);
                if (!this.applyCopilotCatalog(parseToolResult(payload), context)) {
                    throw new Error("An older policy response was ignored. Refresh to see the current selection.");
                }
            } catch (error) {
                if (requestId !== this.copilotRequestId || contextKey !== JSON.stringify(this.getCopilotContext())) return;
                this.state.copilotStatus = `${error?.message || "Failed to save skill selection."} Refresh to load the current policy.`;
                this.state.copilotStatusType = "error";
            } finally {
                this.state.copilotBusy = false;
                if (requestId === this.copilotRequestId && contextKey === JSON.stringify(this.getCopilotContext())) this.renderCopilotSettings();
            }
        }
    };
}

export const copilotController = createCopilotController();
