import { PREVIEW_ACTIONS } from "./file-exp-preview-controller.js";
import { renderCodePreview } from "./file-exp-utils.js";
import { getPreviewUiState } from "./file-exp-preview-state.js";
import { isDpuSecretPath, isDpuVirtualPath, openDpuFile, readDpuCurrentItemState, updateDpuFile, updateDpuSecret } from "./file-exp-dpu-provider.js";
import { startCurrentFileViewWatch, stopCurrentFileViewWatch } from "./file-exp-current-file-monitor.js";
import { emitAuditEvent } from "../../../services/audit/auditService.js";
import {
    applyMarkdownCrdtChange,
    openMarkdownCrdtDocument,
    saveMarkdownCrdtDocument,
    syncMarkdownCrdtFromFile
} from "../../../services/crdt/markdownCrdtClient.js";

function extractDpuUpdatedAt(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return '';
    if (snapshot.kind === 'secret') {
        return String(snapshot.secret?.updatedAt || '');
    }
    if (snapshot.kind === 'confidential') {
        return String(snapshot.object?.updatedAt || '');
    }
    return '';
}

async function ensureMarkdownCrdtEditableShape(crdt, selectedPath) {
    let current = crdt;
    const documentId = String(current?.documentId || '');
    if (!documentId) {
        throw new Error('Unable to resolve Markdown CRDT document id.');
    }
    const chapters = Array.isArray(current?.model?.chapters) ? current.model.chapters : [];
    let changed = false;
    for (const chapter of chapters) {
        if (!chapter?.id || Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0) {
            continue;
        }
        current = await applyMarkdownCrdtChange(documentId, {
            type: 'addParagraph',
            chapterId: chapter.id,
            position: 0,
            paragraph: {
                text: '',
                metadata: {
                    type: 'markdown',
                    comments: { messages: [] }
                }
            }
        });
        changed = true;
    }
    if (changed) {
        current = await saveMarkdownCrdtDocument({
            documentId,
            path: selectedPath
        });
    }
    return current;
}

const MARKDOWN_CRDT_EDIT_CHECK_INTERVAL_MS = 5000;

function getMarkdownCrdtRevision(crdt) {
    const heads = Array.isArray(crdt?.heads) ? crdt.heads.map((head) => String(head)).sort() : [];
    const headsKey = heads.join('|');
    const versionKey = String(crdt?.versionKey || '');
    if (headsKey) {
        return `heads:${headsKey}`;
    }
    if (versionKey) {
        return `version:${versionKey}`;
    }
    return '';
}

export function stopMarkdownCrdtEditWatch(fileExp) {
    if (fileExp?.markdownCrdtEditWatchTimer) {
        window.clearInterval(fileExp.markdownCrdtEditWatchTimer);
        fileExp.markdownCrdtEditWatchTimer = null;
    }
    fileExp.markdownCrdtEditWatchInFlight = false;
    fileExp.markdownCrdtEditPending = null;
}

async function applyLatestMarkdownCrdtDocument(fileExp, latestCrdt) {
    const selectedPath = String(fileExp?.state?.selectedPath || '');
    if (!selectedPath || !fileExp?.state?.isEditing || !fileExp.state.selectedIsMarkdown) {
        return false;
    }
    const documentPresenter = fileExp.element?.querySelector('document-view-page')?.webSkelPresenter || null;
    if (!documentPresenter || typeof documentPresenter.applyRemoteMarkdownDocument !== 'function') {
        return false;
    }
    const latestDocument = latestCrdt?.model;
    if (!latestDocument || typeof latestDocument !== 'object') {
        return false;
    }
    return documentPresenter.applyRemoteMarkdownDocument(latestDocument, {
        revision: getMarkdownCrdtRevision(latestCrdt)
    });
}

