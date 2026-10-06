import { isDpuVirtualPath } from "./file-exp-dpu-provider.js";
import { FILE_EXP_UI_ACTIONS } from "./file-exp-ui-controller.js";
import { PREVIEW_ACTIONS } from "./file-exp-preview-controller.js";

const CURRENT_FILE_VIEW_CHECK_INTERVAL_MS = 30000;

function canMonitorCurrentFileView(fileExp, pathValue = fileExp?.state?.selectedPath) {
    const selectedPath = String(pathValue || '').trim();
    if (!selectedPath) return false;
    if (isDpuVirtualPath(selectedPath)) return false;
    if (fileExp?.state?.isEditing) return false;
    if (String(fileExp?.state?.previewMode || '').trim().toLowerCase() === 'none') return false;
    return true;
}

export function stopCurrentFileViewWatch(fileExp) {
    if (fileExp?.currentFileViewWatchTimer) {
        window.clearInterval(fileExp.currentFileViewWatchTimer);
        fileExp.currentFileViewWatchTimer = null;
    }
    fileExp.currentFileViewWatchInFlight = false;
}

// `infoPromise` is a version info request for the same path that was started before the file content was read;
// using it keeps the baseline from being newer than the content.
export async function refreshCurrentFileViewBaseline(fileExp, pathValue = fileExp?.state?.selectedPath, infoPromise = null) {
    if (!canMonitorCurrentFileView(fileExp, pathValue)) {
        stopCurrentFileViewWatch(fileExp);
        return null;
    }
    try {
        const info = await (infoPromise || fileExp.refreshSelectedFileVersionInfo(pathValue));
        if (!info || fileExp?.normalizePath?.(fileExp.state.selectedPath || '') !== fileExp?.normalizePath?.(pathValue || '')) {
            return null;
        }
        fileExp.setPreviewState({
            selectedFileVersionKey: String(info.versionKey || ''),
            selectedFileModifiedAt: String(info.modified || ''),
            selectedFileSize: Number.isFinite(info.size) ? info.size : null
        }, { invalidate: false });
        return info;
    } catch (error) {
        console.warn('Failed to refresh current file baseline', error);
        return null;
    }
}

async function reloadCurrentFileView(fileExp, pathValue, latestInfo = null) {
    const normalizedPath = fileExp?.normalizePath?.(pathValue || '') || '';
    if (!normalizedPath) return;
    fileExp?.caches?.filePreview?.invalidateForPath?.(normalizedPath);
    fileExp?.caches?.dirListing?.invalidate?.(fileExp, fileExp.state.path);
    await fileExp.openFile(normalizedPath, {
        showLoader: false,
        invalidate: false,
        suppressReadErrorStatus: true,
        audit: false
    });
    const effectiveInfo = latestInfo || await refreshCurrentFileViewBaseline(fileExp, normalizedPath);
    fileExp.setPreviewState({
        lastExternalReloadAt: Date.now(),
        selectedFileVersionKey: String(effectiveInfo?.versionKey || fileExp.state.selectedFileVersionKey || ''),
        selectedFileModifiedAt: String(effectiveInfo?.modified || fileExp.state.selectedFileModifiedAt || ''),
        selectedFileSize: Number.isFinite(effectiveInfo?.size) ? effectiveInfo.size : fileExp.state.selectedFileSize
    }, { invalidate: false });
    fileExp.refreshPreviewUi();
    fileExp.showStatus('Updated to the latest file version.', false);
}

export async function pollCurrentFileView(fileExp) {
    if (fileExp?.currentFileViewWatchInFlight) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!canMonitorCurrentFileView(fileExp)) {
        stopCurrentFileViewWatch(fileExp);
        return;
    }

    const currentPath = String(fileExp.state.selectedPath || '');
    const baselineVersionKey = String(fileExp.state.selectedFileVersionKey || '');
    fileExp.currentFileViewWatchInFlight = true;
    try {
        const latestInfo = await fileExp.refreshSelectedFileVersionInfo(currentPath);
        if (!latestInfo?.versionKey) return;
        if (fileExp?.normalizePath?.(fileExp.state.selectedPath || '') !== fileExp?.normalizePath?.(currentPath)) {
            return;
        }
        if (!baselineVersionKey) {
            fileExp.setPreviewState({
                selectedFileVersionKey: String(latestInfo.versionKey || ''),
                selectedFileModifiedAt: String(latestInfo.modified || ''),
                selectedFileSize: Number.isFinite(latestInfo.size) ? latestInfo.size : null
            }, { invalidate: false });
            return;
        }
        if (latestInfo.versionKey !== baselineVersionKey) {
            await reloadCurrentFileView(fileExp, currentPath, latestInfo);
        }
    } catch (error) {
        if (fileExp?.isPathNotFoundError?.(error)) {
            if (fileExp?.normalizePath?.(fileExp.state.selectedPath || '') === fileExp?.normalizePath?.(currentPath)) {
                stopCurrentFileViewWatch(fileExp);
                fileExp.dispatchUi?.({ type: FILE_EXP_UI_ACTIONS.RESET_DIRECTORY_CONTEXT });
                fileExp.dispatchPreview?.({ type: PREVIEW_ACTIONS.RESET });
                fileExp.refreshPreviewUi?.();
                fileExp.showStatus?.('The selected file no longer exists.', true);
            }
            return;
        }
        console.warn('Failed to poll current file view', error);
    } finally {
        fileExp.currentFileViewWatchInFlight = false;
    }
}

export function startCurrentFileViewWatch(fileExp) {
    stopCurrentFileViewWatch(fileExp);
    if (!canMonitorCurrentFileView(fileExp)) return;
    fileExp.currentFileViewWatchTimer = window.setInterval(() => {
        void pollCurrentFileView(fileExp);
    }, CURRENT_FILE_VIEW_CHECK_INTERVAL_MS);
}
