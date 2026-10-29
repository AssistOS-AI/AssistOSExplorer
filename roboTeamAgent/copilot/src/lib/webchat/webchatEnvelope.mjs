import fs from 'node:fs';

const REFERENCE_SECRET_RE = /(^|\/)\.secrets$|\.secrets$/i;

// RoboTeam's WebChat runtime scope, read once from its own manifest and normalized exactly as
// Ploinky reads `webchat.runtimeScope` (trimmed, lowercased; only "principal" counts). The Router
// signs `runtimeScope: "principal"` into every envelope of a principal-scoped runtime, so the
// rebuilt arguments must carry it exactly when the manifest declares it. An unreadable manifest
// gives null: principal-scoped tokens then fail verification (fail closed).
export function readManifestRuntimeScope(file = new URL('../../../../manifest.json', import.meta.url), { log = (line) => console.error(line) } = {}) {
    try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        const raw = manifest?.webchat?.runtimeScope;
        return typeof raw === 'string' && raw.trim().toLowerCase() === 'principal' ? 'principal' : null;
    } catch {
        log('[webchat] the RoboTeam manifest cannot be read; WebChat runtime scope is unknown and principal-scoped tokens will not verify');
        return null;
    }
}

export const MANIFEST_RUNTIME_SCOPE = readManifestRuntimeScope();

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

// The `__webchat_message__` arguments the Router signs for a forwarded
// envelope (Ploinky `buildWebchatInvocationArgs`), rebuilt from the raw
// envelope before any normalization or materialization, so an owner claim is
// verified over exactly the signed values. `runtimeScope` comes only from
// RoboTeam's manifest, never from the envelope. A Router-written `event` is
// copied whenever the envelope has one, so an added, removed or altered event
// fails verification.
export function webchatSignedArgs(parsed, { runtimeScope = MANIFEST_RUNTIME_SCOPE } = {}) {
    const args = {
        surface: 'webchat',
        tabId: String(parsed?.sourceTabId || ''),
        pageInstanceId: String(parsed?.sourcePageInstanceId || ''),
        text: typeof parsed?.text === 'string' ? parsed.text : '',
        attachments: Array.isArray(parsed?.attachments) ? parsed.attachments : [],
        references: Array.isArray(parsed?.references) ? parsed.references : [],
        presentation: { visible: parsed?.presentation?.visible !== false },
    };
    if (runtimeScope === 'principal') args.runtimeScope = 'principal';
    if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'event')) args.event = parsed.event;
    return args;
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
            event: typeof parsed.event === 'string' ? parsed.event : '',
            signedArgs: webchatSignedArgs(parsed),
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
