import { FILE_EXP_UI_ACTIONS } from "./file-exp-ui-controller.js";
import { buildFileExpHash } from "./file-exp-utils.js";

export async function selectEntry(fileExp, element) {
    const path = element.dataset.entryPath;
    const type = element.dataset.type;

    if (fileExp.state.openMenuPath) {
        fileExp.setOpenMenuPath(null);
        fileExp.pendingMenuFocusPath = null;
    }

    if (fileExp.state.isEditing && fileExp.state.hasUnsavedChanges) {
        if (!confirm("You have unsaved changes. Are you sure you want to navigate away?")) {
            return;
        }
        await fileExp.cancelEdit();
    } else if (fileExp.state.isEditing) {
        await fileExp.cancelEdit();
    }

    if (type === 'directory') {
        await fileExp.withLoader(() => fileExp.loadDirectory(path));
        return;
    }

    if (type === 'file') {
        if (fileExp.state.directoryViewMode === 'tree') {
            const parentDir = fileExp.parentPath(path) || '/';
            fileExp.updateNavigationLocation(parentDir, {
                selectedPath: path,
                historyMode: 'push',
                invalidate: false
            });
        } else {
            const newUrl = buildFileExpHash(path);
            if (window.location.hash !== newUrl) {
                history.pushState(null, '', newUrl);
            }
            fileExp.state.selectedPath = path;
        }
        await fileExp.openFile(path);
        return;
    }

    if (typeof fileExp.navigateToPath === 'function') {
        await fileExp.navigateToPath(path);
        return;
    }

    await fileExp.withLoader(async () => {
        try {
            await fileExp.tooling.readTextFile(path);
            const parentDir = fileExp.parentPath(path) || '/';
            fileExp.state.path = parentDir;
            const entries = await fileExp.loadDirectoryContent(parentDir);
            await fileExp.setEntries(entries);
            fileExp.state.selectedPath = path;
            await fileExp.openFile(path);
            const newUrl = buildFileExpHash(path);
            if (window.location.hash !== newUrl) {
                history.pushState(null, '', newUrl);
            }
        } catch (_) {
            await fileExp.loadDirectory(path);
        }
    });
}

export function handleSortClick(fileExp, event) {
    const key = event.currentTarget?.dataset?.sortKey;
    if (!key) return;
    const nextDir = fileExp.state.sortBy === key && fileExp.state.sortDir === 'asc' ? 'desc' : 'asc';
    const sortedEntries = fileExp.sortEntries(fileExp.state.entries);
    fileExp.dispatchUi({
        type: FILE_EXP_UI_ACTIONS.SET_SORT,
        payload: {
            sortBy: key,
            sortDir: nextDir,
            entries: sortedEntries
        }
    });
    fileExp.invalidate();
}
