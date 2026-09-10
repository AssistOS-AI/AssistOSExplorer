// Wire up search-related behaviors for FileExp without bloating the main presenter.
import { getKeymap, matchesShortcut } from "../../../utils/keymap.js";
import { getCurrentTheme } from "../../../shared/ui/theme.js";
import { FILE_EXP_REPLACE_COMPLETE_EVENT } from "../../../utils/appEvents.js";
import { withTimeout } from "../../utils/workspace-search-utils.js";
import { callExplorerTool } from "../../../services/infrastructure/explorerApi.js";
import { buildFileExpHash } from "./file-exp-utils.js";
import { consumeConversationSettingsRequest } from "./conversation-settings-route.mjs";
export function attachSearchController(fileExp) {
    const getState = () => fileExp.state;
    const defaultExclude = 'node_modules,.git';
    const setDocumentListener = (key, eventName, handler, options) => {
        if (typeof fileExp.setDocumentListener === 'function') {
            return fileExp.setDocumentListener(key, eventName, handler, options);
        }
        document.addEventListener(eventName, handler, options);
        return () => document.removeEventListener(eventName, handler, options);
    };
    const removeDocumentListener = (key) => {
        if (typeof fileExp.removeDocumentListener === 'function') {
            return fileExp.removeDocumentListener(key);
        }
        return false;
    };
    const setWindowListener = (key, eventName, handler, options) => {
        if (typeof fileExp.setWindowListener === 'function') {
            return fileExp.setWindowListener(key, eventName, handler, options);
        }
        if (typeof fileExp.addWindowListener === 'function') {
            return fileExp.addWindowListener(eventName, handler, options);
        }
        window.addEventListener(eventName, handler, options);
        return () => window.removeEventListener(eventName, handler, options);
    };

    const getEl = (selector) => fileExp.element?.querySelector(selector);

    function updateSearchUI() {
        const state = getState();
        const menu = getEl('#searchMenuDropdown');
        const menuButton = getEl('#searchMenuButton');
        if (menu && menuButton) {
            menu.classList.toggle('open', state.searchMenuOpen);
            menuButton.setAttribute('aria-expanded', state.searchMenuOpen ? 'true' : 'false');
        }
        if (state.searchMenuOpen) {
            setDocumentListener('search-menu-outside', 'click', fileExp.boundOutsideSearchMenuClick, true);
        } else {
            removeDocumentListener('search-menu-outside');
        }
    }

    function setupSearchBindings() {
        if (!fileExp.boundGlobalKeydown) {
            fileExp.boundGlobalKeydown = handleGlobalKeydown;
        }
        setDocumentListener('search-global-keydown', 'keydown', fileExp.boundGlobalKeydown);
        if (!fileExp.boundOutsideSearchMenuClick) {
            fileExp.boundOutsideSearchMenuClick = handleOutsideSearchMenuClick;
        }
    }

    function toggleSearchMenu() {
        const state = getState();
        fileExp.setSearchMenuOpen(!state.searchMenuOpen);
        updateSearchUI();
    }

    function buildDirectorySuggestions() {
        const state = getState();
        const suggestions = new Set(['/']);
        const normalize = (value) => fileExp.normalizePath(value || '/');
        const add = (value) => {
            if (!value) return;
            suggestions.add(normalize(value));
        };

        add(state.path || '/');
        let current = normalize(state.path || '/');
        while (current && current !== '/') {
            const parent = fileExp.parentPath(current) || '/';
            add(parent);
            if (parent === current) break;
            current = parent;
        }

        const entries = Array.isArray(state.allEntries) ? state.allEntries : Array.isArray(state.entries) ? state.entries : [];
        entries.forEach((entry) => {
            if (entry?.type === 'directory' && entry.path) {
                add(entry.path);
            }
        });

        const cachedDirs = fileExp.caches?.dirListing?.keys?.() || [];
        cachedDirs.forEach((dir) => add(dir));

        return Array.from(suggestions).sort();
    }

    async function openSearchModal(mode) {
        const state = getState();
        fileExp.setSearchMenuOpen(false);
        updateSearchUI();
        const previousSearchByNameExclude = String(state.searchByNameExclude || defaultExclude);
        const previousWorkspaceVersion = Number.isFinite(state.workspaceVersion) ? state.workspaceVersion : 0;
        const previousDirectoryFilterQuery = String(state.directoryFilterQuery || '').trim();

        const result = await assistOS.UI.createReactiveModal('file-search-modal', {
            mode,
            searchByNameQuery: state.searchByNameQuery || '',
            searchByNameExclude: state.searchByNameExclude || defaultExclude,
            searchInFilesQuery: state.searchInFilesQuery || '',
            searchInFilesExclude: state.searchInFilesExclude || defaultExclude,
            searchInFilesCase: Boolean(state.searchInFilesCaseSensitive),
            searchInFilesRegex: Boolean(state.searchInFilesRegex),
            searchInFilesWholeWord: Boolean(state.searchInFilesWholeWord),
            searchInFilesBasePath: state.searchInFilesBasePath || '/',
            workspaceVersion: Number.isFinite(state.workspaceVersion) ? state.workspaceVersion : 0,
            directorySuggestions: buildDirectorySuggestions(),
            basePath: fileExp.normalizePath(state.path || '/')
        }, true);

        if (result && typeof result === 'object') {
            if (Object.prototype.hasOwnProperty.call(result, 'searchByNameQuery')) {
                state.searchByNameQuery = String(result.searchByNameQuery || '');
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchByNameExclude')) {
                state.searchByNameExclude = String(result.searchByNameExclude || defaultExclude);
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesQuery')) {
                state.searchInFilesQuery = String(result.searchInFilesQuery || '');
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesExclude')) {
                state.searchInFilesExclude = String(result.searchInFilesExclude || defaultExclude);
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesCaseSensitive')
                || Object.prototype.hasOwnProperty.call(result, 'searchInFilesCase')) {
                state.searchInFilesCaseSensitive = Boolean(
                    result.searchInFilesCaseSensitive ?? result.searchInFilesCase
                );
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesRegex')) {
                state.searchInFilesRegex = Boolean(result.searchInFilesRegex);
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesWholeWord')) {
                state.searchInFilesWholeWord = Boolean(result.searchInFilesWholeWord);
            }
            if (Object.prototype.hasOwnProperty.call(result, 'searchInFilesBasePath')) {
                state.searchInFilesBasePath = fileExp.normalizePath(result.searchInFilesBasePath || '/');
            }
            const modalWorkspaceVersion = Number.parseInt(String(result.workspaceVersion ?? ''), 10);
            if (Number.isFinite(modalWorkspaceVersion) && modalWorkspaceVersion > (state.workspaceVersion || 0)) {
                state.workspaceVersion = modalWorkspaceVersion;
                window.__assistosExplorerWorkspaceVersion = modalWorkspaceVersion;
            }
        }

        const currentWorkspaceVersion = Number.isFinite(state.workspaceVersion) ? state.workspaceVersion : 0;
        const shouldRefreshDirectoryFilter = !result?.path
            && previousDirectoryFilterQuery.length >= 2
            && (
                String(state.searchByNameExclude || defaultExclude) !== previousSearchByNameExclude
                || currentWorkspaceVersion !== previousWorkspaceVersion
            );
        if (shouldRefreshDirectoryFilter) {
            try {
                await fileExp.directoryFilterController?.rerunIfActive?.();
            } catch (error) {
                console.warn('Failed to rerun active directory filter after search settings update', error);
            }
        }

        if (result && result.path) {
            const normalized = fileExp.normalizePath(result.path);
            const line = Number.parseInt(String(result.line ?? ''), 10);
            if (Number.isFinite(line) && line > 0) {
                fileExp.setPendingHighlight({ path: normalized, line });
            }
            await navigateToPath(normalized);
        }
    }

    async function openSearchByName() {
        await openSearchModal('name');
    }

    async function openSearchInFiles() {
        await openSearchModal('replace');
    }

    async function openReplaceInFiles() {
        await openSearchModal('replace');
    }

    async function openSettingsModal(_target, tab = 'agents', copilotContext) {
        const state = getState();
        const normalizedTab = ['agents', 'plugins', 'copilot', 'keymap', 'editor', 'theme', 'avatar', 'users'].includes(tab) ? tab : 'agents';
        fileExp.setSearchMenuOpen(false);
        updateSearchUI();
        const result = await assistOS.UI.createReactiveModal('settings-modal', {
            tab: normalizedTab,
            ...(copilotContext ? { copilotContext } : {}),
            keymap: state.keymap || getKeymap(),
            theme: getCurrentTheme(),
            editorAutoSaveEnabled: Boolean(state.editorAutoSaveEnabled),
            editorAutoSaveIntervalSeconds: Number.isFinite(state.editorAutoSaveIntervalSeconds)
                ? state.editorAutoSaveIntervalSeconds
                : 10
        }, true);
        if (result?.keymap) {
            state.keymap = result.keymap;
        }
        if (result && Object.prototype.hasOwnProperty.call(result, 'editorAutoSaveEnabled')) {
            fileExp.setEditorAutoSaveSettings?.(
                Boolean(result.editorAutoSaveEnabled),
                Number.parseInt(String(result.editorAutoSaveIntervalSeconds ?? ''), 10)
            );
        }
    }

    async function openConversationSettingsFromLocation() {
        try {
            const context = consumeConversationSettingsRequest(window.location, window.history);
            if (context) await openSettingsModal(null, 'copilot', context);
        } catch (error) {
            fileExp.showStatus(error?.message || 'Unable to open conversation settings.', true);
        }
    }

    function closeSearchOverlays() {
        fileExp.setSearchMenuOpen(false);
        updateSearchUI();
    }

    function handleGlobalKeydown(event) {
        const keymap = getState().keymap || getKeymap();
        if (keymap.findFile && matchesShortcut(event, keymap.findFile)) {
            event.preventDefault();
            openSearchByName();
            return;
        }
        if (keymap.findInFiles && matchesShortcut(event, keymap.findInFiles)) {
            event.preventDefault();
            openSearchInFiles();
            return;
        }
        if (keymap.replaceInFiles && matchesShortcut(event, keymap.replaceInFiles)) {
            event.preventDefault();
            openReplaceInFiles();
            return;
        }
        if (keymap.saveFile && matchesShortcut(event, keymap.saveFile)) {
            if (getState().isEditing) {
                event.preventDefault();
                fileExp.saveFile();
            }
            return;
        }
        if (keymap.openKeymap && matchesShortcut(event, keymap.openKeymap)) {
            event.preventDefault();
            openSettingsModal(null, 'keymap');
            return;
        }
        if (event.key === 'Escape') {
            const state = getState();
            if (state.searchMenuOpen) {
                event.preventDefault();
                closeSearchOverlays();
            }
        }
    }

    function handleOutsideSearchMenuClick(event) {
        const state = getState();
        if (!state.searchMenuOpen) return;
        const dropdown = fileExp.element.querySelector('.search-dropdown');
        if (dropdown && !dropdown.contains(event.target)) {
            fileExp.setSearchMenuOpen(false);
            updateSearchUI();
        }
    }

    async function handleReplaceComplete(event) {
        const changedRaw = Array.isArray(event?.detail?.changedFiles) ? event.detail.changedFiles : [];
        if (!changedRaw.length) return;
        const changed = changedRaw
            .map((pathValue) => fileExp.normalizePath(pathValue))
            .filter(Boolean);
        if (!changed.length) return;
        const state = getState();
        if (typeof fileExp.bumpWorkspaceVersion === 'function') {
            fileExp.bumpWorkspaceVersion();
        }
        try {
            if (fileExp.caches?.filePreview?.invalidateForPath) {
                changed.forEach((filePath) => fileExp.caches.filePreview.invalidateForPath(filePath));
            }
            if (fileExp.caches?.dirListing?.invalidate) {
                const dirsToInvalidate = new Set();
                if (state.path) {
                    dirsToInvalidate.add(fileExp.normalizePath(state.path));
                }
                changed.forEach((filePath) => {
                    const parent = fileExp.parentPath(filePath) || '/';
                    dirsToInvalidate.add(fileExp.normalizePath(parent));
                });
                dirsToInvalidate.forEach((dirPath) => {
                    fileExp.caches.dirListing.invalidate(fileExp, dirPath);
                });
            }
            const selectedPath = state.selectedPath ? fileExp.normalizePath(state.selectedPath) : '';
            if (state.isEditing && selectedPath && changed.includes(selectedPath)) {
                await fileExp.markExternalModificationDetected?.();
                return;
            }
            if (selectedPath && changed.includes(selectedPath)) {
                void fileExp.openFile(state.selectedPath, {
                    showLoader: false,
                    requestTimeoutMs: 6000,
                    suppressReadErrorStatus: true
                }).catch((error) => {
                    console.warn('Background refresh after replace failed', error);
                });
                fileExp.showStatus('Replace completed. Current file refreshes in background.', false);
            }
        } catch (error) {
            console.warn('Failed to refresh after replace', error);
            fileExp.showStatus('Replace completed. Manual refresh may be needed.', true);
        }
    }

    async function openSearchResult(element) {
        const path = element?.dataset?.filePath;
        if (!path) return;
        const parsedLine = Number.parseInt(String(element.dataset.line ?? ''), 10);
        const line = Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null;
        const normalized = fileExp.normalizePath(path);
        fileExp.setPendingHighlight(line ? { path: normalized, line } : null);
        closeSearchOverlays();
        await navigateToPath(normalized);
    }

    async function navigateToPath(targetPath) {
        const normalized = fileExp.normalizePath(targetPath);
        const state = getState();
        const isTimeoutError = (error) => /timed out/i.test(String(error?.message || ''));
        return fileExp.withLoader(async () => {
            if (state.isEditing && state.hasUnsavedChanges) {
                if (!confirm("You have unsaved changes. Navigate away?")) {
                    return;
                }
                await fileExp.cancelEdit();
            }
            try {
                await withTimeout(
                    () => callExplorerTool('read_text_file', { path: normalized }, { raw: true, withLoader: false }),
                    {
                        timeoutMs: 10000,
                        timeoutMessage: 'Opening file timed out. Try again in a moment.'
                    }
                );
                const parentDir = fileExp.parentPath(normalized) || '/';
                state.path = parentDir;
                const entries = await fileExp.loadDirectoryContent(parentDir);
                await fileExp.setEntries(entries);
                state.selectedPath = normalized;
                state.isEditing = false;
                if (state.pendingHighlight && state.pendingHighlight.path === normalized) {
                    fileExp.caches?.filePreview?.invalidateForPath?.(normalized);
                }
                await fileExp.openFile(normalized);
                history.replaceState(null, '', buildFileExpHash(normalized));
            } catch (error) {
                if (isTimeoutError(error)) {
                    fileExp.showStatus(error.message || 'Opening file timed out. Try again.', true);
                    return;
                }
                fileExp.setPendingHighlight(null);
                await fileExp.loadDirectory(normalized);
                history.replaceState(null, '', buildFileExpHash(normalized));
            }
        });
    }

    Object.assign(fileExp, {
        setupSearchBindings,
        updateSearchUI,
        toggleSearchMenu,
        openSearchByName,
        openSearchInFiles,
        openReplaceInFiles,
        openSettingsModal,
        openConversationSettingsFromLocation,
        closeSearchOverlays,
        openSearchResult,
        navigateToPath,
        handleReplaceComplete
    });

    if (!fileExp.boundReplaceComplete) {
        fileExp.boundReplaceComplete = handleReplaceComplete;
    }
    setWindowListener('replace-complete', FILE_EXP_REPLACE_COMPLETE_EVENT, fileExp.boundReplaceComplete);
}
