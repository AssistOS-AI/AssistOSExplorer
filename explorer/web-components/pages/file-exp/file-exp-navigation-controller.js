import { FILE_EXP_UI_ACTIONS } from "./file-exp-ui-controller.js";
import { PREVIEW_ACTIONS } from "./file-exp-preview-controller.js";
import { buildFileExpHash, encodeLocalActionPathArg } from "./file-exp-utils.js";
import { invalidateDpuState, isDpuManagedPath } from "./file-exp-dpu-provider.js";

async function loadTreeContext(fileExp, targetDirectoryPath, options = {}) {
    const { selectedPath = null, historyMode = 'push' } = options;
    const normalizedTargetPath = fileExp.normalizePath(targetDirectoryPath || '/');
    // The URL selects a branch; it must not replace the workspace tree root.
    const treeRootPath = '/';

    fileExp.updateNavigationLocation(normalizedTargetPath, {
        selectedPath,
        resetContext: true,
        historyMode,
        invalidate: false
    });
    fileExp.state.treeRootPath = treeRootPath;

    const entries = await fileExp.loadDirectoryContent(treeRootPath);
    if (entries === null) {
        return null;
    }

    await fileExp.setEntries(entries);
    fileExp.renderBreadcrumbs();
    fileExp.renderEntries();
    if (normalizedTargetPath !== treeRootPath) {
        const entriesPresenter = fileExp.getEntriesPresenter();
        if (entriesPresenter && typeof entriesPresenter.revealTreeDirectory === 'function') {
            await entriesPresenter.revealTreeDirectory(normalizedTargetPath, { preserveExisting: false });
        } else {
            fileExp.pendingTreeReveal = { path: normalizedTargetPath, preserveExisting: false };
        }
    } else {
        fileExp.pendingTreeReveal = null;
    }

    return entries;
}

