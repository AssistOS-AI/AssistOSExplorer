export function formatRepoSummary(repo) {
    if (!repo || !repo.ok) {
        return 'Not a git repository.';
    }
    if (repo.statusUnavailable) {
        return 'Loading repository status.';
    }
    const counts = repo.counts || { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    const hasChanges = counts.staged || counts.unstaged || counts.untracked || counts.conflicted;
    const stashCount = Number.isFinite(repo.stashCount) ? repo.stashCount : 0;
    if (!hasChanges) {
        return stashCount ? `Clean. Stashes: ${stashCount}.` : 'Clean.';
    }

    const sample = repo.sample || {};
    const parts = [];

    const addPart = (label, count, items) => {
        if (!count) return;
        const list = Array.isArray(items) ? items : [];
        const base = `${label}(${count})`;
        if (!list.length) {
            parts.push(base);
            return;
        }
        const shown = list.slice(0, 4);
        const more = count - shown.length;
        parts.push(`${base}: ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    };

    addPart('staged', counts.staged, sample.staged);
    addPart('unstaged', counts.unstaged, sample.unstaged);
    addPart('untracked', counts.untracked, sample.untracked);
    addPart('conflicts', counts.conflicted, sample.conflicted);
    if (stashCount) {
        parts.push(`stashes(${stashCount})`);
    }

    return parts.join(' | ');
}

import { normalizeRepoRelativePrefix } from './git-commit-modal-selection.js';

const toArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    const iterator = value[Symbol.iterator];
    if (typeof iterator === 'function') {
        try {
            return Array.from(value);
        } catch {
            return [];
        }
    }
    return [];
};

export function renderRepoChangesTree(repo, {
    isFileSelected,
    getAncestorCoveringPrefix,
    getCoveringPrefix,
    isFolderExpanded,
    initialDepth = 1
} = {}) {
    const ignoredPaths = toArray(repo?.ignored);
    const ignoredHints = toArray(repo?.ignoredHints);
    const ignoredSet = new Set(ignoredPaths.map((p) => String(p)));
    const ignoredHintSet = new Set(ignoredHints.map((p) => String(p).replace(/^\/+/, '')));
    const normalizeRow = (row) => {
        if (!row) return null;
        if (typeof row === 'string') {
            return { path: row, kind: 'unknown', flags: null, x: null, y: null };
        }
        if (!row.path && row.filePath) {
            return { ...row, path: row.filePath };
        }
        return row;
    };
    const changesAll = toArray(repo?.changesAll);
    const fallbackPaths = repo?.changes ? [
        ...toArray(repo.changes.staged),
        ...toArray(repo.changes.unstaged),
        ...toArray(repo.changes.untracked),
        ...toArray(repo.changes.conflicted)
    ].map((p) => ({ path: p, kind: 'unknown', x: null, y: null })) : [];
    const ignoredRows = ignoredPaths.map((p) => ({
        path: p,
        kind: 'ignored',
        flags: { ignored: true },
        x: ' ',
        y: ' '
    }));
    const rows = [];
    const seen = new Set();
    const pushRow = (row) => {
        const normalized = normalizeRow(row);
        if (!normalized?.path) return;
        const key = String(normalized.path);
        if (seen.has(key)) return;
        if (ignoredSet.has(key) || ignoredHintSet.has(key)) {
            normalized.kind = 'ignored';
            normalized.flags = { ...(normalized.flags || {}), ignored: true };
            if (!normalized.x) normalized.x = ' ';
            if (!normalized.y) normalized.y = ' ';
        }
        seen.add(key);
        rows.push(normalized);
    };
    const baseRows = (changesAll && changesAll.length) ? changesAll : fallbackPaths;
    baseRows.forEach(pushRow);
    ignoredRows.forEach(pushRow);
    if (!rows.length) return null;

    const root = document.createElement('div');
    root.className = 'git-tree';

    const buildTree = (items) => {
        const tree = { files: [], children: new Map() };
        for (const item of items) {
            const rel = String(item?.path || '').replace(/^\/+/, '');
            if (!rel) continue;
            const parts = rel.split('/').filter(Boolean);
            let node = tree;
            for (let i = 0; i < parts.length; i += 1) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                if (isLast) {
                    const isIgnored = Boolean(item?.flags?.ignored) || item.kind === 'ignored';
                    node.files.push({
                        name: part,
                        path: rel,
                        kind: item.kind,
                        flags: item.flags || null,
                        ignored: isIgnored,
                        x: item.x,
                        y: item.y
                    });
                } else {
                    if (!node.children.has(part)) {
                        node.children.set(part, { files: [], children: new Map() });
                    }
                    node = node.children.get(part);
                }
            }
        }
        return tree;
    };

    const collectSubtreeFilePaths = (node) => {
        const paths = [];
        const stack = [node];
        while (stack.length) {
            const current = stack.pop();
            const files = Array.isArray(current?.files) ? current.files : [];
            for (const f of files) {
                if (f?.path && !f.ignored) paths.push(f.path);
            }
            const children = current?.children;
            if (children && typeof children.values === 'function') {
                for (const child of children.values()) {
                    stack.push(child);
                }
            }
        }
        return paths;
    };

    const renderNode = (node, depth, prefix) => {
        const out = document.createElement('div');
        out.className = 'git-tree-children';
        const indentStep = 18;
        const indent = (level) => `${level * indentStep}px`;

        const hasIgnoredInPrefix = (pathPrefix) => {
            if (!pathPrefix) return false;
            for (const p of ignoredSet.values()) {
                if (p === pathPrefix || p.startsWith(pathPrefix)) return true;
            }
            for (const p of ignoredHintSet.values()) {
                if (p === pathPrefix || p.startsWith(pathPrefix)) return true;
            }
            return false;
        };

        const folderNames = Array.from(node.children.keys()).sort((a, b) => a.localeCompare(b));
        for (const folder of folderNames) {
            const childNode = node.children.get(folder);
            const nextPrefix = prefix ? `${prefix}${folder}/` : `${folder}/`;
            const normalizedPrefix = normalizeRepoRelativePrefix(nextPrefix);
            const subtreeFiles = collectSubtreeFilePaths(childNode);
            const expandedState = isFolderExpanded ? isFolderExpanded(repo.path, normalizedPrefix) : undefined;
            const expanded = expandedState === undefined ? subtreeFiles.length > 0 : Boolean(expandedState);

            const folderWrapper = document.createElement('div');
            folderWrapper.className = 'git-tree-folder-node';

            const row = document.createElement('div');
            row.className = 'git-tree-item';
            row.style.paddingLeft = indent(depth);

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'secondary git-tree-folder-toggle';
            toggle.setAttribute('data-local-action', 'toggleTreeFolder');
            toggle.dataset.repoPath = repo.path;
            toggle.dataset.prefix = normalizedPrefix;
            toggle.textContent = expanded ? '▾' : '▸';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.fileFolderSelect = 'true';
            checkbox.dataset.repoPath = repo.path;
            checkbox.dataset.prefix = normalizedPrefix;
            checkbox.setAttribute('data-local-action', 'toggleTreePrefixSelectionCheckbox');

            const ancestorPrefix = getAncestorCoveringPrefix?.(repo.path, normalizedPrefix) || null;
            const explicitlySelected = Boolean(getCoveringPrefix?.(repo.path, normalizedPrefix) === normalizedPrefix);

            if (ancestorPrefix) {
                checkbox.checked = true;
                checkbox.disabled = true;
            } else if (explicitlySelected) {
                checkbox.checked = true;
            } else {
                const selectedCount = subtreeFiles.reduce((acc, p) => acc + (isFileSelected?.(repo.path, p) ? 1 : 0), 0);
                checkbox.checked = subtreeFiles.length > 0 && selectedCount === subtreeFiles.length;
                checkbox.indeterminate = selectedCount > 0 && selectedCount < subtreeFiles.length;
            }

            const label = document.createElement('div');
            label.className = 'git-tree-folder';
            const icon = document.createElement('span');
            icon.className = 'git-tree-folder-icon';
            icon.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.className = 'git-tree-folder-name';
            text.textContent = folder;
            label.appendChild(icon);
            label.appendChild(text);

            row.appendChild(toggle);
            row.appendChild(checkbox);
            row.appendChild(label);
            row.classList.add('has-file-menu');

            const menu = document.createElement('div');
            menu.className = 'git-file-menu';

            const menuButton = document.createElement('button');
            menuButton.type = 'button';
            menuButton.className = 'icon-button git-file-menu-button';
            menuButton.setAttribute('data-local-action', 'toggleFileMenu');
            menuButton.setAttribute('aria-label', 'Folder actions');
            menuButton.title = 'Folder actions';
            menuButton.textContent = '⋮';

            const menuList = document.createElement('div');
            menuList.className = 'git-file-menu-list';

            const folderIgnored = hasIgnoredInPrefix(normalizedPrefix);
            if (!folderIgnored) {
                const ignoreItem = document.createElement('div');
                ignoreItem.className = 'git-file-menu-item';
                ignoreItem.setAttribute('role', 'menuitem');
                ignoreItem.setAttribute('tabindex', '0');
                ignoreItem.dataset.repoPath = repo.path;
                ignoreItem.dataset.prefix = normalizedPrefix;
                ignoreItem.setAttribute('data-local-action', 'openIgnoreForFolder');
                ignoreItem.textContent = 'Add to .gitignore';
                menuList.appendChild(ignoreItem);
            } else {
                const removeIgnoreItem = document.createElement('div');
                removeIgnoreItem.className = 'git-file-menu-item';
                removeIgnoreItem.setAttribute('role', 'menuitem');
                removeIgnoreItem.setAttribute('tabindex', '0');
                removeIgnoreItem.dataset.repoPath = repo.path;
                removeIgnoreItem.dataset.filePath = normalizedPrefix;
                removeIgnoreItem.setAttribute('data-local-action', 'removeIgnoreForFile');
                removeIgnoreItem.textContent = 'Remove from .gitignore';
                menuList.appendChild(removeIgnoreItem);
            }

            menu.appendChild(menuButton);
            menu.appendChild(menuList);
            row.appendChild(menu);
            folderWrapper.appendChild(row);
            if (expanded) {
                folderWrapper.appendChild(renderNode(childNode, depth + 1, nextPrefix));
            }
            out.appendChild(folderWrapper);
        }

        const files = (node.files || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        for (const file of files) {
            const row = document.createElement('div');
            row.className = 'git-tree-item git-tree-file-row';
            row.style.paddingLeft = indent(depth);
            const x = file.x || ' ';
            const y = file.y || ' ';
            const flags = file.flags || {};
            const kind = String(file.kind || '');
            const isIgnored = Boolean(file.ignored) || Boolean(flags.ignored) || kind === 'ignored';
            const isUntracked = Boolean(flags.untracked) || kind === 'untracked' || (x === '?' && y === '?');
            const isDeleted = !isUntracked && (x === 'D' || y === 'D');
            const isNewTracked = !isUntracked && (x === 'A' || y === 'A');
            const isModified = !isUntracked && !isNewTracked && !isDeleted && (
                x === 'M' || y === 'M' || x === 'R' || y === 'R' || x === 'C' || y === 'C'
                || kind === 'staged' || kind === 'unstaged' || kind === 'staged+unstaged' || kind === 'conflicted'
            );
            row.classList.toggle('is-untracked', isUntracked);
            row.classList.toggle('is-new', isNewTracked);
            row.classList.toggle('is-modified', isModified);
            row.classList.toggle('is-deleted', isDeleted);
            row.classList.toggle('is-conflicted', kind === 'conflicted' || Boolean(flags?.conflicted));
            row.classList.toggle('is-ignored', isIgnored);
            row.classList.add('has-file-menu');

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.fileSelect = 'true';
            checkbox.dataset.repoPath = repo.path;
            checkbox.dataset.filePath = file.path;
            checkbox.setAttribute('data-local-action', 'toggleTreeFileSelectionCheckbox');
            checkbox.checked = !isIgnored && Boolean(isFileSelected?.(repo.path, file.path));
            checkbox.disabled = isIgnored;

            const button = document.createElement('div');
            button.className = 'git-tree-file';
            button.setAttribute('role', 'button');
            button.setAttribute('tabindex', isIgnored ? '-1' : '0');
            if (!isIgnored) {
                button.setAttribute('data-local-action', 'openDiff');
            } else {
                button.setAttribute('aria-disabled', 'true');
            }
            button.dataset.repoPath = repo.path;
            button.dataset.filePath = file.path;
            button.textContent = file.name;

            row.appendChild(checkbox);
            row.appendChild(button);
            const menu = document.createElement('div');
            menu.className = 'git-file-menu';

            const menuButton = document.createElement('button');
            menuButton.type = 'button';
            menuButton.className = 'icon-button git-file-menu-button';
            menuButton.setAttribute('data-local-action', 'toggleFileMenu');
            menuButton.setAttribute('aria-label', 'File actions');
            menuButton.title = 'File actions';
            menuButton.textContent = '⋮';

            const menuList = document.createElement('div');
            menuList.className = 'git-file-menu-list';

            if (!isIgnored) {
                const ignoreItem = document.createElement('div');
                ignoreItem.className = 'git-file-menu-item';
                ignoreItem.setAttribute('role', 'menuitem');
                ignoreItem.setAttribute('tabindex', '0');
                ignoreItem.dataset.repoPath = repo.path;
                ignoreItem.dataset.filePath = file.path;
                ignoreItem.setAttribute('data-local-action', 'openIgnoreForFile');
                ignoreItem.textContent = 'Add to .gitignore';
                menuList.appendChild(ignoreItem);
            } else {
                const removeIgnoreItem = document.createElement('div');
                removeIgnoreItem.className = 'git-file-menu-item';
                removeIgnoreItem.setAttribute('role', 'menuitem');
                removeIgnoreItem.setAttribute('tabindex', '0');
                removeIgnoreItem.dataset.repoPath = repo.path;
                removeIgnoreItem.dataset.filePath = file.path;
                removeIgnoreItem.setAttribute('data-local-action', 'removeIgnoreForFile');
                removeIgnoreItem.textContent = 'Remove from .gitignore';
                menuList.appendChild(removeIgnoreItem);
            }

            const rollbackItem = document.createElement('div');
            rollbackItem.className = 'git-file-menu-item';
            rollbackItem.setAttribute('role', 'menuitem');
            rollbackItem.setAttribute('tabindex', '0');
            rollbackItem.dataset.repoPath = repo.path;
            rollbackItem.dataset.filePath = file.path;
            rollbackItem.setAttribute('data-local-action', 'rollbackFile');
            rollbackItem.textContent = 'Rollback changes';
            menuList.appendChild(rollbackItem);

            const deleteItem = document.createElement('div');
            deleteItem.className = 'git-file-menu-item';
            deleteItem.setAttribute('role', 'menuitem');
            deleteItem.setAttribute('tabindex', '0');
            deleteItem.dataset.repoPath = repo.path;
            deleteItem.dataset.filePath = file.path;
            deleteItem.setAttribute('data-local-action', 'deleteFile');
            deleteItem.textContent = 'Delete file';
            menuList.appendChild(deleteItem);
            menu.appendChild(menuButton);
            menu.appendChild(menuList);
            row.appendChild(menu);
            out.appendChild(row);
        }
        return out;
    };

    const tree = buildTree(rows);
    root.appendChild(renderNode(tree, Number.isFinite(initialDepth) ? initialDepth : 1, ''));
    return root;
}