export async function pollMarkdownCrdtEditWatch(fileExp) {
    if (fileExp?.markdownCrdtEditWatchInFlight) {
        return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
        return;
    }
    const selectedPath = String(fileExp?.state?.selectedPath || '');
    if (!selectedPath || !fileExp?.state?.isEditing || !fileExp.state.selectedIsMarkdown) {
        stopMarkdownCrdtEditWatch(fileExp);
        return;
    }
    const documentPresenter = fileExp.element?.querySelector('document-view-page')?.webSkelPresenter || null;
    if (typeof documentPresenter?.hasBlockingLocalEdit === 'function' && documentPresenter.hasBlockingLocalEdit()) {
        return;
    }
    fileExp.markdownCrdtEditWatchInFlight = true;
    try {
        const latest = await openMarkdownCrdtDocument(selectedPath);
        const latestRevision = getMarkdownCrdtRevision(latest);
        if (!latestRevision) {
            return;
        }
        if (!fileExp.markdownCrdtEditRevision) {
            fileExp.markdownCrdtEditRevision = latestRevision;
            return;
        }
        if (latestRevision === fileExp.markdownCrdtEditRevision) {
            return;
        }
        if (fileExp.markdownCrdtEditPending?.revision === latestRevision) {
            return;
        }
        if (fileExp?.normalizePath?.(fileExp.state.selectedPath || '') !== fileExp?.normalizePath?.(selectedPath)) {
            return;
        }
        const applied = await applyLatestMarkdownCrdtDocument(fileExp, latest);
        if (applied) {
            fileExp.markdownCrdtEditRevision = latestRevision;
            fileExp.markdownCrdtEditPending = null;
            fileExp.setPreviewState?.({ lastExternalReloadAt: Date.now() }, { invalidate: false });
        } else {
            fileExp.markdownCrdtEditPending = {
                revision: latestRevision,
                crdt: latest
            };
        }
    } catch (error) {
        console.warn('Failed to poll Markdown CRDT edit session', error);
    } finally {
        fileExp.markdownCrdtEditWatchInFlight = false;
    }
}

export function startMarkdownCrdtEditWatch(fileExp, crdt = null) {
    stopMarkdownCrdtEditWatch(fileExp);
    if (!fileExp?.state?.selectedPath || !fileExp.state.selectedIsMarkdown || !fileExp.state.isEditing) {
        return;
    }
    fileExp.markdownCrdtEditRevision = getMarkdownCrdtRevision(crdt);
    fileExp.markdownCrdtEditWatchTimer = window.setInterval(() => {
        void pollMarkdownCrdtEditWatch(fileExp);
    }, MARKDOWN_CRDT_EDIT_CHECK_INTERVAL_MS);
}

export async function applyPendingMarkdownCrdtEdit(fileExp) {
    const pending = fileExp?.markdownCrdtEditPending;
    if (!pending?.crdt) {
        return false;
    }
    const applied = await applyLatestMarkdownCrdtDocument(fileExp, pending.crdt);
    if (!applied) {
        return false;
    }
    fileExp.markdownCrdtEditRevision = String(pending.revision || getMarkdownCrdtRevision(pending.crdt));
    fileExp.markdownCrdtEditPending = null;
    fileExp.setPreviewState?.({ lastExternalReloadAt: Date.now() }, { invalidate: false });
    return true;
}

