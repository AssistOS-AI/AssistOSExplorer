const EXPLORER_WAIT_ROUTE = '/explorer/index.html#agent-runtime-wait';

function normalizeAgentRef(value) {
    const agentRef = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(agentRef)) {
        throw new Error('The agent runtime identity is invalid.');
    }
    return agentRef;
}

function normalizeLabel(value) {
    const label = String(value || '').trim();
    if (!label || label.length > 80) {
        throw new Error('The agent runtime label is invalid.');
    }
    return label;
}

export function resolveAgentRuntimeTarget({ agentRef, target }, origin = window.location.origin) {
    const normalizedAgentRef = normalizeAgentRef(agentRef);
    const agentName = normalizedAgentRef.split('/')[1];
    const targetUrl = new URL(String(target || ''), origin);
    const servicePrefix = `/base-agent-additional-server/${agentName}/`;
    const serviceSuffix = targetUrl.pathname.startsWith(servicePrefix)
        ? targetUrl.pathname.slice(servicePrefix.length) : '';
    const servicePort = serviceSuffix.match(/^([1-9][0-9]{0,4})\//)?.[1];
    const isAgentService = servicePort !== undefined && Number(servicePort) <= 65535;
    if (
        targetUrl.origin !== origin
        || targetUrl.username
        || targetUrl.password
        || targetUrl.hash
        || (!targetUrl.pathname.startsWith(`/${agentName}/`) && !isAgentService)
    ) {
        throw new Error('The agent runtime target is invalid.');
    }
    return targetUrl;
}

export function buildAgentRuntimeWaitUrl({ agentRef, label, targetUrl }, origin = window.location.origin) {
    const normalizedAgentRef = normalizeAgentRef(agentRef);
    const normalizedLabel = normalizeLabel(label);
    const resolvedTarget = resolveAgentRuntimeTarget({ agentRef: normalizedAgentRef, target: targetUrl }, origin);
    const parameters = new URLSearchParams({
        agentRef: normalizedAgentRef,
        label: normalizedLabel,
        target: `${resolvedTarget.pathname}${resolvedTarget.search}`
    });
    return new URL(`${EXPLORER_WAIT_ROUTE}?${parameters.toString()}`, origin);
}

export function parseAgentRuntimeWaitRoute(hashValue, origin = window.location.origin) {
    const hash = String(hashValue || '');
    const prefix = '#agent-runtime-wait?';
    if (!hash.startsWith(prefix)) {
        throw new Error('The agent runtime wait route is invalid.');
    }
    const parameters = new URLSearchParams(hash.slice(prefix.length));
    const agentRef = normalizeAgentRef(parameters.get('agentRef'));
    const label = normalizeLabel(parameters.get('label'));
    const targetUrl = resolveAgentRuntimeTarget({ agentRef, target: parameters.get('target') }, origin);
    return Object.freeze({ agentRef, label, targetUrl });
}

export async function probeAgentRuntimeTarget(targetUrl, fetchImpl = fetch) {
    const response = await fetchImpl(targetUrl.toString(), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'text/html' }
    });
    if (!response.ok) {
        const error = new Error(`The agent route is unavailable (${response.status}).`);
        error.status = response.status;
        if (response.status === 404) error.code = 'agent_not_ready';
        throw error;
    }
    if (response.redirected && new URL(response.url).pathname !== targetUrl.pathname) {
        const error = new Error('The agent route requires a different session.');
        error.status = 401;
        throw error;
    }
    await response.body?.cancel?.();
    return targetUrl;
}

export async function probeAgentRuntimeMcp(agentRef, sdk) {
    const normalizedAgentRef = normalizeAgentRef(agentRef);
    const agentName = normalizedAgentRef.split('/')[1];
    if (!sdk?.getClient) {
        throw new Error('The Explorer agent client is unavailable.');
    }
    try {
        await sdk.getClient(agentName).listTools();
    } catch (cause) {
        const status = Number(cause?.status || cause?.statusCode || 0);
        if ([400, 401, 403, 422].includes(status)) throw cause;
        const detail = String(cause?.message || '').trim();
        const error = new Error(detail
            ? `The agent control plane is not ready: ${detail}`
            : 'The agent control plane is not ready.');
        error.code = 'agent_not_ready';
        error.cause = cause;
        throw error;
    }
    return agentName;
}

async function readAgentRouteGeneration(agentRef, { fetchImpl, origin }) {
    const normalizedAgentRef = normalizeAgentRef(agentRef);
    const agentName = normalizedAgentRef.split('/')[1];
    const proofUrl = new URL(`/${agentName}/`, origin);
    const response = await fetchImpl(proofUrl.toString(), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { accept: 'application/json', 'X-Ploinky-Agent-Startup-Probe': '1' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(String(payload?.error || `The route generation is unavailable (${response.status}).`));
        error.status = response.status;
        if (![400, 401, 403, 422].includes(response.status)) error.code = 'agent_not_ready';
        throw error;
    }
    if (
        response.status !== 200
        || response.redirected
        || payload?.state !== 'ready'
        || typeof payload.generation !== 'string'
        || !payload.generation
    ) {
        const error = new Error('The agent route generation is not ready.');
        error.code = 'agent_not_ready';
        throw error;
    }
    return payload.generation;
}

export async function probeAgentRuntimeRouteStability(agentRef, {
    fetchImpl = fetch,
    origin = window.location.origin,
    settleMs = 2500,
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
} = {}) {
    const firstGeneration = await readAgentRouteGeneration(agentRef, { fetchImpl, origin });
    await wait(Math.max(0, Number(settleMs) || 0));
    const secondGeneration = await readAgentRouteGeneration(agentRef, { fetchImpl, origin });
    if (firstGeneration !== secondGeneration) {
        const error = new Error('The agent routes are still being updated.');
        error.code = 'agent_not_ready';
        throw error;
    }
    return secondGeneration;
}
