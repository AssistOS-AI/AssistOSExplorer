import path from 'node:path';

const SECRET_PATH_RE = /(^|\/)\.secrets$|\.secrets$/i;

export function buildAKUPlanningPacket(input = {}) {
    const source = typeof input === 'string'
        ? { text: input }
        : { ...(input || {}) };
    const normalizedMessage = source.normalizedMessage && typeof source.normalizedMessage === 'object'
        ? source.normalizedMessage
        : null;

    const promptText = normalizePromptText(
        source.text
            ?? source.promptText
            ?? source.prompt
            ?? source.message
            ?? normalizedMessage?.text
            ?? '',
    );
    const rawUserText = normalizePromptText(
        source.rawUserText
            ?? source.rawText
            ?? normalizedMessage?.rawText
            ?? promptText,
    );
    const workingDir = normalizeAbsoluteDir(source.workingDir ?? source.cwd ?? process.cwd());
    const workspaceRoot = normalizeAbsoluteDir(source.workspaceRoot ?? source.rootDir ?? workingDir);
    const pathRoot = workspaceRoot || workingDir;

    const folderScopeHint = normalizeFolderScopeHint(
        source.folderScopeHint
            ?? source.folderHint
            ?? source.selectedFolder
            ?? source.workspaceFolder,
        { rootDir: pathRoot },
    );

    const references = [
        ...asArray(source.workspacePathReferences),
        ...asArray(source.pathReferences),
        ...asArray(source.references),
        ...asArray(normalizedMessage?.references),
    ];
    const attachments = [
        ...asArray(source.attachments),
        ...asArray(normalizedMessage?.attachments),
    ];

    return {
        source: normalizeSource(source.source, normalizedMessage),
        rawUserText,
        promptText,
        workingDir,
        workspaceRoot,
        folderScopeHint,
        pathReferences: normalizePathReferences(references, { rootDir: pathRoot }),
        attachments: normalizeAttachments(attachments, { rootDir: pathRoot }),
        sessionId: normalizeOptionalString(
            source.sessionId
                ?? source.session_id
                ?? source.runtimeContext?.sessionId
                ?? normalizedMessage?.sessionId,
        ),
        previousSessionState: source.previousSessionState ?? source.akuSessionState ?? null,
        runtime: {
            hasEnvelope: Boolean(normalizedMessage),
        },
    };
}

export function normalizePromptText(value = '') {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

export function normalizePacketPath(value, options = {}) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw || raw.includes('\0')) {
        return null;
    }

    const unixPath = raw.replace(/\\+/g, '/');
    if (SECRET_PATH_RE.test(unixPath)) {
        return null;
    }

    const rootDir = options.rootDir ? path.resolve(options.rootDir) : '';
    if (path.isAbsolute(unixPath)) {
        if (!rootDir) {
            return null;
        }
        const relative = path.relative(rootDir, path.resolve(unixPath)).replace(/\\+/g, '/');
        if (isPathEscape(relative)) {
            return null;
        }
        return relative || '.';
    }

    const cleaned = path.posix.normalize(unixPath.replace(/^\/+/, ''));
    if (!cleaned || cleaned === '.') {
        return cleaned || '.';
    }
    if (isPathEscape(cleaned) || SECRET_PATH_RE.test(cleaned)) {
        return null;
    }
    return cleaned;
}

function normalizeFolderScopeHint(value, options = {}) {
    if (!value) {
        return null;
    }
    const rawPath = typeof value === 'string'
        ? value
        : value.path ?? value.folder ?? value.dir ?? '';
    const normalizedPath = normalizePacketPath(rawPath, options);
    if (!normalizedPath) {
        return null;
    }
    return {
        path: normalizedPath,
        label: typeof value === 'object' && value.label ? String(value.label).trim() : null,
        source: typeof value === 'object' && value.source ? String(value.source).trim() : null,
    };
}

function normalizePathReferences(references = [], options = {}) {
    const seen = new Set();
    const out = [];
    for (const entry of references) {
        const ref = typeof entry === 'string' ? { path: entry } : entry;
        if (!ref || typeof ref !== 'object') {
            continue;
        }
        const kind = normalizeOptionalString(ref.kind) || 'workspace-path';
        if (kind !== 'workspace-path') {
            continue;
        }
        const normalizedPath = normalizePacketPath(ref.path, options);
        if (!normalizedPath) {
            continue;
        }
        const key = `${kind}:${normalizedPath}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({
            kind,
            path: normalizedPath,
            type: normalizeOptionalString(ref.type),
            label: normalizeOptionalString(ref.label),
        });
    }
    return out;
}

function normalizeAttachments(attachments = [], options = {}) {
    const out = [];
    for (const entry of attachments) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const localPath = normalizePacketPath(entry.localPath ?? entry.path ?? '', options);
        out.push({
            id: normalizeOptionalString(entry.id),
            filename: normalizeOptionalString(entry.filename ?? entry.name),
            mime: normalizeOptionalString(entry.mime ?? entry.mimeType),
            size: Number.isFinite(entry.size) ? entry.size : null,
            localPath,
        });
    }
    return out;
}

function normalizeSource(value, normalizedMessage) {
    const source = normalizeOptionalString(value);
    if (source) {
        return source;
    }
    return normalizedMessage ? 'webchat-envelope' : 'cli';
}

function normalizeAbsoluteDir(value) {
    const raw = normalizeOptionalString(value);
    return raw ? path.resolve(raw) : null;
}

function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }
    const text = String(value).trim();
    return text || null;
}

function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

function isPathEscape(relativePath) {
    return !relativePath
        ? false
        : relativePath === '..'
            || relativePath.startsWith('../')
            || path.isAbsolute(relativePath);
}
