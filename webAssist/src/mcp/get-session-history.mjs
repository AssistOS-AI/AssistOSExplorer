#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgenticKnowledgeUnits } from 'achillesAgentLib/AgenticKnowledgeUnits';
import { resolveSiteDataDir } from '../runtime/akuStore.mjs';
import { getSessionKuId } from '../runtime/update-session.mjs';
import {
    assertValidSessionId,
    callerAccessFromEnvelope,
    canUseSession,
    formatToolError,
    publicError,
    readSessionOwner,
} from '../runtime/sessionAccess.mjs';

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function normalizeInput(envelope) {
    let current = envelope;
    for (let index = 0; index < 4; index += 1) {
        if (!current || typeof current !== 'object') {
            break;
        }
        if (current.input && typeof current.input === 'object') {
            current = current.input;
            continue;
        }
        if (current.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
            continue;
        }
        if (current.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
            continue;
        }
        if (current.params?.input && typeof current.params.input === 'object') {
            current = current.params.input;
            continue;
        }
        break;
    }
    return current && typeof current === 'object' ? current : {};
}

async function readStdinFallback() {
    if (process.stdin.isTTY) {
        return '';
    }
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        process.stdin.on('error', () => {
            resolve('');
        });
    });
}

function missingSession(siteId, sessionId, sessionKuId) {
    return {
        siteId,
        sessionId,
        exists: false,
        sessionKuId,
        history: [],
    };
}

// History is readable by the session's owner, by a caller presenting the
// session secret, and by an admin. Everyone else gets the missing-session
// shape, decided before any AKU read. `sessionSecret` is used only for that
// comparison and never echoed.
export async function getSessionHistory({
    siteId,
    sessionId,
    sessionSecret,
    access = null,
}) {
    if (!access) {
        throw publicError('Access denied: a verified webAssist caller is required.');
    }
    const normalizedSiteId = typeof siteId === 'string' ? siteId.trim() : '';
    if (!normalizedSiteId) {
        throw publicError('web_cli_history requires siteId.');
    }
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
        throw publicError('web_cli_history requires sessionId.');
    }
    assertValidSessionId(normalizedSessionId);
    const sessionKuId = getSessionKuId(normalizedSessionId);

    if (access.admin !== true) {
        const owner = await readSessionOwner({ siteId: normalizedSiteId, sessionId: normalizedSessionId });
        if (!canUseSession(owner, access, sessionSecret)) {
            return missingSession(normalizedSiteId, normalizedSessionId, sessionKuId);
        }
    }

    const akuRootDir = resolveSiteDataDir(normalizedSiteId, { allowMissing: true });

    const aku = new AgenticKnowledgeUnits({
        rootDir: akuRootDir,
        actor: `webassist/${normalizedSiteId}`,
    });

    const akuExists = await aku.exists();
    if (!akuExists) {
        return missingSession(normalizedSiteId, normalizedSessionId, sessionKuId);
    }

    await aku.loadAKU();

    try {
        const sessionKU = await aku.loadKU(sessionKuId);
        const events = sessionKU.events || [];
        const turnEvents = events
            .filter(e => e.event_type === 'turn' && e.metadata?.speaker && e.metadata?.message)
            .map(e => ({
                role: e.metadata.speaker.toLowerCase(),
                message: e.metadata.message,
            }));

        return {
            siteId: normalizedSiteId,
            sessionId: normalizedSessionId,
            exists: true,
            sessionKuId,
            history: turnEvents,
        };
    } catch (error) {
        if (error?.message?.includes('not found')) {
            return missingSession(normalizedSiteId, normalizedSessionId, sessionKuId);
        }
        throw error;
    }
}

async function main() {
    const rawInput = await readStdinFallback();
    const envelope = rawInput && rawInput.trim() ? safeParseJson(rawInput) : null;
    const input = normalizeInput(envelope || {});
    let access = null;
    try {
        access = await callerAccessFromEnvelope(envelope || {});
        const result = await getSessionHistory({
            siteId: typeof input.siteId === 'string' ? input.siteId.trim() : '',
            sessionId: typeof input.sessionId === 'string' ? input.sessionId.trim() : '',
            sessionSecret: input.sessionSecret,
            access,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${formatToolError(error, access)}\n`);
        process.exitCode = 1;
    }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    main().catch(() => {
        process.stderr.write('webAssist request failed.\n');
        process.exitCode = 1;
    });
}
