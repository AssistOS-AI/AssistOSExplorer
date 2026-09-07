import { isOnlyOfficeFile } from './onlyoffice-file-types.js';
import { isOnlyOfficeEditorActive } from './onlyoffice-editor-host.js';
import { isAgentRuntimeStartupError, readMarketplaceAgent } from '../../shared/ui/agent-runtime-loader/agent-runtime-loader.js';

// Reusing a cached session re-points the editor at a documentUrl/callbackUrl
// that embed the server-side session token (idle TTL is 30 minutes server
// side). Keep the client reuse window comfortably below that so a remount
// never hands OnlyOffice an expired download URL.
const SESSION_REUSE_MAX_AGE_MS = 5 * 60 * 1000;

function buildSessionUrl(filePath) {
    const params = new URLSearchParams({ path: String(filePath || '') });
    return `/base-agent-additional-server/onlyOffice/7000/control/office/session?${params.toString()}`;
}

async function readJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return await response.json();
    }
    const text = await response.text();
    return text ? { ok: false, error: text } : {};
}

export async function fetchOnlyOfficeSession(filePath) {
    const response = await fetch(buildSessionUrl(filePath), {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
            accept: 'application/json'
        }
    });
    const payload = await readJsonResponse(response);
    if (!response.ok || payload?.ok === false) {
        const errorMessage = payload?.error || `OnlyOffice session request failed with ${response.status}.`;
        const error = new Error(errorMessage);
        error.status = response.status;
        error.code = payload?.error || '';
        throw error;
    }
    return payload;
}

function normalizeSessionPath(fileExp, filePath) {
    return typeof fileExp?.normalizePath === 'function'
        ? fileExp.normalizePath(filePath || '')
        : String(filePath || '');
}

function getSessionSlot(fileExp) {
    const slot = fileExp?.caches?.officeSession;
    return slot && typeof slot.get === 'function' && typeof slot.set === 'function' ? slot : null;
}

function getEditorHost(fileExp) {
    return fileExp?.previewDom?.componentMount
        || fileExp?.element?.querySelector?.('.preview-component-mount.onlyoffice-editor-host')
        || null;
}

function buildSessionVersionHint(fileExp, normalizedPath) {
    const entry = typeof fileExp?.getEntryByPath === 'function'
        ? fileExp.getEntryByPath(normalizedPath)
        : null;
    if (!entry) {
        return '';
    }
    const modified = entry.modified || entry.updatedAt || '';
    const size = Number.isFinite(entry.size) ? String(entry.size) : '';
    if (!modified && !size) {
        // No real version signal (typical for some DPU entries): report no
        // hint so canReuseSession refuses time-window reuse and only the
        // live-editor case keeps the session.
        return '';
    }
    return `${modified}|${size}`;
}

function canReuseSession(fileExp, entry, versionHint) {
    if (!entry?.session) {
        return false;
    }
    // The mounted editor already consumed this exact config; reusing it costs
    // nothing and keeps the iframe alive, so age does not matter here.
    if (isOnlyOfficeEditorActive(getEditorHost(fileExp), entry.session.config)) {
        return true;
    }
    if (versionHint && entry.versionHint && versionHint !== entry.versionHint) {
        return false;
    }
    if (!versionHint || !entry.versionHint) {
        // No version information to compare; only the live-editor case above
        // is safe to reuse indefinitely.
        return false;
    }
    return Number.isFinite(entry.fetchedAt) && (Date.now() - entry.fetchedAt) < SESSION_REUSE_MAX_AGE_MS;
}

export function invalidateOnlyOfficeSession(fileExp, filePath = null) {
    const slot = getSessionSlot(fileExp);
    if (!slot) {
        return;
    }
    if (filePath === null || filePath === undefined) {
        slot.clear();
        return;
    }
    slot.invalidateForPath(normalizeSessionPath(fileExp, filePath));
}

async function resolveOnlyOfficeSession(fileExp, normalizedPath) {
    const slot = getSessionSlot(fileExp);
    if (!slot) {
        return await fetchOnlyOfficeSession(normalizedPath);
    }

    const versionHint = buildSessionVersionHint(fileExp, normalizedPath);
    const current = slot.get();
    if (current?.path === normalizedPath) {
        if (current.promise) {
            return await current.promise;
        }
        if (canReuseSession(fileExp, current, versionHint)) {
            return current.session;
        }
    }

    const promise = fetchOnlyOfficeSession(normalizedPath);
    slot.set({ path: normalizedPath, promise });
    try {
        const session = await promise;
        if (slot.get()?.promise === promise) {
            slot.set({
                path: normalizedPath,
                session,
                versionHint,
                fetchedAt: Date.now()
            });
        }
        return session;
    } catch (error) {
        if (slot.get()?.promise === promise) {
            slot.clear();
        }
        throw error;
    }
}

export async function tryLoadOnlyOfficePreview(fileExp, filePath, { invalidate = true, deferRuntimeStartup = true } = {}) {
    if (!isOnlyOfficeFile(filePath)) {
        return false;
    }

    const normalizedPath = normalizeSessionPath(fileExp, filePath);
    let session;
    try {
        session = await resolveOnlyOfficeSession(fileExp, normalizedPath);
    } catch (error) {
        if (!deferRuntimeStartup) throw error;
        // A disabled agent may have no session route. Distinguish that from
        // an enabled editor reporting a missing document.
        const runtime = !isAgentRuntimeStartupError(error) && Number(error?.status) === 404
            ? await readMarketplaceAgent('AchillesIDE/onlyOffice') : null;
        if (!isAgentRuntimeStartupError(error) && runtime?.active !== false) throw error;
        fileExp.setPreviewState({
            previewMode: 'onlyoffice',
            mediaType: null,
            onlyOfficeConfig: null,
            onlyOfficeStatusText: 'Starting OnlyOffice…',
            onlyOfficeRuntimeState: { path: normalizedPath }
        });
        if (invalidate) fileExp.invalidate();
        else fileExp.refreshPreviewUi();
        return true;
    }
    const preview = session?.preview && typeof session.preview === 'object' ? session.preview : {};
    // When the editor already shows this exact config, skip the full
    // invalidate(): a full render rebuilds the component DOM and would force
    // a fresh editor iframe even though nothing changed.
    const editorAlreadyLive = isOnlyOfficeEditorActive(getEditorHost(fileExp), session?.config || null);

    fileExp.setPreviewState({
        previewMode: 'onlyoffice',
        mediaType: null,
        previewContent: '',
        selectedIsMarkdown: false,
        fileContent: '',
        markdownTextView: false,
        documentId: null,
        hasUnsavedChanges: false,
        isEditing: false,
        onlyOfficeConfig: session?.config || null,
        onlyOfficeStatusText: '',
        onlyOfficeRuntimeState: null,
        dpuSelectedObjectId: preview.objectId || null,
        dpuSelectedCanWrite: Boolean(preview.canWrite),
        dpuSelectedCanComment: Boolean(preview.canComment),
        dpuSelectedCommentCount: 0,
        dpuSelectedComments: [],
        dpuCommentsOpen: false,
        fileLoadInfo: null
    });

    if (invalidate && !editorAlreadyLive) {
        fileExp.invalidate();
    } else {
        fileExp.refreshPreviewUi();
    }
    return true;
}
