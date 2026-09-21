import {
    compareRuntimePluginEntries,
    forEachRuntimePluginEntry,
    getRuntimePluginOrder,
    getRuntimePluginPolicyKey
} from "../../../utils/pluginUtils.core.js";

export function normalizeSettingsMap(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }
    const plugins = parsed.plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
        return {};
    }
    return plugins;
}

export function flattenPluginsByKey(pluginBuckets) {
    const items = new Map();
    forEachRuntimePluginEntry(pluginBuckets, (plugin, { category, location }) => {
        const agent = typeof plugin?.agent === "string" && plugin.agent.trim() ? plugin.agent.trim() : "unknown";
        const component = typeof plugin?.component === "string" && plugin.component.trim() ? plugin.component.trim() : "";
        const pluginId = typeof plugin?.id === "string" && plugin.id.trim() ? plugin.id.trim() : "";
        const key = getRuntimePluginPolicyKey(plugin);
        if (!key) return;
        const existing = items.get(key) || {
            key,
            agent,
            component,
            pluginId,
            label: "",
            tooltip: "",
            pluginCategory: category,
            contributionTypes: new Set(),
            locations: [],
            locationOrder: getRuntimePluginOrder(plugin),
            settingsComponent: "",
            settingsUrl: "",
            settingsEmbedded: false,
            settingsEmbeddedFullscreen: false,
            assetRootPath: "",
            componentBaseUrl: "",
            adminOnly: false
        };
        existing.pluginCategory = plugin?.pluginCategory || existing.pluginCategory || category;
        if (plugin?.adminOnly === true) existing.adminOnly = true;
        const contributionType = typeof plugin?.contributionType === "string" && plugin.contributionType.trim()
            ? plugin.contributionType.trim()
            : (category === "application" ? "mount" : "document");
        existing.contributionTypes.add(contributionType);
        existing.locationOrder = Math.min(existing.locationOrder, getRuntimePluginOrder(plugin));
        existing.label = typeof plugin?.label === "string" && plugin.label.trim()
            ? plugin.label.trim()
            : existing.label || pluginId || component;
        existing.tooltip = typeof plugin?.tooltip === "string" && plugin.tooltip.trim()
            ? plugin.tooltip.trim()
            : existing.tooltip || existing.label;
        existing.pluginId = pluginId || existing.pluginId || "";
        existing.component = component || existing.component || "";
        existing.settingsComponent = typeof plugin?.settings === "string" && plugin.settings.trim()
            ? plugin.settings.trim()
            : existing.settingsComponent;
        existing.settingsUrl = typeof plugin?.settingsUrl === "string" && plugin.settingsUrl.trim()
            ? plugin.settingsUrl.trim()
            : existing.settingsUrl;
        if (plugin?.settingsEmbedded === true) {
            existing.settingsEmbedded = true;
        }
        if (plugin?.settingsEmbeddedFullscreen === true) {
            existing.settingsEmbeddedFullscreen = true;
        }
        existing.assetRootPath = typeof plugin?.assetRootPath === "string" && plugin.assetRootPath.trim()
            ? plugin.assetRootPath.trim()
            : existing.assetRootPath;
        existing.componentBaseUrl = typeof plugin?.componentBaseUrl === "string" && plugin.componentBaseUrl.trim()
            ? plugin.componentBaseUrl.trim()
            : existing.componentBaseUrl;
        if (!existing.locations.includes(location)) {
            existing.locations.push(location);
        }
        items.set(key, existing);
    });
    return Array.from(items.values())
        .map((item) => ({
            ...item,
            contributionTypes: Array.from(item.contributionTypes.values()).sort(),
            locations: [...item.locations].sort()
        }))
        .sort((a, b) => compareRuntimePluginEntries(a, b));
}

export function getCachedRuntimePlugins(win = globalThis.window) {
    const assist = typeof win !== "undefined" ? win?.assistOS : null;
    const rawPlugins = assist?.rawRuntimePlugins;
    if (rawPlugins && typeof rawPlugins === "object" && !Array.isArray(rawPlugins)) {
        return rawPlugins;
    }
    const runtimePlugins = assist?.runtimePlugins;
    if (runtimePlugins && typeof runtimePlugins === "object" && !Array.isArray(runtimePlugins)) {
        return runtimePlugins;
    }
    return null;
}