export async function loadStateFromURL(fileExp) {
    {
        const rawPath = window.location.hash.split('#file-exp')[1] || '/';
        let path = rawPath;
        try {
            path = decodeURIComponent(rawPath);
        } catch (error) {
            console.warn('Failed to decode file-exp path from URL:', rawPath, error);
            path = rawPath;
        }
        path = fileExp.normalizePath(path);

        if (path === '/') {
            await fileExp.loadDirectory('/');
            return;
        }

        if (fileExp.state.isEditing) {
            await fileExp.cancelEdit();
        }

        const parentDir = fileExp.parentPath(path) || '/';
        const entryName = path.substring(parentDir.length).replace(/^\//, '');

        try {
            const parentEntries = await fileExp.loadDirectoryContent(parentDir);
            if (parentEntries === null) {
                await fileExp.loadDirectory('/');
                fileExp.showStatus('Path not found. Returned to root.', true);
                return;
            }

            const entry = parentEntries.find((item) => item.name === entryName);
            if (!entry) {
                await fileExp.loadDirectory(path);
                return;
            }

            if (entry.type === 'file') {
                if (fileExp.state.directoryViewMode === 'tree') {
                    const loaded = await loadTreeContext(fileExp, parentDir, {
                        selectedPath: path,
                        historyMode: 'replace'
                    });
                    if (loaded === null) {
                        await fileExp.loadDirectory('/');
                        fileExp.showStatus('Path not found. Returned to root.', true);
                        return;
                    }
                    await fileExp.openFile(path);
                    return;
                }
                fileExp.state.path = parentDir;
                fileExp.state.selectedPath = path;
                fileExp.state.isEditing = false;
                await fileExp.setEntries(parentEntries);
                await fileExp.openFile(path);
                const newUrl = buildFileExpHash(path);
                if (window.location.hash !== newUrl) {
                    history.pushState(null, '', newUrl);
                }
                fileExp.invalidate();
                return;
            }

            if (entry.type === 'directory') {
                await fileExp.loadDirectory(path);
                return;
            }

            fileExp.showStatus(`Unsupported entry type for ${path}.`, true);
            await fileExp.loadDirectory(parentDir);
        } catch (error) {
            console.error('Failed to load state from URL:', error);
            await fileExp.loadDirectory('/');
            fileExp.showStatus(error?.message || 'An error occurred while loading the path. Returned to root.', true);
        }
    }
}

export async function loadDirectory(fileExp, path = fileExp.state.path) {
    {
        if (fileExp.state.isEditing) {
            await fileExp.cancelEdit();
        }
        const normalizedPath = fileExp.normalizePath(path);

        if (fileExp.state.directoryViewMode === 'tree') {
            const entries = await loadTreeContext(fileExp, normalizedPath, {
                historyMode: 'push'
            });
            if (entries === null) {
                if (normalizedPath === '/') {
                    fileExp.showStatus('Root directory is not accessible.', true);
                    return;
                }
                await fileExp.loadDirectory('/');
                fileExp.showStatus('Path not found. Returned to root.', true);
            }
            return;
        }

        fileExp.state.path = normalizedPath;
        fileExp.state.treeRootPath = normalizedPath;

        const newUrl = buildFileExpHash(normalizedPath);
        if (window.location.hash !== newUrl) {
            history.pushState(null, '', newUrl);
        }

        fileExp.dispatchUi({ type: FILE_EXP_UI_ACTIONS.RESET_DIRECTORY_CONTEXT });
        fileExp.dispatchPreview({ type: PREVIEW_ACTIONS.RESET });
        fileExp.pendingMenuFocusPath = null;

        const entries = await fileExp.loadDirectoryContent(fileExp.state.path);
        if (entries === null) {
            if (fileExp.state.path === '/') {
                fileExp.showStatus('Root directory is not accessible.', true);
                return;
            }
            await fileExp.loadDirectory('/');
            fileExp.showStatus('Path not found. Returned to root.', true);
            return;
        }
        await fileExp.setEntries(entries);
        fileExp.invalidate();
    }

    if (String(fileExp.state.directoryFilterQuery || '').trim().length >= 2) {
        await fileExp.directoryFilterController.rerunIfActive();
    }
}

export async function refreshDirectory(fileExp) {
    await fileExp.withLoader(async () => {
        const currentPath = fileExp.state.path || '/';
        const listingPath = fileExp.state.directoryViewMode === 'tree'
            ? (fileExp.state.treeRootPath || currentPath || '/')
            : currentPath;
        const selectedPath = fileExp.normalizePath(fileExp.state.selectedPath || '');
        const expandedPaths = fileExp.state.directoryViewMode === 'tree'
            ? [...(fileExp.treeViewState?.expandedPaths || [])] : [];
        if (fileExp.state.directoryViewMode === 'tree' && fileExp.treeViewState) {
            const tree = fileExp.treeViewState;
            const paths = new Set([...expandedPaths, ...tree.childrenCache.keys(), ...tree.loadingPaths]);
            for (const path of paths) fileExp.caches.dirListing.invalidate(fileExp, path);
            tree.childrenCache.clear();
            tree.loadingPaths.clear();
        }
        const dpuRefreshTargets = [listingPath, currentPath, selectedPath].filter((targetPath) => isDpuManagedPath(targetPath));
        if (dpuRefreshTargets.length > 0) {
            invalidateDpuState(fileExp, dpuRefreshTargets);
        } else {
            fileExp.caches.dirListing.invalidate(fileExp, listingPath);
            if (selectedPath) {
                fileExp.caches.filePreview.invalidateForPath(selectedPath);
            }
        }
        const entries = await fileExp.loadDirectoryContent(listingPath);
        if (entries === null) {
            fileExp.showStatus('Path not found. Returning to root.', true);
            await fileExp.loadDirectory('/');
            return;
        }
        await fileExp.setEntries(entries);
        if (selectedPath && isDpuManagedPath(selectedPath)) {
            await fileExp.openFile(selectedPath, { invalidate: false });
        }
        if (fileExp.state.directoryViewMode === 'tree') {
            fileExp.renderEntries();
            const entriesPresenter = fileExp.getEntriesPresenter();
            if (entriesPresenter && typeof entriesPresenter.revealTreeDirectory === 'function') {
                fileExp.pendingTreeReveal = null;
                const paths = [...new Set([...expandedPaths, currentPath])].sort((left, right) => left.split('/').length - right.split('/').length);
                for (const path of paths) {
                    await entriesPresenter.revealTreeDirectory(path, { preserveExisting: true });
                }
            } else {
                fileExp.pendingTreeReveal = { path: currentPath, preserveExisting: true };
            }
        } else {
            fileExp.invalidate();
        }
    });

    if (String(fileExp.state.directoryFilterQuery || '').trim().length >= 2) {
        await fileExp.directoryFilterController.rerunIfActive();
    }
}

export function renderBreadcrumbs(fileExp) {
    const breadcrumbsEl = fileExp.element.querySelector('#breadcrumbs');
    if (!breadcrumbsEl) return;
    const fragment = document.createDocumentFragment();

    const rootButton = document.createElement('button');
    rootButton.textContent = '/';
    rootButton.setAttribute('data-local-action', `openBreadcrumb ${encodeLocalActionPathArg('/')}`);
    fragment.appendChild(rootButton);

    if (!fileExp.state.path || fileExp.state.path === '/') {
        breadcrumbsEl.replaceChildren(fragment);
        return;
    }

    const segments = fileExp.state.path.split('/').filter(Boolean);
    let current = '';
    segments.forEach((segment) => {
        current += `/${segment}`;
        const btn = document.createElement('button');
        btn.textContent = `${segment} /`;
        btn.setAttribute('data-local-action', `openBreadcrumb ${encodeLocalActionPathArg(current)}`);
        fragment.appendChild(btn);
    });

    breadcrumbsEl.replaceChildren(fragment);
}

export async function goUpDirectory(fileExp) {
    const parent = fileExp.parentPath(fileExp.state.path);
    if (parent !== null) {
        await fileExp.loadDirectory(parent);
    }
}
