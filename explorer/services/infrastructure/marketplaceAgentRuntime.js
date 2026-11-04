import { activateMarketplaceAgent } from "./marketplaceActivation.mjs";

async function fetchMarketplaceSnapshot(signal) {
    const response = await fetch("/api/marketplace/agents", {
        signal,
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
        throw new Error(data?.message || data?.error || `Marketplace request failed (${response.status})`);
    }
    return data.marketplace || data;
}

function findAgent(agents, agentRef) {
    const ref = String(agentRef || "").trim();
    if (!ref) return null;
    const exact = agents.find((agent) => String(agent?.ref || "") === ref);
    if (exact) return exact;
    if (!ref.includes("/")) {
        const matches = agents.filter((agent) => String(agent?.name || "") === ref);
        if (matches.length === 1) return matches[0];
    }
    return null;
}

export async function ensureMarketplaceAgentRunning(agentRef, { signal } = {}) {
    const marketplace = await fetchMarketplaceSnapshot(signal);
    signal?.throwIfAborted();
    const agents = Array.isArray(marketplace?.agents) ? marketplace.agents : [];
    const match = findAgent(agents, agentRef);
    if (match?.running === true) {
        return match;
    }

    const activation = await activateMarketplaceAgent({
        action: "enable_agent",
        agentRef: match?.ref || String(agentRef || "").trim()
    }, { signal });
    signal?.throwIfAborted();
    const updated = activation.marketplace || await fetchMarketplaceSnapshot(signal);
    const updatedAgents = Array.isArray(updated?.agents) ? updated.agents : [];
    return findAgent(updatedAgents, match?.ref || agentRef) || match || null;
}
