import {
    ensureSettingsComponentRegistered,
    openPluginSettingsUrl
} from "./settings-component-loader.js";

export async function ensureAgentRunning(agentRef) {
    const ref = String(agentRef || "").trim();
    if (!ref) {
        throw new Error("Agent settings entry is missing an owner agent.");
    }
    const module = await import("/MCPBrowserClient.js");
    if (typeof module?.ensureAgentRunning !== "function") {
        throw new Error("Agent runtime lifecycle is unavailable.");
    }
    return module.ensureAgentRunning(ref);
}

export async function launchAgentSettings(item, {
    ensureRunning = ensureAgentRunning,
    openSettingsUrl = openPluginSettingsUrl,
    registerSettingsComponent = ensureSettingsComponentRegistered
} = {}) {
    if (!item || typeof item !== "object") {
        throw new Error("Agent settings entry is unavailable.");
    }
    const key = String(item.key || item.ownerAgent || "").trim();

    const runtime = await ensureRunning(item.agentRef || item.ownerAgent);

    if (item.settingsUrl) {
        if (!openSettingsUrl(item)) {
            throw new Error(`Invalid settings URL for ${key}.`);
        }
        return runtime;
    }

    if (!item.settingsComponent) {
        throw new Error(`Agent settings for ${key} has no settings target.`);
    }

    await registerSettingsComponent({
        ...(item.sourcePlugin || {}),
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
    return runtime;
}