export async function editFile(fileExp) {
    if (!fileExp?.state?.selectedPath) return;
    stopMarkdownCrdtEditWatch(fileExp);
    if (window.assistOS?.workspace) {
        window.assistOS.workspace.currentMarkdownCrdtDocument = null;
    }
    const selectedPath = fileExp.state.selectedPath || '';
    if (isDpuSecretPath(selectedPath)) {
        await fileExp.beginDpuSecretInlineEdit?.();
        return;
    }
    const isDpuPath = isDpuVirtualPath(selectedPath);
    if (selectedPath.endsWith('.history')) {
        fileExp.showStatus('History files are read-only.', true);
        return;
    }
    const previewUiState = getPreviewUiState(fileExp.state);
    if (selectedPath.endsWith('.backlog') && previewUiState.showBacklogPanel) {
        fileExp.showStatus('Backlog is managed by the Backlog panel.', true);
        return;
    }
    if (fileExp.state.fileLoadInfo?.truncated) {
        fileExp.showStatus('Editing is disabled for large files. Please open it locally to modify.', true);
        return;
    }
    if (isDpuPath) {
        try {
            await openDpuFile(fileExp, selectedPath, {
                invalidate: false
            });
        } catch (error) {
            console.warn('Failed to refresh DPU item before edit', error);
            fileExp.showStatus(error?.message || 'Failed to refresh DPU item before edit.', true);
            return;
        }
    } else {
        try {
            const info = await fileExp.refreshSelectedFileVersionInfo(selectedPath);
            fileExp.setPreviewState({
                selectedFileVersionKey: String(info?.versionKey || ''),
                selectedFileModifiedAt: String(info?.modified || ''),
                selectedFileSize: Number.isFinite(info?.size) ? info.size : null,
                externallyModified: false,
                savePending: false,
                lastSaveError: '',
                lastEditorSaveAt: 0,
                lastEditorSaveMode: ''
            }, { invalidate: false });
        } catch (error) {
            console.warn('Failed to capture file version before edit', error);
            fileExp.showStatus(error?.message || 'Failed to prepare edit session for this file.', true);
            return;
        }
    }
    fileExp.setPreviewState({
        documentId: null,
        markdownTextView: false,
        hasUnsavedChanges: false,
        savePending: false,
        isEditing: true,
        lastExternalReloadAt: 0
    });
    stopCurrentFileViewWatch(fileExp);
    fileExp.handleEditorBufferChange?.();
    if (!isDpuPath && !fileExp.state.selectedIsMarkdown) {
        fileExp.startEditorExternalWatch?.();
    }
    fileExp.refreshPreviewUi();
}

export async function editSoplangMarkdown(fileExp) {
    if (!fileExp?.state?.selectedPath || !fileExp.state.selectedIsMarkdown) {
        fileExp?.showStatus?.('Select a Markdown file first.', true);
        return;
    }
    const selectedPath = fileExp.state.selectedPath || '';
    if (selectedPath.endsWith('.history')) {
        fileExp.showStatus('History files are read-only.', true);
        return;
    }
    if (fileExp.state.fileLoadInfo?.truncated) {
        fileExp.showStatus('SOPLang tag editing is disabled for large files.', true);
        return;
    }
    try {
        let crdt = await openMarkdownCrdtDocument(selectedPath);
        crdt = await ensureMarkdownCrdtEditableShape(crdt, selectedPath);
        fileExp.setPreviewState({
            documentId: selectedPath,
            markdownTextView: false,
            hasUnsavedChanges: false,
            savePending: false,
            isEditing: true,
            lastExternalReloadAt: Date.now()
        });
        if (window.assistOS?.workspace) {
            window.assistOS.workspace.currentDocumentId = selectedPath;
            window.assistOS.workspace.currentDocumentMetadataId = crdt?.documentId || '';
            window.assistOS.workspace.currentDocumentPath = selectedPath;
            window.assistOS.workspace.currentMarkdownCrdtDocument = {
                ...crdt,
                path: selectedPath
            };
        }
        stopCurrentFileViewWatch(fileExp);
        startMarkdownCrdtEditWatch(fileExp, crdt);
        fileExp.refreshPreviewUi();
    } catch (error) {
        console.warn('Failed to prepare SOPLang tag editor', error);
        fileExp.showStatus(error?.message || 'Failed to open SOPLang tag editor.', true);
    }
}

