import { saveColumnVisibilityPreference } from "./file-exp-state.js";
import { renderApplicationPluginSlots } from "./file-exp-application-plugins.js";
import { getPreviewUiState as derivePreviewUiState } from "./file-exp-preview-state.js";
import { scrollToLine } from "./file-exp-utils.js";
import { getDpuPathCapabilities, isDpuManagedPath } from "./file-exp-dpu-provider.js";

function isMobileFileExplorerLayout() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 720px)').matches;
}

function bindDropdownSelection(fileExp, key, menu, setOpen) {
    fileExp.setElementListener(key, menu, 'click', (event) => {
        const action = event.target?.closest?.('[role="menuitem"], button, [role="button"], a[href], [data-local-action]');
        if (menu.classList.contains('open') && action && menu.contains(action)
            && !action.closest(':disabled, [aria-disabled="true"], [aria-busy="true"]')) {
            setOpen(false);
        }
    }, true);
}

export async function runAfterRender(fileExp, options = {}) {
    const previewLinesFallback = Number.isFinite(options.previewLines) ? options.previewLines : 400;

    fileExp.renderBreadcrumbs();
    fileExp.renderEntries();

    if (fileExp.state.directoryViewMode === 'tree' && fileExp.pendingTreeReveal) {
        const entriesPresenter = fileExp.getEntriesPresenter();
        const pendingReveal = fileExp.pendingTreeReveal;
        fileExp.pendingTreeReveal = null;
        if (entriesPresenter && typeof entriesPresenter.revealTreeDirectory === 'function') {
            await entriesPresenter.revealTreeDirectory(pendingReveal.path, {
                preserveExisting: Boolean(pendingReveal.preserveExisting)
            });
        }
    }

    const previewUiState = derivePreviewUiState(fileExp.state);
    fileExp.previewHeaderController.sync(previewUiState);

    const previewPresenterElement = fileExp.element.querySelector('file-exp-preview');
    const previewPresenter = previewPresenterElement?.webSkelPresenter || null;
    if (previewPresenter && typeof previewPresenter.renderPreview === 'function') {
        previewPresenter.renderPreview(previewUiState);
    } else {
        const previewContent = fileExp.element.querySelector('.preview-content');
        fileExp.renderPreviewPanel(previewContent, previewUiState);
    }

    const previewContentHost = fileExp.element.querySelector('.preview-content');
    if (previewContentHost) {
        const onSecretFieldFocusIn = (event) => {
            const target = event?.target?.closest?.('.dpu-secret-value.is-actionable, .dpu-secret-message.is-actionable');
            if (!target) return;
            if (fileExp.state?.dpuSecretState?.editing) return;
            fileExp.beginDpuSecretInlineEdit?.();
        };
        fileExp.setElementListener('dpu-secret-focusin', previewContentHost, 'focusin', onSecretFieldFocusIn);
    }

    const pendingHighlight = fileExp.state.pendingHighlight;
    if (pendingHighlight && pendingHighlight.path === fileExp.normalizePath(fileExp.state.selectedPath || '')) {
        const didScroll = scrollToLine(fileExp.element, pendingHighlight.line);
        if (didScroll) {
            fileExp.setPendingHighlight(null);
            if (fileExp.pendingHighlightRetryTimer) {
                window.clearTimeout(fileExp.pendingHighlightRetryTimer);
                fileExp.pendingHighlightRetryTimer = null;
            }
        } else if (Number.isFinite(pendingHighlight.line) && pendingHighlight.line > 0) {
            if (fileExp.pendingHighlightRetryTimer) {
                window.clearTimeout(fileExp.pendingHighlightRetryTimer);
            }
            fileExp.pendingHighlightRetryTimer = window.setTimeout(() => {
                const current = fileExp.state.pendingHighlight;
                if (!current) return;
                if (current.path !== fileExp.normalizePath(fileExp.state.selectedPath || '')) return;
                const retried = scrollToLine(fileExp.element, current.line);
                if (retried) {
                    fileExp.setPendingHighlight(null);
                }
            }, 80);
        }
    } else if (fileExp.pendingHighlightRetryTimer) {
        window.clearTimeout(fileExp.pendingHighlightRetryTimer);
        fileExp.pendingHighlightRetryTimer = null;
    }

    const toggleListButton = fileExp.element.querySelector('#toggleListButton');
    const toggleHeaderButton = fileExp.element.querySelector('#toggleHeaderButton');
    const directoryPanel = fileExp.element.querySelector('#directoryPanel');
    const pathInfo = fileExp.element.querySelector('.path-info');
    const toolbar = fileExp.element.querySelector('.toolbar');
    const workspace = fileExp.element.querySelector('.workspace');
    const listPanel = fileExp.element.querySelector('.list');
    const columnMenuButton = fileExp.element.querySelector('#columnVisibilityButton');
    const columnMenu = fileExp.element.querySelector('#columnVisibilityMenu');
    const directoryViewModeButton = fileExp.element.querySelector('#directoryViewModeButton');
    const upButton = fileExp.element.querySelector('#upButton');
    const toolbarMenuButton = fileExp.element.querySelector('#toolbarMenuButton');
    const toolbarMenu = fileExp.element.querySelector('#toolbarMenu');
    const uploadButton = fileExp.element.querySelector('#uploadButton');
    const accountMenuButton = fileExp.element.querySelector('#accountMenuButton');
    const accountMenu = fileExp.element.querySelector('#accountMenu');
    const pluginsMenuButton = fileExp.element.querySelector('#pluginsMenuButton');
    const pluginsMenu = fileExp.element.querySelector('#pluginsMenu');
    const fileUploadInput = fileExp.element.querySelector('#fileUploadInput');
    const managedByDpu = isDpuManagedPath(fileExp.state.path || '/');
    const dpuCapabilities = managedByDpu
        ? await getDpuPathCapabilities(fileExp, fileExp.state.path || '/')
        : null;
    fileExp.state.currentDpuCapabilities = dpuCapabilities;
    const allowManagedUploads = Boolean(dpuCapabilities?.canUpload);
    const allowManagedCreate = Boolean(dpuCapabilities?.canCreateFiles || dpuCapabilities?.canCreateDirectories);

    if (uploadButton) {
        uploadButton.disabled = managedByDpu ? !allowManagedUploads : false;
        uploadButton.title = managedByDpu
            ? (allowManagedUploads
                ? 'Upload files to this Confidential folder'
                : 'Uploads are not allowed in this Confidential location.')
            : 'Upload files';
    }
    if (toolbarMenuButton) {
        toolbarMenuButton.disabled = managedByDpu ? !allowManagedCreate : false;
        toolbarMenuButton.title = managedByDpu
            ? (allowManagedCreate
                ? 'Create items in this Confidential folder'
                : 'Create actions are not allowed in this Confidential location.')
            : 'More actions';
    }
    fileExp.renderToolbarMenuItems?.();
    await fileExp.refreshToolbarMenuItems?.();

    const updateToggleState = () => {
        if (!toggleListButton || !listPanel) return;
        const collapsed = listPanel.classList.contains('collapsed');
        toggleListButton.setAttribute('aria-expanded', String(!collapsed));
        const isMobile = isMobileFileExplorerLayout();
        const title = isMobile
            ? (collapsed ? 'Show files' : 'Hide files')
            : (collapsed ? 'Expand directory panel' : 'Collapse directory panel');
        toggleListButton.setAttribute('title', title);
        toggleListButton.setAttribute('aria-label', title);
    };

    const applyHeaderCollapsedState = () => {
        if (!directoryPanel) return;
        directoryPanel.classList.toggle('header-collapsed', Boolean(fileExp.state.explorerHeaderCollapsed));
    };

    const updateHeaderToggleState = () => {
        if (!toggleHeaderButton || !directoryPanel) return;
        const collapsed = directoryPanel.classList.contains('header-collapsed');
        toggleHeaderButton.setAttribute('aria-expanded', String(!collapsed));
        toggleHeaderButton.setAttribute('title', collapsed ? 'Show Explorer header' : 'Hide Explorer header');
        toggleHeaderButton.setAttribute('aria-label', collapsed ? 'Show Explorer header' : 'Hide Explorer header');
    };

    const updateDirectoryViewModeButton = () => {
        const isTreeView = fileExp.state.directoryViewMode === 'tree';
        if (upButton) {
            upButton.classList.toggle('hidden', isTreeView);
        }
        if (!directoryViewModeButton) return;
        directoryViewModeButton.classList.toggle('active', isTreeView);
        directoryViewModeButton.setAttribute('aria-pressed', isTreeView ? 'true' : 'false');
        directoryViewModeButton.setAttribute('title', isTreeView ? 'Switch to list view' : 'Switch to tree view');
        directoryViewModeButton.setAttribute('aria-label', isTreeView ? 'Switch to list view' : 'Switch to tree view');
    };

    const setWorkspaceListWidth = (width) => {
        if (!workspace || !Number.isFinite(width) || width <= 0) return;
        workspace.style.setProperty('--file-exp-list-width', `${Math.max(200, Math.round(width))}px`);
    };

    const applyCollapsedState = () => {
        if (!listPanel) return;
        listPanel.classList.toggle('collapsed', Boolean(fileExp.state.listCollapsed));
        listPanel.classList.toggle('mobile-drawer', isMobileFileExplorerLayout());
    };

    const syncCollapsedState = () => {
        if (!workspace || !listPanel) return;
        workspace.classList.toggle('list-collapsed', listPanel.classList.contains('collapsed'));
        workspace.classList.toggle('mobile-list-drawer', isMobileFileExplorerLayout());
    };

    const applySavedWidth = () => {
        if (!listPanel || listPanel.classList.contains('collapsed')) return;
        if (!fileExp.state.listWidth && listPanel.offsetWidth) {
            fileExp.setListWidth(listPanel.offsetWidth);
        }
        if (fileExp.state.listWidth) {
            setWorkspaceListWidth(fileExp.state.listWidth);
        }
    };

    applyCollapsedState();
    applyHeaderCollapsedState();
    applySavedWidth();
    if (listPanel && !listPanel.classList.contains('collapsed')) {
        if (!fileExp.state.listWidth && listPanel.offsetWidth) {
            fileExp.setListWidth(listPanel.offsetWidth);
            setWorkspaceListWidth(listPanel.offsetWidth);
        }
    }
    syncCollapsedState();

    if (toggleListButton && listPanel) {
        const onToggleListClick = () => {
            const isCollapsed = listPanel.classList.contains('collapsed');
            if (!isCollapsed) {
                const currentWidth = Math.round(listPanel.getBoundingClientRect().width || listPanel.offsetWidth);
                if (currentWidth > 0) {
                    fileExp.setListWidth(currentWidth);
                }
                fileExp.setListCollapsed(true);
                applyCollapsedState();
            } else {
                fileExp.setListCollapsed(false);
                applyCollapsedState();
                applySavedWidth();
            }
            syncCollapsedState();
            updateToggleState();
        };
        fileExp.setElementListener('toggle-list-button', toggleListButton, 'click', onToggleListClick);
        updateToggleState();
    }

    if (workspace && listPanel) {
        const onMobileDrawerResize = () => {
            applyCollapsedState();
            syncCollapsedState();
            updateToggleState();
        };
        fileExp.removeDocumentListener('mobile-list-drawer-outside');
        fileExp.setWindowListener?.('mobile-list-drawer-resize', 'resize', onMobileDrawerResize);
    } else {
        fileExp.removeDocumentListener('mobile-list-drawer-outside');
    }

    if (toggleHeaderButton && directoryPanel && pathInfo && toolbar) {
        const onToggleHeaderClick = () => {
            const nextCollapsed = !directoryPanel.classList.contains('header-collapsed');
            fileExp.setExplorerHeaderCollapsed(nextCollapsed);
            fileExp.setToolbarMenuOpen(false);
            toolbarMenu?.classList.remove('open');
            toolbarMenuButton?.setAttribute('aria-expanded', 'false');
            accountMenu?.classList.remove('open');
            accountMenuButton?.setAttribute('aria-expanded', 'false');
            applyHeaderCollapsedState();
            updateHeaderToggleState();
        };
        fileExp.setElementListener('toggle-header-button', toggleHeaderButton, 'click', onToggleHeaderClick);
        updateHeaderToggleState();
    }

    if (directoryViewModeButton) {
        const onDirectoryViewModeClick = () => {
            const nextMode = fileExp.state.directoryViewMode === 'tree' ? 'list' : 'tree';
            fileExp.setDirectoryViewMode(nextMode);
            updateDirectoryViewModeButton();
            fileExp.renderEntries();
        };
        fileExp.setElementListener('directory-view-mode-button', directoryViewModeButton, 'click', onDirectoryViewModeClick);
        updateDirectoryViewModeButton();
    }

    if (columnMenuButton && columnMenu) {
        const toggleMenu = () => {
            const isOpen = columnMenu.classList.toggle('open');
            columnMenuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };
        const onColumnButtonClick = (event) => {
            event.stopPropagation();
            toggleMenu();
        };
        const onColumnDocumentClick = (event) => {
            if (!columnMenu.contains(event.target) && event.target !== columnMenuButton) {
                columnMenu.classList.remove('open');
                columnMenuButton.setAttribute('aria-expanded', 'false');
            }
        };
        fileExp.setElementListener('column-menu-button', columnMenuButton, 'click', onColumnButtonClick);
        fileExp.setDocumentListener('column-menu-outside', 'click', onColumnDocumentClick);
    } else {
        fileExp.removeDocumentListener('column-menu-outside');
    }

    if (toolbarMenuButton && toolbarMenu) {
        const setToolbarMenuOpen = (open) => {
            fileExp.setToolbarMenuOpen(open);
            toolbarMenu.classList.toggle('open', open);
            toolbarMenuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
                accountMenu?.classList.remove('open');
                accountMenuButton?.setAttribute('aria-expanded', 'false');
                pluginsMenu?.classList.remove('open');
                pluginsMenuButton?.setAttribute('aria-expanded', 'false');
            }
        };
        const onToolbarButtonClick = (event) => {
            event.stopPropagation();
            const isOpen = toolbarMenu.classList.contains('open');
            setToolbarMenuOpen(!isOpen);
        };
        const onToolbarOutsideClick = (event) => {
            if (!toolbarMenu.contains(event.target) && event.target !== toolbarMenuButton) {
                setToolbarMenuOpen(false);
            }
        };
        fileExp.setElementListener('toolbar-menu-button', toolbarMenuButton, 'click', onToolbarButtonClick);
        bindDropdownSelection(fileExp, 'toolbar-menu-container', toolbarMenu, setToolbarMenuOpen);
        fileExp.setDocumentListener('toolbar-menu-outside', 'click', onToolbarOutsideClick);
        toolbarMenu.classList.toggle('open', Boolean(fileExp.state.toolbarMenuOpen));
        toolbarMenuButton.setAttribute('aria-expanded', fileExp.state.toolbarMenuOpen ? 'true' : 'false');
    } else {
        fileExp.removeDocumentListener('toolbar-menu-outside');
    }

    if (accountMenuButton && accountMenu) {
        const setAccountMenuOpen = (open) => {
            accountMenu.classList.toggle('open', open);
            accountMenuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
                toolbarMenu?.classList.remove('open');
                toolbarMenuButton?.setAttribute('aria-expanded', 'false');
                pluginsMenu?.classList.remove('open');
                pluginsMenuButton?.setAttribute('aria-expanded', 'false');
            }
        };
        const onAccountButtonClick = (event) => {
            event.stopPropagation();
            const willOpen = !accountMenu.classList.contains('open');
            setAccountMenuOpen(willOpen);
        };
        const onAccountOutsideClick = (event) => {
            if (!accountMenu.contains(event.target) && event.target !== accountMenuButton) {
                setAccountMenuOpen(false);
            }
        };
        fileExp.setElementListener('account-menu-button', accountMenuButton, 'click', onAccountButtonClick);
        bindDropdownSelection(fileExp, 'account-menu-container', accountMenu, setAccountMenuOpen);
        fileExp.setDocumentListener('account-menu-outside', 'click', onAccountOutsideClick);
        accountMenuButton.setAttribute('aria-expanded', accountMenu.classList.contains('open') ? 'true' : 'false');
    } else {
        fileExp.removeDocumentListener('account-menu-outside');
    }

    if (pluginsMenuButton && pluginsMenu) {
        const setPluginsMenuOpen = (open) => {
            pluginsMenu.classList.toggle('open', open);
            pluginsMenuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
                toolbarMenu?.classList.remove('open');
                toolbarMenuButton?.setAttribute('aria-expanded', 'false');
                accountMenu?.classList.remove('open');
                accountMenuButton?.setAttribute('aria-expanded', 'false');
            }
        };
        const onPluginsButtonClick = (event) => {
            event.stopPropagation();
            const willOpen = !pluginsMenu.classList.contains('open');
            setPluginsMenuOpen(willOpen);
        };
        const onPluginsOutsideClick = (event) => {
            if (!pluginsMenu.contains(event.target) && event.target !== pluginsMenuButton) {
                setPluginsMenuOpen(false);
            }
        };
        fileExp.setElementListener('plugins-menu-button', pluginsMenuButton, 'click', onPluginsButtonClick);
        bindDropdownSelection(fileExp, 'plugins-menu-container', pluginsMenu, setPluginsMenuOpen);
        fileExp.setDocumentListener('plugins-menu-outside', 'click', onPluginsOutsideClick);
        pluginsMenuButton.setAttribute('aria-expanded', pluginsMenu.classList.contains('open') ? 'true' : 'false');
    } else {
        fileExp.removeDocumentListener('plugins-menu-outside');
    }

    if (fileUploadInput) {
        fileExp.setElementListener('file-upload-input', fileUploadInput, 'change', (event) => {
            fileExp.handleUploadSelection?.(event);
        });
    }

    const columnCheckboxes = fileExp.element.querySelectorAll('#columnVisibilityMenu input[type="checkbox"]');
    columnCheckboxes.forEach((checkbox) => {
        const column = checkbox.dataset.column;
        if (column) {
            checkbox.checked = Boolean(fileExp.state.columnVisibility?.[column]);
        }
        if (!column) return;
        const onColumnVisibilityChange = (event) => {
            const col = event.target.dataset.column;
            if (!col) return;
            fileExp.setColumnVisibility(col, Boolean(event.target.checked));
            saveColumnVisibilityPreference(fileExp.state.columnVisibility);
            fileExp.applyColumnVisibility();
        };
        fileExp.setElementListener(`column-visibility-${column}`, checkbox, 'change', onColumnVisibilityChange);
    });
    fileExp.applyColumnVisibility();

    const resizer = fileExp.element.querySelector('#resizer');
    if (resizer && listPanel) {
        const onResizerMouseDown = (event) => {
            event.preventDefault();
            if (listPanel.classList.contains('collapsed')) return;

            const startX = event.clientX;
            const startWidth = listPanel.getBoundingClientRect().width || fileExp.state.listWidth || listPanel.offsetWidth;
            fileExp.setIsResizing(true);
            workspace?.classList.add('resizing');
            setWorkspaceListWidth(startWidth);

            const onMouseMove = (moveEvent) => {
                if (!fileExp.state.isResizing) return;
                if (listPanel.classList.contains('collapsed')) return;
                const delta = moveEvent.clientX - startX;
                const newWidth = Math.max(200, startWidth + delta);
                setWorkspaceListWidth(newWidth);
            };

            let stopMove = () => {};
            let stopUp = () => {};
            const onMouseUp = () => {
                fileExp.setIsResizing(false);
                workspace?.classList.remove('resizing');
                if (!listPanel.classList.contains('collapsed')) {
                    const currentWidth = listPanel.offsetWidth;
                    if (currentWidth > 0) {
                        fileExp.setListWidth(currentWidth);
                        setWorkspaceListWidth(currentWidth);
                    }
                }
                stopMove();
                stopUp();
            };

            stopMove = fileExp.addDocumentListener('mousemove', onMouseMove);
            stopUp = fileExp.addDocumentListener('mouseup', onMouseUp);
        };
        fileExp.setElementListener('list-resizer', resizer, 'mousedown', onResizerMouseDown);
    }

    const saveButton = fileExp.element.querySelector('#saveButton');
    if (saveButton) {
        saveButton.classList.toggle('hidden', Boolean(fileExp.state.selectedIsMarkdown && fileExp.state.documentId));
    }

    if (!fileExp.state.isEditing) {
        fileExp.setHasUnsavedChanges(false);
        fileExp.clearEditorAutoSaveTimer?.();
    }

    const cancelButton = fileExp.element.querySelector('#cancelButton');
    if (cancelButton) {
        cancelButton.textContent = fileExp.state.selectedIsMarkdown && fileExp.state.documentId ? 'Close' : 'Cancel';
    }

    const previewNotice = fileExp.element.querySelector('#previewNotice');
    if (previewNotice) {
        previewNotice.classList.remove('warning');
        if (fileExp.state.externallyModified) {
            previewNotice.textContent = 'This file changed on disk after you started editing it. Reload the file to review the latest version before saving again.';
            previewNotice.classList.remove('hidden');
            previewNotice.classList.add('warning');
        } else if (fileExp.state.fileLoadInfo?.truncated) {
            const info = fileExp.state.fileLoadInfo;
            const previewLines = info.previewLines || previewLinesFallback;
            const sizeText = Number.isFinite(info.size) ? fileExp.formatBytes(info.size) : 'large';
            previewNotice.textContent = info.message
                || `File is ${sizeText}; showing first ${previewLines} lines only. Editing is disabled for this view.`;
            previewNotice.classList.remove('hidden');
        } else {
            previewNotice.textContent = '';
            previewNotice.classList.add('hidden');
        }
    }

    const clipboard = fileExp.state.clipboard;
    const clearClipboardButton = fileExp.element.querySelector('#clearClipboardButton');
    if (clearClipboardButton) {
        if (clipboard) {
            clearClipboardButton.removeAttribute('disabled');
        } else {
            clearClipboardButton.setAttribute('disabled', 'true');
        }
    }

    const sortButtons = fileExp.element.querySelectorAll('[data-sort-key]');
    sortButtons.forEach((btn) => {
        const sortKey = btn.dataset.sortKey;
        if (!sortKey) return;
        fileExp.setElementListener(`sort-${sortKey}`, btn, 'click', fileExp.boundSortClickHandler);
        const isActive = fileExp.state.sortBy === sortKey;
        btn.classList.toggle('active', isActive);
        btn.dataset.direction = isActive ? fileExp.state.sortDir : '';
        btn.setAttribute('aria-sort', isActive ? (fileExp.state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });

    if (fileExp.pendingMenuFocusPath && fileExp.state.openMenuPath === fileExp.pendingMenuFocusPath) {
        const menuContainer = fileExp.element.querySelector(`[data-action-menu="true"][data-entry-path="${fileExp.state.openMenuPath}"]`);
        const firstItem = menuContainer?.querySelector('.action-menu-item');
        if (firstItem) {
            firstItem.focus();
        }
        fileExp.pendingMenuFocusPath = null;
    } else if (!fileExp.state.openMenuPath) {
        fileExp.pendingMenuFocusPath = null;
    }

    if (fileExp.state.openMenuPath) {
        fileExp.syncOpenActionMenuTracking?.();
        fileExp.positionOpenActionMenu();
    }

    const filterToggle = fileExp.element.querySelector('#filterSpecsToggle');
    if (filterToggle) {
        filterToggle.checked = Boolean(fileExp.state.filterSpecs);
        fileExp.setElementListener('filter-specs-toggle', filterToggle, 'change', () => {
            fileExp.toggleFilterSpecs(filterToggle);
        });
    }

    fileExp.setupSearchBindings();
    fileExp.updateSearchUI();
    fileExp.directoryFilterController.bindControls();

    const entriesContainer = fileExp.element.querySelector('.entries')
        || fileExp.element.querySelector('file-exp-entries');
    if (entriesContainer) {
        fileExp.setElementListener('entries-contextmenu', entriesContainer, 'contextmenu', fileExp.boundContextMenu, true);
    }

    renderApplicationPluginSlots(fileExp).catch((error) => {
        console.error('[app-plugins] Failed to render application plugin slots:', error);
    });
}
