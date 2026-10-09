import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { MainAgent } from 'achillesAgentLib';
import { VISITOR_FLOW_SYSTEM_PROMPT } from './prompts/visitor-flow-system-prompt.mjs';
import { loadAkuContext } from './runtime/load-aku-context.mjs';
import { appendSessionTurn } from './runtime/update-session.mjs';
import { initializeWebAssistDataRoot, resolveSiteDataDir } from './runtime/akuStore.mjs';
import { resolveChatSession } from './runtime/sessionAccess.mjs';

function getCodeRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function isDebugEnabled() {
    const raw = String(process.env.ACHILLES_DEBUG || '').trim().toLowerCase();
    return raw && !['0', 'false', 'no', 'off'].includes(raw);
}

function resolveDebugDir() {
    return path.resolve(process.env.WEBASSIST_DEBUG_DIR || '/code/debuglogs');
}

function safeFileSegment(value) {
    const normalized = String(value || '')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return normalized || 'unknown';
}

function debugTimestamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

async function writeDebugText(kind, { siteId, sessionId, text }) {
    if (!isDebugEnabled()) {
        return null;
    }

    try {
        const debugDir = resolveDebugDir();
        await fs.mkdir(debugDir, { recursive: true });
        const fileName = `${kind}-${debugTimestamp()}-${safeFileSegment(siteId)}-${safeFileSegment(sessionId)}.txt`;
        const filePath = path.join(debugDir, fileName);
        await fs.writeFile(filePath, `${text}\n`, 'utf8');
        return filePath;
    } catch {
        return null;
    }
}

function buildBaseAgentOptions({ codeRoot, logger, mainAgentOptions }) {
    const explicitSkillRoot = path.join(codeRoot, 'skills');
    const requestedSkillRoots = Array.isArray(mainAgentOptions?.additionalSkillRoots)
        ? mainAgentOptions.additionalSkillRoots
        : [];
    const additionalSkillRoots = [explicitSkillRoot, ...requestedSkillRoots]
        .filter((value, index, all) => value && all.indexOf(value) === index);

    return {
        logger,
        startDir: codeRoot,
        additionalSkillRoots,
        ...(mainAgentOptions ?? {}),
    };
}

function buildRuntimePrompt({ siteId, sessionId, message, loadedContext }) {
    return [
        'User message:',
        String(message),
        'Site ID:',
        String(siteId),
        'Session ID:',
        String(sessionId),
        'Session profile:',
        JSON.stringify(loadedContext.sessionProfile ?? {}, null, 2),
        'Current lead:',
        JSON.stringify(loadedContext.currentLead ?? {}, null, 2),
        'Session profile markdown snapshot:',
        String(loadedContext.sessionProfile?.sessionProfileText ?? ''),
        'Predefined target profiles (always loaded from AKU):',
        String(loadedContext.profileCatalogText ?? 'No predefined target profiles found.'),
        'Relevant Site Context (from AKU):',
        String(loadedContext.akuContextText ?? 'No relevant site context found.'),
        'Conversation History (last 10 messages):',
        String(loadedContext.conversationHistoryText ?? 'No previous conversation history found.'),
    ].join('\n');
}

export async function createWebAssistAgent({
    llmAgent = null,
    logger = null,
    mainAgentOptions = {},
} = {}) {
    await initializeWebAssistDataRoot();
    const codeRoot = getCodeRoot();

    const mainAgent = new MainAgent(buildBaseAgentOptions({
        codeRoot,
        logger,
        mainAgentOptions,
    }));
    if (llmAgent) {
        mainAgent.llmAgent = llmAgent;
    }

    return {
        achilles: {
            libraryName: 'achillesAgentLib',
            source: 'node_modules',
        },
        mainAgent,
        // `access` is the verified caller (or LOCAL_OPERATOR_ACCESS for the CLI).
        // The session is resolved before any context load; `sessionSecret` is
        // consumed only by resolveChatSession and never reaches the prompt,
        // the execution context, debug output or AKU state.
        async handleMessage({ siteId, sessionId = '', sessionSecret = '', message, access, mode = 'soul_gateway/web-assist' }) {
            if (!siteId) {
                throw new Error('webAssist.handleMessage requires a siteId.');
            }
            if (!message) {
                throw new Error('webAssist.handleMessage requires a message.');
            }
            if (!access) {
                throw new Error('webAssist.handleMessage requires a verified caller access.');
            }

            const siteDataDir = resolveSiteDataDir(siteId);
            const session = await resolveChatSession({
                siteId,
                requestedSessionId: sessionId,
                sessionSecret,
                access,
            });
            const effectiveSessionId = session.sessionId;
            const loadedContext = await loadAkuContext({
                siteId,
                sessionId: effectiveSessionId,
                message,
            });
            const runtimePrompt = buildRuntimePrompt({
                siteId,
                sessionId: effectiveSessionId,
                message,
                loadedContext,
            });
            await writeDebugText('runtime-prompt', {
                siteId,
                sessionId: effectiveSessionId,
                text: runtimePrompt,
            });

            const execution = await mainAgent.executePrompt(runtimePrompt, {
                model: mode,
                systemPrompt: VISITOR_FLOW_SYSTEM_PROMPT,
                reasoningEffort: "low",
                // Trusted values for skills; they ignore model-supplied ids.
                context: {
                    siteDataDir,
                    siteId,
                    sessionId: effectiveSessionId,
                },
            });

            const response = String(execution.result ?? '').trim();
            if (!response) {
                throw new Error('webAssist orchestrator result must include a non-empty response.');
            }

            await appendSessionTurn({
                siteId,
                sessionId: effectiveSessionId,
                userMessage: message,
                agentResponse: response,
            });

            return {
                response,
                siteId,
                sessionId: effectiveSessionId,
                ...(session.sessionSecret ? { sessionSecret: session.sessionSecret } : {}),
            };
        },
    };
}