export async function saveFile(fileExp, options = {}) {
    if (fileExp._saveFileInProgress || fileExp.state.savePending) {
        return;
    }
    fileExp.textarea = fileExp.element.querySelector('.code-input');
    if (!fileExp.textarea) {
        return;
    }

    const preserveEditing = Boolean(options?.preserveEditing);
    const autoSave = Boolean(options?.autoSave);
    const newContent = fileExp.textarea.value;
    let savedContent = newContent;
    const selectedPath = fileExp.state.selectedPath || '';
    const isDpuPath = isDpuVirtualPath(selectedPath);
    const isExternalModificationError = (error) => /updated externally/i.test(String(error?.message || ''));
    let markdownCrdtDocumentId = '';
    let markdownInfoMessage = '';
    fileExp._saveFileInProgress = true;
    try {
        fileExp.setPreviewState({ savePending: true, lastSaveError: '' }, { invalidate: false });
        fileExp.refreshPreviewUi();
        let markdownEditorPresenter = null;
        if (!isDpuPath && fileExp.state.selectedIsMarkdown) {
            markdownEditorPresenter = fileExp.element.querySelector('markdown-editor')?.webSkelPresenter || null;
            markdownCrdtDocumentId = String(markdownEditorPresenter?.crdtDocumentId || '');
            if (!markdownEditorPresenter || typeof markdownEditorPresenter.flushPendingCrdtChange !== 'function') {
                throw new Error('Markdown editor is not ready. Wait for the editor to finish loading before saving.');
            }
            await markdownEditorPresenter.flushPendingCrdtChange();
            markdownCrdtDocumentId = String(markdownEditorPresenter.crdtDocumentId || markdownCrdtDocumentId);
            if (!markdownCrdtDocumentId) {
                throw new Error('Markdown CRDT document id is not available.');
            }
        }
        if (isDpuPath) {
            if (!fileExp.state.dpuSelectedCanWrite) {
                throw new Error('You do not have permission to save this DPU file.');
            }
            const latestSnapshot = await readDpuCurrentItemState(fileExp, selectedPath);
            const latestUpdatedAt = extractDpuUpdatedAt(latestSnapshot);
            const editBaselineUpdatedAt = String(fileExp.state.dpuSelectedUpdatedAt || '');
            if (editBaselineUpdatedAt && latestUpdatedAt && latestUpdatedAt !== editBaselineUpdatedAt) {
                await openDpuFile(fileExp, selectedPath, {
                    invalidate: false
                });
                throw new Error('This item was updated by another user. Review the latest version and apply your changes again.');
            }
            if (isDpuSecretPath(selectedPath)) {
                await updateDpuSecret(fileExp, fileExp.state.selectedPath, {
                    value: newContent
                });
            } else {
                if (!fileExp.state.dpuSelectedObjectId) {
                    throw new Error('You do not have permission to save this Confidential file.');
                }
                await updateDpuFile(fileExp, fileExp.state.selectedPath, {
                    content: newContent
                });
            }
        } else {
            if (!fileExp.state.selectedIsMarkdown && fileExp.state.externallyModified) {
                throw new Error('This file was updated externally. Reload it before saving again.');
            }
            const latestInfo = await fileExp.refreshSelectedFileVersionInfo(selectedPath);
            const baselineVersionKey = String(fileExp.state.selectedFileVersionKey || '');
            if (!fileExp.state.selectedIsMarkdown && baselineVersionKey && latestInfo?.versionKey && latestInfo.versionKey !== baselineVersionKey) {
                await fileExp.markExternalModificationDetected({ silent: true });
                throw new Error('This file was updated externally. Reload it before saving again.');
            }
            if (fileExp.state.selectedIsMarkdown) {
                const saveResult = await saveMarkdownCrdtDocument({
                    documentId: markdownCrdtDocumentId || markdownEditorPresenter?.crdtDocumentId || '',
                    path: fileExp.state.selectedPath
                });
                if (typeof saveResult?.markdown === 'string') {
                    savedContent = saveResult.markdown;
                }
                if (Array.isArray(saveResult?.warnings) && saveResult.warnings.length > 0) {
                    markdownInfoMessage = saveResult.warnings.join(' ');
                }
            } else {
                await fileExp.tooling.writeFile(fileExp.state.selectedPath, newContent);
            }
            fileExp.bumpWorkspaceVersion?.();
            fileExp.caches.filePreview.invalidateForPath(fileExp.state.selectedPath);
            fileExp.caches.dirListing.invalidate(fileExp, fileExp.state.path);
        }

        let latestSavedVersion = null;
        if (!isDpuPath) {
            latestSavedVersion = await fileExp.refreshSelectedFileVersionInfo(selectedPath);
        }
        if (!autoSave) {
            fileExp.showStatus(markdownInfoMessage || `Successfully saved ${selectedPath}`, false);
        }
        void emitAuditEvent('file.update', {
            path: selectedPath,
            currentPath: fileExp.normalizePath(fileExp.state.path || '/'),
            selectedPath: fileExp.normalizePath(selectedPath),
            metadata: {
                autoSave,
                preserveEditing,
                isDpu: isDpuPath
            }
        });
        fileExp.setPreviewState({
            fileContent: savedContent,
            hasUnsavedChanges: false,
            lastSaveError: '',
            lastEditorSaveAt: Date.now(),
            lastEditorSaveMode: autoSave ? 'auto' : 'manual',
            externallyModified: false,
            selectedFileVersionKey: String(latestSavedVersion?.versionKey || fileExp.state.selectedFileVersionKey || ''),
            selectedFileModifiedAt: String(latestSavedVersion?.modified || fileExp.state.selectedFileModifiedAt || ''),
            selectedFileSize: Number.isFinite(latestSavedVersion?.size) ? latestSavedVersion.size : fileExp.state.selectedFileSize
        }, { invalidate: false });

        if (isDpuPath) {
            fileExp.stopEditorExternalWatch?.();
            fileExp.clearEditorAutoSaveTimer?.();
            fileExp.setPreviewState({ isEditing: false });
            fileExp.editorPresenter = null;
            await openDpuFile(fileExp, selectedPath, {
                invalidate: false
            });
            return;
        }

        if (fileExp.state.selectedIsMarkdown) {
            fileExp.setPreviewState({
                previewContent: '',
                markdownTextView: false,
                documentId: null
            });
        } else {
            fileExp.setPreviewState({
                previewContent: renderCodePreview(newContent, fileExp.state.selectedPath)
            });
        }

        if (fileExp.isHtmlPreviewCandidate(fileExp.state.selectedPath) && fileExp.state.previewViewMode !== 'code') {
            fileExp.dispatchPreview({
                type: PREVIEW_ACTIONS.REFRESH,
                payload: { path: fileExp.state.selectedPath }
            });
        }

        if (preserveEditing) {
            fileExp.startEditorExternalWatch?.();
        } else {
            fileExp.stopEditorExternalWatch?.();
            fileExp.clearEditorAutoSaveTimer?.();
            fileExp.setPreviewState({ isEditing: false }, { invalidate: false });
            fileExp.editorPresenter = null;
            fileExp.startCurrentFileViewWatch?.();
        }
        fileExp.refreshPreviewUi();
    } catch (err) {
        if (!isExternalModificationError(err)) {
            console.error(err);
        }
        fileExp.setPreviewState({
            lastSaveError: err?.message || 'Failed to save file.',
            lastEditorSaveMode: '',
            lastExternalReloadAt: 0
        }, { invalidate: false });
        fileExp.refreshPreviewUi();
        fileExp.showStatus(err.message || 'Failed to save file.', true);
    } finally {
        fileExp._saveFileInProgress = false;
        fileExp.setPreviewState({ savePending: false }, { invalidate: false });
        fileExp.refreshPreviewUi();
    }
}

