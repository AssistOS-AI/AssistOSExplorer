const STARTING_RETRY_INTERVAL_MS = 1000;
const DEFAULT_STARTING_TIMEOUT_MS = 180000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAgentStillStarting(error) {
    return /agent\s+['"][^'"\r\n]+['"]\s+is still starting(?:\.|\s|$)/i.test(
        String(error?.message || error || '')
    );
}

export async function ensureAgentsRunning(client, agentRefs, invocation = {}) {
    const ensure = typeof invocation.ensureAgentRunning === 'function'
        ? invocation.ensureAgentRunning
        : typeof client?.ensureAgentRunning === 'function'
            ? client.ensureAgentRunning.bind(client)
            : null;
    if (!ensure) return;

    for (const agentRef of agentRefs) {
        await ensure(agentRef, {
            mode: 'global',
            timeoutMs: DEFAULT_STARTING_TIMEOUT_MS,
        });
    }
}

export async function callToolWhenReady(call, { timeoutMs = DEFAULT_STARTING_TIMEOUT_MS } = {}) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_STARTING_TIMEOUT_MS);
    while (true) {
        try {
            return await call();
        } catch (error) {
            if (!isAgentStillStarting(error) || Date.now() >= deadline) throw error;
            await sleep(STARTING_RETRY_INTERVAL_MS);
        }
    }
}

export const __testables = {
    isAgentStillStarting,
};
