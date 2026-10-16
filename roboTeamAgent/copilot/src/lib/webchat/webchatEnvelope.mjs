const REFERENCE_SECRET_RE = /(^|\/)\.secrets$|\.secrets$/i;

export function normalizeWebchatReferences(rawReferences) {
    if (!Array.isArray(rawReferences)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of rawReferences) {
        if (!entry || typeof entry !== 'object') continue;
        const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
        const refPath = typeof entry.path === 'string' ? entry.path.trim() : '';
        if (!kind || !refPath) continue;
        if (refPath.includes('\0')) continue;
        if (kind === 'workspace-path') {
            const normalizedPath = refPath.replace(/\\+/g, '/');
            if (normalizedPath.startsWith('/')) continue;
            if (normalizedPath.split('/').some((segment) => segment === '..')) continue;
            if (REFERENCE_SECRET_RE.test(normalizedPath)) continue;
            const key = `${kind}:${normalizedPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                kind,
                path: normalizedPath,
                type: entry.type ? String(entry.type).trim() || null : null,
                label: entry.label ? String(entry.label).trim() || null : null,
            });
        }
    }
    return out;
}

export function normalizeWebchatOrigin(rawOrigin) {
    if (!rawOrigin || typeof rawOrigin !== 'object') {
        return {};
    }
    const candidates = [
        rawOrigin.publicBaseUrl,
        rawOrigin.public_base_url,
        rawOrigin.origin,
        rawOrigin.baseUrl,
        rawOrigin.base_url,
        rawOrigin.routerUrl,
        rawOrigin.router_url,
        rawOrigin.url,
    ];
    for (const candidate of candidates) {
        const raw = typeof candidate === 'string' ? candidate.trim() : '';
        if (!raw) {
            continue;
        }
        try {
            const parsed = new URL(raw);
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) {
                return { publicBaseUrl: parsed.origin };
            }
        } catch {
            // Ignore malformed origin hints.
        }
    }
    return {};
}

export function isWebchatMessageEnvelope(raw) {
    const text = String(raw || '').trim();
    if (!text.startsWith('{')) return false;
    try {
        const parsed = JSON.parse(text);
        return Boolean(parsed && typeof parsed === 'object' && parsed.__webchatMessage);
    } catch {
        return false;
    }
}

export function normalizeWebchatMessage(raw) {
    const text = String(raw || '').trim();
    if (!text) {
        return {
            text: '',
            rawText: '',
            attachments: [],
            references: [],
            invocationToken: '',
            origin: {},
            visible: true,
            sourceTabId: '',
            sourcePageInstanceId: '',
        };
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || !parsed.__webchatMessage) {
            return {
                text,
                rawText: text,
                attachments: [],
                references: [],
                invocationToken: '',
                origin: {},
                visible: true,
                sourceTabId: '',
                sourcePageInstanceId: '',
            };
        }
        const messageText = typeof parsed.text === 'string' ? parsed.text : '';
        const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
        const references = normalizeWebchatReferences(parsed.references);
        const origin = normalizeWebchatOrigin(parsed.origin);
        const invocationToken = typeof parsed.invocation?.token === 'string'
            ? parsed.invocation.token
            : '';
        const sourceTabId = typeof parsed.sourceTabId === 'string'
            && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.sourceTabId)
            ? parsed.sourceTabId
            : '';
        const sourcePageInstanceId = typeof parsed.sourcePageInstanceId === 'string'
            && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.sourcePageInstanceId)
            ? parsed.sourcePageInstanceId
            : '';
        const attachmentLines = attachments
            .filter((entry) => entry && typeof entry === 'object')
            .map((entry) => {
                const name = entry.filename || entry.id || 'attachment';
                const localPath = entry.localPath ? ` path=${entry.localPath}` : '';
                const mime = entry.mime ? ` mime=${entry.mime}` : '';
                return `- ${name}${mime}${localPath}`;
            });
        const referenceLines = references.map((entry) => {
            const kind = entry.type || 'file';
            return `- ${entry.label || entry.path} (${kind} path=${entry.path})`;
        });
        const sections = [];
        if (attachmentLines.length) {
            sections.push(`Attachments:\n${attachmentLines.join('\n')}`);
        }
        if (referenceLines.length) {
            sections.push(`Referenced workspace paths:\n${referenceLines.join('\n')}`);
        }
        return {
            text: sections.length
                ? `${messageText}\n\n${sections.join('\n\n')}`
                : messageText,
            rawText: messageText,
            attachments,
            references,
            invocationToken,
            origin,
            visible: parsed.presentation?.visible !== false,
            sourceTabId,
            sourcePageInstanceId,
        };
    } catch {
        return {
            text,
            rawText: text,
            attachments: [],
            references: [],
            invocationToken: '',
            origin: {},
            visible: true,
            sourceTabId: '',
            sourcePageInstanceId: '',
        };
    }
}

export function shouldEmitWebchatOutput(message, { isSlashCommand = false } = {}) {
    return !(isSlashCommand && message?.visible === false);
}
