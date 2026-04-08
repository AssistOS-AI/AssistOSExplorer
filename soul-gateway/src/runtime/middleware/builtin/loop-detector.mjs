/**
 * Built-in middleware: Loop Detector
 *
 * Detects repetitive session behavior and can log, intervene, or block.
 */

import { createHash } from 'node:crypto';

export const meta = Object.freeze({
    key: 'loop-detector',
    name: 'Loop Detector',
    description:
        'Detects agent loops via response fingerprinting and token growth analysis.',
    version: '2.0.0',
    scope: 'gateway',
    defaultSettings: Object.freeze({
        mode: 'log',
        similarityThreshold: 5,
        window: 7,
        growthThreshold: 50_000,
        minResponses: 3,
        repetitiveRatio: 0.6,
    }),
});

const _sessions = new Map();

export function factory(settings = {}) {
    const merged = { ...meta.defaultSettings, ...settings };

    return async function loopDetector(ctx, next) {
        const sessionId = ctx.session?.key || 'default';
        const session = getSession(sessionId);
        const { looped, reason } = detectLoop(session, merged);

        if (looped) {
            const mode = merged.mode || 'log';
            if (mode === 'log') {
                ctx.log.warn('Loop detected (log mode)', { sessionId, reason });
            } else if (mode === 'intervene') {
                ctx.log.warn('Loop detected (intervene mode)', {
                    sessionId,
                    reason,
                });
                if (!Array.isArray(ctx.request?.messages)) {
                    ctx.request.messages = [];
                }
                ctx.request.messages.push({
                    role: 'system',
                    content:
                        '[LOOP DETECTED] You appear to be repeating yourself. Please provide a different approach or indicate you are stuck.',
                });
            } else if (mode === 'block') {
                ctx.log.warn('Loop detected (block mode)', { sessionId, reason });
                ctx.abort.error(429, `Agent loop detected: ${reason}`);
            }
        }

        await next();

        const responseText = extractResponseText(ctx.response);
        const fp = fingerprint(responseText);
        session.fingerprints.push(fp);

        const usage = ctx.response?.usage ?? ctx.usage;
        const tokens = usage?.total_tokens ?? usage?.totalTokens ?? 0;
        const previousTotal =
            session.totalTokens.length > 0
                ? session.totalTokens[session.totalTokens.length - 1]
                : 0;
        session.totalTokens.push(previousTotal + tokens);

        const maxKeep = (merged.window || 7) * 2;
        if (session.fingerprints.length > maxKeep) {
            session.fingerprints = session.fingerprints.slice(-(merged.window || 7));
        }
        if (session.totalTokens.length > maxKeep) {
            session.totalTokens = session.totalTokens.slice(-(merged.window || 7));
        }
    };
}

function getSession(sessionId) {
    let session = _sessions.get(sessionId);
    if (!session) {
        session = { fingerprints: [], totalTokens: [] };
        _sessions.set(sessionId, session);
    }
    return session;
}

function fingerprint(text) {
    if (!text) return '';
    return createHash('md5').update(text).digest('hex').slice(0, 16);
}

function fingerprintDistance(a, b) {
    if (a.length !== b.length) return Math.max(a.length, b.length);
    let distance = 0;
    for (let idx = 0; idx < a.length; idx++) {
        if (a[idx] !== b[idx]) {
            distance++;
        }
    }
    return distance;
}

function detectLoop(session, settings) {
    const minResponses = settings.minResponses || 3;
    const windowSize = settings.window || 7;
    const threshold = settings.similarityThreshold ?? 5;
    const repetitiveRatio = settings.repetitiveRatio ?? 0.6;
    const growthThreshold = settings.growthThreshold ?? 50_000;

    const fingerprints = session.fingerprints;
    if (fingerprints.length < minResponses) {
        return { looped: false, reason: null };
    }

    const recent = fingerprints.slice(-windowSize);
    if (recent.length < minResponses) {
        return { looped: false, reason: null };
    }

    const latest = recent[recent.length - 1];
    let similarCount = 0;
    for (let idx = 0; idx < recent.length - 1; idx++) {
        if (fingerprintDistance(recent[idx], latest) <= threshold) {
            similarCount++;
        }
    }

    const ratio = similarCount / (recent.length - 1);
    if (ratio >= repetitiveRatio) {
        return {
            looped: true,
            reason: `Repetitive responses: ${(ratio * 100).toFixed(0)}% similar`,
        };
    }

    const tokens = session.totalTokens;
    if (tokens.length >= minResponses) {
        const recentTokens = tokens.slice(-windowSize);
        const growth = recentTokens[recentTokens.length - 1] - recentTokens[0];
        if (growth > growthThreshold) {
            return {
                looped: true,
                reason: `Token growth exceeded threshold: ${growth} > ${growthThreshold}`,
            };
        }
    }

    return { looped: false, reason: null };
}

function extractResponseText(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    const choices = response.choices || [];
    if (choices.length > 0) {
        const message = choices[0].message || choices[0].delta || {};
        return typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content || '');
    }
    return JSON.stringify(response);
}

export function _resetSessions() {
    _sessions.clear();
}

export function _getSession(sessionId) {
    return _sessions.get(sessionId) || null;
}

export function _setSession(sessionId, data) {
    _sessions.set(sessionId, data);
}
