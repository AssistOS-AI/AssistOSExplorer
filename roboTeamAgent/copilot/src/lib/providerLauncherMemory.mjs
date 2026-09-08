import { AkuMemoryAdapter } from './akuMemory/AkuMemoryAdapter.mjs';
import { buildAKUPlanningPacket } from './akuMemory/akuPlanningPacket.mjs';
import { formatAKUContextForPrompt, appendAKUContextToPrompt } from './akuMemory/akuContextFormatter.mjs';

export async function preparePromptForAKUMemory({
    prompt,
    normalizedMessage = null,
    workingDir,
    workspaceRoot,
    context,
    sessionState,
    logger,
    sessionId = null,
}) {
    const adapter = context.akuMemoryAdapter instanceof AkuMemoryAdapter
        ? context.akuMemoryAdapter
        : new AkuMemoryAdapter({
            rootDir: workspaceRoot || workingDir,
            workspaceRoot: workspaceRoot || workingDir,
            actor: 'achilles-cli',
            sessionState,
            logger,
        });
    context.akuMemoryAdapter = adapter;
    context.akuMemoryActions = adapter.createActionSurface();

    const packet = buildAKUPlanningPacket({
        text: prompt,
        rawText: normalizedMessage?.rawText,
        normalizedMessage,
        workingDir,
        workspaceRoot: workspaceRoot || workingDir,
        previousSessionState: sessionState?.toJSON?.() ?? null,
        sessionId: sessionId || null,
    });

    try {
        const preflight = await adapter.preparePromptMemory(packet);
        context.akuMemoryPreflight = preflight;
        const memoryContext = formatAKUContextForPrompt(preflight);
        return {
            prompt: appendAKUContextToPrompt(prompt, memoryContext),
            preflight,
            memoryContext,
        };
    } catch (error) {
        logger?.debug?.(`AKU memory preflight skipped: ${error.message}`);
        context.akuMemoryPreflight = {
            enabled: false,
            initialized: false,
            diagnostics: [`AKU memory preflight skipped: ${error.message}`],
        };
        return {
            prompt,
            preflight: context.akuMemoryPreflight,
            memoryContext: '',
        };
    }
}

export async function lookupCachedProviderResultForPrompt(context, {
    prompt,
    workingDir,
    logger,
} = {}) {
    const adapter = context?.akuMemoryAdapter;
    if (!(adapter instanceof AkuMemoryAdapter)) {
        return { hit: false, reason: 'aku_adapter_unavailable' };
    }
    const cached = await adapter.lookupCachedAgentResult({
        prompt,
        workingDir,
    });
    if (!cached?.hit || !String(cached.resultText || '').trim()) {
        return cached || { hit: false, reason: 'miss' };
    }
    logger?.debug?.(`AKU provider-result cache hit: ${cached.backend || 'unknown'} (${cached.provenance || 'aku'})`);
    return {
        ...cached,
        resultText: String(cached.resultText || '').trim(),
    };
}

export async function persistProviderLauncherResults(context, {
    prompt,
    workingDir,
    fromIndex = 0,
    logger,
} = {}) {
    const adapter = context?.akuMemoryAdapter;
    const launcherResults = Array.isArray(context?.providerLauncherResults)
        ? context.providerLauncherResults.slice(Math.max(0, Number(fromIndex) || 0))
        : [];
    if (!(adapter instanceof AkuMemoryAdapter) || !launcherResults.length) {
        return [];
    }
    const persisted = [];
    for (const entry of launcherResults) {
        const result = entry?.result && typeof entry.result === 'object' ? entry.result : entry;
        const backend = String(entry?.backend || result?.backend || '').trim();
        const resultText = String(result?.result_text || result?.final_answer || result?.natural_language_output || '').trim();
        if (!backend || !resultText) {
            continue;
        }
        try {
            persisted.push(await adapter.persistAgentResult({
                prompt: entry?.prompt || prompt,
                backend,
                resultText,
                workingDir,
                cacheable: result?.cacheable === true,
                ttlHintSeconds: result?.persistence_hint?.ttl_hint_seconds ?? entry?.ttlHintSeconds,
                originPaths: collectWebchatOriginPaths(context),
                metadata: {
                    launcher: String(entry?.launcher || '').trim() || undefined,
                    ok: typeof result?.ok === 'boolean' ? result.ok : undefined,
                    provider_availability: result?.diagnostics?.providerAvailability,
                },
            }));
        } catch (error) {
            logger?.debug?.(`AKU provider-result postflight skipped: ${error.message}`);
            persisted.push({ ok: false, error: error.message });
        }
    }
    return persisted;
}

function collectWebchatOriginPaths(context = {}) {
    const paths = [];
    for (const entry of Array.isArray(context.webchatPaths) ? context.webchatPaths : []) {
        if (typeof entry === 'string') {
            paths.push(entry);
        } else if (entry && typeof entry === 'object') {
            paths.push(entry.path);
        }
    }
    for (const resource of Array.isArray(context.webchatResources) ? context.webchatResources : []) {
        if (resource && typeof resource === 'object') {
            paths.push(resource.path || resource.name);
        }
    }
    return [...new Set(paths.map((value) => String(value || '').trim()).filter(Boolean))];
}
