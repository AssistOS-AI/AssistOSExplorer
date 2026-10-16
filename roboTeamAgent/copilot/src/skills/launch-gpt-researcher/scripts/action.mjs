import { callToolWhenReady, ensureAgentsRunning } from './ploinkyAgentRuntime.mjs';

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return undefined;
}

function resolveWorkingDir(invocation = {}) {
    return trim(invocation.workingDir) || process.cwd();
}

function resolveAgentClient(invocation = {}) {
    if (invocation.agentClient && typeof invocation.agentClient.callToolWithoutWait === 'function') {
        return invocation.agentClient;
    }
    throw new Error('The skill runtime delegation capability is unavailable.');
}

function parseTaskResult(payload) {
    if (!payload || typeof payload !== 'object') {
        return { ok: true };
    }

    const content = Array.isArray(payload.result?.content)
        ? payload.result.content
        : Array.isArray(payload.content)
            ? payload.content
            : [];
    const text = trim(content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text);

    try {
        if (!text) {
            throw new Error('no mcp text');
        }
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            return {
                ...parsed,
            };
        }
        return {
            ...payload,
            ok: true,
            outputText: text,
        };
    } catch {
        if (text) {
            return {
                ...payload,
                ok: true,
                outputText: text,
            };
        }
    }

    const hasStatus = typeof payload.status === 'string' || typeof payload.logTail === 'string' || typeof payload.logSeq !== 'undefined' || payload?.result;
    const hasMetadata = payload?.metadata || payload?.result?.metadata;
    if (payload.outputText !== undefined || payload.ok !== undefined || typeof payload.error === 'string' || hasStatus || hasMetadata) {
        return payload;
    }

    return { ok: true };
}

async function callAgentTool(agentName, toolName, payload, invocation = {}) {
    const client = resolveAgentClient(invocation);
    await ensureAgentsRunning(client, [SEARCH_AGENT_REF, TARGET_AGENT_REF], invocation);
    return callToolWhenReady(() => client.callToolWithoutWait(toolName, payload));
}

export const TARGET_AGENT = 'GPTResearcher';
export const TARGET_AGENT_REF = 'AchillesCLI/GPTResearcher';
export const SEARCH_AGENT_REF = 'proxies/searchAgent';
export const TOOL_NAME = 'start_research';

function normalizeInput(invocation = {}) {
    const defaultWorkingDir = resolveWorkingDir(invocation);
    const candidate = typeof invocation.promptText === 'string'
        ? invocation.promptText
        : typeof invocation.prompt === 'string'
        ? invocation.prompt
        : '';
    const text = trim(candidate);
    if (!text) {
        return {
            query: trim(invocation.query || invocation.prompt),
            context: trim(invocation.researchContext || invocation.context),
            reportType: trim(invocation.reportType),
            workingDir: defaultWorkingDir,
            useLocalDocs: normalizeOptionalBoolean(invocation.useLocalDocs),
        };
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                query: trim(parsed.query || parsed.task || parsed.taskDescription),
                context: trim(parsed.context),
                reportType: trim(parsed.reportType || parsed.report_type),
                workingDir: defaultWorkingDir,
                useLocalDocs: normalizeOptionalBoolean(parsed.useLocalDocs ?? parsed.use_local_docs),
            };
        }
    } catch {
    }
    return {
        query: text,
        context: trim(invocation.researchContext || invocation.context),
        reportType: trim(invocation.reportType),
        workingDir: defaultWorkingDir,
        useLocalDocs: normalizeOptionalBoolean(invocation.useLocalDocs),
    };
}

function buildPayload({ query, context, reportType, workingDir, useLocalDocs }) {
    const payload = {
        query,
    };
    if (context) {
        payload.context = context;
    }
    if (reportType) {
        payload.reportType = reportType;
    }
    if (workingDir) {
        payload.workingDir = workingDir;
    }
    if (typeof useLocalDocs === 'boolean') {
        payload.useLocalDocs = useLocalDocs;
    }
    return payload;
}

function formatFailurePayload(payload) {
    const errorText = trim(payload.error);
    const outputText = trim(payload.outputText || payload.logTail);
    if (!errorText) {
        return outputText || 'GPTResearcher task failed.';
    }
    if (!outputText || outputText === errorText) {
        return errorText;
    }
    return `${errorText}\n\n${outputText}`;
}

function compactJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return '';
    }
}

function normalizeAnswer(payload) {
    if (!payload || typeof payload !== 'object') {
        return 'GPTResearcher task completed without a response.';
    }
    const backgroundTask = payload?.metadata?.backgroundTask;
    if (backgroundTask?.detached) {
        return 'Task started.';
    }
    if (trim(payload?.metadata?.taskId || payload?.result?.metadata?.taskId)) {
        return 'Task started.';
    }
    if (payload.ok === false && payload.error) {
        return formatFailurePayload(payload);
    }
    const report = trim(payload.report);
    if (report) {
        const reportPath = trim(payload.reportPath);
        const savedLine = reportPath ? `\n\nSaved report: ${reportPath}` : '';
        return `GPTResearcher task completed.${savedLine}\n\n${report}`;
    }
    const outputText = trim(payload.outputText);
    if (outputText) {
        return `GPTResearcher task completed.\n\n${outputText}`;
    }
    if (payload.result !== undefined) {
        const resultText = typeof payload.result === 'string' ? trim(payload.result) : compactJson(payload.result);
        if (resultText) {
            return `GPTResearcher task completed.\n\n${resultText}`;
        }
    }
    const fallback = compactJson(payload);
    if (fallback) {
        return `GPTResearcher task completed.\n\n${fallback}`;
    }
    return 'GPTResearcher task completed.';
}

export async function action(invocation = {}) {
    const input = normalizeInput(invocation);
    if (!input.query) {
        return 'GPTResearcher needs a natural-language research task to run.';
    }

    try {
        const result = parseTaskResult(await callAgentTool(TARGET_AGENT, TOOL_NAME, buildPayload(input), invocation));
        return normalizeAnswer(result);
    } catch (error) {
        if (error?.task) {
            const failed = parseTaskResult(error.task);
            return `GPTResearcher task failed: ${formatFailurePayload(failed)}`;
        }
        return `GPTResearcher task failed: ${error?.message || 'delegated research failed'}`;
    }
}

export default action;
