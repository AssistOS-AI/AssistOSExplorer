function extractToolText(result) {
    if (typeof result === 'string') return result;
    if (Array.isArray(result?.content)) {
        return result.content
            .filter((entry) => entry?.type === 'text')
            .map((entry) => entry.text || '')
            .join('\n');
    }
    return JSON.stringify(result || {});
}

function parseToolResult(result) {
    if (result && typeof result === 'object' && !Array.isArray(result) && !Array.isArray(result.content)) {
        return result;
    }
    const text = extractToolText(result);
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

async function createEmailAgentClient() {
    const module = await import('/Agent/client/AgentMcpClient.mjs');
    return module.createAgentClient('emailAgent');
}

// Query the internal, boolean-only readiness tool before entering a persistence
// scope. A missing, denied, malformed or slow provider is unavailable. Neither
// client acquisition nor shutdown may extend the caller's bounded wait.
export async function getEmailAuthCodeStatus({ createClient = createEmailAgentClient, timeoutMs = 2000 } = {}) {
    const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000 ? timeoutMs : 2000;
    let client;
    let timedOut = false;
    let closed = false;
    let timer;
    const close = () => {
        if (!client || closed) return;
        closed = true;
        void Promise.resolve().then(() => client.close?.()).catch(() => {});
    };
    const operation = (async () => {
        client = await createClient();
        if (timedOut) { close(); return { available: false }; }
        const response = await client.callTool('email_auth_code_status', {});
        const result = parseToolResult(response);
        return { available: response?.isError !== true && !result.error && result.ok !== false && result.available === true };
    })().catch(() => ({ available: false }));
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; close(); resolve({ available: false }); }, deadline);
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        clearTimeout(timer);
        close();
    }
}

export async function sendAuthCode({ to, code, correlationId = '' }, { createClient = createEmailAgentClient } = {}) {
    const client = await createClient();
    try {
        const response = await client.callTool('email_send_auth_code', {
            to,
            code,
            correlationId,
        });
        const result = parseToolResult(response);
        if (response?.isError === true || result?.ok === false || result?.error
            || typeof result.providerMessageId !== 'string' || !result.providerMessageId.trim()) {
            return {
                delivered: false,
                result: result.error || 'email-agent-error',
            };
        }
        return {
            delivered: true,
            providerMessageId: result.providerMessageId || '',
            result,
        };
    } finally {
        await Promise.resolve().then(() => client.close?.()).catch(() => {});
    }
}

export async function sendAuthCodeEmail({ email, code, correlationId = '' }) {
    return sendAuthCode({ to: email, code, correlationId });
}
