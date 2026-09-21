function normalizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeMatchKey(value) {
    return normalizeString(value).toLowerCase();
}

export function normalizeAgentRuntimeStatus(agent) {
    if (!agent) return "unavailable";
    if (agent.active === false) return "inactive";
    if (agent.running === true) return "running";
    const status = normalizeMatchKey(agent.status);
    if (status) return status;
    return agent.active === true ? "stopped" : "inactive";
}

export function applyAgentRuntimeStatuses(items = [], agents = []) {
    const runtimeAgents = Array.isArray(agents) ? agents : [];
    return items.map((item) => {
        const ownerAgent = normalizeMatchKey(item?.ownerAgent);
        const exactRef = runtimeAgents.find((agent) => normalizeMatchKey(agent?.ref) === ownerAgent);
        const nameMatches = exactRef
            ? []
            : runtimeAgents.filter((agent) => normalizeMatchKey(agent?.name) === ownerAgent);
        const runtime = exactRef || (nameMatches.length === 1 ? nameMatches[0] : null);
        return {
            ...item,
            agentRef: normalizeString(runtime?.ref),
            runtimeAvailable: Boolean(runtime),
            runtimeStatus: normalizeAgentRuntimeStatus(runtime)
        };
    });
}

export function normalizeAgentSettingsPayload(payload) {
    const settings = Array.isArray(payload) ? payload : [];
    return settings
        .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return null;
            }
            const key = normalizeString(entry.key);
            const label = normalizeString(entry.label);
            const ownerAgent = normalizeString(entry.ownerAgent);
            const pluginKey = normalizeString(entry.pluginKey);
            if (!key || !label || !ownerAgent || !pluginKey) {
                return null;
            }
            return {
                key,
                label,
                ownerAgent,
                pluginKey,
                scope: normalizeString(entry.scope) || "workspace",
                settingsComponent: normalizeString(entry.settingsComponent),
                settingsUrl: normalizeString(entry.settingsUrl),
                adminOnly: entry.adminOnly === true
            };
        })
        .filter(Boolean);
}

export function buildAgentSettingsItems(agentSettings = [], pluginItems = [], { isAdmin = true } = {}) {
    const pluginByKey = new Map(pluginItems.map((item) => [item.key, item]));
    return normalizeAgentSettingsPayload(agentSettings)
        .filter((definition) => isAdmin || !definition.adminOnly)
        .map((definition) => {
            const sourcePlugin = pluginByKey.get(definition.pluginKey) || null;
            const settingsComponent = definition.settingsComponent || sourcePlugin?.settingsComponent || "";
            const settingsUrl = definition.settingsUrl || sourcePlugin?.settingsUrl || "";
            const settingsEmbedded = definition.settingsEmbedded === true || sourcePlugin?.settingsEmbedded === true;
            return {
                ...definition,
                sourcePlugin,
                component: sourcePlugin?.component || "",
                pluginId: sourcePlugin?.pluginId || "",
                available: Boolean(sourcePlugin) && Boolean(settingsUrl || settingsComponent || settingsEmbedded),
                settingsComponent,
                settingsUrl,
                settingsEmbedded,
                settingsEmbeddedFullscreen: definition.settingsEmbeddedFullscreen === true || sourcePlugin?.settingsEmbeddedFullscreen === true,
                assetRootPath: sourcePlugin?.assetRootPath || "",
                componentBaseUrl: sourcePlugin?.componentBaseUrl || "",
                agentRef: "",
                runtimeAvailable: null,
                runtimeStatus: "checking"
            };
        });
}
