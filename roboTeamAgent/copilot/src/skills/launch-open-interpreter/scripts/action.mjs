import { extractToolJson } from './toolResponse.mjs';

export const BACKEND = 'open-interpreter';
export const RELAY_AGENT = 'copilotProviderRelay';
export const PROVIDER_AGENT = 'openInterpreterAgent';
export const LIST_TOOL = 'copilot_provider_list_backends';
export const SUBMIT_TOOL = 'copilot_provider_task_submit';
export const PROVIDER_STATUS_TOOL = 'oi_status';
const DEFAULT_TIMEOUT_MS = 110000;
const MAX_TASK_TIMEOUT_MS = 120000;
const PROVIDER_TOKEN_RE = /(^|\s)@open-interpreter(?=\s|$|[.,:;!?])/i;

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parsePromptText(value) {
    const text = trim(value);
    if (!text) return {};
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : { prompt: text };
    } catch {
        return { prompt: text };
    }
}

function normalizeArgs(args = {}) {
    const fromPrompt = parsePromptText(args.promptText);
    const context = args.context && typeof args.context === 'object' ? args.context : {};
    return {
        ...fromPrompt,
        ...args,
        context,
        prompt: trim(args.prompt || fromPrompt.prompt || args.promptText),
        workingDir: trim(args.workingDir || context.workingDir),
        resources: asArray(args.resources?.length ? args.resources : fromPrompt.resources?.length ? fromPrompt.resources : context.webchatResources),
        paths: asArray(args.paths?.length ? args.paths : fromPrompt.paths?.length ? fromPrompt.paths : context.webchatPaths),
        origin: args.origin && typeof args.origin === 'object'
            ? args.origin
            : fromPrompt.origin && typeof fromPrompt.origin === 'object'
            ? fromPrompt.origin
            : context.webchatOrigin || {},
        warnings: asArray(context.webchatResourceWarnings),
        hasInvocationToken: args.hasInvocationToken === true,
        timeoutMs: normalizeTimeout(args.timeoutMs ?? fromPrompt.timeoutMs),
        callAgentTool: args.callAgentTool,
    };
}

function normalizeTimeout(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_TIMEOUT_MS;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return DEFAULT_TIMEOUT_MS;
    }
    return Math.max(1000, Math.min(MAX_TASK_TIMEOUT_MS, Math.floor(numeric)));
}

function resultBase(overrides = {}) {
    return {
        ok: false,
        backend: BACKEND,
        cacheable: false,
        result_text: '',
        persistence_hint: {
            ku_type: 'code_work',
            record_result: false,
            ttl_hint_seconds: null,
        },
        diagnostics: {},
        ...overrides,
    };
}

function findCatalogBackend(payload) {
    const backends = Array.isArray(payload?.backends) ? payload.backends : [];
    return backends.find((backend) => {
        if (!backend || typeof backend !== 'object') return false;
        return String(backend.id || '').trim().toLowerCase() === BACKEND;
    }) || null;
}

function normalizeRelayAnswer(payload) {
    if (!payload || typeof payload !== 'object') {
        return 'Open Interpreter completed without a response.';
    }
    return String(
        payload.final_answer
        || payload.natural_language_output
        || payload.error
        || 'Open Interpreter completed without a response.'
    ).trim();
}

function withForwardingWarnings(prompt, warnings = []) {
    const cleanWarnings = warnings.map((entry) => trim(entry)).filter(Boolean);
    if (!cleanWarnings.length) {
        return prompt;
    }
    return `${prompt}\n\nReference forwarding notes:\n${cleanWarnings.map((entry) => `- ${entry}`).join('\n')}`;
}

function normalizeForwardablePaths(paths = []) {
    const forwarded = [];
    const warnings = [];
    for (const entry of asArray(paths)) {
        if (typeof entry === 'string') {
            const text = trim(entry);
            if (text) forwarded.push(text);
            continue;
        }
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const entryPath = trim(entry.path);
        if (!entryPath) {
            continue;
        }
        if (String(entry.type || '').toLowerCase() === 'file') {
            forwarded.push(entryPath);
            continue;
        }
        const label = trim(entry.label) || entryPath;
        warnings.push(`Workspace reference "${label}" is a ${trim(entry.type) || 'non-file'} path and was not forwarded as a relay path. Attach or reference specific files to send file paths.`);
    }
    return {
        paths: [...new Set(forwarded)],
        warnings,
    };
}

