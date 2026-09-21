import { callExplorerTool, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";
import { flattenPluginsByKey, getCachedRuntimePlugins } from "/explorer/web-components/modals/settings-modal/settings-plugin-model.js";
import { buildAgentSettingsItems } from "/explorer/web-components/modals/settings-modal/settings-agent-model.js";
import { launchAgentSettings } from "/explorer/web-components/modals/settings-modal/settings-agent-launcher.js";

const SOUL_GATEWAY_SETTINGS_KEY = "soul-gateway";

async function resolveSoulGatewaySettingsItem() {
    let pluginsByLocation = getCachedRuntimePlugins();
    if (!Array.isArray(pluginsByLocation?.agentSettings) || !pluginsByLocation.agentSettings.length) {
        const payload = await callExplorerTool("collect_ide_plugins", {}, { raw: true, withLoader: false });
        pluginsByLocation = parseToolResult(payload) || {};
    }
    const agentSettingsRaw = Array.isArray(pluginsByLocation?.agentSettings) ? pluginsByLocation.agentSettings : [];
    const pluginItems = flattenPluginsByKey(pluginsByLocation);
    const items = buildAgentSettingsItems(agentSettingsRaw, pluginItems);
    return items.find((entry) => entry.key === SOUL_GATEWAY_SETTINGS_KEY) || null;
}

export class SoulGatewayToolButton {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = {};
        this.busy = false;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.button = this.element.querySelector("#soulGatewayToolButton");
        this.iconImageEl = this.element.querySelector(".soul-gateway-tool-button-icon-image");
        this.labelEl = this.element.querySelector(".soul-gateway-tool-button-label");
        this.button?.addEventListener("click", this.openSettings);
        this.syncButtonMetadata();
        if (this.button) {
            this.button.hidden = false;
        }
    }

    afterUnload() {
        this.button?.removeEventListener("click", this.openSettings);
    }

    updateHostContext(context = {}) {
        this.hostContext = context;
        this.syncButtonMetadata();
    }

    syncButtonMetadata() {
        const label = typeof this.hostContext?.pluginLabel === "string" && this.hostContext.pluginLabel.trim()
            ? this.hostContext.pluginLabel.trim()
            : this.element.getAttribute("data-plugin-label") || "Soul Gateway";
        const tooltip = typeof this.hostContext?.pluginTooltip === "string" && this.hostContext.pluginTooltip.trim()
            ? this.hostContext.pluginTooltip.trim()
            : this.element.getAttribute("data-plugin-tooltip") || label;
        const icon = typeof this.hostContext?.pluginIcon === "string" && this.hostContext.pluginIcon.trim()
            ? this.hostContext.pluginIcon.trim()
            : this.element.getAttribute("data-plugin-icon") || "";

        if (this.labelEl) this.labelEl.textContent = label;
        if (this.iconImageEl && icon) this.iconImageEl.src = icon;
        if (this.button) {
            this.button.title = tooltip;
            this.button.setAttribute("aria-label", tooltip);
        }
    }

    setBusy(busy) {
        this.busy = busy;
        if (!this.button) return;
        this.button.disabled = busy;
        this.button.classList.toggle("is-busy", busy);
        this.button.setAttribute("aria-busy", busy ? "true" : "false");
    }

    openSettings = async (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (this.busy) return;
        this.setBusy(true);
        try {
            const item = await resolveSoulGatewaySettingsItem();
            if (!item || !item.available) {
                throw new Error("Soul Gateway settings are unavailable.");
            }
            await launchAgentSettings(item);
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || "Soul Gateway settings could not be opened.", "error", 4000);
        } finally {
            this.setBusy(false);
            this.button?.focus?.();
        }
    };
}
