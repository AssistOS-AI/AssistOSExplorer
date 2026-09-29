const DEFAULT_TIMEOUT_MS = 450000;

const GENERATED_LOCAL_ROUTER_FIELDS = new Set([
    'PLOINKY_ROUTER_DESCRIPTOR_FILE',
    'PLOINKY_ROUTER_URL',
    'PLOINKY_ROUTER_HOST',
    'PLOINKY_ROUTER_PORT',
    'PLOINKY_ROUTER_REQUEST_AUTHORITY',
    'PLOINKY_ROUTER_AUTHORITY',
    'PLOINKY_INTERNAL_ROUTER_URL',
    'PLOINKY_EDGE_TOPOLOGY_FILE',
    'PLOINKY_ROUTER_LISTENER_CLASS',
    'PLOINKY_ROUTER_ATTESTATION_ID',
    'PLOINKY_ROUTER_TRANSPORT_VERSION',
    'PLOINKY_ROUTER_LOCAL_STREAMING',
    'PLOINKY_AGENT_API_PUBLIC_KEY',
    'PLOINKY_AGENT_API_KEY',
]);

function assertNoGeneratedLocalCredentialedFallback(env) {
    const names = Object.keys(env || {});
    if (names.some((name) => GENERATED_LOCAL_ROUTER_FIELDS.has(name)
        || name.startsWith('PLOINKY_ENV_SOURCE_PLOINKY_'))) {
        const error = new Error(
            'Generated-local Agent MCP invocation requires the certified descriptor authority transport; raw Router URL fallback is disabled.',
        );
        error.code = 'PLOINKY_AGENT_MCP_LOCAL_TRANSPORT_NOT_CERTIFIED';
        throw error;
    }
}

function resolveRouterUrl(env = process.env) {
    const explicit = String(env.PLOINKY_ROUTER_URL || '').trim();
    if (explicit) {
        return explicit.replace(/\/+$/, '');
    }
    const host = String(env.PLOINKY_ROUTER_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const port = String(env.PLOINKY_ROUTER_PORT || '8080').trim() || '8080';
    return `http://${host}:${port}`;
}

export async function callAgentTool(agent, toolName, input = {}, options = {}) {
    const env = options.env || process.env;
    assertNoGeneratedLocalCredentialedFallback(env);
    const base = resolveRouterUrl(env);
    const url = new URL(`/${encodeURIComponent(agent)}/mcp`, base);
    const payload = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: input || {} },
    };
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
    };
    if (options.invocationToken) {
        headers['x-ploinky-caller-jwt'] = options.invocationToken;
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (options.signal) {
        if (options.signal.aborted) {
            controller.abort();
        } else {
            options.signal.addEventListener('abort', abortFromCaller, { once: true });
        }
    }
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const text = await response.text();
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new Error(`invalid MCP response: ${error.message}`);
        }
        if (!response.ok || parsed?.error) {
            const message = parsed?.error?.message || parsed?.error?.detail || `router responded ${response.status}`;
            throw new Error(message);
        }
        return parsed;
    } finally {
        clearTimeout(timer);
        if (options.signal) {
            options.signal.removeEventListener('abort', abortFromCaller);
        }
    }
}

export function extractToolText(response) {
    const result = response && response.result ? response.result : response;
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content)) {
        return result.content
            .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
            .map((entry) => entry.text)
            .join('\n');
    }
    if (result && typeof result.text === 'string') return result.text;
    return '';
}

export function extractToolJson(response) {
    const text = extractToolText(response).trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        if (/^MCP error\b/i.test(text)) {
            throw new Error(text);
        }
        throw new Error(`invalid JSON tool response: ${error.message}`);
    }
}