async function checkProviderAvailability(input, backend) {
    const providerAgent = trim(backend?.provider?.agent) || PROVIDER_AGENT;
    if (!providerAgent) {
        return {
            ok: false,
            result_text: 'Open Interpreter is unavailable because the Copilot Provider Relay backend has no provider route.',
            diagnostics: { providerAvailability: 'not_deployed', missingProviderRoute: true },
        };
    }
    try {
        const response = await input.callAgentTool(providerAgent, PROVIDER_STATUS_TOOL, {});
        return {
            ok: true,
            providerAgent,
            status: extractToolJson(response),
        };
    } catch (error) {
        return {
            ok: false,
            result_text: `Open Interpreter is unavailable because provider agent ${providerAgent} is not reachable: ${error?.message || 'provider status failed'}`,
            diagnostics: {
                providerAvailability: 'not_deployed',
                providerAgent,
                providerStatusError: error?.message || String(error),
            },
        };
    }
}

function rememberLauncherResult(context, result, extra = {}) {
    if (context && typeof context === 'object') {
        if (!Array.isArray(context.providerLauncherResults)) {
            context.providerLauncherResults = [];
        }
        context.providerLauncherResults.push({
            launcher: 'launch-open-interpreter',
            backend: BACKEND,
            prompt: extra.prompt || '',
            result,
        });
    }
    return result;
}

function finish(input, result) {
    return rememberLauncherResult(input?.context, result, { prompt: input?.prompt });
}

export async function action(args = {}) {
    const input = normalizeArgs(args);
    if (!input.prompt) {
        return finish(input, resultBase({
            result_text: 'Open Interpreter needs a natural-language task to run.',
            diagnostics: { providerAvailability: 'active' },
        }));
    }
    if (PROVIDER_TOKEN_RE.test(input.prompt)) {
        return finish(input, resultBase({
            result_text: '`@open-interpreter` is ordinary chat text now. I did not start Open Interpreter from that token.',
            diagnostics: { providerAvailability: 'active', deprecatedToken: true },
        }));
    }
    if (!input.hasInvocationToken) {
        return finish(input, resultBase({
            result_text: 'Open Interpreter is unavailable in this chat because no router invocation capability was provided.',
            diagnostics: { providerAvailability: 'disabled', missingInvocationToken: true },
        }));
    }
    if (typeof input.callAgentTool !== 'function') {
        return finish(input, resultBase({
            result_text: 'Open Interpreter is unavailable because the skill runtime MCP capability is unavailable.',
            diagnostics: { providerAvailability: 'disabled', missingRuntimeCapability: true },
        }));
    }

    let catalog = {};
    try {
        const response = await input.callAgentTool(RELAY_AGENT, LIST_TOOL, {});
        catalog = extractToolJson(response);
    } catch (error) {
        return finish(input, resultBase({
            result_text: `Open Interpreter is unavailable because the Copilot Provider Relay is not reachable: ${error?.message || 'relay lookup failed'}`,
            diagnostics: { providerAvailability: 'not_deployed', relayLookupError: error?.message || String(error) },
        }));
    }

    const catalogBackend = findCatalogBackend(catalog);
    if (!catalogBackend) {
        return finish(input, resultBase({
            result_text: 'Open Interpreter launcher is available, but the Copilot Provider Relay catalog does not currently expose the open-interpreter backend.',
            diagnostics: { providerAvailability: 'not_deployed', missingBackend: BACKEND },
        }));
    }

    const providerAvailability = await checkProviderAvailability(input, catalogBackend);
    if (!providerAvailability.ok) {
        return finish(input, resultBase({
            result_text: providerAvailability.result_text,
            diagnostics: providerAvailability.diagnostics,
        }));
    }

    const forwardablePaths = normalizeForwardablePaths(input.paths);
    const submitArguments = {
        backend: BACKEND,
        prompt: withForwardingWarnings(input.prompt, [
            ...input.warnings,
            ...forwardablePaths.warnings,
        ]),
        resources: input.resources,
        origin: {
            type: 'semantic-copilot',
            surface: 'webchat',
            ...input.origin,
            working_directory: input.workingDir,
        },
        timeoutMs: input.timeoutMs,
    };
    if (forwardablePaths.paths.length) {
        submitArguments.paths = forwardablePaths.paths;
    }

    try {
        const response = await input.callAgentTool(RELAY_AGENT, SUBMIT_TOOL, submitArguments);
        const payload = extractToolJson(response);
        return finish(input, resultBase({
            ok: payload.ok !== undefined ? Boolean(payload.ok) : true,
            result_text: normalizeRelayAnswer(payload),
            persistence_hint: {
                ku_type: 'code_work',
                record_result: true,
                ttl_hint_seconds: null,
            },
            diagnostics: {
                providerAvailability: 'active',
                relayBackend: payload.backend || BACKEND,
                jobId: payload.jobId || null,
                sandboxOk: payload.sandbox_ok ?? null,
                backendOk: payload.backend_ok ?? null,
                providerAgent: providerAvailability.providerAgent,
            },
        }));
    } catch (error) {
        return finish(input, resultBase({
            result_text: `Open Interpreter task failed: ${error?.message || 'delegated task failed'}`,
            diagnostics: { providerAvailability: 'active', submitError: error?.message || String(error) },
        }));
    }
}
