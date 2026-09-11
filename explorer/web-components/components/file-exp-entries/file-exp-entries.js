const VIRTUALIZATION_THRESHOLD = 180;
const DEFAULT_ROW_HEIGHT = 38;
const VIRTUALIZATION_OVERSCAN = 10;

function encodeMenuItems(items) {
    try {
        return encodeURIComponent(JSON.stringify(Array.isArray(items) ? items : []));
    } catch {
        return encodeURIComponent('[]');
    }
}

function createEntryIcon(iconClass) {
    const icon = document.createElement('span');
    icon.className = `entry-icon ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

export class FileExpEntries {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        this.rowsByPath = new Map();
        this.snapshot = null;
        this.tbody = null;
        this.scrollContainer = null;
        this.resizeObserver = null;
        this.pendingPatchFrame = null;
        this.virtual = {
            enabled: false,
            scrollTop: 0,
            viewportHeight: 0,
            rowHeight: DEFAULT_ROW_HEIGHT
        };
        this.boundHandleScroll = this.handleScroll.bind(this);
        this.boundHandleResize = this.handleResize.bind(this);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.tbody = this.element.querySelector('#entriesBody');
        this.scrollContainer = this.element.querySelector('.entries');
        this.bindVirtualizationListeners();
        this.syncFromHost();
    }

    beforeUnload() {
        this.unbindVirtualizationListeners();
        if (this.pendingPatchFrame !== null) {
            cancelAnimationFrame(this.pendingPatchFrame);
            this.pendingPatchFrame = null;
        }
        this.rowsByPath.clear();
        this.tbody = null;
        this.scrollContainer = null;
    }

    bindVirtualizationListeners() {
        this.unbindVirtualizationListeners();
        if (!this.scrollContainer) return;
        this.scrollContainer.addEventListener('scroll', this.boundHandleScroll, { passive: true });
        window.addEventListener('resize', this.boundHandleResize);
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this.handleResize();
            });
            this.resizeObserver.observe(this.scrollContainer);
        }
        this.virtual.scrollTop = this.scrollContainer.scrollTop || 0;
        this.virtual.viewportHeight = this.scrollContainer.clientHeight || 0;
    }

    unbindVirtualizationListeners() {
        if (this.scrollContainer) {
            this.scrollContainer.removeEventListener('scroll', this.boundHandleScroll);
        }
        window.removeEventListener('resize', this.boundHandleResize);
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    handleScroll() {
        if (!this.virtual.enabled || !this.scrollContainer) return;
        this.virtual.scrollTop = this.scrollContainer.scrollTop || 0;
        this.schedulePatchRows();
    }

    handleResize() {
        if (!this.scrollContainer) return;
        this.virtual.viewportHeight = this.scrollContainer.clientHeight || 0;
        this.schedulePatchRows();
    }

    schedulePatchRows() {
        if (this.pendingPatchFrame !== null) return;
        this.pendingPatchFrame = requestAnimationFrame(() => {
            this.pendingPatchFrame = null;
            this.patchRows();
        });
    }

    getHostPresenter() {
        return this.element.closest('file-exp')?.webSkelPresenter || null;
    }

    syncFromHost() {
        const host = this.getHostPresenter();
        if (!host) return;
        this.renderEntries(host.state);
    }

    renderEntries(snapshot) {
        this.snapshot = snapshot || null;
        this.syncTreeContext();
        this.patchRows();
        this.applyColumnVisibility(this.snapshot || this.getHostPresenter()?.state || {});
    }

    getTreeViewState() {
        const host = this.getHostPresenter();
        if (!host) {
            return {
                contextKey: '',
                expandedPaths: new Set(),
                childrenCache: new Map(),
                loadingPaths: new Set()
            };
        }
        if (!host.treeViewState) {
            host.treeViewState = {
                contextKey: '',
                expandedPaths: new Set(),
                childrenCache: new Map(),
                loadingPaths: new Set()
            };
        }
        return host.treeViewState;
    }

    syncTreeContext() {
        const state = this.snapshot || this.getHostPresenter()?.state || {};
        const treeViewState = this.getTreeViewState();
        const contextKey = [
            String(state?.workspaceVersion || 0),
            String(state?.filterSpecs ? '1' : '0'),
            String(state?.sortBy || 'name'),
            String(state?.sortDir || 'asc')
        ].join(':');
        if (contextKey === treeViewState.contextKey) return;
        treeViewState.contextKey = contextKey;
        treeViewState.expandedPaths.clear();
        treeViewState.childrenCache.clear();
        treeViewState.loadingPaths.clear();
    }

    applyColumnVisibility(state) {
        const columns = ['type', 'size', 'modified'];
        columns.forEach((col) => {
            const visible = Boolean(state?.columnVisibility?.[col]);
            const cells = this.element.querySelectorAll(`.col-${col}`);
            cells.forEach((cell) => {
                cell.classList.toggle('column-hidden', !visible);
            });
        });
    }

    toEntryPath(entry, state, host) {
        const rawPath = entry?.path || host?.joinPath?.(state?.path || '/', entry?.name || '');
        return host?.normalizePath?.(rawPath) || String(rawPath || '');
    }

    toMenuId(entryPath) {
        const normalized = String(entryPath || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(-80);
        return `action-menu-${normalized || 'row'}`;
    }

    createSelectCell(className, value, entryPath, type, iconClass = '', options = {}) {
        const cell = document.createElement('td');
        cell.className = className;
        cell.dataset.entryPath = entryPath;
        cell.dataset.type = type;
        cell.dataset.localAction = options.localAction || 'selectEntry';
        if (options.isSymlink) {
            cell.dataset.symlink = 'true';
            if (options.linkTarget) {
                cell.dataset.linkTarget = options.linkTarget;
            }
        }
        if (iconClass) {
            if (Number.isFinite(options.depth) && options.depth > 0) {
                cell.style.setProperty('--tree-depth', String(options.depth));
                cell.classList.add('tree-name-cell');
            } else {
                cell.style.removeProperty('--tree-depth');
                cell.classList.remove('tree-name-cell');
            }
            if (options.showTreeToggle) {
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = `tree-toggle${options.expanded ? ' expanded' : ''}${options.loading ? ' loading' : ''}`;
                toggle.setAttribute('aria-label', options.loading
                    ? 'Loading folder'
                    : (options.expanded ? 'Collapse folder' : 'Expand folder'));
                toggle.setAttribute('aria-expanded', options.expanded ? 'true' : 'false');
                toggle.disabled = Boolean(options.loading);
                toggle.tabIndex = -1;
                const chevron = document.createElement('span');
                chevron.className = 'tree-toggle-chevron';
                chevron.setAttribute('aria-hidden', 'true');
                toggle.appendChild(chevron);
                cell.appendChild(toggle);
            } else if (Number.isFinite(options.depth) && options.depth >= 0) {
                const spacer = document.createElement('span');
                spacer.className = 'tree-toggle-spacer';
                cell.appendChild(spacer);
            }
            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.appendChild(createEntryIcon(iconClass));
            cell.appendChild(icon);
            const label = document.createElement('span');
            label.className = 'entry-label';
            label.textContent = value;
            cell.appendChild(label);
        } else {
            cell.textContent = value;
        }
        return cell;
    }

    createActionsCell(entryPath, type, isMenuOpen, entry = null) {
        const menuId = this.toMenuId(entryPath);
        const actionsCell = document.createElement('td');
        actionsCell.className = 'actions-cell col-actions';

        const container = document.createElement('div');
        container.className = `action-menu-container${isMenuOpen ? ' open' : ''}`;
        container.dataset.actionMenu = 'true';
        container.dataset.entryPath = entryPath;

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'secondary action-menu-trigger';
        trigger.dataset.localAction = 'toggleActionMenu';
        trigger.dataset.entryPath = entryPath;
        trigger.dataset.type = type;
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', isMenuOpen ? 'true' : 'false');
        trigger.setAttribute('aria-controls', menuId);
        trigger.setAttribute('title', 'More actions');

        const triggerIcon = document.createElement('img');
        triggerIcon.className = 'action-menu-trigger-icon';
        triggerIcon.loading = 'lazy';
        triggerIcon.src = './assets/icons/action-dots.svg';
        triggerIcon.alt = 'More actions';
        trigger.appendChild(triggerIcon);

        const dropdown = document.createElement('div');
        dropdown.className = 'action-menu-dropdown';
        dropdown.id = menuId;
        dropdown.setAttribute('role', 'menu');
        const host = this.getHostPresenter();
        const menuItems = host?.getContextMenuItemsForEntry?.(entryPath, type, entry) || [];
        const appMenu = document.createElement('app-menu');
        appMenu.setAttribute('data-presenter', 'app-menu');
        appMenu.setAttribute('data-items', encodeMenuItems(menuItems));
        appMenu.setAttribute('data-loading', 'false');
        dropdown.appendChild(appMenu);

        container.appendChild(trigger);
        container.appendChild(dropdown);
        actionsCell.appendChild(container);
        return actionsCell;
    }

    syncActionsCell(actionsCell, entryPath, type, isMenuOpen, entry = null) {
        const container = actionsCell?.querySelector?.('[data-action-menu="true"]');
        const trigger = container?.querySelector?.('.action-menu-trigger');
        const dropdown = container?.querySelector?.('.action-menu-dropdown');
        const appMenu = dropdown?.querySelector?.('app-menu');
        if (!container || !trigger || !dropdown || !appMenu) return false;

        const menuId = this.toMenuId(entryPath);
        container.dataset.entryPath = entryPath;
        container.classList.toggle('open', isMenuOpen);
        trigger.dataset.entryPath = entryPath;
        trigger.dataset.type = type;
        trigger.setAttribute('aria-expanded', isMenuOpen ? 'true' : 'false');
        trigger.setAttribute('aria-controls', menuId);
        dropdown.id = menuId;

        const host = this.getHostPresenter();
        const menuItems = host?.getContextMenuItemsForEntry?.(entryPath, type, entry) || [];
        const encodedItems = encodeMenuItems(menuItems);
        if (appMenu.getAttribute('data-items') !== encodedItems) {
            appMenu.setAttribute('data-items', encodedItems);
            if (typeof appMenu.webSkelPresenter?.applyItems === 'function') {
                appMenu.webSkelPresenter.applyItems(menuItems);
            }
        }
        return true;
    }

    createRow(entryPath) {
        const row = document.createElement('tr');
        row.dataset.entryPath = entryPath;
        return row;
    }

    createEmptyRow() {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.textContent = 'Empty directory.';
        row.appendChild(cell);
        return row;
    }

    createTreeStatusRow(message, parentPath, kind = 'status') {
        const row = document.createElement('tr');
        row.className = `tree-status-row tree-status-${kind}`;
        row.dataset.entryPath = `${parentPath || '/'}::${kind}`;

        const nameCell = document.createElement('td');
        nameCell.className = 'col-name tree-status-cell';
        nameCell.colSpan = 4;
        nameCell.textContent = message;

        const actionsCell = document.createElement('td');
        actionsCell.className = 'actions-cell col-actions';

        row.append(nameCell, actionsCell);
        return row;
    }

    createSpacerRow(height, position) {
        const row = document.createElement('tr');
        row.className = 'entries-virtual-spacer';
        row.dataset.spacer = position;
        row.setAttribute('aria-hidden', 'true');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.style.height = `${Math.max(0, Math.round(height))}px`;
        row.appendChild(cell);
        return row;
    }

    shouldVirtualize(entriesCount, state) {
        return state?.directoryViewMode !== 'tree'
            && Boolean(this.scrollContainer)
            && entriesCount >= VIRTUALIZATION_THRESHOLD;
    }

    syncVirtualViewport() {
        if (!this.scrollContainer) return;
        this.virtual.viewportHeight = this.scrollContainer.clientHeight || 0;
        this.virtual.scrollTop = this.scrollContainer.scrollTop || 0;
    }

    clampVirtualScroll(entriesCount) {
        if (!this.scrollContainer || !this.virtual.enabled) return;
        const rowHeight = Math.max(1, Number(this.virtual.rowHeight) || DEFAULT_ROW_HEIGHT);
        const viewportHeight = Math.max(0, Number(this.virtual.viewportHeight) || 0);
        const maxScrollTop = Math.max(0, entriesCount * rowHeight - viewportHeight);
        if (this.scrollContainer.scrollTop > maxScrollTop) {
            this.scrollContainer.scrollTop = maxScrollTop;
        }
        this.virtual.scrollTop = this.scrollContainer.scrollTop || 0;
    }

    computeVirtualWindow(totalCount) {
        const rowHeight = Math.max(1, Number(this.virtual.rowHeight) || DEFAULT_ROW_HEIGHT);
        const viewportHeight = Math.max(
            rowHeight,
            Number(this.virtual.viewportHeight) || this.scrollContainer?.clientHeight || rowHeight
        );
        const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
        const startIndex = Math.max(0, Math.floor((this.virtual.scrollTop || 0) / rowHeight) - VIRTUALIZATION_OVERSCAN);
        const endIndex = Math.min(totalCount, startIndex + visibleRows + (VIRTUALIZATION_OVERSCAN * 2));
        return {
            startIndex,
            endIndex,
            topSpacerHeight: startIndex * rowHeight,
            bottomSpacerHeight: Math.max(0, (totalCount - endIndex) * rowHeight)
        };
    }

    updateMeasuredRowHeight() {
        if (!this.virtual.enabled || !this.tbody) return;
        const row = this.tbody.querySelector('tr:not(.entries-virtual-spacer)');
        if (!row) return;
        const measured = Math.round(row.getBoundingClientRect().height || 0);
        if (!Number.isFinite(measured) || measured <= 0) return;
        if (Math.abs(measured - this.virtual.rowHeight) >= 1) {
            this.virtual.rowHeight = measured;
            this.schedulePatchRows();
        }
    }

    filterLoadedTreeEntries(entries, state, host) {
        const filterQuery = String(state?.directoryFilterQuery || '').trim().toLowerCase();
        const items = Array.isArray(entries) ? entries : [];
        const filtered = filterQuery
            ? items.filter((entry) => {
                const name = String(entry?.name || '').toLowerCase();
                const entryPath = String(entry?.path || '').toLowerCase();
                return name.includes(filterQuery) || entryPath.includes(filterQuery);
            })
            : items;
        return host.sortEntries(filtered);
    }

    buildTreeItems(entries, state, host, depth = 0, target = []) {
        for (const entry of entries) {
            const entryPath = this.toEntryPath(entry, state, host);
            if (!entryPath) continue;
            const type = String(entry?.type || 'file');
            const treeViewState = this.getTreeViewState();
            const isExpanded = type === 'directory' && treeViewState.expandedPaths.has(entryPath);
            const isLoading = type === 'directory' && treeViewState.loadingPaths.has(entryPath);
            target.push({
                kind: 'entry',
                entry,
                entryPath,
                type,
                depth,
                isExpanded,
                isLoading
            });
            if (!isExpanded || type !== 'directory') continue;
            const cachedChildren = this.getTreeViewState().childrenCache.get(entryPath);
            if (Array.isArray(cachedChildren)) {
                const children = this.filterLoadedTreeEntries(cachedChildren, state, host);
                if (children.length) {
                    this.buildTreeItems(children, state, host, depth + 1, target);
                } else {
                    target.push({
                        kind: 'status',
                        statusKind: 'empty',
                        parentPath: entryPath,
                        depth: depth + 1,
                        message: 'Empty folder.'
                    });
                }
            }
        }
        return target;
    }

    patchRows() {
        if (!this.tbody) return;
        const host = this.getHostPresenter();
        if (!host) return;
        const state = this.snapshot || host.state || {};
        const isTreeView = state.directoryViewMode === 'tree';
        const entries = Array.isArray(state.entries) ? state.entries : [];
        const items = isTreeView
            ? this.buildTreeItems(entries, state, host)
            : entries.map((entry) => ({
                kind: 'entry',
                entry,
                entryPath: this.toEntryPath(entry, state, host),
                type: String(entry?.type || 'file'),
                depth: 0,
                isExpanded: false,
                isLoading: false
            }));
        this.virtual.enabled = this.shouldVirtualize(items.length, state);
        this.syncVirtualViewport();
        this.clampVirtualScroll(items.length);
        const clipboard = state.clipboard || null;
        const selectedPath = String(state.selectedPath || '');
        const openMenuPath = String(state.openMenuPath || '');
        const nextRows = new Map();
        const orderedRows = [];
        const appendRow = (row) => orderedRows.push(row);

        if (!items.length) {
            const emptyRow = this.createEmptyRow();
            this.rowsByPath.clear();
            this.tbody.replaceChildren(emptyRow);
            this.applyColumnVisibility(state);
            return;
        }

        const windowRange = this.virtual.enabled
            ? this.computeVirtualWindow(items.length)
            : {
                startIndex: 0,
                endIndex: items.length,
                topSpacerHeight: 0,
                bottomSpacerHeight: 0
            };

        if (this.virtual.enabled && windowRange.topSpacerHeight > 0) {
            appendRow(this.createSpacerRow(windowRange.topSpacerHeight, 'top'));
        }

        for (let index = windowRange.startIndex; index < windowRange.endIndex; index += 1) {
            const item = items[index];
            if (!item) continue;
            if (item.kind !== 'entry') {
                const statusRow = this.createTreeStatusRow(item.message, item.parentPath, item.statusKind);
                const statusCell = statusRow.querySelector('.tree-status-cell');
                if (statusCell) {
                    statusCell.style.setProperty('--tree-depth', String(item.depth || 0));
                }
                const rowKey = statusRow.dataset.entryPath;
                nextRows.set(rowKey, statusRow);
                appendRow(statusRow);
                continue;
            }

            const { entry, entryPath, type, depth, isExpanded, isLoading } = item;
            if (!entryPath) continue;
            const row = this.rowsByPath.get(entryPath) || this.createRow(entryPath);
            const previousType = String(row.dataset.type || '');
            row.dataset.entryPath = entryPath;
            row.dataset.type = type;
            row.dataset.symlink = entry?.isSymlink ? 'true' : 'false';
            if (entry?.linkTarget) {
                row.title = `Symbolic link to ${entry.linkTarget}`;
            } else {
                row.removeAttribute('title');
            }
            row.classList.toggle('active', selectedPath === entryPath);
            row.classList.toggle('is-symlink', Boolean(entry?.isSymlink));

            const isClipboardSource = clipboard?.path === entryPath;
            row.classList.toggle('clipboard-row', Boolean(isClipboardSource));
            row.classList.toggle('clipboard-cut', Boolean(isClipboardSource && clipboard?.mode === 'cut'));
            row.classList.toggle('clipboard-copy', Boolean(isClipboardSource && clipboard?.mode === 'copy'));

            const iconClass = entry?.isSymlink
                ? (type === 'directory' ? 'icon-folder-symlink' : 'icon-file-symlink')
                : (entryPath === '/Confidential'
                    ? 'icon-folder-secure'
                    : (type === 'directory' ? 'icon-folder' : 'icon-file'));
            const nameCell = this.createSelectCell('col-name', entry?.name || '', entryPath, type, iconClass, {
                isSymlink: Boolean(entry?.isSymlink),
                linkTarget: entry?.linkTarget || '',
                depth,
                localAction: isTreeView && type === 'directory' ? 'toggleTreeDirectory' : 'selectEntry',
                showTreeToggle: isTreeView && type === 'directory',
                expanded: isExpanded,
                loading: isLoading
            });
            const rowLocalAction = isTreeView && type === 'directory' ? 'toggleTreeDirectory' : 'selectEntry';
            const typeCell = this.createSelectCell('col-type', type, entryPath, type, '', { localAction: rowLocalAction });
            const sizeValue = type === 'directory' ? '—' : host.formatBytes(entry?.size);
            const sizeCell = this.createSelectCell('col-size', sizeValue, entryPath, type, '', { localAction: rowLocalAction });
            const modifiedCell = this.createSelectCell('col-modified', entry?.modified ? host.formatDate(entry.modified) : '—', entryPath, type, '', { localAction: rowLocalAction });
            const existingActionsCell = previousType === type
                ? Array.from(row.children).find((cell) => cell?.classList?.contains('actions-cell'))
                : null;
            const actionsCell = existingActionsCell || this.createActionsCell(
                entryPath,
                type,
                openMenuPath === entryPath,
                entry
            );
            if (existingActionsCell) {
                this.syncActionsCell(
                    existingActionsCell,
                    entryPath,
                    type,
                    openMenuPath === entryPath,
                    entry
                );
            }

            if (existingActionsCell && row.children.length >= 5) {
                row.children[0].replaceWith(nameCell);
                row.children[1].replaceWith(typeCell);
                row.children[2].replaceWith(sizeCell);
                row.children[3].replaceWith(modifiedCell);
            } else {
                row.replaceChildren(nameCell, typeCell, sizeCell, modifiedCell, actionsCell);
            }
            nextRows.set(entryPath, row);
            appendRow(row);
        }

        if (this.virtual.enabled && windowRange.bottomSpacerHeight > 0) {
            appendRow(this.createSpacerRow(windowRange.bottomSpacerHeight, 'bottom'));
        }

        this.rowsByPath = nextRows;
        const retainedRows = new Set(orderedRows);
        for (const child of Array.from(this.tbody.children)) {
            if (!retainedRows.has(child)) child.remove();
        }
        let cursor = this.tbody.firstElementChild;
        for (const row of orderedRows) {
            if (row === cursor) {
                cursor = cursor.nextElementSibling;
            } else {
                this.tbody.insertBefore(row, cursor);
            }
        }
        this.applyColumnVisibility(state);
        this.updateMeasuredRowHeight();
    }

    delegateAction(methodName, ...args) {
        const host = this.getHostPresenter();
        const handler = host?.[methodName];
        if (typeof handler !== 'function') return;
        return handler.apply(host, args);
    }

    selectEntry(...args) {
        return this.delegateAction('selectEntry', ...args);
    }

    toggleActionMenu(...args) {
        return this.delegateAction('toggleActionMenu', ...args);
    }

    renameEntry(...args) {
        return this.delegateAction('renameEntry', ...args);
    }

    copyEntry(...args) {
        return this.delegateAction('copyEntry', ...args);
    }

    cutEntry(...args) {
        return this.delegateAction('cutEntry', ...args);
    }

    pasteClipboard(...args) {
        return this.delegateAction('pasteClipboard', ...args);
    }

    uploadHere(...args) {
        return this.delegateAction('uploadHere', ...args);
    }

    openDpuPermissions(...args) {
        return this.delegateAction('openDpuPermissions', ...args);
    }

    deleteEntry(...args) {
        return this.delegateAction('deleteEntry', ...args);
    }

    async revealTreeDirectory(entryPath, options = {}) {
        const host = this.getHostPresenter();
        if (!host) return;
        const normalizedPath = host.normalizePath?.(entryPath || '/') || String(entryPath || '/');
        const rootPath = host.normalizePath?.(host.state?.treeRootPath || '/') || String(host.state?.treeRootPath || '/');
        const treeViewState = this.getTreeViewState();
        if (!normalizedPath || normalizedPath === rootPath) {
            if (!options.preserveExisting) {
                treeViewState.expandedPaths.clear();
                this.patchRows();
            }
            return;
        }

        if (!options.preserveExisting) {
            treeViewState.expandedPaths.clear();
        }
        if (!options.skipAncestors) {
            const ancestors = [];
            let parent = normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) || '/';
            while (parent !== rootPath && parent !== '/' && parent.startsWith(rootPath === '/' ? '/' : `${rootPath}/`)) {
                ancestors.unshift(parent);
                parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
            }
            for (const ancestor of ancestors) {
                await this.revealTreeDirectory(ancestor, { preserveExisting: true, skipAncestors: true });
            }
        }
        treeViewState.expandedPaths.add(normalizedPath);

        if (treeViewState.childrenCache.has(normalizedPath)) {
            this.patchRows();
            return;
        }

        const cached = host.state?.filterSpecs ? null : host.getCachedDirectoryContent?.(normalizedPath);
        if (Array.isArray(cached?.value)) {
            treeViewState.childrenCache.set(normalizedPath, host.sortEntries(cached.value));
            this.patchRows();
            return;
        }

        treeViewState.loadingPaths.add(normalizedPath);
        this.patchRows();
        const cacheGeneration = host.caches?.dirListing?.getGeneration?.(host, normalizedPath) || 0;
        const workspaceVersion = Number(host.state?.workspaceVersion) || 0;
        const requestIsCurrent = () => (
            (host.caches?.dirListing?.getGeneration?.(host, normalizedPath) || 0) === cacheGeneration
            && (Number(host.state?.workspaceVersion) || 0) === workspaceVersion
        );
        try {
            let children = await host.loadDirectoryContent(normalizedPath);
            if (!Array.isArray(children)) {
                children = [];
            }
            if (host.state?.filterSpecs) {
                children = await host.filterEntriesForSpecs(children);
            }
            if (requestIsCurrent()) {
                treeViewState.childrenCache.set(normalizedPath, host.sortEntries(children));
            }
        } catch (error) {
            if (requestIsCurrent()) {
                console.error(error);
                treeViewState.childrenCache.set(normalizedPath, []);
                host.showStatus?.(error?.message || 'Failed to load folder contents.', true);
            }
        } finally {
            treeViewState.loadingPaths.delete(normalizedPath);
            this.patchRows();
        }
    }

    updateTreeDirectoryChildren(entryPath, entries) {
        const host = this.getHostPresenter();
        if (!host) return;
        this.snapshot = host.stateStore?.getState ? host.stateStore.getState() : host.state;
        const normalizedPath = host.normalizePath?.(entryPath || '/') || String(entryPath || '/');
        const treeViewState = this.getTreeViewState();
        treeViewState.childrenCache.set(normalizedPath, Array.isArray(entries) ? entries : []);
        if (treeViewState.expandedPaths.has(normalizedPath)) {
            this.patchRows();
        }
    }

    updateTreeRootEntries() {
        const host = this.getHostPresenter();
        if (!host) return;
        this.snapshot = host.stateStore?.getState ? host.stateStore.getState() : host.state;
        this.syncTreeContext();
        this.patchRows();
    }

    async toggleTreeDirectory(element) {
        const host = this.getHostPresenter();
        if (!host) return;
        const state = this.snapshot || host.state || {};
        if (state.directoryViewMode !== 'tree') {
            return this.selectEntry(element);
        }
        const entryPath = host.normalizePath?.(element?.dataset?.entryPath || '') || String(element?.dataset?.entryPath || '');
        const entryType = String(element?.dataset?.type || '');
        const treeViewState = this.getTreeViewState();
        if (!entryPath || entryType !== 'directory') return;

        if (treeViewState.expandedPaths.has(entryPath)) {
            treeViewState.expandedPaths.delete(entryPath);
            this.patchRows();
            return;
        }

        treeViewState.expandedPaths.add(entryPath);
        if (treeViewState.childrenCache.has(entryPath)) {
            host.updateNavigationLocation?.(entryPath, {
                selectedPath: null,
                resetContext: true
            });
            this.patchRows();
            return;
        }

        const cached = host.state?.filterSpecs ? null : host.getCachedDirectoryContent?.(entryPath);
        if (Array.isArray(cached?.value)) {
            treeViewState.childrenCache.set(entryPath, host.sortEntries(cached.value));
            host.updateNavigationLocation?.(entryPath, {
                selectedPath: null,
                resetContext: true
            });
            this.patchRows();
            return;
        }

        treeViewState.loadingPaths.add(entryPath);
        host.updateNavigationLocation?.(entryPath, {
            selectedPath: null,
            resetContext: true
        });
        this.patchRows();
        const cacheGeneration = host.caches?.dirListing?.getGeneration?.(host, entryPath) || 0;
        const workspaceVersion = Number(host.state?.workspaceVersion) || 0;
        const requestIsCurrent = () => (
            (host.caches?.dirListing?.getGeneration?.(host, entryPath) || 0) === cacheGeneration
            && (Number(host.state?.workspaceVersion) || 0) === workspaceVersion
        );
        try {
            let children = await host.loadDirectoryContent(entryPath);
            if (!Array.isArray(children)) {
                children = [];
            }
            if (host.state?.filterSpecs) {
                children = await host.filterEntriesForSpecs(children);
            }
            if (requestIsCurrent()) {
                treeViewState.childrenCache.set(entryPath, host.sortEntries(children));
            }
        } catch (error) {
            if (requestIsCurrent()) {
                console.error(error);
                treeViewState.childrenCache.set(entryPath, []);
                host.showStatus?.(error?.message || 'Failed to load folder contents.', true);
            }
        } finally {
            treeViewState.loadingPaths.delete(entryPath);
            this.patchRows();
        }
    }
}
