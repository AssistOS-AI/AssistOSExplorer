import {
    normalizePath,
    canonicalTerminalDirectoryPath,
    joinPath,
    parentPath,
    decodeLocalActionPathArg,
    formatBytes,
    formatDate,
    sanitizeEntryName,
    generateCopyName,
    buildFileExpHash,
    buildLogoutConfirmationUrl,
    parseDetailedDirectoryListing,
    isMarkdownFile,
    extractScriptaPreviewImages,
    prepareMarkdownPreviewContent,
    renderMarkdownPreview
} from "./file-exp-utils.js";
import {
    createFileExpState,
    saveDirectoryViewModePreference,
    saveFilterSpecsPreference,
    saveListWidthPreference,
    saveListCollapsedPreference,
    saveExplorerHeaderCollapsedPreference,
    savePreviewWrapPreference,
    saveEditorAutoSavePreference,
    saveEditorAutoSaveIntervalPreference
} from "./file-exp-state.js";
import { createFileExpTooling } from "./file-exp-tooling.js";
import { attachSearchController } from "./file-exp-search.js";
import { attachFsActions } from "./file-exp-fs-actions.js";
import { attachApplicationPluginHost } from "./file-exp-application-plugins.js";
import {
    FILE_EXP_MENU_SLOTS,
    getBuiltInContextMenuItems,
    getBuiltInNewMenuItems,
    resolveFileExpMenuItems,
    executeFileExpMenuItem
} from "./file-exp-menu-contributions.js";
import { withGlobalLoader } from "../../../utils/globalLoader.js";
import { createSecureUuid } from "../../../shared/libs/webskel/webskel.mjs";
import { createFileExpCaches } from "./file-exp-caches.js";
import { createDirectoryFilterController } from "./file-exp-directory-filter.js";
import { openFile as openFileImpl, tryLoadMediaPreview as tryLoadMediaPreviewImpl, attachPreviewAnchorHandler as attachPreviewAnchorHandlerImpl, detachPreviewAnchorHandler as detachPreviewAnchorHandlerImpl, handlePreviewAnchorClick as handlePreviewAnchorClickImpl } from "./file-exp-preview.js";
import { filterEntriesForSpecs as filterEntriesForSpecsImpl, hasMarkdownInTree as hasMarkdownInTreeImpl } from "./file-exp-specs.js";
import { positionOpenActionMenu as positionOpenActionMenuImpl } from "./file-exp-action-menu.js";
import { getNextMarkdownToggle, getNextBacklogViewToggle, PREVIEW_ACTIONS, previewReducer } from "./file-exp-preview-controller.js";
import { FILE_EXP_UI_ACTIONS, fileExpUiReducer } from "./file-exp-ui-controller.js";
import { createPreviewHeaderController } from "./file-exp-preview-header-controller.js";
import { getPreviewUiState } from "./file-exp-preview-state.js";
import { FILE_EXP_REPLACE_COMPLETE_EVENT } from "../../../utils/appEvents.js";
import { createDomListenerRegistry } from "../../../utils/domListenerRegistry.js";
import { dispatchAppMenuItemsSet } from "../../components/app-menu/app-menu-events.js";
import { runAfterRender as runLayoutAfterRender } from "./file-exp-layout-controller.js";
import { loadStateFromURL as loadStateFromURLImpl, loadDirectory as loadDirectoryImpl, refreshDirectory as refreshDirectoryImpl, renderBreadcrumbs as renderBreadcrumbsImpl, goUpDirectory as goUpDirectoryImpl } from "./file-exp-navigation-controller.js";
import { selectEntry as selectEntryImpl, handleSortClick as handleSortClickImpl } from "./file-exp-selection-controller.js";
import {
    applyPendingMarkdownCrdtEdit as applyPendingMarkdownCrdtEditImpl,
    editFile as editFileImpl,
    editSoplangMarkdown as editSoplangMarkdownImpl,
    saveFile as saveFileImpl,
    cancelEdit as cancelEditImpl,
    pollMarkdownCrdtEditWatch as pollMarkdownCrdtEditWatchImpl,
    stopMarkdownCrdtEditWatch as stopMarkdownCrdtEditWatchImpl
} from "./file-exp-editor-controller.js";
import {
    toggleHidden as toggleHiddenImpl,
    createPreviewActionButton as createPreviewActionButtonImpl,
    createPreviewCloseButton as createPreviewCloseButtonImpl,
    clearMountElement as clearMountElementImpl,
    mountPresenterElement as mountPresenterElementImpl,
    ensurePreviewDom as ensurePreviewDomImpl,
    renderStandardPreview as renderStandardPreviewImpl,
    renderHtmlPreview as renderHtmlPreviewImpl,
    renderPreviewPanel as renderPreviewPanelImpl
} from "./file-exp-preview-renderer.js";
import {
    isDpuVirtualPath,
    isDpuSecretPath,
    listDpuDirectory,
    mergeDpuRootEntry,
    openDpuFile,
    callDpuTool,
    readDpuCurrentItemState,
    updateDpuSecret
} from "./file-exp-dpu-provider.js";
import {
    startCurrentFileViewWatch as startCurrentFileViewWatchImpl,
    stopCurrentFileViewWatch as stopCurrentFileViewWatchImpl,
    refreshCurrentFileViewBaseline as refreshCurrentFileViewBaselineImpl,
    pollCurrentFileView as pollCurrentFileViewImpl
} from "./file-exp-current-file-monitor.js";
import { emitAuditEvent } from "../../../services/audit/auditService.js";

const LARGE_FILE_PREVIEW_LIMIT_BYTES = 1.5 * 1024 * 1024; // ~1.5MB safety window before transport limits
const LARGE_FILE_PREVIEW_LINES = 400;
const EDITOR_EXTERNAL_CHECK_INTERVAL_MS = 30000;

function normalizeEditorIntervalSeconds(value, fallback = 10) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function buildFileVersionKey(info) {
    if (!info || typeof info !== 'object') return '';
    const mtimeMs = Number.parseInt(String(info.mtimeMs ?? ''), 10);
    const size = Number.parseInt(String(info.size ?? ''), 10);
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return '';
    return `${mtimeMs}:${size}`;
}

