import { parseDetailedDirectoryListing, joinPath } from "/explorer/web-components/pages/file-exp/file-exp-utils.js";
import { parseJsonToolResult, isReposRootPath, normalizeErrorMessage, getVisibleRepoOverviews } from "./git-panel-utils.js";
import { getRepoScanPaths, getInternalReposRoot } from "/explorer/utils/reposRoot.js";
import {
    ensureSelectionEntry,
    peekSelectionEntry,
    isPathSelected,
    getCoveringPrefix as getCoveringPrefixFromEntry,
    getAncestorCoveringPrefix as getAncestorCoveringPrefixFromEntry,
    toggleFileSelection as toggleFileSelectionOnEntry,
    togglePrefixSelection as togglePrefixSelectionOnEntry
} from "./git-panel-selection.js";
import { formatRepoSummary, renderRepoChangesTree as renderRepoChangesTreeInternal } from "./git-panel-tree.js";
import { mergeRepoOverviewWithStatus } from './git-panel-status.js';

export function createGitCommitRepo(ctx) {
    const {
        element,
        state,
        service,
        statusCache,
        repoOverviewCache,
        setStatusLine,
        updateCommitButtons,
        clearSelectedDiff,
        refreshSelectedDiff
    } = ctx;

    const getRepoTreePresenter = () => element.querySelector('git-repo-tree')?.webSkelPresenter || null;
    const internalReposRoot = getInternalReposRoot({ rootHint: state.reposRoot });
    const repoStatusCache = new Map();
    const repoStatusPromises = new Map();

    const replaceRepoOverview = (repoPath, updater) => {
        const updateList = (list) => (Array.isArray(list) ? list : []).map((repo) => {
            if (!repo || repo.path !== repoPath) return repo;
            return updater(repo);
        });
        state.repoOverviews = updateList(state.repoOverviews);
        if (Array.isArray(repoOverviewCache.list)) {
            repoOverviewCache.list = updateList(repoOverviewCache.list);
        }
        renderRepoOverviews(state.repoOverviews);
    };

    const loadRepoStatus = async (repoPath, { force = false } = {}) => {
        if (!repoPath) return null;
        if (!force && repoStatusCache.has(repoPath)) {
            const cached = repoStatusCache.get(repoPath);
            replaceRepoOverview(repoPath, (repo) => mergeRepoOverviewWithStatus(repo, cached));
            return cached;
        }
        if (repoStatusPromises.has(repoPath)) {
            return repoStatusPromises.get(repoPath);
        }

        replaceRepoOverview(repoPath, (repo) => ({
            ...repo,
            changesLoading: true,
            changesError: null
        }));
        const pending = (async () => {
            try {
                const payload = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
                if (payload.ok === false) {
                    throw new Error(String(payload.message || payload.error || 'Unable to load repository changes.'));
                }
                repoStatusCache.set(repoPath, payload);
                replaceRepoOverview(repoPath, (repo) => mergeRepoOverviewWithStatus(repo, payload));
                return payload;
            } catch (error) {
                replaceRepoOverview(repoPath, (repo) => ({
                    ...repo,
                    changesLoading: false,
                    changesLoaded: false,
                    changesError: normalizeErrorMessage(error)
                }));
                return null;
            } finally {
                repoStatusPromises.delete(repoPath);
            }
        })();
        repoStatusPromises.set(repoPath, pending);
        return pending;
    };

    const loadExpandedRepoStatuses = async ({ force = false } = {}) => {
        const repoPaths = (Array.isArray(state.repoOverviews) ? state.repoOverviews : [])
            .filter((repo) => {
                if (!repo?.path) return false;
                const counts = repo.counts || {};
                const dirty = Boolean(repo.dirty || repo.statusUnavailable || counts.staged || counts.unstaged || counts.untracked || counts.conflicted);
                return dirty && state.repoChangesExpanded?.[repo.path] !== false;
            })
            .map((repo) => repo.path);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < repoPaths.length) {
                const repoPath = repoPaths[nextIndex];
                nextIndex += 1;
                await loadRepoStatus(repoPath, { force });
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, repoPaths.length) }, () => worker()));
    };

    const mergeRepoResults = (collections = []) => {
        const merged = [];
        const seenPaths = new Set();
        for (const collection of collections) {
            for (const repo of Array.isArray(collection) ? collection : []) {
                const repoPath = String(repo?.path || '').trim();
                if (!repoPath || seenPaths.has(repoPath)) continue;
                seenPaths.add(repoPath);
                const relativePath = String(repo?.relativePath || repo?.name || '').replace(/^\/+/, '');
                const nextRelativePath = repoPath.startsWith(`${internalReposRoot}/`)
                    ? `.ploinky/repos/${relativePath || repoPath.slice(internalReposRoot.length + 1)}`
                    : relativePath;
                merged.push({
                    ...repo,
                    relativePath: nextRelativePath || relativePath
                });
            }
        }
        return merged.sort((a, b) => {
            const left = String(a?.relativePath || a?.name || a?.path || '');
            const right = String(b?.relativePath || b?.name || b?.path || '');
            return left.localeCompare(right, undefined, { sensitivity: 'base' });
        });
    };

    const getSelectedFilesEntry = (repoPath) => {
        if (!repoPath) return null;
        const store = state.selectedFilesByRepo || {};
        const entry = ensureSelectionEntry(store, repoPath);
        state.selectedFilesByRepo = store;
        return entry;
    };

    const peekSelectedFilesEntry = (repoPath) => peekSelectionEntry(state.selectedFilesByRepo, repoPath);

    const isFileSelected = (repoPath, filePath) => {
        const entry = peekSelectionEntry(state.selectedFilesByRepo, repoPath);
        return isPathSelected(entry, filePath);
    };

    const toggleFileSelection = (repoPath, filePath, section, isSelected) => {
        if (!repoPath || !filePath) return;
        const entry = getSelectedFilesEntry(repoPath);
        if (!entry) return;
        toggleFileSelectionOnEntry(entry, filePath, section, isSelected);
        updateCommitButtons();
        renderRepoOverviews(state.repoOverviews);
    };

    const getCoveringPrefix = (repoPath, relativePath) => {
        const entry = peekSelectionEntry(state.selectedFilesByRepo, repoPath);
        return getCoveringPrefixFromEntry(entry, relativePath);
    };

    const getAncestorCoveringPrefix = (repoPath, prefix) => {
        const entry = peekSelectionEntry(state.selectedFilesByRepo, repoPath);
        return getAncestorCoveringPrefixFromEntry(entry, prefix);
    };

    const togglePrefixSelection = (repoPath, prefix, isSelected) => {
        if (!repoPath) return;
        const entry = getSelectedFilesEntry(repoPath);
        if (!entry) return;
        togglePrefixSelectionOnEntry(entry, prefix, isSelected);
        updateCommitButtons();
        renderRepoOverviews(state.repoOverviews);
    };

    const toggleMultipleReposAllChanges = (repoPaths, isSelected) => {
        const list = Array.isArray(repoPaths) ? repoPaths.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
        if (!list.length) return;
        for (const repoPath of list) {
            const entry = getSelectedFilesEntry(repoPath);
            if (!entry) continue;
            if (isSelected) {
                togglePrefixSelectionOnEntry(entry, '*', true);
                continue;
            }
            entry.files?.clear?.();
            entry.sectionsByFile?.clear?.();
            entry.prefixes?.clear?.();
            entry.excludedFiles?.clear?.();
        }
        updateCommitButtons();
        renderRepoOverviews(state.repoOverviews);
    };

    const toggleFolderExpanded = (folderId) => {
        if (!folderId) return;
        const expanded = { ...(state.repoTreeExpanded || {}) };
        expanded[folderId] = expanded[folderId] === true ? false : true;
        state.repoTreeExpanded = expanded;
        renderRepoOverviews(state.repoOverviews);
    };

    const toggleRepoChanges = (elementNode) => {
        const repoPath = elementNode?.dataset?.repoPath;
        if (!repoPath) return;
        const expanded = { ...(state.repoChangesExpanded || {}) };
        const current = isRepoChangesExpanded(repoPath);
        expanded[repoPath] = !current;
        state.repoChangesExpanded = expanded;
        renderRepoOverviews(state.repoOverviews);
        if (!current) {
            void loadRepoStatus(repoPath);
        }
    };

    const isRepoChangesExpanded = (repoPath) => {
        if (!repoPath) return true;
        const current = state.repoChangesExpanded?.[repoPath];
        if (current !== undefined) {
            return Boolean(current);
        }
        const repo = (Array.isArray(state.repoOverviews) ? state.repoOverviews : []).find((entry) => entry?.path === repoPath);
        const counts = repo?.counts || {};
        return Boolean(repo?.dirty || counts.staged || counts.unstaged || counts.untracked || counts.conflicted);
    };

    const toggleTreeFolder = (elementNode) => {
        const repoPath = elementNode?.dataset?.repoPath;
        const prefix = elementNode?.dataset?.prefix;
        if (!repoPath || !prefix) return;
        const key = `${repoPath}::${prefix}`;
        const expanded = { ...(state.treeExpandedByRepo || {}) };
        const current = isTreeFolderExpanded(repoPath, prefix);
        const isExpandedInUi = String(elementNode?.textContent || '').includes('▾');
        expanded[key] = current === undefined ? !isExpandedInUi : !current;
        state.treeExpandedByRepo = expanded;
        renderRepoOverviews(state.repoOverviews);
    };

    const isTreeFolderExpanded = (repoPath, prefix) => {
        if (!repoPath || !prefix) return true;
        const key = `${repoPath}::${prefix}`;
        const current = state.treeExpandedByRepo?.[key];
        return current === undefined ? undefined : Boolean(current);
    };

    const getDisplayedRepoOverviews = () => {
        const repos = getVisibleRepoOverviews(state.repoOverviews, state.showAgentRepos);
        const filtered = repos.filter((repo) => {
            if (!repo) return false;
            const counts = repo.counts || {};
            const ignoredCount = Number.isFinite(repo.ignoredCount)
                ? repo.ignoredCount
                : (Array.isArray(repo.ignored) ? repo.ignored.length : 0);
            return Boolean(
                repo.dirty
                || repo.statusUnavailable
                || counts.staged
                || counts.unstaged
                || counts.untracked
                || counts.conflicted
                || ignoredCount
            );
        });
        return filtered.length ? filtered : repos;
    };

    const buildRepoTree = () => {
        const root = { id: '/', name: state.reposRoot, children: new Map(), repos: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } };
        const repos = getDisplayedRepoOverviews();

        const addCounts = (target, counts) => {
            const c = counts || {};
            target.counts.staged += c.staged || 0;
            target.counts.unstaged += c.unstaged || 0;
            target.counts.untracked += c.untracked || 0;
            target.counts.conflicted += c.conflicted || 0;
        };

        for (const repo of repos) {
            const rel = String(repo.relativePath || repo.name || '').replace(/^\/+/, '');
            const parts = rel.split('/').filter(Boolean);
            let node = root;
            for (let i = 0; i < Math.max(0, parts.length - 1); i += 1) {
                const part = parts[i];
                const nextId = node.id === '/' ? part : `${node.id}/${part}`;
                if (!node.children.has(part)) {
                    node.children.set(part, { id: nextId, name: part, children: new Map(), repos: [], counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } });
                }
                node = node.children.get(part);
                addCounts(node, repo.counts);
            }
            node.repos.push(repo);
            addCounts(node, repo.counts);
            addCounts(root, repo.counts);
        }
        return root;
    };

    const applyDefaultRepoTreeExpansion = () => {
        const repos = getDisplayedRepoOverviews();
        const expanded = { '/': true };
        const repoChangesExpanded = { ...(state.repoChangesExpanded || {}) };
        for (const repo of repos) {
            const counts = repo?.counts || {};
            const isDirty = Boolean(repo?.dirty || repo?.statusUnavailable || counts.staged || counts.unstaged || counts.untracked || counts.conflicted);
            if (!isDirty) continue;
            repoChangesExpanded[repo.path] = true;
            const rel = String(repo.relativePath || repo.name || '').replace(/^\/+/, '');
            const parts = rel.split('/').filter(Boolean);
            let current = '';
            for (let i = 0; i < Math.max(0, parts.length - 1); i += 1) {
                current = current ? `${current}/${parts[i]}` : parts[i];
                expanded[current] = true;
            }
        }
        state.repoTreeExpanded = expanded;
        state.repoChangesExpanded = repoChangesExpanded;
    };

    const renderRepoChangesTree = (repo) => renderRepoChangesTreeInternal(repo, {
        isFileSelected: (repoPath, filePath) => isFileSelected(repoPath, filePath),
        getAncestorCoveringPrefix: (repoPath, prefix) => getAncestorCoveringPrefix(repoPath, prefix),
        getCoveringPrefix: (repoPath, prefix) => getCoveringPrefix(repoPath, prefix),
        isFolderExpanded: (repoPath, prefix) => isTreeFolderExpanded(repoPath, prefix)
    });

    const renderRepoOverviews = (overviews) => {
        const presenter = getRepoTreePresenter();
        if (!presenter?.setState) return;
        const visibleOverviews = getVisibleRepoOverviews(overviews, state.showAgentRepos);
        presenter.setState({
            reposRoot: state.reposRoot || '',
            repos: visibleOverviews,
            loading: Boolean(state.repoOverviewsLoading && !state.suppressInlineLoading),
            repoTreeExpanded: state.repoTreeExpanded || {},
            repoChangesExpanded: state.repoChangesExpanded || {},
            treeExpandedByRepo: state.treeExpandedByRepo || {},
            selectionState: state.selectedFilesByRepo || {},
            selectedPath: state.selectedPath || '',
            selectedRepoPath: state.selectedRepoPath || state.repoPath || ''
        });
    };

    const loadRepoOverviews = async ({ force = false } = {}) => {
        const now = Date.now();
        if (force) {
            repoStatusCache.clear();
        }
        if (!force && repoOverviewCache.list && now - repoOverviewCache.at < 1500) {
            state.repoOverviews = repoOverviewCache.list;
            state.repoOverviewsLoaded = true;
            renderRepoOverviews(state.repoOverviews);
            return state.repoOverviews;
        }
        if (state.repoOverviewsLoading) {
            return repoOverviewCache.promise || state.repoOverviews;
        }
        state.repoOverviewsLoading = true;
        renderRepoOverviews([]);
        const pending = (async () => {
            try {
                const resultSets = [];
                const scanPaths = getRepoScanPaths({ rootHint: state.reposRoot });
                for (const scanPath of scanPaths) {
                    if (!scanPath) continue;
                    try {
                        const payload = parseJsonToolResult(await service.gitReposOverview(scanPath)) || {};
                        const results = Array.isArray(payload.repos) ? payload.repos : [];
                        if (results.length) {
                            resultSets.push(results);
                        }
                    } catch {
                        // try next path
                    }
                }
                const hintMap = state.ignoreHints || {};
                const merged = mergeRepoResults(resultSets).map((repo) => {
                    const hints = Array.isArray(hintMap[repo?.path]) ? hintMap[repo.path] : [];
                    return hints.length ? { ...repo, ignoredHints: hints } : repo;
                });
                state.repoOverviews = merged;
                state.repoOverviewsLoaded = true;
                repoOverviewCache.at = now;
                repoOverviewCache.list = merged;
                applyDefaultRepoTreeExpansion();
                renderRepoOverviews(merged);
                void loadExpandedRepoStatuses({ force });
                return merged;
            } catch (error) {
                try {
                    const fallbackCollections = [];
                    const scanPaths = getRepoScanPaths({ rootHint: state.reposRoot, includeWorkspaceFallback: false });
                    for (const scanPath of scanPaths) {
                        const listingText = await service.listDirectoryDetailed(scanPath);
                        const entries = parseDetailedDirectoryListing(listingText);
                        const listed = (entries || [])
                            .filter((entry) => entry && entry.type === 'directory' && entry.name && !String(entry.name).startsWith('.'))
                            .map((entry) => ({
                                name: entry.name,
                                path: joinPath(scanPath, entry.name),
                                relativePath: joinPath(scanPath === internalReposRoot ? '.ploinky/repos' : '', entry.name).replace(/^\/+/, ''),
                                ok: true,
                                branch: null,
                                counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
                                sample: { staged: [], unstaged: [], untracked: [], conflicted: [] }
                            }));
                        fallbackCollections.push(listed);
                    }
                    const results = mergeRepoResults(fallbackCollections);
                    state.repoOverviews = results;
                    state.repoOverviewsLoaded = true;
                    repoOverviewCache.at = now;
                    repoOverviewCache.list = results;
                    applyDefaultRepoTreeExpansion();
                    renderRepoOverviews(results);
                    setStatusLine(`Loaded repositories list (status unavailable): ${normalizeErrorMessage(error)}`, true);
                    return results;
                } catch (fallbackError) {
                    state.repoOverviews = [];
                    state.repoOverviewsLoaded = true;
                    renderRepoOverviews([]);
                    setStatusLine(normalizeErrorMessage(fallbackError) || normalizeErrorMessage(error), true);
                    return state.repoOverviews;
                }
            } finally {
                state.repoOverviewsLoading = false;
                renderRepoOverviews(state.repoOverviews);
                repoOverviewCache.promise = null;
            }
        })();
        repoOverviewCache.promise = pending;
        return pending;
    };

    const applyRepoInfo = (info) => {
        state.branch = info.branch || null;
        state.upstream = info.upstream || null;
        state.remotes = Array.isArray(info.remotes) ? info.remotes : [];
        state.repoInfoOk = info && typeof info.ok === 'boolean' ? info.ok : null;
        const branchInfo = element.querySelector('#gitBranchInfo');
        if (branchInfo) {
            if (info && info.ok === false) {
                branchInfo.textContent = 'Not a git repository. Choose a repo path that contains a .git folder.';
                return;
            }
            const bits = [];
            if (state.branch) bits.push(`Branch: ${state.branch}`);
            if (state.upstream) bits.push(`Upstream: ${state.upstream}`);
            branchInfo.textContent = bits.length ? bits.join(' · ') : 'Not a git repository.';
        }
    };

    const loadRepoInfo = async ({ force = false } = {}) => {
        const cached = statusCache.payload?.repoInfo;
        if (!force && cached) {
            applyRepoInfo(cached);
            return cached;
        }
        const text = await service.gitInfo(state.repoPath);
        const payload = parseJsonToolResult(text) || {};
        statusCache.at = statusCache.at || 0;
        statusCache.payload = {
            ...(statusCache.payload || {}),
            repoInfo: payload
        };
        applyRepoInfo(payload);
        return payload;
    };

    const refreshAll = async ({ force = false, keepStatus = false } = {}) => {
        const shouldSetStatus = !keepStatus;
        if (shouldSetStatus) {
            setStatusLine('Loading git status…');
        }
        try {
            await loadRepoOverviews({ force });
            await reconcileSelectedDiffWithChanges();

            const unpushedRepos = (state.repoOverviews || []).filter((repo) => {
                const ahead = Number(repo?.ahead) || 0;
                return ahead > 0;
            });

            if (unpushedRepos.length > 0 && shouldSetStatus) {
                const unpushedCount = unpushedRepos.length;
                const totalUnpushed = unpushedRepos.reduce((sum, repo) => sum + (Number(repo?.ahead) || 0), 0);
                setStatusLine(`${unpushedCount} repo(s) have ${totalUnpushed} unpushed commit(s).`);
            }

            if (isReposRootPath(state.repoPath, state.reposRoot)) {
                state.repoInfoOk = false;
                state.branch = null;
                state.upstream = null;
                state.remotes = [];
                state.selectedRepoPath = null;
                updateCommitButtons();

                if (shouldSetStatus && unpushedRepos.length === 0) {
                    setStatusLine('Select a repository from the list.');
                }
                return;
            }

            const repoInfo = await loadRepoInfo({ force });
            if (repoInfo && repoInfo.ok === false) {
                updateCommitButtons();
                if (shouldSetStatus && unpushedRepos.length === 0) {
                    setStatusLine('Select a repository from the list.');
                }
                return;
            }
            await reconcileSelectedDiffWithChanges();
            updateCommitButtons();
            if (shouldSetStatus && unpushedRepos.length === 0) {
                setStatusLine('Ready.');
            }
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
    };

    const getAllChangedPathsForRepo = (repoPath) => {
        const repo = (state.repoOverviews || []).find((r) => r?.path === repoPath) || null;
        const rows = Array.isArray(repo?.changesAll) ? repo.changesAll : [];
        return rows.map((r) => (typeof r === 'string' ? r : String(r?.path || ''))).filter(Boolean);
    };

    const isCommittableChangeRow = (row) => {
        if (!row || typeof row === 'string') return true;
        const flags = row.flags || {};
        if (flags.ignored && !flags.staged && !flags.unstaged && !flags.untracked && !flags.conflicted) return false;
        return Boolean(flags.staged || flags.unstaged || flags.untracked || flags.conflicted);
    };

    const getCommittablePathsForRepo = (repoPath) => {
        const repo = (state.repoOverviews || []).find((r) => r?.path === repoPath) || null;
        const rows = Array.isArray(repo?.changesAll) ? repo.changesAll : [];
        return rows
            .filter((row) => isCommittableChangeRow(row))
            .map((row) => (typeof row === 'string' ? row : String(row?.path || '')))
            .filter(Boolean);
    };

    const reconcileSelectedDiffWithChanges = async () => {
        const filePath = state.selectedPath;
        if (!filePath) return false;

        const repoPath = state.selectedRepoPath || state.repoPath;
        if (!repoPath || isReposRootPath(repoPath, state.reposRoot)) {
            clearSelectedDiff();
            return false;
        }

        const changed = getAllChangedPathsForRepo(repoPath);
        if (!changed.includes(filePath)) {
            clearSelectedDiff();
            return false;
        }
        await refreshSelectedDiff?.();
        return true;
    };

    const getPathsForCommitInRepo = (repoPath) => {
        const changed = getCommittablePathsForRepo(repoPath);
        const changedSet = new Set(changed);
        const entry = state.selectedFilesByRepo?.[repoPath] || null;
        const out = new Set();
        for (const file of entry?.files || []) {
            if (changedSet.has(file)) out.add(file);
        }
        const prefixes = Array.from(entry?.prefixes || []);
        for (const prefix of prefixes) {
            if (prefix === '*') {
                for (const p of changed) out.add(p);
                continue;
            }
            for (const p of changed) {
                if (p.startsWith(prefix)) out.add(p);
            }
        }
        if (entry?.excludedFiles?.size) {
            for (const filePath of entry.excludedFiles) {
                out.delete(filePath);
            }
        }
        return Array.from(out);
    };

    return {
        refreshAll,
        loadRepoInfo,
        applyRepoInfo,
        loadRepoOverviews,
        applyDefaultRepoTreeExpansion,
        renderRepoOverviews,
        renderRepoChangesTree,
        formatRepoSummary,
        getDisplayedRepoOverviews,
        buildRepoTree,
        toggleFolderExpanded,
        toggleRepoChanges,
        isRepoChangesExpanded,
        toggleTreeFolder,
        isTreeFolderExpanded,
        getSelectedFilesEntry,
        peekSelectedFilesEntry,
        isFileSelected,
        toggleFileSelection,
        getCoveringPrefix,
        getAncestorCoveringPrefix,
        togglePrefixSelection,
        toggleMultipleReposAllChanges,
        getAllChangedPathsForRepo,
        getCommittablePathsForRepo,
        reconcileSelectedDiffWithChanges,
        getPathsForCommitInRepo
    };
}
