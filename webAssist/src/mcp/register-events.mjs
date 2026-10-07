#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgenticKnowledgeUnits } from 'achillesAgentLib/AgenticKnowledgeUnits';
import { initializeWebAssistDataRoot, normalizeSiteId, resolveSiteDataDir } from '../runtime/akuStore.mjs';

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

function normalizeVisitorId(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
        throw new Error('register-events requires visitorId.');
    }
    const safe = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
    const normalized = safe.replace(/^[-.]+|[-.]+$/g, '');
    if (!normalized) {
        throw new Error('register-events requires a valid visitorId.');
    }
    return normalized;
}

function normalizeEventType(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
        throw new Error('register-events requires eventType.');
    }
    return raw;
}

function getSiteKuId(siteId) {
    return `ku_site`;
}

export async function registerEvent({
    siteId,
    visitorId,
    eventType,
    sessionId = '',
    referrer = '',
    country = '',
    openedChat = false,
    details = {},
}) {
    if (!siteId) {
        throw new Error('register-events requires siteId.');
    }
    const normalizedVisitorId = normalizeVisitorId(visitorId);
    const normalizedEventType = normalizeEventType(eventType);
    normalizeSiteId(siteId);
    await initializeWebAssistDataRoot();
    const akuRootDir = resolveSiteDataDir(siteId);

    const aku = new AgenticKnowledgeUnits({
        rootDir: akuRootDir,
        actor: `webassist/${siteId}`,
    });

    const akuExists = await aku.exists();
    if (!akuExists) {
        throw new Error(`AKU not initialized for site: ${siteId}`);
    }

    await aku.loadAKU();

    const siteKuId = getSiteKuId(siteId);
    const nowIso = new Date().toISOString();

    const metadata = {
        visitorId: normalizedVisitorId,
        timestamp: nowIso,
    };

    if (sessionId) {
        metadata.sessionId = String(sessionId).trim();
    }
    if (typeof referrer === 'string' && referrer.trim()) {
        metadata.referrer = referrer.trim();
    }
    if (typeof country === 'string' && country.trim()) {
        metadata.country = country.trim();
    }
    if (normalizedEventType === 'visit' || normalizedEventType === 'chat-start') {
        metadata.openedChat = openedChat === true ? 'yes' : 'no';
    }
    if (details && typeof details === 'object' && !Array.isArray(details)) {
        for (const [key, value] of Object.entries(details)) {
            metadata[String(key)] = String(value ?? '');
        }
    }

    await aku.recordEvent(siteKuId, {
        event_type: normalizedEventType,
        title: `Event: ${normalizedEventType}`,
        summary: `Visitor ${normalizedVisitorId} - ${normalizedEventType}`,
        tags: ['event', normalizedEventType],
        metadata,
    });

    return {
        ok: true,
        siteId,
        visitorId: normalizedVisitorId,
        eventType: normalizedEventType,
        timestamp: nowIso,
    };
}

async function main() {
    const rawInput = await readStdinFallback();
    const envelope = rawInput && rawInput.trim() ? safeParseJson(rawInput) : null;
    const input = normalizeInput(envelope || {});

    const result = await registerEvent({
        siteId: typeof input.siteId === 'string' ? input.siteId.trim() : '',
        visitorId: input.visitorId,
        eventType: typeof input.eventType === 'string' ? input.eventType.trim() : '',
        sessionId: typeof input.sessionId === 'string' ? input.sessionId.trim() : '',
        referrer: typeof input.referrer === 'string' ? input.referrer.trim() : '',
        country: typeof input.country === 'string' ? input.country.trim() : '',
        openedChat: input.openedChat === true,
        details: input.details && typeof input.details === 'object' ? input.details : {},
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