function formatEditorTimeLabel(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

export class FileExp {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;

        this.boundPreviewAnchorHandler = this.handlePreviewAnchorClick.bind(this);
        this.normalizePath = normalizePath;
        this.joinPath = joinPath;
        this.parentPath = parentPath;
        this.formatBytes = formatBytes;
        this.formatDate = formatDate;
        this.sanitizeEntryName = sanitizeEntryName;
        this.generateCopyName = (baseName, existingNames = null) => generateCopyName(baseName, existingNames, this.state?.entries || []);
        this.isMarkdownFile = isMarkdownFile;
        this.extractScriptaPreviewImages = extractScriptaPreviewImages;
        this.prepareMarkdownPreviewContent = prepareMarkdownPreviewContent;
        this.renderMarkdownPreview = renderMarkdownPreview;

        this.stateStore = createFileExpState();
        this.state = this.stateStore.state;
        if (typeof window !== 'undefined') {
            const globalVersion = Number.parseInt(String(window.__assistosExplorerWorkspaceVersion ?? '0'), 10);
            if (Number.isFinite(globalVersion) && globalVersion > this.state.workspaceVersion) {
                this.state.workspaceVersion = globalVersion;
            } else {
                window.__assistosExplorerWorkspaceVersion = this.state.workspaceVersion;
            }
        }
        this.cleanupCallbacks = [];
        this.domListenerRegistry = createDomListenerRegistry();
        this.pendingMenuFocusPath = null;
        this.searchByNameTimer = null;
        this.boundGlobalKeydown = null;
        this.boundOutsideSearchMenuClick = null;
        this.boundSortClickHandler = (event) => this.handleSortClick(event);
        this.boundAppMenuSelect = this.handleAppMenuSelect.bind(this);
        this.toolbarMenuItems = [];
        this.openActionMenuDropdown = null;
        this.openActionMenuResizeObserver = null;
        this.openActionMenuMutationObserver = null;
        this.openActionMenuPositionFrame = null;
        this.boundOpenActionMenuViewportChange = (event) => {
            const dropdown = this.openActionMenuDropdown;
            const eventTarget = event?.target;
            const eventPath = typeof event?.composedPath === 'function' ? event.composedPath() : [];
            if (dropdown && (
                (eventTarget && (eventTarget === dropdown || dropdown.contains?.(eventTarget)))
                || (Array.isArray(eventPath) && eventPath.includes(dropdown))
            )) {
                return;
            }
            this.scheduleOpenActionMenuPosition?.();
        };
        this.editorAutoSaveTimer = null;
        this.editorExternalWatchTimer = null;
        this.editorExternalWatchInFlight = false;
        this.markdownCrdtEditWatchTimer = null;
        this.markdownCrdtEditWatchInFlight = false;
        this.markdownCrdtEditRevision = '';
        this.markdownCrdtEditPending = null;
        this.currentFileViewWatchTimer = null;
        this.currentFileViewWatchInFlight = false;
        this.externalModificationPromptActive = false;

        attachSearchController(this);
        attachFsActions(this);
        attachApplicationPluginHost(this);

        this.initialLocationRouteApplied = false;
        this.boundLoadStateFromURL = this.loadStateFromURL.bind(this);
        this.setWindowListener('file-exp-popstate', 'popstate', this.boundLoadStateFromURL);
        this.invalidate(() => this.applyInitialLocationRoute());

        this.boundOutsideMenuClick = this.handleOutsideMenuClick.bind(this);
        this.boundMenuKeydown = this.handleMenuKeydown.bind(this);
        this.boundContextMenu = this.handleContextMenu.bind(this);
        this.boundHandleDpuCommentsState = this.handleDpuCommentsState.bind(this);
        this.boundHandleDpuCommentsClose = this.handleDpuCommentsClose.bind(this);
        this.boundAuditLocalAction = this.handleAuditLocalAction.bind(this);

        this.caches = createFileExpCaches();
        this.inflightDirListing = new Map();
        this.backgroundDirRevalidation = new Map();
        this.directoryFilterController = createDirectoryFilterController(this);
        this.previewHeaderController = createPreviewHeaderController(this);
        this.tooling = createFileExpTooling();
        this.lastLoadError = null;
        this.previewDom = null;
        this.pendingTreeReveal = null;
        this.treeViewState = {
            contextKey: '',
            expandedPaths: new Set(),
            childrenCache: new Map(),
            loadingPaths: new Set()
        };
        this.setElementListener('file-exp-dpu-comments-state', this.element, 'dpu-comments-state', this.boundHandleDpuCommentsState);
        this.setElementListener('file-exp-dpu-comments-close', this.element, 'dpu-comments-close', this.boundHandleDpuCommentsClose);
        this.setElementListener('file-exp-app-menu-select', this.element, 'app-menu-select', this.boundAppMenuSelect);
        this.setElementListener('file-exp-audit-local-action', this.element, 'click', this.boundAuditLocalAction, true);
    }

    openLogoutConfirmation() {
        window.location.assign(buildLogoutConfirmationUrl(window.location));
    }

    async withLoader(fn) {
        return withGlobalLoader(fn);
    }


    beforeUnload() {
        this.detachPreviewAnchorHandler();
        this.previewDom = null;
        this.clearEditorAutoSaveTimer();
        this.stopEditorExternalWatch();
        this.stopMarkdownCrdtEditWatch();
        this.stopCurrentFileViewWatch();
        if (this.boundGlobalKeydown) {
            document.removeEventListener('keydown', this.boundGlobalKeydown);
        }
        if (this.boundOutsideSearchMenuClick) {
            document.removeEventListener('click', this.boundOutsideSearchMenuClick, true);
        }
        if (this.boundReplaceComplete) {
            window.removeEventListener(FILE_EXP_REPLACE_COMPLETE_EVENT, this.boundReplaceComplete);
            this.boundReplaceComplete = null;
        }
        const entriesContainer = this.element?.querySelector('.entries')
            || this.element?.querySelector('file-exp-entries');
        if (entriesContainer) {
            entriesContainer.removeEventListener('contextmenu', this.boundContextMenu, true);
        }
        this.clearOpenActionMenuTracking?.();
        this.flushCleanupCallbacks();
    }

    registerCleanup(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }
        this.cleanupCallbacks.push(callback);
        return callback;
    }

    addWindowListener(type, listener, options) {
        return this.domListenerRegistry.add(window, type, listener, options);
    }

    addDocumentListener(type, listener, options) {
        return this.domListenerRegistry.add(document, type, listener, options);
    }

    setDomListener(key, target, type, listener, options) {
        if (!key) return () => {};
        return this.domListenerRegistry.set(key, target, type, listener, options);
    }

    removeDomListener(key) {
        if (!key) return false;
        return this.domListenerRegistry.remove(key);
    }

    setWindowListener(key, type, listener, options) {
        return this.setDomListener(`window:${key}`, window, type, listener, options);
    }

    removeWindowListener(key) {
        return this.removeDomListener(`window:${key}`);
    }

    setDocumentListener(key, type, listener, options) {
        return this.setDomListener(`document:${key}`, document, type, listener, options);
    }

    removeDocumentListener(key) {
        return this.removeDomListener(`document:${key}`);
    }

    setElementListener(key, element, type, listener, options) {
        return this.setDomListener(`element:${key}`, element, type, listener, options);
    }

    removeElementListener(key) {
        return this.removeDomListener(`element:${key}`);
    }

    flushCleanupCallbacks() {
        if (!Array.isArray(this.cleanupCallbacks) || !this.cleanupCallbacks.length) {
            return;
        }
        const callbacks = this.cleanupCallbacks.splice(0, this.cleanupCallbacks.length);
        for (const callback of callbacks.reverse()) {
            try {
                callback();
            } catch (_) {
                // Ignore cleanup errors to avoid breaking unload flow.
            }
        }
        this.domListenerRegistry.clear();
    }

    async loadStateFromURL() {
        return loadStateFromURLImpl(this);
    }

    async applyInitialLocationRoute() {
        if (this.initialLocationRouteApplied) {
            return false;
        }
        this.initialLocationRouteApplied = true;
        await this.boundLoadStateFromURL();
        return true;
    }

    clearEditorAutoSaveTimer() {
        if (this.editorAutoSaveTimer) {
            window.clearTimeout(this.editorAutoSaveTimer);
            this.editorAutoSaveTimer = null;
        }
    }

    stopCurrentFileViewWatch() {
        return stopCurrentFileViewWatchImpl(this);
    }

    stopEditorExternalWatch() {
        if (this.editorExternalWatchTimer) {
            window.clearInterval(this.editorExternalWatchTimer);
            this.editorExternalWatchTimer = null;
        }
        this.editorExternalWatchInFlight = false;
    }

    stopMarkdownCrdtEditWatch() {
        return stopMarkdownCrdtEditWatchImpl(this);
    }

    async pollMarkdownCrdtEditWatch() {
        return pollMarkdownCrdtEditWatchImpl(this);
    }

    async applyPendingMarkdownCrdtEdit() {
        return applyPendingMarkdownCrdtEditImpl(this);
    }

    isLocalTextEditingActive() {
        return Boolean(
            this.state.isEditing
            && this.state.selectedPath
            && !isDpuVirtualPath(this.state.selectedPath)
        );
    }

    async refreshSelectedFileVersionInfo(pathValue = this.state.selectedPath) {
        if (!pathValue || isDpuVirtualPath(pathValue)) {
            return null;
        }
        const info = await this.tooling.getFileInfo(pathValue);
        return {
            ...info,
            versionKey: buildFileVersionKey(info)
        };
    }

    async markExternalModificationDetected({ silent = false } = {}) {
        this.clearEditorAutoSaveTimer();
        this.stopEditorExternalWatch();
        this.setPreviewState({
            externallyModified: true,
            savePending: false
        }, { invalidate: false });
        this.refreshPreviewUi();
        if (!silent) {
            this.showStatus('This file was modified externally. Reload it before saving again.', true);
        }
        void this.promptExternalModificationReload();
    }

    async promptExternalModificationReload() {
        if (this.externalModificationPromptActive || !this.state.externallyModified || !this.state.selectedPath) {
            return;
        }
        this.externalModificationPromptActive = true;
        try {
            const confirmed = await assistOS.UI.showModal('confirm-action-modal', {
                message: 'This file was modified by another session. Reload the latest version now? Unsaved local edits from this editor will be discarded.'
            }, true);
            if (!confirmed) {
                return;
            }
            this.clearEditorAutoSaveTimer();
            this.stopEditorExternalWatch();
            await this.cancelEdit();
            await this.openFile(this.state.selectedPath, {
                showLoader: false,
                invalidate: false
            });
            this.showStatus('Reloaded the latest file version.', false);
        } finally {
            this.externalModificationPromptActive = false;
        }
    }

    scheduleEditorAutoSave() {
        this.clearEditorAutoSaveTimer();
        if (!this.isLocalTextEditingActive()) return;
        if (!this.state.editorAutoSaveEnabled) return;
        if (!this.state.hasUnsavedChanges) return;
        if (this.state.savePending || this.state.externallyModified) return;
        const delayMs = normalizeEditorIntervalSeconds(this.state.editorAutoSaveIntervalSeconds, 10) * 1000;
        this.editorAutoSaveTimer = window.setTimeout(() => {
            this.editorAutoSaveTimer = null;
            if (!this.isLocalTextEditingActive()) return;
            if (!this.state.editorAutoSaveEnabled || !this.state.hasUnsavedChanges) return;
            if (this.state.savePending || this.state.externallyModified) return;
            void this.saveFile({ autoSave: true, preserveEditing: true });
        }, delayMs);
    }

    async pollEditorExternalModification() {
        if (this.editorExternalWatchInFlight || !this.isLocalTextEditingActive()) {
            return;
        }
        const baselineVersionKey = String(this.state.selectedFileVersionKey || '');
        if (!baselineVersionKey) return;
        this.editorExternalWatchInFlight = true;
        try {
            const latest = await this.refreshSelectedFileVersionInfo(this.state.selectedPath);
            if (!latest?.versionKey) return;
            if (latest.versionKey !== baselineVersionKey) {
                await this.markExternalModificationDetected();
            }
        } catch (error) {
            console.warn('Failed to poll file version while editing', error);
        } finally {
            this.editorExternalWatchInFlight = false;
        }
    }

    startEditorExternalWatch() {
        this.stopEditorExternalWatch();
        if (!this.isLocalTextEditingActive()) return;
        if (!String(this.state.selectedFileVersionKey || '')) return;
        this.editorExternalWatchTimer = window.setInterval(() => {
            void this.pollEditorExternalModification();
        }, EDITOR_EXTERNAL_CHECK_INTERVAL_MS);
    }

    async refreshCurrentFileViewBaseline(pathValue = this.state.selectedPath) {
        return refreshCurrentFileViewBaselineImpl(this, pathValue);
    }

    async pollCurrentFileView() {
        return pollCurrentFileViewImpl(this);
    }

    startCurrentFileViewWatch() {
        return startCurrentFileViewWatchImpl(this);
    }

    handleEditorBufferChange() {
        this.previewHeaderController?.sync(getPreviewUiState(this.state));
        if (this.state.hasUnsavedChanges) {
            this.scheduleEditorAutoSave();
            return;
        }
        this.clearEditorAutoSaveTimer();
    }

    setEditorAutoSaveSettings(enabled, intervalSeconds) {
        const nextEnabled = Boolean(enabled);
        const nextIntervalSeconds = normalizeEditorIntervalSeconds(intervalSeconds, 10);
        this.setPreviewState({
            editorAutoSaveEnabled: nextEnabled,
            editorAutoSaveIntervalSeconds: nextIntervalSeconds
        }, { invalidate: false });
        saveEditorAutoSavePreference(nextEnabled);
        saveEditorAutoSaveIntervalPreference(nextIntervalSeconds);
        if (!nextEnabled) {
            this.clearEditorAutoSaveTimer();
        } else {
            this.scheduleEditorAutoSave();
        }
        this.refreshPreviewUi();
    }

    bumpWorkspaceVersion() {
        const current = Number.isFinite(this.state.workspaceVersion) ? this.state.workspaceVersion : 0;
        const next = current + 1;
        this.state.workspaceVersion = next;
        if (typeof window !== 'undefined') {
            window.__assistosExplorerWorkspaceVersion = next;
        }
        return next;
    }

    beforeRender() {
    }

    getEntriesPresenter() {
        const entriesElement = this.element?.querySelector?.('file-exp-entries');
        return entriesElement?.webSkelPresenter || null;
    }

    renderEntries() {
        const snapshot = this.stateStore?.getState ? this.stateStore.getState() : this.state;
        const entriesPresenter = this.getEntriesPresenter();
        if (entriesPresenter && typeof entriesPresenter.renderEntries === 'function') {
            entriesPresenter.renderEntries(snapshot);
        } else {
            const entriesBody = this.element?.querySelector?.('#entriesBody');
            if (entriesBody) {
                entriesBody.replaceChildren();
            }
        }
        this.applyColumnVisibility();
        if (this.state.openMenuPath) {
            this.positionOpenActionMenu();
        }
    }

    renderEntriesBody() {
        this.renderEntries();
    }

    async afterRender() {
        return runLayoutAfterRender(this, {
            previewLines: LARGE_FILE_PREVIEW_LINES
        });
    }

    getEntryByPath(entryPath) {
        const normalizedTarget = this.normalizePath(entryPath || '');
        if (!normalizedTarget) {
            return null;
        }
        const entries = Array.isArray(this.state.allEntries) && this.state.allEntries.length
            ? this.state.allEntries
            : Array.isArray(this.state.entries)
                ? this.state.entries
                : [];
        const topLevelEntry = entries.find((entry) => this.normalizePath(entry?.path || '') === normalizedTarget) || null;
        if (topLevelEntry) {
            return topLevelEntry;
        }
        const treeChildren = this.treeViewState?.childrenCache instanceof Map
            ? this.treeViewState.childrenCache.values()
            : [];
        for (const children of treeChildren) {
            if (!Array.isArray(children)) {
                continue;
            }
            const childEntry = children.find((entry) => this.normalizePath(entry?.path || '') === normalizedTarget) || null;
            if (childEntry) {
                return childEntry;
            }
        }
        return null;
    }

    getToolbarMenuItems() {
        return Array.isArray(this.toolbarMenuItems) ? this.toolbarMenuItems : [];
    }

    getContextMenuItemsForEntry(entryPath, type, entry = null) {
        const normalizedPath = this.normalizePath(entryPath || '');
        const targetEntry = entry || this.getEntryByPath(normalizedPath) || null;
        const builtInItems = getBuiltInContextMenuItems(this, {
            ...(targetEntry || {}),
            path: normalizedPath,
            type: type || targetEntry?.type || 'file'
        });
        const slot = String(type || targetEntry?.type || 'file') === 'directory'
            ? FILE_EXP_MENU_SLOTS.contextDirectory
            : FILE_EXP_MENU_SLOTS.contextFile;
        return resolveFileExpMenuItems(slot, targetEntry || {
            path: normalizedPath,
            type: type || 'file'
        }, builtInItems);
    }

    renderToolbarMenuItems() {
        const appMenuElement = this.element?.querySelector?.('#toolbarAppMenu');
        if (!appMenuElement) {
            return;
        }
        const items = this.getToolbarMenuItems();
        if (typeof appMenuElement.webSkelPresenter?.setItems === 'function') {
            appMenuElement.webSkelPresenter.setItems(items);
            return;
        }
        try {
            appMenuElement.setAttribute('data-items', encodeURIComponent(JSON.stringify(items)));
        } catch {
            appMenuElement.setAttribute('data-items', encodeURIComponent('[]'));
        }
    }

    refreshToolbarMenuItems() {
        const builtInItems = getBuiltInNewMenuItems(this);
        this.toolbarMenuItems = resolveFileExpMenuItems(FILE_EXP_MENU_SLOTS.newMenu, null, builtInItems);
        this.renderToolbarMenuItems();
        return this.toolbarMenuItems;
    }

    refreshContextMenuItems(entryPath) {
        const normalizedPath = this.normalizePath(entryPath || '');
        if (!normalizedPath) {
            return;
        }
        const targetEntry = this.getEntryByPath(normalizedPath) || { path: normalizedPath, type: 'file' };
        const slot = String(targetEntry?.type || 'file') === 'directory'
            ? FILE_EXP_MENU_SLOTS.contextDirectory
            : FILE_EXP_MENU_SLOTS.contextFile;
        const builtInItems = getBuiltInContextMenuItems(this, targetEntry);
        const items = resolveFileExpMenuItems(slot, targetEntry, builtInItems);
        this.publishMenuItems(this.getContextAppMenu(normalizedPath), items);
        return items;
    }

    getContextAppMenu(entryPath) {
        const containers = this.element?.querySelectorAll?.('[data-action-menu="true"]') || [];
        const container = Array.from(containers)
            .find((entry) => String(entry?.dataset?.entryPath || '') === String(entryPath || ''));
        return container?.querySelector?.('app-menu') || null;
    }

    publishMenuItems(appMenu, menuItems) {
        if (!appMenu) return false;
        try {
            appMenu.setAttribute('data-items', encodeURIComponent(JSON.stringify(menuItems)));
            appMenu.setAttribute('data-loading', menuItems.some((item) => item?.loading === true) ? 'true' : 'false');
        } catch {}
        return dispatchAppMenuItemsSet(appMenu, menuItems);
    }

    async executeHostMenuAction(item) {
        const dataset = {
            entryPath: item?.entryPath || '',
            type: item?.entryType || '',
            targetPath: item?.targetPath || item?.entryPath || ''
        };
        const element = { dataset };
        switch (item?.action) {
            case 'newDirectory':
                return this.newDirectory();
            case 'newFile':
                return this.newFile();
            case 'renameEntry':
                return this.renameEntry(element);
            case 'openEntryInNewTab':
                return this.openEntryInNewTab(element);
            case 'openTerminalHere':
                return this.openTerminalHere(element);
            case 'copyEntry':
                return this.copyEntry(element);
            case 'cutEntry':
                return this.cutEntry(element);
            case 'uploadHere':
                return this.uploadHere(element);
            case 'pasteClipboard':
                return this.pasteClipboard(element);
            case 'openDpuPermissions':
                return this.openDpuPermissions(element);
            case 'deleteEntry':
                return this.deleteEntry(element);
            default:
                return false;
        }
    }

    async handleAppMenuSelect(event) {
        const item = event?.detail?.item;
        if (!item || typeof item !== 'object') {
            return;
        }
        if (item.source === 'plugin') {
            const isContextMenu = item.slot === FILE_EXP_MENU_SLOTS.contextFile
                || item.slot === FILE_EXP_MENU_SLOTS.contextDirectory;
            const appMenu = event?.target?.closest?.('app-menu') || event?.target;
            const currentItems = item.slot === FILE_EXP_MENU_SLOTS.newMenu
                ? this.getToolbarMenuItems()
                : this.getContextMenuItemsForEntry(item.entryPath, item.entryType);
            this.publishMenuItems(appMenu, currentItems.map((entry) => (
                entry.id === item.id ? { ...entry, loading: true } : entry
            )));
            try {
                return await executeFileExpMenuItem(this, item, null, {
                    onReady: () => {
                        if (isContextMenu) {
                            this.closeActionMenu(false);
                        } else {
                            this.publishMenuItems(appMenu, currentItems);
                        }
                    }
                });
            } catch (error) {
                console.error(`[menu plugin:${item.pluginId || 'unknown'}]`, error);
                this.showStatus(error?.message || 'Plugin action failed.', true);
                return false;
            } finally {
                if (isContextMenu) {
                    if (this.state.openMenuPath === item.entryPath) this.closeActionMenu(false);
                } else {
                    this.publishMenuItems(appMenu, currentItems);
                }
            }
        }
        if (item.slot === FILE_EXP_MENU_SLOTS.contextFile || item.slot === FILE_EXP_MENU_SLOTS.contextDirectory) {
            this.closeActionMenu(false);
        }
        await this.executeHostMenuAction(item);
    }

    scheduleDirectoryRevalidation(path) {
        const normalizedPath = this.normalizePath(path);
        const cacheGeneration = this.caches.dirListing.getGeneration(this, normalizedPath);
        const workspaceVersion = Number(this.state.workspaceVersion) || 0;
        const existing = this.backgroundDirRevalidation.get(normalizedPath);
        if (existing?.cacheGeneration === cacheGeneration && existing?.workspaceVersion === workspaceVersion) {
            return existing.promise;
        }
        const request = (async () => {
            const entries = await this.loadDirectoryContent(normalizedPath, {
                skipCache: true,
                background: true
            });
            if (!Array.isArray(entries)) return entries;
            if (
                this.caches.dirListing.getGeneration(this, normalizedPath) !== cacheGeneration
                || (Number(this.state.workspaceVersion) || 0) !== workspaceVersion
            ) {
                return null;
            }
            this.caches.dirListing.set(this, normalizedPath, entries);

            const treeViewState = this.treeViewState;
            const visibleListingPath = this.state.directoryViewMode === 'tree'
                ? (this.state.treeRootPath || this.state.path || '/')
                : (this.state.path || '/');
            if (this.normalizePath(visibleListingPath) === normalizedPath) {
                const isCurrentGeneration = () => (
                    this.caches.dirListing.getGeneration(this, normalizedPath) === cacheGeneration
                    && (Number(this.state.workspaceVersion) || 0) === workspaceVersion
                    && this.normalizePath(this.state.directoryViewMode === 'tree'
                        ? (this.state.treeRootPath || this.state.path || '/')
                        : (this.state.path || '/')) === normalizedPath
                );
                const committed = await this.setEntries(entries, { shouldCommit: isCurrentGeneration });
                if (committed && isCurrentGeneration()) {
                    if (this.state.directoryViewMode === 'tree') {
                        this.getEntriesPresenter()?.updateTreeRootEntries?.();
                    } else {
                        this.renderEntries();
                    }
                }
            } else if (treeViewState?.childrenCache?.has(normalizedPath)) {
                const visibleChildren = this.state.filterSpecs
                    ? await this.filterEntriesForSpecs(entries)
                    : entries;
                if (
                    this.caches.dirListing.getGeneration(this, normalizedPath) === cacheGeneration
                    && (Number(this.state.workspaceVersion) || 0) === workspaceVersion
                ) {
                    this.getEntriesPresenter()?.updateTreeDirectoryChildren?.(
                        normalizedPath,
                        this.sortEntries(visibleChildren)
                    );
                }
            }
            return entries;
        })().catch((error) => {
            console.warn(`Failed to revalidate directory ${normalizedPath}:`, error);
            return null;
        }).finally(() => {
            if (this.backgroundDirRevalidation.get(normalizedPath)?.promise === request) {
                this.backgroundDirRevalidation.delete(normalizedPath);
            }
        });
        this.backgroundDirRevalidation.set(normalizedPath, {
            cacheGeneration,
            workspaceVersion,
            promise: request
        });
        return request;
    }

    getCachedDirectoryContent(path, { revalidate = true } = {}) {
        const normalizedPath = this.normalizePath(path);
        const cached = this.caches.dirListing.read(this, normalizedPath);
        if (cached?.isStale && revalidate) {
            void this.scheduleDirectoryRevalidation(normalizedPath);
        }
        return cached;
    }

    async loadDirectoryContent(path, options = {}) {
        const normalizedPath = this.normalizePath(path);
        const cacheGeneration = this.caches.dirListing.getGeneration(this, normalizedPath);
        const skipCache = Boolean(options.skipCache);
        const background = Boolean(options.background);
        if (isDpuVirtualPath(normalizedPath)) {
            try {
                this.lastLoadError = null;
                const cached = skipCache ? null : this.getCachedDirectoryContent(normalizedPath);
                if (cached) {
                    return cached.value;
                }
                const entries = await listDpuDirectory(this, normalizedPath);
                if (!background && this.caches.dirListing.getGeneration(this, normalizedPath) === cacheGeneration) {
                    this.caches.dirListing.set(this, normalizedPath, entries);
                }
                return entries;
            } catch (err) {
                this.lastLoadError = err;
                if (this.isPathNotFoundError(err)) {
                    return null;
                }
                if (background) return null;
                console.error(err);
                this.showStatus(err.message || 'Failed to load confidential directory.', true);
                return [];
            }
        }
        try {
            this.lastLoadError = null;
            const cached = skipCache ? null : this.getCachedDirectoryContent(normalizedPath);
            if (cached) {
                return cached.value;
            }
            const globalInflight = window.__fileExpInflightDirListing || (window.__fileExpInflightDirListing = new Map());
            const inflightKey = `${normalizedPath}|generation:${cacheGeneration}`;
            if (this.inflightDirListing.has(inflightKey)) {
                return await this.inflightDirListing.get(inflightKey);
            }
            if (globalInflight.has(inflightKey)) {
                return await globalInflight.get(inflightKey);
            }
            const request = (async () => {
            const result = await this.tooling.listDirectoryDetailed(normalizedPath);
            const entries = parseDetailedDirectoryListing(result.text);
            let resolved = entries.map(entry => ({
                ...entry,
                path: this.joinPath(normalizedPath, entry.name)
            }));
            if (normalizedPath === '/') {
                resolved = await mergeDpuRootEntry(this, resolved);
            }
            if (!background && this.caches.dirListing.getGeneration(this, normalizedPath) === cacheGeneration) {
                this.caches.dirListing.set(this, normalizedPath, resolved);
            }
            return resolved;
            })();
            this.inflightDirListing.set(inflightKey, request);
            globalInflight.set(inflightKey, request);
            try {
                return await request;
            } finally {
                this.inflightDirListing.delete(inflightKey);
                globalInflight.delete(inflightKey);
            }
        } catch (err) {
            this.lastLoadError = err;
            if (this.isPathNotFoundError(err)) {
                return null;
            }
            if (background) return null;
            console.error(err);
            this.showStatus(err.message || 'Failed to load directory.', true);
            return [];
        }
    }

    async setEntries(entries, options = {}) {
        const snapshot = this.stateStore?.getState ? this.stateStore.getState() : this.state;
        const sourceEntries = Array.isArray(entries) ? entries : [];
        let nextEntries;
        let filterError = null;
        try {
            const filterQuery = String(snapshot.directoryFilterQuery || '').trim().toLowerCase();
            const applyDirectoryFilter = (items) => {
                if (!filterQuery) return items || [];
                return (items || []).filter((entry) => {
                    const name = String(entry?.name || '').toLowerCase();
                    const entryPath = String(entry?.path || '').toLowerCase();
                    return name.includes(filterQuery) || entryPath.includes(filterQuery);
                });
            };

            if (snapshot.filterSpecs) {
                const filtered = await this.filterEntriesForSpecs(sourceEntries);
                nextEntries = this.sortEntries(applyDirectoryFilter(filtered));
            } else {
                nextEntries = this.sortEntries(applyDirectoryFilter(sourceEntries));
            }
        } catch (err) {
            filterError = err;
            nextEntries = this.sortEntries(sourceEntries);
        }
        if (typeof options.shouldCommit === 'function' && !options.shouldCommit()) {
            return false;
        }
        this.state.allEntries = sourceEntries;
        this.state.entries = nextEntries;
        if (filterError) {
            console.warn('Failed to apply specs filter', filterError);
            this.showStatus('Could not apply filter. Showing all files.', true);
        }
        return true;
    }

    sortEntries(entries = []) {
        if (!Array.isArray(entries)) return [];
        const { sortBy, sortDir } = this.state;
        const direction = sortDir === 'desc' ? -1 : 1;
        const toLower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
        const getValue = (entry, key) => {
            switch (key) {
                case 'size':
                    return Number.isFinite(entry.size) ? entry.size : -1;
                case 'modified': {
                    const ts = Date.parse(entry.modified);
                    return Number.isFinite(ts) ? ts : 0;
                }
                case 'name':
                default:
                    return toLower(entry.name || '');
            }
        };
        const copy = [...entries];
        copy.sort((a, b) => {
            // Keep directories before files for consistency
            const typeOrderA = a.type === 'directory' ? 0 : 1;
            const typeOrderB = b.type === 'directory' ? 0 : 1;
            if (typeOrderA !== typeOrderB) {
                return typeOrderA - typeOrderB;
            }
            const aVal = getValue(a, sortBy);
            const bVal = getValue(b, sortBy);
            let result = 0;
            if (typeof aVal === 'string' || typeof bVal === 'string') {
                result = String(aVal).localeCompare(String(bVal), undefined, { sensitivity: 'base' });
            } else {
                result = aVal === bVal ? 0 : (aVal < bVal ? -1 : 1);
            }
            if (result === 0 && sortBy !== 'name') {
                result = toLower(a.name || '').localeCompare(toLower(b.name || ''), undefined, { sensitivity: 'base' });
            }
            return result * direction;
        });
        return copy;
    }

    async loadDirectory(path = this.state.path) {
        this.stopCurrentFileViewWatch();
        return loadDirectoryImpl(this, path);
    }

    async refresh() {
        return refreshDirectoryImpl(this);
    }

    async selectEntry(element) {
        return selectEntryImpl(this, element);
    }

    async tryLoadMediaPreview(filePath) {
        return tryLoadMediaPreviewImpl(this, filePath);
    }

    async openFile(filePath, options = {}) {
        if (filePath && !String(filePath).endsWith('.backlog') && !String(filePath).endsWith('.history')) {
            this.setPreviewState({ backlogTextView: false }, { invalidate: false });
        }
        const opened = await openFileImpl(this, filePath, {
            largeFilePreviewLimitBytes: LARGE_FILE_PREVIEW_LIMIT_BYTES,
            largeFilePreviewLines: LARGE_FILE_PREVIEW_LINES,
            ...options
        });
        if (!opened) {
            this.stopCurrentFileViewWatch();
            return false;
        }
        if (this.normalizePath(this.state.selectedPath || '') === this.normalizePath(filePath || '')) {
            await this.refreshCurrentFileViewBaseline(filePath);
            this.startCurrentFileViewWatch();
        } else {
            this.stopCurrentFileViewWatch();
        }
        this.syncWebViewForPath(filePath);
        if (options?.audit !== false) {
            void emitAuditEvent('file.open', {
                path: this.normalizePath(filePath || ''),
                currentPath: this.normalizePath(this.state.path || '/'),
                selectedPath: this.normalizePath(this.state.selectedPath || ''),
                metadata: {
                    previewMode: this.state.previewMode || '',
                    isDpu: Boolean(isDpuVirtualPath(filePath))
                }
            });
        }
        return true;
    }

    async editFile() {
        return editFileImpl(this);
    }

    async editSoplangMarkdown() {
        return editSoplangMarkdownImpl(this);
    }

    async saveFile(options = {}) {
        return saveFileImpl(this, options);
    }

    handleAuditLocalAction(event) {
        const target = event?.target instanceof Element ? event.target.closest('[data-local-action]') : null;
        if (!target || !this.element?.contains?.(target)) {
            return;
        }
        const descriptor = String(target.getAttribute('data-local-action') || '').trim();
        if (!descriptor) {
            return;
        }
        const [action, ...args] = descriptor.split(/\s+/);
        if (!action) {
            return;
        }
        void emitAuditEvent('explorer.action', {
            action,
            currentPath: this.normalizePath(this.state.path || '/'),
            selectedPath: this.normalizePath(this.state.selectedPath || ''),
            metadata: {
                args,
                tagName: target.tagName.toLowerCase()
            }
        });
    }

    async cancelEdit() {
        return cancelEditImpl(this);
    }

    renderBreadcrumbs() {
        return renderBreadcrumbsImpl(this);
    }

    showStatus(message, isError = false) {
        if (!message) {
            return;
        }
        const toast = window.assistOS?.showToast || window.assistOS?.UI?.showToast;
        if (typeof toast === 'function') {
            toast(String(message), isError ? 'error' : 'info', 5000);
            return;
        }
        console[isError ? 'error' : 'info'](message);
    }

    isPathNotFoundError(err) {
        const message = err?.message || '';
        return err?.code === 'ENOENT' || message.includes('ENOENT');
    }

    async goUp() {
        return goUpDirectoryImpl(this);
    }

    async filterEntriesForSpecs(entries = []) {
        return filterEntriesForSpecsImpl(this, entries);
    }

    async hasMarkdownInTree(dirPath) {
        return hasMarkdownInTreeImpl(this, dirPath);
    }

    toggleHidden(element, hidden = true) {
        return toggleHiddenImpl(this, element, hidden);
    }

    createPreviewActionButton(label, action, className = 'preview-pane-action') {
        return createPreviewActionButtonImpl(label, action, className);
    }

    createPreviewCloseButton(action, label) {
        return createPreviewCloseButtonImpl(action, label);
    }

    clearMountElement(mount) {
        return clearMountElementImpl(mount);
    }

    mountPresenterElement(mount, { key, tagName, attributes = {} }) {
        return mountPresenterElementImpl(mount, { key, tagName, attributes });
    }

    ensurePreviewDom(previewContent) {
        return ensurePreviewDomImpl(this, previewContent);
    }

    renderStandardPreview(refs, previewUiState) {
        return renderStandardPreviewImpl(this, refs, previewUiState);
    }

    renderHtmlPreview(refs, previewUiState) {
        return renderHtmlPreviewImpl(this, refs, previewUiState);
    }

    renderPreviewPanel(previewContent, previewUiState) {
        return renderPreviewPanelImpl(this, previewContent, previewUiState);
    }

    refreshPreviewUi() {
        const previewUiState = getPreviewUiState(this.state);
        this.previewHeaderController?.sync(previewUiState);

        const previewPresenterElement = this.element?.querySelector?.('file-exp-preview');
        const previewPresenter = previewPresenterElement?.webSkelPresenter || null;
        if (previewPresenter && typeof previewPresenter.renderPreview === 'function') {
            previewPresenter.renderPreview(previewUiState);
        } else {
            const previewContent = this.element?.querySelector?.('.preview-content');
            if (previewContent) {
                this.renderPreviewPanel(previewContent, previewUiState);
            }
        }

        const saveButton = this.element?.querySelector?.('#saveButton');
        if (saveButton) {
            saveButton.classList.toggle('hidden', Boolean(this.state.selectedIsMarkdown && this.state.documentId));
        }

        const cancelButton = this.element?.querySelector?.('#cancelButton');
        if (cancelButton) {
            cancelButton.textContent = this.state.selectedIsMarkdown && this.state.documentId ? 'Close' : 'Cancel';
        }

        const previewNotice = this.element?.querySelector?.('#previewNotice');
        if (previewNotice) {
            if (this.state.fileLoadInfo?.truncated) {
                const info = this.state.fileLoadInfo;
                const previewLines = info.previewLines || LARGE_FILE_PREVIEW_LINES;
                const sizeText = Number.isFinite(info.size) ? this.formatBytes(info.size) : 'large';
                previewNotice.textContent = info.message
                    || `File is ${sizeText}; showing first ${previewLines} lines only. Editing is disabled for this view.`;
                previewNotice.classList.remove('hidden');
            } else {
                previewNotice.textContent = '';
                previewNotice.classList.add('hidden');
            }
        }
    }

    toggleMarkdownView() {
        const transition = getNextMarkdownToggle(this.state);
        if (!transition.changed) {
            return;
        }
        this.setPreviewState(transition.patch, { invalidate: true });
    }

    togglePreviewWrap() {
        const nextValue = !Boolean(this.state.previewWrapEnabled);
        this.setPreviewState({ previewWrapEnabled: nextValue }, { invalidate: true });
        savePreviewWrapPreference(nextValue);
    }

    async toggleFilterSpecs(element) {
        await this.withLoader(async () => {
            this.setFilterSpecs(Boolean(element?.checked));
            saveFilterSpecsPreference(this.state.filterSpecs);
            await this.setEntries(this.state.allEntries?.length ? this.state.allEntries : this.state.entries);
            this.invalidate();
        });
    }

    applyColumnVisibility() {
        const columns = ['type', 'size', 'modified'];
        columns.forEach((col) => {
            const visible = Boolean(this.state.columnVisibility?.[col]);
            const cells = this.element.querySelectorAll(`.col-${col}`);
            cells.forEach((cell) => {
                cell.classList.toggle('column-hidden', !visible);
            });
        });
    }

    renderBacklogViewToggle(headerExtras, showBacklogPanel) {
        if (!headerExtras) return;
        let button = headerExtras.querySelector('#backlogViewToggle');
        if (!button) {
            button = document.createElement('button');
            button.id = 'backlogViewToggle';
            button.type = 'button';
            button.className = 'secondary';
            button.setAttribute('data-local-action', 'toggleBacklogView');
            headerExtras.appendChild(button);
        }
        button.textContent = showBacklogPanel ? 'View as text' : 'View as backlog';
    }

    renderEditorStatusIndicators(statusStrip, previewUiState) {
        if (!statusStrip) {
            return;
        }
        const appendLabel = (text, className = '') => {
            const label = document.createElement('div');
            label.className = `preview-status-label${className ? ` ${className}` : ''}`;
            label.textContent = text;
            statusStrip.appendChild(label);
        };
        if (this.state.savePending) {
            appendLabel('Saving...');
        } else if (previewUiState?.showEditingActions) {
            if (this.state.editorAutoSaveEnabled) {
                appendLabel(`Auto-save on (${normalizeEditorIntervalSeconds(this.state.editorAutoSaveIntervalSeconds, 10)}s)`);
            }
            if (this.state.hasUnsavedChanges) {
                appendLabel('Unsaved changes', 'warning');
            } else if (this.state.externallyModified) {
                appendLabel('Modified externally', 'warning');
            } else if (this.state.lastSaveError) {
                appendLabel('Save failed', 'warning');
            } else if (this.state.editorAutoSaveEnabled && this.state.lastEditorSaveMode === 'auto' && this.state.lastEditorSaveAt > 0) {
                const savedAt = formatEditorTimeLabel(this.state.lastEditorSaveAt);
                appendLabel(savedAt ? `Auto-saved ${savedAt}` : 'Auto-saved');
            }
        } else if (this.state.lastExternalReloadAt > 0 && this.state.selectedPath) {
            const updatedAt = formatEditorTimeLabel(this.state.lastExternalReloadAt);
            appendLabel(updatedAt ? `Updated ${updatedAt}` : 'Updated');
        }
        if (statusStrip.children.length) {
            statusStrip.classList.remove('hidden');
        }
    }

    renderDpuCommentActions(headerExtras, previewUiState) {
        if (!headerExtras) return;
        const canShow = Boolean(
            this.state.selectedPath
            && isDpuVirtualPath(this.state.selectedPath)
            && this.state.dpuSelectedObjectId
            && !this.state.isEditing
            && !previewUiState?.showBacklogPanel
        );
        if (!canShow) {
            return;
        }

        const commentsButton = document.createElement('button');
        commentsButton.type = 'button';
        commentsButton.className = 'secondary';
        commentsButton.setAttribute('data-local-action', this.state.dpuCommentsOpen ? 'closeDpuComments' : 'toggleDpuComments');
        commentsButton.textContent = this.state.dpuSelectedCommentCount > 0
            ? `Comments (${this.state.dpuSelectedCommentCount})`
            : (this.state.dpuSelectedCanComment ? 'Comments' : 'No comments');
        commentsButton.disabled = !this.state.dpuSelectedCanComment && this.state.dpuSelectedCommentCount <= 0;
        headerExtras.appendChild(commentsButton);
    }

    async toggleBacklogView() {
        const transition = getNextBacklogViewToggle(this.state);
        if (transition.blocked) {
            this.showStatus('Save or cancel changes before switching backlog view.', true);
            return;
        }
        if (!transition.changed) {
            return;
        }
        this.setPreviewState(transition.patch, { invalidate: false });
        if (transition.shouldReloadSelection && this.state.selectedPath) {
            await this.openFile(this.state.selectedPath);
        }
        this.invalidate();
    }

    async openBreadcrumb(_target, path) {
        await this.loadDirectory(decodeLocalActionPathArg(path));
    }

    updateNavigationLocation(path, options = {}) {
        const {
            selectedPath = undefined,
            resetContext = false,
            historyMode = 'push',
            invalidate = false
        } = options;
        const normalizedPath = this.normalizePath(path || '/');
        this.state.path = normalizedPath;

        if (resetContext) {
            this.dispatchUi({ type: FILE_EXP_UI_ACTIONS.RESET_DIRECTORY_CONTEXT });
            this.dispatchPreview({ type: PREVIEW_ACTIONS.RESET });
            this.pendingMenuFocusPath = null;
        }

        if (selectedPath !== undefined) {
            this.state.selectedPath = selectedPath ? this.normalizePath(selectedPath) : null;
        }

        const targetPath = this.state.selectedPath || normalizedPath;
        const newUrl = buildFileExpHash(targetPath);
        if (window.location.hash !== newUrl) {
            const method = historyMode === 'replace' ? 'replaceState' : 'pushState';
            history[method](null, '', newUrl);
        }

        if (invalidate) {
            this.invalidate();
            return;
        }

        this.renderBreadcrumbs();
        if (resetContext) {
            this.refreshPreviewUi();
        }
    }

    toggleDpuComments() {
        if (!this.state.dpuSelectedObjectId) {
            return;
        }
        this.setPreviewState({ dpuCommentsOpen: !this.state.dpuCommentsOpen }, { invalidate: true });
    }

    closeDpuComments() {
        this.setPreviewState({ dpuCommentsOpen: false }, { invalidate: true });
    }

    handleDpuCommentsState(event) {
        const detail = event?.detail || {};
        if (!detail.objectId || detail.objectId !== this.state.dpuSelectedObjectId) {
            return;
        }
        this.setPreviewState({
            dpuSelectedCommentCount: Number.parseInt(String(detail.commentCount ?? 0), 10) || 0,
            dpuSelectedComments: Array.isArray(detail.comments) ? detail.comments : [],
            dpuSelectedCanComment: detail.canComment === undefined ? this.state.dpuSelectedCanComment : Boolean(detail.canComment),
            dpuCommentsOpen: true
        }, { invalidate: true });
    }

    handleDpuCommentsClose() {
        this.closeDpuComments();
    }

    toggleDpuSecretMask() {
        const secretState = this.state.dpuSecretState;
        if (!secretState?.canRead || secretState?.editing) {
            return;
        }
        this.setPreviewState({
            dpuSecretState: {
                ...secretState,
                masked: !secretState.masked
            }
        }, { invalidate: false });
        this.refreshPreviewUi();
    }

    async beginDpuSecretInlineEdit() {
        const selectedPath = this.state.selectedPath || '';
        const secretState = this.state.dpuSecretState;
        if (!isDpuSecretPath(selectedPath) || !secretState?.canWrite) {
            return;
        }
        try {
            await openDpuFile(this, selectedPath, { invalidate: false });
            const refreshed = this.state.dpuSecretState;
            if (!refreshed?.canWrite) {
                return;
            }
            this.setPreviewState({
                dpuSecretState: {
                    ...refreshed,
                    masked: false,
                    editing: true,
                    draft: String(refreshed.canRead ? refreshed.value : '')
                }
            }, { invalidate: false });
            this.refreshPreviewUi();
            window.requestAnimationFrame(() => {
                const input = this.element?.querySelector?.('.dpu-secret-editor-input');
                input?.focus?.();
                const valueLength = String(input?.value || '').length;
                if (typeof input?.setSelectionRange === 'function') {
                    input.setSelectionRange(valueLength, valueLength);
                }
            });
        } catch (error) {
            this.showStatus(error?.message || 'Failed to load the latest secret value.', true);
        }
    }

    cancelDpuSecretInlineEdit() {
        const secretState = this.state.dpuSecretState;
        if (!secretState) {
            return;
        }
        this.setPreviewState({
            dpuSecretState: {
                ...secretState,
                editing: false,
                draft: String(secretState.value || ''),
                masked: true
            }
        }, { invalidate: false });
        this.refreshPreviewUi();
    }

    async saveDpuSecretInlineEdit() {
        const selectedPath = this.state.selectedPath || '';
        const secretState = this.state.dpuSecretState;
        if (!isDpuSecretPath(selectedPath) || !secretState?.canWrite) {
            return;
        }
        const input = this.element?.querySelector?.('.dpu-secret-editor-input');
        const nextValue = String(input?.value ?? secretState.draft ?? '');
        try {
            const latestSnapshot = await readDpuCurrentItemState(this, selectedPath);
            const latestUpdatedAt = String(latestSnapshot?.secret?.updatedAt || '');
            const editBaselineUpdatedAt = String(this.state.dpuSelectedUpdatedAt || '');
            if (editBaselineUpdatedAt && latestUpdatedAt && latestUpdatedAt !== editBaselineUpdatedAt) {
                await openDpuFile(this, selectedPath, { invalidate: false });
                throw new Error('This secret was updated by another user. Review the latest value and apply your changes again.');
            }
            await updateDpuSecret(this, selectedPath, { value: nextValue });
            this.showStatus(`Successfully saved ${selectedPath}`, false);
            await openDpuFile(this, selectedPath, { invalidate: false });
            this.setPreviewState({
                dpuSecretState: {
                    ...this.state.dpuSecretState,
                    masked: true,
                    editing: false
                }
            }, { invalidate: false });
            this.refreshPreviewUi();
        } catch (error) {
            console.error(error);
            this.showStatus(error?.message || 'Failed to save secret value.', true);
        }
    }

    async acquireDpuResearchResource(target, resourceId) {
        const id = String(resourceId || '').trim();
        if (!id) {
            this.showStatus('The selected DPU research resource is no longer available. Reopen it and try again.', true);
            return;
        }
        if (target?.disabled) return;
        const initialLabel = String(target?.textContent || 'Acquire');
        if (target) {
            target.disabled = true;
            target.setAttribute('aria-busy', 'true');
            target.textContent = initialLabel === 'Request Access' ? 'Requesting…' : 'Acquiring…';
        }
        this.showStatus(initialLabel === 'Request Access' ? 'Requesting DPU resource access…' : 'Starting DPU resource acquisition…');
        try {
            const idempotencyKey = this.state.dpuResearchIdempotencyKey || `explorer:${id}:${createSecureUuid()}`;
            this.state.dpuResearchIdempotencyKey = idempotencyKey;
            const result = await callDpuTool('dpu_resource_acquire', { id, idempotencyKey });
            if (result.proposal) {
                const confirmed = await this.confirmDpuActionProposal(result.proposal);
                if (!confirmed) this.state.dpuResearchIdempotencyKey = '';
            } else {
                this.showStatus(`Acquisition job ${result.job?.state || 'started'}.`);
                if (['succeeded', 'failed', 'cancelled'].includes(result.job?.state)) this.state.dpuResearchIdempotencyKey = '';
            }
            await openDpuFile(this, this.state.selectedPath, { invalidate: false });
        } catch (error) {
            this.showStatus(error?.message || 'Failed to acquire the resource.', true);
        } finally {
            if (target?.isConnected) {
                target.disabled = false;
                target.removeAttribute('aria-busy');
                target.textContent = initialLabel;
            }
        }
    }

    async requestDpuResearchAccess(target, resourceId) {
        return this.acquireDpuResearchResource(target, resourceId);
    }

    async verifyDpuResearchFileRead(target, encodedResourceId, encodedFilePath) {
        let resourceId = '';
        let filePath = '';
        try {
            resourceId = decodeURIComponent(String(encodedResourceId || '')).trim();
            filePath = decodeURIComponent(String(encodedFilePath || '')).trim();
        } catch {
            this.showStatus('The verification target is invalid. Reopen the resource and try again.', true);
            return;
        }
        if (!resourceId || !filePath) {
            this.showStatus('The verification target is missing. Reopen the resource and try again.', true);
            return;
        }
        if (target?.disabled) return;

        const initialLabel = String(target?.textContent || 'Verify read');
        if (target) {
            target.disabled = true;
            target.setAttribute('aria-busy', 'true');
            target.textContent = 'Verifying…';
        }
        this.showStatus(`Verifying read access to ${filePath}…`);

        let verified = false;
        try {
            const result = await callDpuTool('dpu_resource_file_read', {
                id: resourceId,
                path: filePath,
                offset: 0,
                length: 4096
            });
            if (result.encoding !== 'base64' || !Number.isSafeInteger(result.bytesRead) || typeof result.data !== 'string') {
                throw new Error('DPU returned an invalid verified-read response.');
            }
            verified = true;
            if (target?.isConnected) {
                target.textContent = `Verified · ${result.bytesRead} bytes`;
                target.dataset.verificationState = 'verified';
            }
            const continuation = result.eof ? 'end of file reached' : `next offset ${result.nextOffset}`;
            this.showStatus(`Verified read of ${filePath}: ${result.bytesRead} bytes, ${continuation}.`);
        } catch (error) {
            this.showStatus(error?.message || `Failed to verify read access to ${filePath}.`, true);
        } finally {
            if (target?.isConnected) {
                target.disabled = false;
                target.removeAttribute('aria-busy');
                if (!verified) target.textContent = initialLabel;
            }
        }
    }

    async runDpuFederatedExperiment(target) {
        const selectedId = this.state.dpuResearchResourceId;
        const backendId = String(target?.dataset?.backendId || '').trim();
        if (!selectedId || !backendId) return;
        const participantText = prompt('Participant resource UUIDs (comma separated, minimum three):', selectedId);
        if (participantText === null) return;
        const participantResourceIds = participantText.split(',').map((value) => value.trim()).filter(Boolean);
        const templateId = prompt('Configured NVFlare template ID:', 'default');
        if (!templateId) return;
        const modelId = prompt('Model ID:', 'federated-model');
        if (!modelId) return;
        const modelRevision = prompt('Exact model revision:', '1');
        if (!modelRevision) return;
        const strategy = String(prompt('Strategy (fedavg, fedprox, scaffold):', 'fedavg') || '').trim().toLowerCase();
        if (!strategy) return;
        const rounds = Number(prompt('Training rounds:', '3'));
        try {
            const result = await callDpuTool('dpu_federated_experiment_propose', {
                backendId, templateId, participantResourceIds, modelId, modelRevision, strategy, rounds,
                privacy: { secureAggregation: true, differentialPrivacy: { enabled: true } },
                evaluation: { leakageTests: ['membership', 'reconstruction'] },
                idempotencyKey: `explorer:federated:${createSecureUuid()}`
            });
            await this.confirmDpuActionProposal(result.proposal);
            this.showStatus(`Federated job ${result.job?.id || ''} was proposed.`);
        } catch (error) {
            this.showStatus(error?.message || 'Failed to propose federated execution.', true);
        }
    }

    async runDpuSecureExecution(target) {
        const selectedId = this.state.dpuResearchResourceId;
        const backendId = String(target?.dataset?.backendId || '').trim();
        if (!selectedId || !backendId) return;
        const workloadId = prompt('Secure workload ID:');
        if (!workloadId) return;
        try {
            const result = await callDpuTool('dpu_secure_execution_propose', {
                backendId, workloadId, resourceIds: [selectedId], parameters: {}, outputPolicy: {},
                idempotencyKey: `explorer:secure:${createSecureUuid()}`
            });
            await this.confirmDpuActionProposal(result.proposal);
        } catch (error) {
            this.showStatus(error?.message || 'Failed to propose secure execution.', true);
        }
    }

    async confirmDpuActionProposal(proposal) {
        if (!proposal?.id) return false;
        const effects = Array.isArray(proposal.effects) ? proposal.effects.join('\n') : '';
        const accepted = await assistOS.UI.showModal('confirm-action-modal', {
            message: `Confirm DPU action "${proposal.type}"?\n\n${effects}\n\nExpires: ${proposal.expiresAt || 'unknown'}`
        }, true);
        if (!accepted) {
            await callDpuTool('dpu_action_reject', { id: proposal.id });
            this.showStatus('DPU action was rejected.');
            return false;
        }
        const result = await callDpuTool('dpu_action_confirm', { id: proposal.id });
        this.showStatus(result.job?.error || `DPU action ${proposal.id} was confirmed.`, Boolean(result.job?.error));
        return true;
    }

    async showDpuResearchPermissions() {
        const record = this.state.dpuResearchRecord || {};
        const id = this.state.dpuResearchResourceId;
        if (!id) return;
        try {
            const result = await assistOS.UI.showModal('dpu-permissions-modal', {
                agent: 'explorer',
                kind: 'resource',
                id,
                path: this.state.selectedPath || '/Confidential/Research Data',
                name: record.name || record.externalId || id
            }, true);
            if (result?.changed && this.state.selectedPath) {
                await openDpuFile(this, this.state.selectedPath, { invalidate: false });
            }
        } catch (error) {
            this.showStatus(error?.message || 'Failed to open resource permissions.', true);
        }
    }

    async cancelDpuResearchJob() {
        const id = this.state.dpuResearchJobId;
        if (!id) return;
        try {
            await callDpuTool('dpu_job_cancel', { id });
            this.showStatus(`Job ${id} was cancelled.`);
            await openDpuFile(this, this.state.selectedPath, { invalidate: false });
        } catch (error) {
            this.showStatus(error?.message || 'Failed to cancel the job.', true);
        }
    }

    askDpuResearchAgent(_target, encodedResourceId) {
        let resourceId = '';
        try {
            resourceId = decodeURIComponent(String(encodedResourceId || '')).trim();
        } catch {
            this.showStatus('The selected DPU research resource is invalid. Reopen it and try again.', true);
            return;
        }
        if (!resourceId) {
            this.showStatus('No DPU research resource is selected.', true);
            return;
        }
        const params = new URLSearchParams({
            agent: 'dpuAgent',
            'forward-envelope': '1',
            'workspace-dir': '.',
            'dpu-resource-id': resourceId
        });
        const opened = window.open(`/webchat?${params.toString()}`, '_blank', 'noopener,noreferrer');
        this.showStatus(opened === null ? 'Allow pop-ups to open DPU Agent WebChat.' : 'DPU Agent WebChat opened with the selected resource.');
    }

    setPreviewViewMode(_target, mode) {
        if (!this.isHtmlPreviewCandidate(this.state.selectedPath)) {
            return;
        }
        this.dispatchPreview({
            type: PREVIEW_ACTIONS.SET_VIEW_MODE,
            payload: { mode }
        }, { invalidate: true });
    }

    getActiveWebViewPresenter() {
        const webViewElement = this.element?.querySelector?.('html-web-view');
        return webViewElement?.webSkelPresenter || null;
    }

    refreshWebPreviewPane() {
        const presenter = this.getActiveWebViewPresenter();
        if (presenter && typeof presenter.refreshIframe === 'function') {
            presenter.refreshIframe();
            return;
        }
        this.dispatchPreview({
            type: PREVIEW_ACTIONS.REFRESH,
            payload: { path: this.state.selectedPath }
        }, { invalidate: true });
    }

    openWebPreviewInTab() {
        const presenter = this.getActiveWebViewPresenter();
        if (presenter && typeof presenter.openInNewTab === 'function') {
            presenter.openInNewTab();
            return;
        }
        const webViewUrl = this.state.webViewUrl || this.buildWebViewUrl(this.state.selectedPath);
        if (!webViewUrl) return;
        try {
            const absoluteUrl = new URL(webViewUrl, window.location.origin).toString();
            window.open(absoluteUrl, '_blank', 'noopener,noreferrer');
        } catch (_) {
            // ignore malformed URL fallback
        }
    }

    openEntryInNewTab(element) {
        const targetPath = this.normalizePath(element?.dataset?.entryPath || '');
        if (!targetPath) {
            return false;
        }
        try {
            const targetUrl = new URL(buildFileExpHash(targetPath), window.location.href);
            window.open(targetUrl.toString(), '_blank', 'noopener,noreferrer');
            return true;
        } catch (_) {
            return false;
        }
    }

    async openTerminalHere(element) {
        const relativePath = canonicalTerminalDirectoryPath(element?.dataset?.entryPath);
        if (relativePath === null) {
            return false;
        }
        try {
            await assistOS.UI.showModal('terminal-target-modal', { dir: relativePath });
            return true;
        } catch (_) {
            return false;
        }
    }

    dispatchUi(action, options = {}) {
        const { invalidate = false } = options;
        const transition = fileExpUiReducer(this.state, action);
        if (!transition.changed) {
            return false;
        }
        Object.assign(this.state, transition.patch);
        if (invalidate) {
            this.invalidate();
        }
        return true;
    }

    setToolbarMenuOpen(open, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_TOOLBAR_MENU_OPEN,
            payload: { open }
        }, options);
    }

    setSearchMenuOpen(open, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_SEARCH_MENU_OPEN,
            payload: { open }
        }, options);
    }

    setPendingHighlight(highlight, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_PENDING_HIGHLIGHT,
            payload: { highlight }
        }, options);
    }

    setOpenMenuPath(pathValue, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_OPEN_MENU_PATH,
            payload: { path: pathValue }
        }, options);
    }

    setListWidth(width, options = {}) {
        const result = this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_LIST_WIDTH,
            payload: { width }
        }, options);
        const nextWidth = Number.isFinite(this.state?.listWidth) ? this.state.listWidth : null;
        saveListWidthPreference(nextWidth);
        return result;
    }

    setListCollapsed(listCollapsed, options = {}) {
        const result = this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_LIST_COLLAPSED,
            payload: { listCollapsed }
        }, options);
        saveListCollapsedPreference(Boolean(this.state?.listCollapsed));
        return result;
    }

    setExplorerHeaderCollapsed(explorerHeaderCollapsed, options = {}) {
        const result = this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_EXPLORER_HEADER_COLLAPSED,
            payload: { explorerHeaderCollapsed }
        }, options);
        saveExplorerHeaderCollapsedPreference(Boolean(this.state?.explorerHeaderCollapsed));
        return result;
    }

    setDirectoryViewMode(directoryViewMode, options = {}) {
        const result = this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_DIRECTORY_VIEW_MODE,
            payload: { directoryViewMode }
        }, options);
        saveDirectoryViewModePreference(this.state?.directoryViewMode || 'list');
        return result;
    }

    setIsResizing(isResizing, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_IS_RESIZING,
            payload: { isResizing }
        }, options);
    }

    setColumnVisibility(column, visible, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_COLUMN_VISIBILITY,
            payload: { column, visible }
        }, options);
    }

    setHasUnsavedChanges(hasUnsavedChanges, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_HAS_UNSAVED_CHANGES,
            payload: { hasUnsavedChanges }
        }, options);
    }

    setFilterSpecs(filterSpecs, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_FILTER_SPECS,
            payload: { filterSpecs }
        }, options);
    }

    setPreviewState(patch, options = {}) {
        return this.dispatchUi({
            type: FILE_EXP_UI_ACTIONS.SET_PREVIEW_STATE,
            payload: { patch }
        }, options);
    }

    isHtmlPreviewCandidate(pathValue) {
        return /\.html?$/i.test(String(pathValue || ''));
    }

    syncWebViewForPath(pathValue) {
        this.dispatchPreview({
            type: PREVIEW_ACTIONS.SYNC_PATH,
            payload: {
                path: pathValue,
                buildWebViewUrl: (path) => this.buildWebViewUrl(path)
            }
        });
    }

    dispatchPreview(action, options = {}) {
        const { invalidate = false } = options;
        const transition = previewReducer(this.state, action);
        if (!transition.changed) {
            return false;
        }
        Object.assign(this.state, transition.patch);
        if (invalidate) {
            this.invalidate();
        }
        return true;
    }

    buildWebViewUrl(pathValue) {
        const rawPath = String(pathValue || '').trim();
        if (!rawPath) return '';
        const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!normalized || normalized.includes('..')) return '';

        const encodedPath = normalized
            .split('/')
            .filter(Boolean)
            .map((part) => encodeURIComponent(part))
            .join('/');
        return `/workspace-files/${encodedPath}`;
    }

    attachPreviewAnchorHandler() {
        return attachPreviewAnchorHandlerImpl(this);
    }

    detachPreviewAnchorHandler() {
        return detachPreviewAnchorHandlerImpl(this);
    }

    handlePreviewAnchorClick(event) {
        return handlePreviewAnchorClickImpl(this, event);
    }

    positionOpenActionMenu() {
        return positionOpenActionMenuImpl(this);
    }

    handleSortClick(event) {
        return handleSortClickImpl(this, event);
    }

}
