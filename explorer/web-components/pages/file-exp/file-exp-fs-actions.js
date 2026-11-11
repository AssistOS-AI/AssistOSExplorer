// File system related UI actions for FileExp, attached to the presenter to keep it lean.
import { buildFileExpHash, showContextPasteMenu } from "./file-exp-utils.js";
import { callToolWithLoader } from "../../../utils/globalLoader.js";
import { getNewFileInitialContent } from "../../../services/onlyoffice/onlyoffice-new-file-content.js";
import { retryOnStaleBrowserProof } from "../../../services/infrastructure/browserMutationRetry.js";
import { FILE_EXP_UI_ACTIONS } from "./file-exp-ui-controller.js";
import { PREVIEW_ACTIONS } from "./file-exp-preview-controller.js";
import {
    invalidateFsMutationCaches,
    isSameOrDescendantPath
} from "./file-exp-fs-mutation-utils.js";
import {
    DPU_SECRETS_PATH,
    createDpuDirectory,
    createDpuFile,
    deleteDpuEntry,
    getDpuPermissionsTarget,
    getDpuPathCapabilities,
    invalidateDpuState,
    isDpuManagedPath,
    renameDpuEntry,
    uploadDpuFiles
} from "./file-exp-dpu-provider.js";

export function attachFsActions(fileExp) {
    Object.assign(fileExp, {
        scheduleOpenActionMenuPosition() {
            if (this.openActionMenuPositionFrame !== null) {
                cancelAnimationFrame(this.openActionMenuPositionFrame);
            }
            this.openActionMenuPositionFrame = requestAnimationFrame(() => {
                this.openActionMenuPositionFrame = null;
                this.positionOpenActionMenu?.();
            });
        },

        scheduleOpenActionMenuPositionSettle() {
            this.scheduleOpenActionMenuPosition();
            requestAnimationFrame(() => {
                this.scheduleOpenActionMenuPosition();
            });
        },

        clearOpenActionMenuTracking() {
            if (this.openActionMenuResizeObserver) {
                this.openActionMenuResizeObserver.disconnect();
                this.openActionMenuResizeObserver = null;
            }
            if (this.openActionMenuMutationObserver) {
                this.openActionMenuMutationObserver.disconnect();
                this.openActionMenuMutationObserver = null;
            }
            this.removeDocumentListener?.('open-menu-scroll');
            this.removeWindowListener?.('open-menu-resize');
            this.openActionMenuDropdown = null;
            if (this.openActionMenuPositionFrame !== null) {
                cancelAnimationFrame(this.openActionMenuPositionFrame);
                this.openActionMenuPositionFrame = null;
            }
        },

        syncOpenActionMenuTracking() {
            const openPath = this.state.openMenuPath;
            if (!openPath) {
                this.clearOpenActionMenuTracking();
                return;
            }
            const dropdown = this.element?.querySelector?.(`[data-action-menu="true"][data-entry-path="${openPath}"] .action-menu-dropdown`);
            if (!dropdown) {
                this.clearOpenActionMenuTracking();
                return;
            }
            if (this.openActionMenuDropdown === dropdown) {
                this.scheduleOpenActionMenuPositionSettle();
                return;
            }

            this.clearOpenActionMenuTracking();
            this.openActionMenuDropdown = dropdown;
            this.setDocumentListener?.('open-menu-scroll', 'scroll', this.boundOpenActionMenuViewportChange, {
                capture: true,
                passive: true
            });
            this.setWindowListener?.('open-menu-resize', 'resize', this.boundOpenActionMenuViewportChange, {
                passive: true
            });

            if (typeof ResizeObserver !== 'undefined') {
                this.openActionMenuResizeObserver = new ResizeObserver(() => {
                    this.scheduleOpenActionMenuPositionSettle();
                });
                this.openActionMenuResizeObserver.observe(dropdown);
            }
            if (typeof MutationObserver !== 'undefined') {
                this.openActionMenuMutationObserver = new MutationObserver(() => {
                    this.scheduleOpenActionMenuPositionSettle();
                });
                this.openActionMenuMutationObserver.observe(dropdown, {
                    childList: true,
                    subtree: true
                });
            }

            this.scheduleOpenActionMenuPositionSettle();
        },

        ensureMutableFsPath(targetPath = this.state.path) {
            const normalized = this.normalizePath(targetPath || '/');
            if (isDpuManagedPath(normalized)) {
                this.showStatus('Confidential workspace items are managed by DPU. Explorer filesystem actions are unavailable here.', true);
                return false;
            }
            return true;
        },

        resolveUploadTargetPath(targetPath = this.state.selectedPath) {
            const fallbackPath = this.state.path || '/';
            const raw = typeof targetPath === 'string' && targetPath.trim() ? targetPath.trim() : fallbackPath;
            const normalizedTarget = this.normalizePath(raw);
            const selectedEntry = Array.isArray(this.state.entries)
                ? this.state.entries.find((entry) => this.normalizePath(entry.path) === normalizedTarget)
                : null;
            if (selectedEntry?.type === 'directory') {
                return normalizedTarget;
            }
            if (selectedEntry?.type === 'file') {
                return this.parentPath(normalizedTarget) || '/';
            }
            return this.normalizePath(fallbackPath);
        },

        openUploadPicker(element) {
            const input = this.element.querySelector('#fileUploadInput');
            if (!input) {
                this.showStatus('Upload input is unavailable.', true);
                return;
            }
            const targetPath = element?.dataset?.targetPath || this.state.selectedPath || this.state.path || '/';
            input.dataset.targetPath = this.resolveUploadTargetPath(targetPath);
            input.value = '';
            input.click();
        },

        uploadHere(element) {
            this.closeActionMenu(false);
            this.openUploadPicker(element);
        },

        async openDpuPermissions(element) {
            const targetPath = this.normalizePath(element?.dataset?.entryPath || '');
            if (!targetPath || !isDpuManagedPath(targetPath)) {
                return;
            }
            this.closeActionMenu(false);
            try {
                const target = await getDpuPermissionsTarget(this, targetPath);
                const result = await assistOS.UI.showModal('dpu-permissions-modal', {
                    agent: 'explorer',
                    kind: target.kind,
                    id: target.id,
                    key: target.key,
                    path: target.path,
                    name: target.name
                }, true);
                if (!result?.changed) {
                    return;
                }

                invalidateDpuState(this, [
                    this.state.path,
                    this.state.selectedPath,
                    targetPath,
                    '/Confidential/Shared',
                    '/Confidential/Secrets'
                ]);

                const refreshedEntries = await this.loadDirectoryContent(this.state.path);
                if (refreshedEntries !== null) {
                    await this.setEntries(refreshedEntries);
                }

                if (this.state.selectedPath && isDpuManagedPath(this.state.selectedPath)) {
                    const selectedEntryStillVisible = Array.isArray(refreshedEntries)
                        ? refreshedEntries.some((entry) => this.normalizePath(entry.path) === this.normalizePath(this.state.selectedPath))
                        : false;
                    if (selectedEntryStillVisible) {
                        await this.openFile(this.state.selectedPath, {
                            showLoader: false,
                            invalidate: false
                        });
                    }
                }

                this.showStatus('Permissions updated.');
                this.invalidate();
            } catch (error) {
                console.error(error);
                this.showStatus(this.humanizeFsError(error), true);
            }
        },

        async handleUploadSelection(event) {
            const input = event?.target;
            const files = Array.from(input?.files || []);
            if (!files.length) return;

            const targetDir = this.resolveUploadTargetPath(input?.dataset?.targetPath || this.state.selectedPath || this.state.path);
            const uploadedPaths = [];
            try {
                await this.withLoader(async () => {
                    if (isDpuManagedPath(targetDir)) {
                        const capabilities = await getDpuPathCapabilities(this, targetDir);
                        if (!capabilities.canUpload) {
                            throw new Error('Uploads are not allowed in this Confidential folder.');
                        }
                        const created = await uploadDpuFiles(this, targetDir, files);
                        uploadedPaths.push(...created.map((item) => this.joinPath(targetDir, item?.name || '')).filter(Boolean));
                    } else {
                        if (!this.ensureMutableFsPath(targetDir)) {
                            return;
                        }
                        for (const file of files) {
                            const targetPath = this.joinPath(targetDir, file.name);
                            const response = await retryOnStaleBrowserProof(() => fetch(`/upload?path=${encodeURIComponent(targetPath)}`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': file.type || 'application/octet-stream'
                                },
                                body: file
                            }));
                            const payload = await response.json().catch(() => ({}));
                            if (!response.ok || payload?.ok === false) {
                                throw new Error(payload?.error || `Failed to upload ${file.name}.`);
                            }
                            uploadedPaths.push(targetPath);
                        }
                        this.bumpWorkspaceVersion?.();
                        invalidateFsMutationCaches(this, {
                            directories: [targetDir, this.state.path],
                            files: uploadedPaths
                        });
                    }
                    await this.loadDirectory(this.state.path);
                    if (uploadedPaths.length === 1) {
                        await this.selectEntry({
                            dataset: {
                                entryPath: uploadedPaths[0],
                                type: 'file'
                            }
                        });
                    }
                    this.showStatus(
                        uploadedPaths.length === 1
                            ? `Uploaded ${files[0].name}.`
                            : `Uploaded ${uploadedPaths.length} files.`
                    );
                });
            } catch (err) {
                console.error(err);
                this.showStatus(err.message || 'Failed to upload files.', true);
            } finally {
                if (input) {
                    input.value = '';
                }
            }
        },

        async deleteEntry(element) {
            const path = element.dataset.entryPath;
            const type = element.dataset.type;
            this.closeActionMenu();
            if (!confirm(`Are you sure you want to delete ${path}?`)) return;
            try {
                await this.withLoader(async () => {
                    const deletesCurrentSelection = isSameOrDescendantPath(this, this.state.selectedPath, path);
                    if (deletesCurrentSelection) {
                        this.stopCurrentFileViewWatch?.();
                        this.stopEditorExternalWatch?.();
                    }
                    if (isDpuManagedPath(path)) {
                        const capabilities = await getDpuPathCapabilities(this, path);
                        if (!capabilities.canDelete) {
                            throw new Error('You do not have permission to delete this Confidential item.');
                        }
                        await deleteDpuEntry(this, path);
                    } else {
                        if (!this.ensureMutableFsPath(path)) return;
                        const tool = type === 'directory' ? 'delete_directory' : 'delete_file';
                        await callToolWithLoader('explorer', tool, {path});
                        this.bumpWorkspaceVersion?.();
                    }
                    this.showStatus(`Successfully deleted ${path}`);

                    if (deletesCurrentSelection) {
                        this.dispatchUi({ type: FILE_EXP_UI_ACTIONS.RESET_DIRECTORY_CONTEXT });
                        this.dispatchPreview({ type: PREVIEW_ACTIONS.RESET });
                    }

                    if (isSameOrDescendantPath(this, this.state.clipboard?.path, path)) {
                        this.state.clipboard = null;
                    }

                    const parentPath = this.parentPath(path) || '/';
                    const nextDirectoryPath = isSameOrDescendantPath(this, this.state.path, path)
                        ? parentPath
                        : this.state.path;
                    invalidateFsMutationCaches(this, {
                        directories: [this.state.path, parentPath, nextDirectoryPath],
                        directoryBranches: type === 'directory' ? [path] : [],
                        files: type === 'file' ? [path] : []
                    });

                    if (deletesCurrentSelection) {
                        const newUrl = buildFileExpHash(nextDirectoryPath);
                        if (window.location.hash !== newUrl) {
                            history.replaceState(null, '', newUrl);
                        }
                    }
                    await this.loadDirectory(nextDirectoryPath);
                });
            } catch (err) {
                console.error(err);
                this.showStatus(this.humanizeFsError(err), true);
            }
        },

        async renameEntry(element) {
            const source = element?.dataset?.entryPath;
            if (!source) return;
            this.closeActionMenu();
            const itemType = element.dataset.type;
            const currentName = source.split('/').pop();
            const input = prompt(`Enter a new name for "${currentName}":`, currentName);
            if (input === null) return;
            const newName = this.sanitizeEntryName(input);
            if (!newName) {
                this.showStatus('Please enter a valid name.', true);
                return;
            }
            if (newName === currentName) return;
            const parent = this.parentPath(source) || '/';
            const destination = this.joinPath(parent, newName);
            if (destination === source) return;
            try {
                await this.withLoader(async () => {
                    if (isDpuManagedPath(source)) {
                        const capabilities = await getDpuPathCapabilities(this, source);
                        if (!capabilities.canRename) {
                            throw new Error('You do not have permission to rename this Confidential item.');
                        }
                        await renameDpuEntry(this, source, newName);
                    } else {
                        if (!this.ensureMutableFsPath(source)) return;
                        await callToolWithLoader('explorer', 'move_file', {source, destination});
                        this.bumpWorkspaceVersion?.();
                        invalidateFsMutationCaches(this, {
                            directories: [parent, this.state.path],
                            directoryBranches: itemType === 'directory' ? [source] : [],
                            files: itemType === 'file' ? [source] : []
                        });
                    }
                    const wasSelected = this.state.selectedPath === source;
                    if (this.state.clipboard?.path === source) {
                        this.state.clipboard = {...this.state.clipboard, path: destination, name: newName};
                    }
                    const entries = await this.loadDirectoryContent(this.state.path);
                    await this.setEntries(entries);
                    this.showStatus(`Renamed "${currentName}" to "${newName}".`);
                    if (wasSelected) {
                        this.state.selectedPath = destination;
                        history.replaceState(null, '', buildFileExpHash(destination));
                        if (itemType === 'file') {
                            if (isDpuManagedPath(destination)) {
                                await this.selectEntry({ dataset: { entryPath: destination, type: 'file' } });
                            } else {
                                await this.openFile(destination);
                            }
                            return;
                        }
                    }
                    this.invalidate();
                });
            } catch (err) {
                console.error(err);
                this.showStatus(this.humanizeFsError(err), true);
            }
        },

        copyEntry(element) {
            const path = element?.dataset?.entryPath;
            if (!path) return;
            this.closeActionMenu(false);
            if (!this.ensureMutableFsPath(path)) return;
            const name = path.split('/').pop();
            this.state.clipboard = {mode: 'copy', path, name, type: element.dataset.type};
            this.showStatus(`Copied "${name}" to clipboard.`);
            this.updateClipboardUI();
        },

        cutEntry(element) {
            const path = element?.dataset?.entryPath;
            if (!path) return;
            this.closeActionMenu(false);
            if (!this.ensureMutableFsPath(path)) return;
            const name = path.split('/').pop();
            this.state.clipboard = {mode: 'cut', path, name, type: element.dataset.type};
            this.showStatus(`Ready to move "${name}".`);
            this.updateClipboardUI();
        },

        pasteHere() {
            return this.pasteClipboard({dataset: {targetPath: this.state.path}});
        },

        toggleActionMenu(element, maybeEvent) {
            if (maybeEvent?.stopPropagation) maybeEvent.stopPropagation();
            if (maybeEvent?.preventDefault) maybeEvent.preventDefault();
            const path = element?.dataset?.entryPath;
            if (!path) return;
            const previous = this.state.openMenuPath;
            const next = previous === path ? null : path;
            if (!next) {
                this.closeActionMenu(false);
                return;
            }
            this.openActionMenu(next);
        },

        handleOutsideMenuClick(event) {
            if (!this.state.openMenuPath) return;
            const composedPath = typeof event?.composedPath === 'function' ? event.composedPath() : [];
            const interactedMenu = (Array.isArray(composedPath)
                ? composedPath.find((node) => node?.dataset?.actionMenu === 'true')
                : null) || event?.target?.closest?.('[data-action-menu="true"]');
            if (interactedMenu && this.element?.contains?.(interactedMenu) !== false) {
                return;
            }
            const openPath = this.state.openMenuPath;
            const openContainer = this.element?.querySelector?.(`[data-action-menu="true"][data-entry-path="${openPath}"]`);
            if (!openContainer) {
                this.closeActionMenu(false);
                return;
            }
            if (Array.isArray(composedPath) && composedPath.includes(openContainer)) {
                return;
            }
            this.closeActionMenu(false);
        },

        handleMenuKeydown(event) {
            if (event?.key === 'Escape' && this.state.openMenuPath) {
                this.closeActionMenu();
            }
        },

        handleContextMenu(event) {
            const row = event.target?.closest?.('tr[data-entry-path]');
            if (row) {
                event.preventDefault();
                event.stopPropagation();
                const path = row.dataset.entryPath;
                const type = row.dataset.type;
                if (!path || this.state.isEditing) {
                    return;
                }
                this.state.selectedPath = path;
                this.state.selectedIsMarkdown = this.isMarkdownFile(path) && type === 'file';
                this.closeActionMenu(false);
                this.pendingMenuFocusPath = path;
                this.openActionMenu(path, { invalidate: true });
                return;
            }
            if (this.state.clipboard) {
                event.preventDefault();
                event.stopPropagation();
                showContextPasteMenu({
                    x: event.clientX,
                    y: event.clientY,
                    targetPath: this.state.path,
                    hostElement: this.element
                });
            }
        },

        closeActionMenu(shouldInvalidate = true) {
            if (!this.state.openMenuPath) return false;
            const openPath = this.state.openMenuPath;
            const container = this.element?.querySelector(`[data-action-menu="true"][data-entry-path="${openPath}"]`);
            container?.classList.remove('open');
            const trigger = container?.querySelector('.action-menu-trigger');
            trigger?.setAttribute('aria-expanded', 'false');
            const dropdown = container?.querySelector('.action-menu-dropdown');
            if (dropdown) {
                dropdown.removeAttribute('data-positioned');
                dropdown.classList.remove('drop-up');
                dropdown.style.left = '';
                dropdown.style.top = '';
                dropdown.style.right = '';
                dropdown.style.bottom = '';
                dropdown.style.width = '';
                dropdown.style.maxWidth = '';
                dropdown.style.maxHeight = '';
            }
            this.pendingMenuFocusPath = null;
            this.clearOpenActionMenuTracking();
            this.removeDocumentListener?.('open-menu-outside');
            this.removeDocumentListener?.('open-menu-keydown');
            this.setOpenMenuPath(null);
            if (shouldInvalidate) this.invalidate();
            return true;
        },

        openActionMenu(path, options = {}) {
            if (this.state.openMenuPath && this.state.openMenuPath !== path) {
                this.closeActionMenu(false);
            }
            this.setDocumentListener?.('open-menu-outside', 'pointerdown', this.boundOutsideMenuClick, true);
            this.setDocumentListener?.('open-menu-keydown', 'keydown', this.boundMenuKeydown);
            this.setOpenMenuPath(path, { invalidate: false });
            try {
                this.refreshContextMenuItems?.(path);
            } catch (error) {
                console.error(error);
                this.showStatus(error?.message || 'Failed to render menu actions.', true);
                return;
            }
            if (options?.invalidate) {
                this.renderEntries?.();
            }
            const container = this.element?.querySelector(`[data-action-menu="true"][data-entry-path="${path}"]`);
            if (container) {
                container.classList.add('open');
                const trigger = container.querySelector('.action-menu-trigger');
                trigger?.setAttribute('aria-expanded', 'true');
                this.scheduleOpenActionMenuPositionSettle?.();
                const firstItem = container.querySelector('.action-menu-item');
                if (firstItem) {
                    firstItem.focus({ preventScroll: true });
                }
            }
            this.syncOpenActionMenuTracking?.();
        },

        updateClipboardUI() {
            // Update toolbar clipboard info and paste button
            const clipboard = this.state.clipboard;
            const clearClipboardButton = this.element.querySelector('#clearClipboardButton');
            if (clearClipboardButton) {
                if (clipboard) {
                    clearClipboardButton.removeAttribute('disabled');
                } else {
                    clearClipboardButton.setAttribute('disabled', 'true');
                }
            }

            const clipboardGroup = this.element.querySelector('.clipboard-group');
            const clipboardInfo = this.element.querySelector('#clipboardInfo');
            if (clipboardInfo && clipboardGroup) {
                if (clipboard) {
                    clipboardInfo.textContent = `${clipboard.mode === 'cut' ? 'Cut' : 'Copy'}: ${clipboard.name}`;
                    clipboardInfo.classList.add('visible');
                    clipboardGroup.classList.add('visible');
                } else {
                    clipboardInfo.textContent = '';
                    clipboardInfo.classList.remove('visible');
                    clipboardGroup.classList.remove('visible');
                }
            }

            // Update row highlight for clipboard source without re-rendering
            const previousRow = this.element.querySelector('tr.clipboard-row');
            previousRow?.classList.remove('clipboard-row', 'clipboard-cut', 'clipboard-copy');

            if (clipboard?.path) {
                const row = this.element.querySelector(`tr[data-entry-path="${clipboard.path}"]`);
                if (row) {
                    row.classList.add('clipboard-row');
                    row.classList.toggle('clipboard-cut', clipboard.mode === 'cut');
                    row.classList.toggle('clipboard-copy', clipboard.mode === 'copy');
                }
            }
        },

        clearClipboard() {
            if (!this.state.clipboard) return;
            const previous = this.state.clipboard.name;
            this.state.clipboard = null;
            this.showStatus(previous ? `Cleared clipboard (was "${previous}").` : 'Clipboard cleared.');
            this.updateClipboardUI();
            // Remove any clipboard marker when clearing
            const previousRow = this.element.querySelector('tr.clipboard-row');
            previousRow?.classList.remove('clipboard-row', 'clipboard-cut', 'clipboard-copy');
        },

        humanizeFsError(error) {
            const message = error?.message || error?.toString?.() || '';
            if (typeof message === 'string') {
                if (message.includes('Request timed out')) {
                    return 'Operation timed out. Please try again.';
                }
                if (message.includes('Missing or invalid MCP session')) {
                    return 'Your session has expired. Redirecting to sign in.';
                }
                if (message.includes('HTTP 401') && message.includes('not_authenticated')) {
                    return 'Your session has expired. Redirecting to sign in.';
                }
                if (message.includes('Path is outside allowed roots')) {
                    return 'Operation blocked: path is outside the workspace.';
                }
            }
            return message || 'Operation failed. Please try again.';
        },

        async pasteClipboard(element) {
            const clipboard = this.state.clipboard;
            if (!clipboard) {
                this.showStatus('Clipboard is empty.', true);
                return;
            }
            const targetPathRaw = element?.dataset?.targetPath || this.state.path;
            const targetDir = this.normalizePath(targetPathRaw);
            if (!this.ensureMutableFsPath(targetDir) || !this.ensureMutableFsPath(clipboard.path)) {
                return;
            }
            const targetIsCurrentDirectory = targetDir === this.state.path;
            const sourceParent = this.parentPath(clipboard.path) || '/';
            this.closeActionMenu(false);

            let targetEntries = [];
            if (targetIsCurrentDirectory) {
                targetEntries = this.state.entries;
            } else {
                targetEntries = await this.loadDirectoryContent(targetDir);
            }
            const existingNames = new Set(targetEntries.map((entry) => entry.name));

            const defaultName = clipboard.mode === 'copy'
                ? this.generateCopyName(clipboard.name, existingNames)
                : clipboard.name;
            const promptLabel = clipboard.mode === 'copy'
                ? `Enter a name for the copied ${clipboard.type === 'directory' ? 'folder' : 'file'}:`
                : `Enter a name for the moved ${clipboard.type === 'directory' ? 'folder' : 'file'}:`;
            const input = prompt(promptLabel, defaultName);
            if (input === null) return;
            let desiredName = this.sanitizeEntryName(input);
            if (!desiredName) {
                this.showStatus('Please enter a valid name.', true);
                return;
            }

            let existsInTarget = existingNames.has(desiredName);
            if (clipboard.mode === 'cut' && existsInTarget) {
                const fallbackName = this.generateCopyName(desiredName, existingNames);
                desiredName = fallbackName;
                existsInTarget = existingNames.has(desiredName);
                this.showStatus(`"${input}" already exists. Moving as "${desiredName}".`);
            }

            const destination = this.joinPath(targetDir, desiredName);
            const wasSelectedFile = this.state.selectedPath === clipboard.path && clipboard.type === 'file';
            const normalizedSource = this.normalizePath(clipboard.path);
            const normalizedDestination = this.normalizePath(destination);

            if (normalizedDestination === normalizedSource) {
                this.showStatus('Destination matches the source.', true);
                return;
            }
            if (clipboard.type === 'directory' && normalizedDestination.startsWith(`${normalizedSource}/`)) {
                this.showStatus('Cannot paste a folder into itself or one of its subfolders.', true);
                return;
            }
            let pasteCompleted = false;
            try {
                await this.withLoader(async () => {
                    if (clipboard.mode === 'cut') {
                        await callToolWithLoader('explorer', 'move_file', {
                            source: clipboard.path,
                            destination
                        });
                        this.bumpWorkspaceVersion?.();
                        this.showStatus(`Moved to ${destination}.`);
                    } else {
                        let overwrite = false;
                        if (existsInTarget) {
                            const shouldOverwrite = confirm(`"${desiredName}" already exists here. Overwrite it?`);
                            if (!shouldOverwrite) return;
                            overwrite = true;
                        }
                        await callToolWithLoader('explorer', 'copy_file', {
                            source: clipboard.path,
                            destination,
                            overwrite
                        });
                        this.bumpWorkspaceVersion?.();
                        this.showStatus(`Copied to ${destination}${overwrite ? ' (overwritten)' : ''}.`);
                    }

                    invalidateFsMutationCaches(this, {
                        directories: [targetDir, sourceParent, this.state.path],
                        directoryBranches: [
                            ...(clipboard.type === 'directory' && clipboard.mode === 'cut' ? [clipboard.path] : []),
                            ...(clipboard.type === 'directory' ? [destination] : [])
                        ],
                        files: [
                            ...(clipboard.type === 'file' ? [destination] : []),
                            ...(clipboard.type === 'file' && clipboard.mode === 'cut' ? [clipboard.path] : [])
                        ]
                    });
                    const targetMatchesCurrentView = targetIsCurrentDirectory;
                    const sourceMatchesCurrentView = sourceParent === this.state.path;

                    if (targetMatchesCurrentView || sourceMatchesCurrentView) {
                        const entries = await this.loadDirectoryContent(this.state.path);
                        await this.setEntries(entries);
                    }

                    if (wasSelectedFile) {
                        this.state.selectedPath = destination;
                        const historyMethod = clipboard.mode === 'cut' ? 'replaceState' : 'pushState';
                        history[historyMethod](null, '', buildFileExpHash(destination));
                        await this.openFile(destination);
                        pasteCompleted = true;
                        return;
                    }

                    pasteCompleted = true;
                    this.invalidate();
                });
            } catch (err) {
                console.error(err);
                this.showStatus(this.humanizeFsError(err), true);
            }
            if (pasteCompleted && this.state.clipboard === clipboard) {
                this.state.clipboard = null;
                this.updateClipboardUI();
                const clipboardRow = this.element.querySelector('tr.clipboard-row');
                clipboardRow?.classList.remove('clipboard-row', 'clipboard-cut', 'clipboard-copy');
            }
            this.invalidate();
        },

        async newFile() {
            const fileName = prompt('Enter name for the new file:');
            if (!fileName || !fileName.trim()) return;
            const trimmedName = fileName.trim();
            const initialContent = getNewFileInitialContent(trimmedName);
            try {
                let shouldSelect = false;
                let createdPath = null;
                let createdType = 'file';
                let shouldEditAfterCreate = false;
                await this.withLoader(async () => {
                    if (isDpuManagedPath(this.state.path)) {
                        const capabilities = await getDpuPathCapabilities(this, this.state.path);
                        if (!capabilities.canCreateFiles) {
                            throw new Error('New files are not allowed in this Confidential folder.');
                        }
                        const createsSecret = this.normalizePath(this.state.path) === DPU_SECRETS_PATH;
                        const created = await createDpuFile(this, this.state.path, trimmedName, {
                            content: createsSecret ? '' : initialContent.dpuContent,
                            mimeType: createsSecret ? '' : initialContent.mimeType
                        });
                        createdPath = created?.path || this.joinPath(this.state.path, created?.key || created?.name || trimmedName);
                        createdType = created?.type || 'file';
                        shouldEditAfterCreate = createsSecret;
                    } else {
                        if (!this.ensureMutableFsPath(this.state.path)) return;
                        createdPath = this.joinPath(this.state.path, trimmedName);
                        await callToolWithLoader('explorer', 'write_file', {
                            path: createdPath,
                            content: initialContent.content
                        });
                        this.bumpWorkspaceVersion?.();
                        invalidateFsMutationCaches(this, {
                            directories: [this.state.path],
                            files: [createdPath]
                        });
                    }
                    this.showStatus(`Created file: ${createdPath}`);
                    const entries = await this.loadDirectoryContent(this.state.path);
                    if (entries === null) {
                        return;
                    }
                    await this.setEntries(entries);
                    this.invalidate();
                    shouldSelect = true;
                });
                if (shouldSelect) {
                    await this.selectEntry({ dataset: { entryPath: createdPath, type: createdType } });
                    if (shouldEditAfterCreate) {
                        await this.editFile();
                    }
                }
            } catch (err) {
                if (err?.code !== 'invalid_secret_name') {
                    console.error(err);
                }
                this.showStatus(this.humanizeFsError(err), true);
            }
        },

        async newDirectory() {
            const dirName = prompt('Enter name for the new directory:');
            if (!dirName || !dirName.trim()) return;
            try {
                await this.withLoader(async () => {
                    if (isDpuManagedPath(this.state.path)) {
                        const capabilities = await getDpuPathCapabilities(this, this.state.path);
                        if (!capabilities.canCreateDirectories) {
                            throw new Error('New folders are not allowed in this Confidential location.');
                        }
                        await createDpuDirectory(this, this.state.path, dirName.trim());
                    } else {
                        if (!this.ensureMutableFsPath(this.state.path)) return;
                        const newDirPath = this.joinPath(this.state.path, dirName.trim());
                        await callToolWithLoader('explorer', 'create_directory', {path: newDirPath});
                        this.bumpWorkspaceVersion?.();
                        invalidateFsMutationCaches(this, {
                            directories: [this.state.path]
                        });
                    }
                    this.showStatus(`Successfully created directory.`);
                    await this.loadDirectory(this.state.path);
                });
            } catch (err) {
                console.error(err);
                this.showStatus(this.humanizeFsError(err), true);
            }
        }
    });
}
