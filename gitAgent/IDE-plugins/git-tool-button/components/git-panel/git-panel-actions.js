import {
    normalizeErrorMessage,
    parseJsonToolResult,
    getConflictAutoresolveSetting,
    normalizeGitStatusPayload
} from "./git-panel-utils.js";
import { restoreStashFlow } from "../../utils/git-auto-stash-flow.js";
import { createCredentialsActions } from "./git-panel-actions-credentials.js";
import { createCommitMessageActions } from "./git-panel-actions-commit-message.js";
import { createConflictActions } from "./git-panel-actions-conflicts.js";
import { createGitOpsActions } from "./git-panel-actions-gitops.js";
import { createStashActions } from "./git-panel-actions-stash.js";
import { createRepoActions } from "./git-panel-actions-repo.js";
import { createAutoStashActions } from "./git-panel-actions-autostash.js";
import { createBranchActions } from "./git-panel-actions-branches.js";
import { AUTOCOMMIT_STOP_EVENT, AUTOCOMMIT_RESET_EVENT } from "/explorer/utils/appEvents.js";

export function createGitCommitActions(ctx) {
    const {
        getState,
        setState,
        setStateIn,
        service,
        setStatusLine,
        updateCommitButtons,
        syncStaticUI,
        updateIdentityPrompt,
        updateAuthPrompt,
        closeActionsMenu,
        getSelectedReposForBatch,
        getPathsForCommitInRepo,
        setCommitMessage,
        setCommitMessageBusy,
        withPanelLoader,
        clearCommitMessageInput,
        clearDiffCache,
        loadRepoInfo,
        loadRepoOverviews,
        refreshAll,
        refreshAfterGitOperation
    } = ctx;

    const applyState = (patch = {}, options = {}) => {
        if (typeof setState === 'function') {
            setState(patch, options);
            return;
        }
        Object.assign(getState(), patch);
        if (!options.silent && typeof syncStaticUI === 'function') {
            syncStaticUI();
        }
    };

    const applyStateIn = (path, value, options = {}) => {
        if (typeof setStateIn === 'function') {
            setStateIn(path, value, options);
            return;
        }
        const state = getState();
        const targetPath = Array.isArray(path) ? path : [];
        let cursor = state;
        for (let i = 0; i < targetPath.length - 1; i += 1) {
            const key = targetPath[i];
            if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
            cursor = cursor[key];
        }
        if (targetPath.length) {
            cursor[targetPath[targetPath.length - 1]] = value;
        }
        if (!options.silent && typeof syncStaticUI === 'function') {
            syncStaticUI();
        }
    };

    let commitSelectedRepos;
    let syncSelectedRepos;
    let pullRepos;
    let pullSelectedRepos;
    let pushRepos;
    let pushSelectedRepos;
    let push;
    let commit;
    let runGitAction;
    let gitPushWithToken;
    let gitPullWithToken;

    const dispatchAutocommitStop = (message = '') => {
        window.dispatchEvent(new CustomEvent(AUTOCOMMIT_STOP_EVENT, {
            detail: { message: message || '' }
        }));
    };

    const dispatchAutocommitReset = () => {
        window.dispatchEvent(new CustomEvent(AUTOCOMMIT_RESET_EVENT));
    };

    const commitMessageActions = createCommitMessageActions({
        service,
        setStatusLine,
        setCommitMessage,
        setCommitMessageBusy,
        updateCommitButtons,
        getSelectedReposForBatch,
        getPathsForCommitInRepo
    });
    const {
        generateCommitMessageForSelections,
        promptForFallbackCommitMessage,
        generateCommitMessage
    } = commitMessageActions;

    const credentialsActions = createCredentialsActions({
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        updateIdentityPrompt,
        updateAuthPrompt,
        refreshAll,
        pullRepos: (...args) => pullRepos?.(...args),
        pullSelectedRepos: (...args) => pullSelectedRepos?.(...args),
        push: (...args) => push?.(...args),
        pushRepos: (...args) => pushRepos?.(...args),
        commitSelectedRepos: (...args) => commitSelectedRepos?.(...args),
        syncSelectedRepos: (...args) => syncSelectedRepos?.(...args),
        getSelectedReposForBatch,
        getExplicitActionRepoPaths: ctx.getExplicitActionRepoPaths,
        getPrimaryExplicitActionRepoPath: ctx.getPrimaryExplicitActionRepoPath
    });
    const {
        showGitAuthPrompt,
        openGitTokenPrompt,
        openGitIdentityPrompt,
        cancelGitToken,
        cancelGitIdentity,
        cancelGitCredentials,
        clearGitCredentials,
        saveGitToken,
        saveGitCredentials,
        ensureGitIdentityOrPrompt,
        saveGitIdentity
    } = credentialsActions;

    const coerceCount = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return null;
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    };

    const extractAheadCount = (payload) => {
        if (!payload || typeof payload !== 'object') return null;
        const candidates = [
            payload.ahead,
            payload.aheadCount,
            payload.ahead_by,
            payload.aheadBy,
            payload.status?.ahead,
            payload.status?.aheadCount,
            payload.status?.ahead_by,
            payload.status?.aheadBy,
            payload.branch?.ahead,
            payload.branch?.aheadCount,
            payload.tracking?.ahead,
            payload.tracking?.aheadCount,
            payload.tracking?.ahead_by,
            payload.tracking?.aheadBy
        ];
        for (const candidate of candidates) {
            const value = coerceCount(candidate);
            if (value !== null) return value;
        }
        return null;
    };

    const getAheadCountForRepo = async (repoPath) => {
        if (!repoPath) return null;
        let info = null;
        try {
            const state = getState();
            if (loadRepoInfo && repoPath === state.repoPath) {
                info = await loadRepoInfo({ force: true });
            } else {
                const text = await service.gitInfo(repoPath);
                info = parseJsonToolResult(text) || {};
            }
        } catch (_) {
            info = null;
        }
        const fromInfo = extractAheadCount(info);
        if (fromInfo !== null) return fromInfo;
        try {
            const statusText = await service.gitStatus(repoPath, { includeAhead: true });
            const statusPayload = parseJsonToolResult(statusText) || {};
            return extractAheadCount(statusPayload);
        } catch (_) {
            return null;
        }
    };

    const collectConflictedItems = (repoPaths) => {
        const targets = Array.isArray(repoPaths) && repoPaths.length ? new Set(repoPaths) : null;
        const repos = Array.isArray(getState().repoOverviews) ? getState().repoOverviews : [];
        const out = [];
        for (const repo of repos) {
            if (!repo?.path) continue;
            if (targets && !targets.has(repo.path)) continue;
            const conflicted = Array.isArray(repo?.changes?.conflicted) ? repo.changes.conflicted : [];
            for (const filePath of conflicted) {
                if (!filePath) continue;
                out.push({ repoPath: repo.path, filePath });
            }
        }
        return out;
    };

    const hasConflictsForRepos = (repoPaths) => collectConflictedItems(repoPaths).length > 0;

    const clearPullBlockedState = () => {
        const state = getState();
        if (!state.pullBlocked) return;
        applyState({ pullBlocked: null });
    };

    const extractConflictPaths = (statusPayload) => {
        return normalizeGitStatusPayload(statusPayload).paths.conflicted;
    };

    const joinPath = (base, relative) => {
        const left = String(base || '').replace(/\/+$/, '');
        const right = String(relative || '').replace(/^\/+/, '');
        if (!left) return right;
        if (!right) return left;
        return `${left}/${right}`;
    };

    const extractResolvedContent = (payload) => {
        if (!payload) return '';
        if (typeof payload === 'string') return payload;
        if (typeof payload.content === 'string') return payload.content;
        if (typeof payload.resolved === 'string') return payload.resolved;
        if (typeof payload.result === 'string') return payload.result;
        if (typeof payload.merged === 'string') return payload.merged;
        if (typeof payload.output === 'string') return payload.output;
        if (typeof payload.resolution === 'string') return payload.resolution;
        return '';
    };

    const isAutoresolveEnabled = () => {
        const state = getState();
        if (state.autoresolveDirty) {
            return Boolean(state.autoresolveDraft?.enabled);
        }
        return getConflictAutoresolveSetting();
    };

    const autoResolveConflicts = async (repoPaths, source = 'merge') => {
        if (!isAutoresolveEnabled()) return { ok: false, errorMessage: '' };
        const list = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        if (!list.length) return { ok: false, errorMessage: '' };
        setStatusLine('Auto-resolving conflicts...');
        try {
            for (const repoPath of list) {
                const statusPayload = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
                const status = statusPayload?.status || statusPayload || {};
                const conflictPaths = extractConflictPaths(status);
                if (!conflictPaths.length) continue;
                for (const filePath of conflictPaths) {
                    const versionsText = await service.gitConflictVersions({ path: repoPath, file: filePath });
                    const versions = parseJsonToolResult(versionsText) || {};
                    const localSide = (source === 'rebase' || source === 'stash') ? 'theirs' : 'ours';
                    const oursContent = localSide === 'ours' ? (versions.ours || '') : (versions.theirs || '');
                    const theirsContent = localSide === 'ours' ? (versions.theirs || '') : (versions.ours || '');
                    const resolveText = await service.llmResolveConflict({
                        base: versions.base || '',
                        ours: oursContent,
                        theirs: theirsContent,
                        source
                    });
                    const resolvePayload = parseJsonToolResult(resolveText) || resolveText;
                    const resolved = extractResolvedContent(resolvePayload);
                    if (!resolved) {
                        throw new Error('LLM returned empty conflict resolution.');
                    }
                    const absoluteFile = joinPath(repoPath, filePath);
                    await service.writeFile(absoluteFile, resolved);
                    await service.gitStage(repoPath, [filePath]);
                }
                const afterPayload = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
                const afterStatus = afterPayload?.status || afterPayload || {};
                updateRepoOverviewFromStatus(repoPath, afterPayload);
                if (extractConflictPaths(afterStatus).length) {
                    return { ok: false, errorMessage: '' };
                }
            }
            await loadManualConflicts(repoPaths);
            setStatusLine('Conflicts auto-resolved.');
            return { ok: true, errorMessage: '' };
        } catch (error) {
            const msg = normalizeErrorMessage(error);
            if (msg.toLowerCase().includes('git_resolve_conflict') && msg.toLowerCase().includes('not found')) {
                return { ok: false, errorMessage: 'Autoresolve unavailable: git_resolve_conflict tool not found.' };
            }
            return { ok: false, errorMessage: msg };
        }
    };

    const handlePullConflicts = async (message, repoPaths = null, source = 'merge', seededConflicts = null) => {
        const autoResult = await autoResolveConflicts(repoPaths, source);
        if (autoResult.ok) {
            await loadRepoOverviews({ force: true });
            syncStaticUI();
            updateCommitButtons();
            return true;
        }
        await loadManualConflicts(repoPaths);
        let manualConflicts = Array.isArray(getState().manualConflicts) ? getState().manualConflicts : [];
        if (!manualConflicts.length && Array.isArray(seededConflicts) && seededConflicts.length) {
            manualConflicts = seededConflicts
                .filter((entry) => entry?.repoPath && entry?.filePath)
                .map((entry) => ({ repoPath: entry.repoPath, filePath: entry.filePath }));
            applyState({ manualConflicts }, { silent: true });
        }
        await loadRepoOverviews({ force: true });
        const repoConflicts = collectConflictedItems(repoPaths);
        const effectiveConflicts = manualConflicts.length ? manualConflicts : repoConflicts;
        if (!manualConflicts.length && repoConflicts.length) {
            applyState({ manualConflicts: repoConflicts }, { silent: true });
            manualConflicts = repoConflicts;
        }
        const firstConflict = effectiveConflicts[0] || null;
        const hasResolvableConflicts = effectiveConflicts.length > 0;
        applyState({
            conflictSource: source,
            conflictFocus: hasResolvableConflicts,
            selectedRepoPath: firstConflict?.repoPath || getState().selectedRepoPath || null
        }, { silent: true });
        syncStaticUI();
        if (hasResolvableConflicts && firstConflict && typeof selectConflictFile === 'function') {
            await selectConflictFile(firstConflict);
        }
        updateCommitButtons();
        const fallbackMessage = autoResult.errorMessage || message || 'Merge conflicts detected. Resolve them before continuing.';
        setStatusLine(fallbackMessage, true);
        return false;
    };

    const restoreStash = async (repoPath, stashRef) => {
        const restored = await restoreStashFlow({
            service,
            repoPath,
            stashRef,
            setStatusLine,
            onConflicts: async ({ seededConflicts }) => {
                const resolved = await handlePullConflicts(
                    'Conflicts after restoring stashed changes. Resolve them before continuing.',
                    [repoPath],
                    'stash',
                    seededConflicts
                );
                if (!resolved) {
                    const detectedConflicts = collectConflictedItems([repoPath]);
                    if (!seededConflicts.length && !detectedConflicts.length) {
                        setStatusLine(
                            'Stash restore did not finish cleanly, but no conflicted files were detected for the resolver. Refresh the repository and inspect its Git status.',
                            true
                        );
                    }
                }
                return resolved;
            }
        });
        if (!restored.ok && !restored.conflicts && restored.message) {
            setStatusLine(restored.message, true);
        }
        return restored;
    };

    const encodeBase64 = (value) => {
        const raw = String(value ?? '');
        try {
            return btoa(unescape(encodeURIComponent(raw)));
        } catch {
            try {
                return btoa(raw);
            } catch {
                return '';
            }
        }
    };

    const getRepoLabel = (repoPath) => {
        if (!repoPath) return '';
        const state = getState();
        const repo = Array.isArray(state.repoOverviews)
            ? state.repoOverviews.find((entry) => entry?.path === repoPath)
            : null;
        return repo?.name || repoPath.split('/').filter(Boolean).slice(-1)[0] || repoPath;
    };

    const selectStashRef = async (repoPath) => {
        try {
            const text = await service.gitStashList({ path: repoPath });
            const payload = parseJsonToolResult(text) || {};
            const entries = Array.isArray(payload.entries) ? payload.entries : [];
            if (!entries.length) {
                setStatusLine('No stash entries found to restore.', true);
                return { ok: false, canceled: false };
            }
            if (entries.length === 1) {
                return { ok: true, ref: entries[0]?.ref || null };
            }
            const repoLabel = getRepoLabel(repoPath);
            const stashes = encodeBase64(JSON.stringify(entries));
            const selection = await assistOS.UI.showModal("git-stash-select-modal", {
                repoPath,
                repoLabel,
                stashes
            }, true);
            const ref = selection?.ref || null;
            if (!ref) {
                return { ok: false, canceled: true };
            }
            return { ok: true, ref };
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
            return { ok: false, canceled: false };
        }
    };



    const repoActions = createRepoActions({
        getState,
        applyState,
        service
    });
    const {
        updateRepoOverviewFromStatus,
        loadManualConflicts
    } = repoActions;

    const stashActions = createStashActions({
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        loadRepoOverviews,
        refreshAll,
        selectStashRef,
        restoreStash,
        getSelectedReposForBatch,
        withPanelLoader
    });
    const { stashSelectedRepos, unstashSelectedRepos } = stashActions;

    const autoStashActions = createAutoStashActions({
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        syncStaticUI,
        loadRepoOverviews,
        handlePullConflicts,
        ensureGitIdentityOrPrompt,
        showGitAuthPrompt,
        gitPullWithToken: (...args) => gitPullWithToken?.(...args),
        restoreStash,
        hasConflictsForRepos,
        collectConflictedItems
    });
    const { pullWithAutoStash, maybeRestoreAutoStash } = autoStashActions;

    const branchActions = createBranchActions({
        service,
        setStatusLine,
        refreshAfterGitOperation,
        handlePullConflicts,
        restoreStash,
        applyState,
        withPanelLoader
    });
    const {
        checkoutBranchFromRepoRow,
        createBranchFromRepoRow,
        mergeBranchFromRepoRow
    } = branchActions;

    const conflictActions = createConflictActions({
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        syncStaticUI,
        refreshAll,
        loadRepoOverviews,
        collectConflictedItems,
        hasConflictsForRepos,
        handlePullConflicts,
        maybeRestoreAutoStash,
        updateRepoOverviewFromStatus
    });
    const {
        selectConflictFile,
        applyConflictChoice,
        saveConflictResolution,
        refreshConflicts
    } = conflictActions;

    const gitOpsActions = createGitOpsActions({
        getState,
        applyState,
        service,
        setStatusLine,
        updateCommitButtons,
        syncStaticUI,
        closeActionsMenu,
        getSelectedReposForBatch,
        getPathsForCommitInRepo,
        setCommitMessage,
        clearCommitMessageInput,
        clearDiffCache,
        loadRepoOverviews,
        refreshAll,
        refreshAfterGitOperation,
        showGitAuthPrompt,
        ensureGitIdentityOrPrompt,
        isAutoresolveEnabled,
        pullWithAutoStash,
        handlePullConflicts,
        clearPullBlockedState,
        hasConflictsForRepos,
        collectConflictedItems,
        updateRepoOverviewFromStatus,
        getAheadCountForRepo,
        dispatchAutocommitStop,
        dispatchAutocommitReset,
        generateCommitMessageForSelections,
        promptForFallbackCommitMessage,
        stashSelectedRepos,
        unstashSelectedRepos,
        withPanelLoader
    });
    ({
        gitPushWithToken,
        gitPullWithToken,
        pushRepos,
        pullRepos,
        commitSelectedRepos,
        syncSelectedRepos,
        commit,
        push,
        pushSelectedRepos,
        pullSelectedRepos,
        runGitAction
    } = gitOpsActions);

    return {
        runGitAction,
        showGitAuthPrompt,
        openGitTokenPrompt,
        openGitIdentityPrompt,
        cancelGitToken,
        cancelGitIdentity,
        cancelGitCredentials,
        clearGitCredentials,
        generateCommitMessage,
        saveGitToken,
        saveGitCredentials,
        selectConflictFile,
        applyConflictChoice,
        saveConflictResolution,
        refreshConflicts,
        gitPushWithToken,
        gitPullWithToken,
        pushRepos,
        pullRepos,
        ensureGitIdentityOrPrompt,
        saveGitIdentity,
        commitSelectedRepos,
        commit,
        push,
        pushSelectedRepos,
        pullSelectedRepos,
        stashSelectedRepos,
        unstashSelectedRepos,
        checkoutBranchFromRepoRow,
        createBranchFromRepoRow,
        mergeBranchFromRepoRow
    };
}
