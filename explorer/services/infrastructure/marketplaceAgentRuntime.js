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

// How long a panel waits for an enabled agent that is still starting, for example a no-wait dependency right after
// `ploinky restart`, before it gives up without touching it.
const STARTING_WAIT_MS = 90_000;
const STARTING_POLL_MS = 2_000;

function pause(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
}

export async function ensureMarketplaceAgentRunning(agentRef, { signal, startingWaitMs = STARTING_WAIT_MS, startingPollMs = STARTING_POLL_MS } = {}) {
    const marketplace = await fetchMarketplaceSnapshot(signal);
    signal?.throwIfAborted();
    const agents = Array.isArray(marketplace?.agents) ? marketplace.agents : [];
    let match = findAgent(agents, agentRef);
    if (match?.running === true) {
        return match;
    }

    // An enabled agent that is still starting is waited for and never enabled again. Enabling it again would replace
    // its registry record while it starts, which fails its startup and loses the mode it was enabled in (an agent
    // declared global would come back isolated, without the workspace).
    const deadline = Date.now() + startingWaitMs;
    while (match?.active === true && match.status === "starting" && Date.now() < deadline) {
        await pause(startingPollMs, signal);
        const refreshed = await fetchMarketplaceSnapshot(signal);
        signal?.throwIfAborted();
        match = findAgent(Array.isArray(refreshed?.agents) ? refreshed.agents : [], match.ref) || match;
        if (match.running === true) return match;
    }
    if (match?.active === true && match.status === "starting") {
        return match;
    }

    // A stopped or failed agent that is enabled restarts in the mode it is enabled in, never in the manifest default.
    const activation = await activateMarketplaceAgent({
        action: "enable_agent",
        agentRef: match?.ref || String(agentRef || "").trim(),
        ...(match?.active === true && match.enableMode ? { mode: match.enableMode } : {})
    }, { signal });
    signal?.throwIfAborted();
    const updated = activation.marketplace || await fetchMarketplaceSnapshot(signal);
    const updatedAgents = Array.isArray(updated?.agents) ? updated.agents : [];
    return findAgent(updatedAgents, match?.ref || agentRef) || match || null;
}
