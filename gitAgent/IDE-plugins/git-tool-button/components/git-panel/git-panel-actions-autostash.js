import { extractGitPullBlockedFiles } from "./git-panel-utils.js";
import { FILE_EXP_REFRESH_EVENT } from "/explorer/utils/appEvents.js";
import { pullWithAutoStashFlow } from "../../utils/git-auto-stash-flow.js";

export function createAutoStashActions(ctx) {
    const {
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
        gitPullWithToken,
        restoreStash,
        hasConflictsForRepos,
        collectConflictedItems
    } = ctx;

    const rollbackAutoStash = async (repoPath, stashRef, {
        restoreStatusLine = false,
        failureMessage = 'Failed to restore stashed changes.'
    } = {}) => {
        if (!stashRef && !repoPath) {
            return { ok: false, conflicts: false };
        }
        if (restoreStatusLine) {
            setStatusLine('Restoring stashed changes...');
        }
        const restored = await restoreStash(repoPath, stashRef);
        try {
            await loadRepoOverviews({ force: true });
        } catch {
            // ignore refresh failures after stash rollback
        }
        syncStaticUI();
        updateCommitButtons();
        try {
            window.dispatchEvent(new CustomEvent(FILE_EXP_REFRESH_EVENT));
        } catch {
            // ignore dispatch failures
        }
        if (!restored.ok && failureMessage) {
            setStatusLine(restored.message || failureMessage, true);
        }
        return restored;
    };

    const pullWithAutoStash = async (repoPath, token, repoPaths) => {
        const result = await pullWithAutoStashFlow({
            service,
            repoPath,
            token,
            repoPaths,
            gitPullWithToken,
            restoreStash: (nextRepoPath, nextStashRef) => rollbackAutoStash(nextRepoPath, nextStashRef, {
                restoreStatusLine: true
            }),
            setStatusLine
        });

        if (result.ok) return true;

        if (result.reason === 'restore_failed') {
            if (result.stashCreated) {
                applyState({
                    autoStash: { repoPath: result.repoPath || repoPath, ref: result.stashRef || null }
                }, { silent: true });
            }
            setStatusLine(result.message || 'Failed to restore stashed changes.', true);
            return false;
        }

        if (result.reason === 'identity') {
            await ensureGitIdentityOrPrompt(repoPath, { type: 'pull', mode: 'batch', repoPaths });
            return false;
        }

        if (result.reason === 'auth') {
            if (!token) {
                showGitAuthPrompt(repoPath, { type: 'pull', mode: 'batch', repoPaths }, { message: result.message });
                return false;
            }
            setStatusLine(`${result.message} (A token is already saved. Use "Token" to update it.)`, true);
            return false;
        }

        if (result.reason === 'pull_conflicts') {
            if (result.stashCreated) {
                applyState({ autoStash: { repoPath, ref: result.stashRef } }, { silent: true });
            }
            const resolved = await handlePullConflicts(result.message, [repoPath], 'merge');
            if (!resolved) return false;
            if (result.stashCreated) {
                const restored = await rollbackAutoStash(repoPath, result.stashRef, { restoreStatusLine: true });
                if (restored.ok) {
                    applyState({ autoStash: null }, { silent: true });
                }
                return restored.ok;
            }
            return true;
        }

        if (result.reason === 'pull_blocked') {
            const blockedFiles = extractGitPullBlockedFiles(result.detailedMessage || result.message || '');
            applyState({ pullBlocked: blockedFiles.length ? { repoPath, files: blockedFiles } : null });
            updateCommitButtons();
            setStatusLine(result.message, true);
            return false;
        }

        if (result.message) {
            setStatusLine(result.message, true);
            return false;
        }

        return false;
    };

    const maybeRestoreAutoStash = async () => {
        const state = getState();
        const pending = state.autoStash;
        if (!pending?.repoPath) return false;
        if (hasConflictsForRepos([pending.repoPath])) return false;
        setStatusLine('Restoring stashed changes...');
        const restored = await restoreStash(pending.repoPath, pending.ref);
        if (restored.ok) {
            applyState({ autoStash: null }, { silent: true });
            await loadRepoOverviews({ force: true });
            syncStaticUI();
            updateCommitButtons();
            setStatusLine('Restored stashed changes.');
        }
        return restored.ok;
    };

    return {
        pullWithAutoStash,
        maybeRestoreAutoStash
    };
}
