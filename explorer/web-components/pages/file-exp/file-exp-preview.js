import {
    isImageFile,
    isAudioFile,
    isVideoFile,
    isPdfFile,
    renderCodePreview,
    scrollToLine,
    scrollPreviewToAnchor,
    clearLineHighlight
} from "./file-exp-utils.js";
import {
    callExplorerTool,
    extractToolText,
    parseToolResult
} from "../../../services/infrastructure/explorerApi.js";
import { withTimeout } from "../../utils/workspace-search-utils.js";
import { isDpuVirtualPath, openDpuFile } from "./file-exp-dpu-provider.js";
import { tryLoadOnlyOfficePreview } from "../../../services/onlyoffice/onlyoffice-preview-service.js";

const DEFAULT_FILE_READ_TIMEOUT_MS = 12000;

function resolveFileReadTimeoutMs(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FILE_READ_TIMEOUT_MS;
    return parsed;
}

export async function tryLoadMediaPreview(fileExp, filePath, { requestTimeoutMs = DEFAULT_FILE_READ_TIMEOUT_MS } = {}) {
    const isMedia = isImageFile(filePath) || isAudioFile(filePath) || isVideoFile(filePath);
    if (!isMedia) {
        return false;
    }
    try {
        const result = await withTimeout(
            () => callExplorerTool('read_media_file', { path: filePath }, { raw: true, withLoader: false }),
            {
                timeoutMs: requestTimeoutMs,
                timeoutMessage: `Reading media timed out after ${Math.ceil(requestTimeoutMs / 1000)}s.`
            }
        );
        const parsedResult = parseToolResult(result) || result;
        const blocks = Array.isArray(parsedResult?.blocks) ? parsedResult.blocks : [];
        const content = Array.isArray(parsedResult?.content) ? parsedResult.content : [];
        const block = [...blocks, ...content].find((item) => item?.data || item?.resource?.uri);
        if (!block) {
            throw new Error('No media data returned.');
        }

        const mimeType = block.mimeType || block.resource?.mimeType || 'application/octet-stream';
        const src = block.resource?.uri
            ? block.resource.uri
            : `data:${mimeType};base64,${block.data}`;

        const type = block.type === 'image' || mimeType.startsWith('image/')
            ? 'image'
            : block.type === 'audio' || mimeType.startsWith('audio/')
                ? 'audio'
                : block.type === 'video' || mimeType.startsWith('video/')
                    ? 'video'
                    : 'resource';

        let markup = '';
        if (type === 'audio') {
            markup = `<audio controls class="media-audio" preload="metadata" src="${src}"></audio>`;
        } else if (type === 'video') {
            markup = `<video controls class="media-video" preload="metadata" src="${src}"></video>`;
        } else if (type === 'image') {
            markup = `<img src="${src}" alt="Preview of ${filePath.split('/').pop()}" class="media-image">`;
        } else {
            markup = `<a href="${src}" target="_blank" rel="noopener">Open media</a>`;
        }

        fileExp.setPreviewState({
            previewMode: 'media',
            mediaType: type,
            previewContent: markup,
            selectedIsMarkdown: false,
            fileContent: '',
            markdownTextView: false,
            documentId: null,
            hasUnsavedChanges: false,
            isEditing: false
        });
        return true;
    } catch (err) {
        console.warn('Media preview failed', err);
        fileExp.showStatus(err.message || 'Could not preview media file.', true);
        fileExp.setPreviewState({
            previewMode: 'code',
            mediaType: null
        });
        return false;
    }
}

