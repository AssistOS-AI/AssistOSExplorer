import path from 'node:path';

import { getTask, setTaskModel } from './workspaceTasks.mjs';

const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const LOGIN_OPERATIONS = new Set([
    'login_describe',
    'login_start',
    'login_status',
    'login_respond',
    'login_cancel',
]);

function assertControllableTask(dir, taskId) {
    const task = getTask(dir, taskId);
    if (!task) throw new Error('task_not_found');
    if (!TERMINAL_STATUSES.has(task.status)) throw new Error('task_not_terminal');
    if (!task.continuation?.handle) throw new Error('task_not_continuable');
    if (!task.targetAgent) throw new Error('task_agent_missing');
    return task;
}

function normalizeModels(response) {
    const data = Array.isArray(response?.data) ? response.data : [];
    return data.map((raw) => {
        const key = String(raw?.id || '').trim();
        const model = String(raw?.execution?.model || raw?.modelId || raw?.id || '').trim();
        const provider = String(raw?.execution?.provider || '').trim();
        if (!key || !model) return null;
        return {
            key,
            model,
            ...(provider ? { provider } : {}),
            label: String(raw?.displayName || raw?.name || key),
            description: [
                provider,
                Number.isFinite(Number(raw?.contextWindow)) ? `${Number(raw.contextWindow).toLocaleString()} context` : '',
            ].filter(Boolean).join(' · '),
        };
    }).filter(Boolean);
}

function parseToolJson(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text;
    if (!text) return result && typeof result === 'object' ? result : {};
    return JSON.parse(text);
}

function normalizeProviderInputs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const entries = Object.entries(raw);
    if (entries.length > 20) throw new Error('too_many_provider_inputs');
    const normalized = {};
    for (const [rawKey, rawValue] of entries) {
        const key = String(rawKey || '').trim();
        const value = String(rawValue ?? '');
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new Error('invalid_provider_input_key');
        if (value.length > 4000) throw new Error('provider_input_too_long');
        normalized[key] = value;
    }
    return normalized;
}

export async function controlTaskSession(input, {
    clientModule = null,
    getTaskImpl = assertControllableTask,
    setTaskModelImpl = setTaskModel,
} = {}) {
    const dir = path.resolve(String(input?.dir || '').trim());
    const taskId = String(input?.taskId || '').trim();
    const operation = String(input?.operation || '').trim();
    if (!input?.dir || !taskId || !operation) throw new Error('dir, taskId and operation are required');
    const task = getTaskImpl(dir, taskId);
    const modelOperation = operation === 'list_models' || operation === 'set_model';
    if (!modelOperation && !LOGIN_OPERATIONS.has(operation)) {
        throw new Error('unsupported_task_control_operation');
    }
    const agents = clientModule || await import('/Agent/client/AgentMcpClient.mjs');
    const client = await agents.createAgentClient(task.targetAgent);
    await client.ensureAgentRunning(task.targetAgent, { mode: 'global' });

    if (modelOperation) {
        const catalog = normalizeModels(await client.getModels());
        if (operation === 'list_models') {
            return {
                type: 'task-model-catalog',
                version: 1,
                taskId,
                currentModel: task.execution?.model || null,
                models: catalog,
            };
        }
        const modelKey = String(input?.modelKey || '').trim();
        const selected = catalog.find((model) => model.key === modelKey);
        if (!selected) throw new Error('task_model_not_available');
        const updated = await setTaskModelImpl(dir, taskId, selected);
        return {
            type: 'task-model-selected',
            version: 1,
            taskId,
            model: updated.execution.model,
            logAppend: updated.logAppend,
            logOffset: updated.logOffset,
        };
    }

    const providerInputs = normalizeProviderInputs(input?.inputs);
    const result = await client.callTool('task-session-control', {
        operation,
        handle: task.continuation.handle,
        provider: String(input?.provider || '').trim(),
        method: String(input?.method || '').trim(),
        flowId: String(input?.flowId || '').trim(),
        response: typeof input?.response === 'string' ? input.response : '',
        secretResponse: typeof input?.secretResponse === 'string' ? input.secretResponse : '',
        apiKey: typeof input?.apiKey === 'string' ? input.apiKey : '',
        ...(Object.keys(providerInputs).length ? { inputs: providerInputs } : {}),
    });
    return parseToolJson(result);
}

export const __testables = {
    normalizeModels,
    normalizeProviderInputs,
};