export async function cancelEdit(fileExp) {
    const selectedPath = fileExp.state.selectedPath || '';
    const isMarkdownClose = Boolean(fileExp.state.selectedIsMarkdown && selectedPath);
    fileExp.clearEditorAutoSaveTimer?.();
    fileExp.stopEditorExternalWatch?.();
    stopMarkdownCrdtEditWatch(fileExp);
    if (isMarkdownClose) {
        fileExp.setPreviewState({
            savePending: true,
            lastSaveError: ''
        }, { invalidate: false });
        try {
            const markdownEditorPresenter = fileExp.element.querySelector('markdown-editor')?.webSkelPresenter || null;
            if (markdownEditorPresenter) {
                if (typeof markdownEditorPresenter.discardPendingCrdtChange === 'function') {
                    await markdownEditorPresenter.discardPendingCrdtChange();
                }
                await syncMarkdownCrdtFromFile(selectedPath);
            }
            const documentViewPresenter = fileExp.element.querySelector('document-view-page')?.webSkelPresenter || null;
            if (typeof documentViewPresenter?.flushPendingEdit === 'function') {
                await documentViewPresenter.flushPendingEdit();
            }
        } catch (error) {
            console.error(error);
            fileExp.setPreviewState({
                savePending: false,
                lastSaveError: error?.message || 'Failed to close Markdown editor.'
            }, { invalidate: false });
            fileExp.refreshPreviewUi();
            fileExp.showStatus(error?.message || 'Failed to close Markdown editor.', true);
            return;
        }
    }
    if (window.assistOS?.workspace) {
        window.assistOS.workspace.currentMarkdownCrdtDocument = null;
        if (isMarkdownClose) {
            window.assistOS.workspace.currentDocumentId = selectedPath;
            window.assistOS.workspace.currentDocumentPath = selectedPath;
        }
    }
    fileExp.setPreviewState({
        documentId: isMarkdownClose ? selectedPath : fileExp.state.documentId,
        isEditing: false,
        markdownTextView: false,
        hasUnsavedChanges: false,
        savePending: false,
        lastSaveError: '',
        lastEditorSaveAt: 0,
        lastEditorSaveMode: '',
        lastExternalReloadAt: 0,
        externallyModified: false,
        selectedFileVersionKey: '',
        selectedFileModifiedAt: '',
        selectedFileSize: null
    });
    fileExp.editorPresenter = null;
    if (isDpuVirtualPath(selectedPath)) {
        await openDpuFile(fileExp, selectedPath, {
            showLoader: false,
            invalidate: false
        });
        return;
    }
    if (isMarkdownClose) {
        try {
            const documentModule = window.assistOS?.loadModule?.('document');
            if (typeof documentModule?.waitForPendingMarkdownChanges === 'function') {
                await documentModule.waitForPendingMarkdownChanges(selectedPath);
            }
            fileExp.bumpWorkspaceVersion?.();
            fileExp.caches.filePreview.invalidateForPath(selectedPath);
            fileExp.caches.dirListing.invalidate(fileExp, fileExp.state.path);
            await fileExp.openFile(selectedPath, {
                showLoader: false,
                invalidate: false,
                preserveSaveStatus: false
            });
            fileExp.setPreviewState({
                documentId: selectedPath,
                savePending: false,
                lastSaveError: ''
            }, { invalidate: false });
            startCurrentFileViewWatch(fileExp);
            fileExp.refreshPreviewUi();
        } catch (error) {
            console.error(error);
            fileExp.setPreviewState({
                savePending: false,
                lastSaveError: error?.message || 'Failed to refresh Markdown preview.'
            }, { invalidate: false });
            fileExp.refreshPreviewUi();
            fileExp.showStatus(error?.message || 'Failed to refresh Markdown preview.', true);
        }
        return;
    }
    startCurrentFileViewWatch(fileExp);
    fileExp.refreshPreviewUi();
}