export async function tryLoadPdfPreview(fileExp, filePath) {
    if (!isPdfFile(filePath)) {
        return false;
    }

    const src = fileExp.buildWebViewUrl(filePath);
    if (!src) {
        fileExp.showStatus('Could not build PDF preview URL.', true);
        return false;
    }

    const safeName = String(filePath || '').split('/').pop() || 'PDF document';
    const escapedSrc = src.replace(/"/g, '&quot;');
    const escapedTitle = safeName.replace(/"/g, '&quot;');

    fileExp.setPreviewState({
        previewMode: 'pdf',
        mediaType: 'pdf',
        previewContent: `<iframe class="media-pdf" src="${escapedSrc}" title="Preview of ${escapedTitle}"></iframe>`,
        selectedIsMarkdown: false,
        fileContent: '',
        markdownTextView: false,
        documentId: null,
        hasUnsavedChanges: false,
        isEditing: false
    });
    return true;
}

async function refreshMissingFileParent(fileExp, filePath) {
    const normalizedPath = fileExp.normalizePath(filePath || '');
    const parentPath = fileExp.parentPath(normalizedPath) || '/';
    fileExp.stopCurrentFileViewWatch?.();
    fileExp.caches.filePreview.invalidateForPath(normalizedPath);
    fileExp.caches.dirListing.invalidate(fileExp, parentPath);
    fileExp.updateNavigationLocation(parentPath, {
        selectedPath: null,
        resetContext: true,
        historyMode: 'replace',
        invalidate: false
    });
    const entries = await fileExp.scheduleDirectoryRevalidation(parentPath);
    fileExp.refreshPreviewUi?.();
    return Array.isArray(entries);
}

export async function openFile(fileExp, filePath, {
    largeFilePreviewLimitBytes,
    largeFilePreviewLines,
    showLoader = true,
    invalidate = true,
    requestTimeoutMs = null,
    suppressReadErrorStatus = false,
    preserveSaveStatus = false,
    onFileInfoRequested = null
}) {
    const effectiveTimeoutMs = resolveFileReadTimeoutMs(requestTimeoutMs);
    const run = async () => {
        try {
            clearLineHighlight(fileExp.element);
            fileExp.setPreviewState({
                previewMode: 'code',
                mediaType: null,
                fileLoadInfo: null,
                onlyOfficeConfig: null,
                onlyOfficeStatusText: '',
                onlyOfficeRuntimeState: null,
                externallyModified: false,
                savePending: preserveSaveStatus ? fileExp.state.savePending : false,
                lastSaveError: preserveSaveStatus ? fileExp.state.lastSaveError : '',
                lastEditorSaveAt: preserveSaveStatus ? fileExp.state.lastEditorSaveAt : 0,
                lastEditorSaveMode: preserveSaveStatus ? fileExp.state.lastEditorSaveMode : '',
                lastExternalReloadAt: 0,
                selectedFileVersionKey: '',
                selectedFileModifiedAt: '',
                selectedFileSize: null,
                dpuSelectedObjectId: null,
                dpuSelectedCanWrite: false,
                dpuSelectedUpdatedAt: '',
                dpuSelectedCanComment: false,
                dpuSelectedCommentCount: 0,
                dpuSelectedComments: [],
                dpuCommentsOpen: false,
                dpuSecretState: null
            });
            if (await tryLoadOnlyOfficePreview(fileExp, filePath, { invalidate })) {
                return true;
            }
            if (isDpuVirtualPath(filePath)) {
                await openDpuFile(fileExp, filePath, { invalidate });
                return true;
            }
            if (await tryLoadPdfPreview(fileExp, filePath)) {
                if (invalidate) {
                    fileExp.invalidate();
                } else {
                    fileExp.refreshPreviewUi();
                }
                return true;
            }
            if (await tryLoadMediaPreview(fileExp, filePath, { requestTimeoutMs: effectiveTimeoutMs })) {
                if (invalidate) {
                    fileExp.invalidate();
                } else {
                    fileExp.refreshPreviewUi();
                }
                return true;
            }

            const entry = (fileExp.state.allEntries || []).find((item) => item?.path === filePath);
            const entrySize = Number.isFinite(entry?.size) ? entry.size : null;
            const pendingHighlight = fileExp.state.pendingHighlight;
            const hasPendingForFile = pendingHighlight
                && fileExp.normalizePath(pendingHighlight.path || '') === fileExp.normalizePath(filePath);
            const pendingLine = hasPendingForFile
                ? Number.parseInt(String(pendingHighlight.line ?? ''), 10)
                : null;
            const effectivePendingLine = Number.isFinite(pendingLine) && pendingLine > 0 ? pendingLine : null;
            const previewLineBudget = effectivePendingLine
                ? Math.max(largeFilePreviewLines, effectivePendingLine + 80)
                : largeFilePreviewLines;
            const shouldPreviewPartial = entrySize !== null && entrySize > largeFilePreviewLimitBytes;
            const cacheKey = fileExp.caches.filePreview.buildKey(
                filePath,
                entry,
                shouldPreviewPartial,
                fileExp.state.workspaceVersion
            );
            const isBacklogFile = String(filePath || '').endsWith('.backlog') || String(filePath || '').endsWith('.history');
            const cachedPreview = (isBacklogFile || hasPendingForFile) ? null : fileExp.caches.filePreview.get(cacheKey);
            if (cachedPreview) {
                fileExp.setPreviewState({
                    fileContent: cachedPreview.fileContent,
                    selectedIsMarkdown: cachedPreview.selectedIsMarkdown,
                    previewContent: cachedPreview.previewContent,
                    previewMode: cachedPreview.previewMode,
                    fileLoadInfo: cachedPreview.fileLoadInfo,
                    markdownTextView: false,
                    documentId: null,
                    hasUnsavedChanges: false,
                    isEditing: false
                });
                if (fileExp.state.pendingHighlight && fileExp.state.pendingHighlight.path !== fileExp.normalizePath(filePath)) {
                    fileExp.setPendingHighlight(null);
                }
                if (invalidate) {
                    fileExp.invalidate();
                } else {
                    fileExp.refreshPreviewUi();
                }
                return true;
            }

            const isPayloadTooLargeError = (error) => {
                const message = error?.message || '';
                return /payloadtoo?large/i.test(message) || /entity too large/i.test(message) || error?.status === 413;
            };

            const readText = async (usePartial = false) => {
                const args = { path: filePath };
                if (usePartial) {
                    args.head = previewLineBudget;
                }
                return withTimeout(
                    () => callExplorerTool('read_text_file', args, { raw: true, withLoader: false }),
                    {
                        timeoutMs: effectiveTimeoutMs,
                        timeoutMessage: `Reading file timed out after ${Math.ceil(effectiveTimeoutMs / 1000)}s.`
                    }
                );
            };

            // The version info is requested first and the content right after it, without waiting in between.
            // The baseline taken from this info is then never newer than the content, so a change that lands
            // between the two requests is detected as a reload instead of being missed.
            if (typeof onFileInfoRequested === 'function' && typeof fileExp.refreshSelectedFileVersionInfo === 'function') {
                const fileInfoPromise = fileExp.refreshSelectedFileVersionInfo(filePath);
                // The baseline consumer reports a failure; a read that fails first must not leave it unhandled.
                fileInfoPromise.catch(() => {});
                onFileInfoRequested(fileInfoPromise);
            }

            let contentResult;
            let truncated = false;
            try {
                contentResult = await readText(shouldPreviewPartial);
                truncated = shouldPreviewPartial;
            } catch (error) {
                if (!shouldPreviewPartial && isPayloadTooLargeError(error)) {
                    contentResult = await readText(true);
                    truncated = true;
                } else {
                    throw error;
                }
            }

            const fileLoadInfo = truncated ? {
                truncated: true,
                size: entrySize,
                previewLines: previewLineBudget,
                message: `File is ${entrySize ? fileExp.formatBytes(entrySize) : 'large'}; showing first ${previewLineBudget} lines. Editing is disabled in this view.`
            } : null;

            const fileContent = extractToolText(contentResult);
            const selectedIsMarkdown = fileExp.isMarkdownFile(filePath);
            const useMarkdownTextViewForHighlight = Boolean(hasPendingForFile && selectedIsMarkdown);
            const previewContent = selectedIsMarkdown ? '' : renderCodePreview(fileContent, filePath);
            const previewMode = selectedIsMarkdown ? 'markdown' : 'code';

            fileExp.setPreviewState({
                fileLoadInfo,
                fileContent,
                selectedIsMarkdown,
                markdownTextView: useMarkdownTextViewForHighlight,
                documentId: null,
                dpuSelectedObjectId: null,
                dpuSelectedCanWrite: false,
                dpuSelectedUpdatedAt: '',
                dpuSelectedCanComment: false,
                dpuSelectedCommentCount: 0,
                dpuSelectedComments: [],
                dpuCommentsOpen: false,
                dpuSecretState: null,
                hasUnsavedChanges: false,
                previewContent,
                previewMode,
                mediaType: null,
                isEditing: false
            });
            if (!isBacklogFile) {
                fileExp.caches.filePreview.set(cacheKey, {
                    fileContent: fileExp.state.fileContent,
                    selectedIsMarkdown: fileExp.state.selectedIsMarkdown,
                    previewContent: fileExp.state.selectedIsMarkdown ? '' : fileExp.state.previewContent,
                    previewMode: fileExp.state.previewMode,
                    fileLoadInfo: fileExp.state.fileLoadInfo
                });
            }
            if (fileExp.state.pendingHighlight && fileExp.state.pendingHighlight.path !== fileExp.normalizePath(filePath)) {
                fileExp.setPendingHighlight(null);
            }
            if (invalidate) {
                fileExp.invalidate();
            } else {
                fileExp.refreshPreviewUi();
            }
            return true;
        } catch (err) {
            const pathNotFound = fileExp.isPathNotFoundError?.(err);
            let directoryRefreshed = false;
            if (pathNotFound) {
                try {
                    directoryRefreshed = await refreshMissingFileParent(fileExp, filePath);
                } catch (refreshError) {
                    console.warn('Failed to refresh directory after a missing file was selected', refreshError);
                }
            } else if (!err?.sessionExpiredHandled) {
                console.error(err);
            }
            if (!suppressReadErrorStatus) {
                fileExp.showStatus(
                    pathNotFound
                        ? directoryRefreshed
                            ? 'The selected file no longer exists. The directory was refreshed.'
                            : 'The selected file no longer exists.'
                        : err?.sessionExpiredHandled
                        ? 'Your session has expired. Redirecting to sign in...'
                        : (err.message || 'Failed to read file.'),
                    true
                );
            }
            return false;
        }
    };

    if (showLoader) {
        return fileExp.withLoader(run);
    }
    return run();
}

export function attachPreviewAnchorHandler(fileExp) {
    const previewRoot = fileExp.element.querySelector('#filePreview');
    if (!previewRoot) {
        return;
    }
    previewRoot.removeEventListener('click', fileExp.boundPreviewAnchorHandler);
    previewRoot.addEventListener('click', fileExp.boundPreviewAnchorHandler);
}

export function detachPreviewAnchorHandler(fileExp) {
    const previewRoot = fileExp.element.querySelector('#filePreview');
    if (!previewRoot) {
        return;
    }
    previewRoot.removeEventListener('click', fileExp.boundPreviewAnchorHandler);
}

export function handlePreviewAnchorClick(fileExp, event) {
    const anchor = event.target?.closest?.('a[href^="#"]');
    if (!anchor) {
        return;
    }
    const href = anchor.getAttribute('href');
    if (!href || href.length <= 1) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    const targetId = href.slice(1);
    if (!targetId) {
        return;
    }
    const previewRoot = fileExp.element.querySelector('#filePreview');
    if (!previewRoot) {
        return;
    }
    scrollPreviewToAnchor(previewRoot, targetId);
}
