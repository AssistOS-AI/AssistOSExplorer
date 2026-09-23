import {
    normalizeErrorMessage,
    parseJsonToolResult,
    normalizeGitStatusPayload
} from "./git-panel-utils.js";

const encodeBase64 = (value) => {
    const text = String(value ?? '');
    try {
        return btoa(unescape(encodeURIComponent(text)));
    } catch {
        return btoa(text);
    }
};

const sortBranches = (branches, {
    excludeCurrent = false,
    currentBranch = ''
} = {}) => {
    return (Array.isArray(branches) ? branches : [])
        .filter((branch) => branch?.name)
        .filter((branch) => !(excludeCurrent && branch.name === currentBranch))
        .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'local' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
};

const chooseBranch = async (branches, {
    title,
    excludeCurrent = false,
    currentBranch = ''
} = {}) => {
    const candidates = sortBranches(branches, { excludeCurrent, currentBranch });
    if (!candidates.length) return null;
    const result = await assistOS.UI.showModal('git-branch-select-modal', {
        title,
        branches: encodeBase64(JSON.stringify(candidates))
    }, true);
    return result?.branch?.name ? result.branch : null;
};

export function createBranchActions(ctx) {
    const {
        service,
        setStatusLine,
        refreshAfterGitOperation,
        handlePullConflicts,
        restoreStash,
        applyState,
        withPanelLoader
    } = ctx;

    const getBranchPayload = async (repoPath) => {
        const text = await service.gitBranchList(repoPath);
        const payload = parseJsonToolResult(text) || {};
        if (payload?.ok === false) {
            throw new Error(payload.error || 'Could not list branches.');
        }
        return payload;
    };

    const getDirtyCounts = async (repoPath) => {
        const text = await service.gitStatus(repoPath);
        const payload = parseJsonToolResult(text) || {};
        const normalized = normalizeGitStatusPayload(payload);
        const counts = normalized.counts || {};
        return {
            staged: counts.staged || 0,
            unstaged: counts.unstaged || 0,
            untracked: counts.untracked || 0,
            conflicted: counts.conflicted || 0,
            total: (counts.staged || 0) + (counts.unstaged || 0) + (counts.untracked || 0) + (counts.conflicted || 0)
        };
    };

    const askDirtyPolicy = async (counts, action) => {
        if (!counts.total) return 'clean';
        const result = await assistOS.UI.showModal('git-branch-dirty-modal', {
            actionLabel: action,
            counts: encodeBase64(JSON.stringify(counts))
        }, true);
        const policy = String(result?.policy || 'cancel').trim();
        return ['stash', 'run', 'cancel'].includes(policy) ? policy : 'cancel';
    };

    const runWithOptionalStash = async (repoPath, actionLabel, runOperation) => {
        const counts = await withPanelLoader(() => getDirtyCounts(repoPath));
        const policy = await askDirtyPolicy(counts, actionLabel);
        if (policy === 'cancel') {
            setStatusLine(`${actionLabel} canceled.`);
            return null;
        }

        return withPanelLoader(async () => {
            let stashRef = null;
            let stashCreated = false;
            if (policy === 'stash') {
                setStatusLine(`Stashing local changes before ${actionLabel}...`);
                const stashText = await service.gitStash({
                    path: repoPath,
                    includeUntracked: true,
                    message: `webskel:branch-${actionLabel}`
                });
                const stashPayload = parseJsonToolResult(stashText) || {};
                if (stashPayload?.ok === false) {
                    throw new Error(stashPayload.output || stashPayload.error || 'Failed to stash local changes.');
                }
                stashCreated = Boolean(stashPayload.created);
                stashRef = stashPayload.ref || null;
            }

            const result = await runOperation({ stashCreated, stashRef });
            if (stashCreated && result?.conflicts) {
                applyState?.({ autoStash: { repoPath, ref: stashRef } }, { silent: true });
                return result;
            }
            if (stashCreated) {
                setStatusLine('Restoring stashed changes...');
                const restored = await restoreStash(repoPath, stashRef);
                if (!restored.ok) {
                    return { ok: false, restoreFailed: true, message: restored.message || 'Failed to restore stashed changes.' };
                }
            }
            return result;
        });
    };

    const checkoutBranchFromRepoRow = async (element) => {
        const repoPath = String(element?.dataset?.repoPath || '').trim();
        if (!repoPath) return;
        try {
            const branchPayload = await withPanelLoader(() => getBranchPayload(repoPath));
            const selected = await chooseBranch(branchPayload.branches, {
                title: 'Checkout branch',
                currentBranch: branchPayload.currentBranch || ''
            });
            if (!selected) {
                setStatusLine('Checkout canceled.');
                return;
            }
            setStatusLine(`Checking out ${selected.name}...`);
            const result = await runWithOptionalStash(repoPath, 'checkout', async () => {
                const text = await service.gitBranchCheckout({ path: repoPath, branch: selected.name });
                const payload = parseJsonToolResult(text) || {};
                if (payload?.ok === false) throw new Error(payload.error || 'Checkout failed.');
                return payload;
            });
            if (!result) return;
            await withPanelLoader(() => refreshAfterGitOperation({ keepStatus: true }));
            setStatusLine(`Checked out ${result.branch || selected.name}.`);
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
    };

    const createBranchFromRepoRow = async (element) => {
        const repoPath = String(element?.dataset?.repoPath || '').trim();
        if (!repoPath) return;
        try {
            const branchPayload = await withPanelLoader(() => getBranchPayload(repoPath));
            const result = await assistOS.UI.showModal('git-branch-create-modal', {
                currentBranch: branchPayload.currentBranch || '',
                branches: encodeBase64(JSON.stringify(sortBranches(branchPayload.branches)))
            }, true);
            const name = String(result?.name || '').trim();
            if (!name) {
                setStatusLine('New branch canceled.');
                return;
            }
            const startPoint = String(result?.startPoint || '').trim();
            const checkout = Boolean(result?.checkout);
            setStatusLine(`Creating branch ${name}...`);
            await withPanelLoader(async () => {
                const text = await service.gitBranchCreate({
                    path: repoPath,
                    name,
                    startPoint,
                    checkout
                });
                const payload = parseJsonToolResult(text) || {};
                if (payload?.ok === false) throw new Error(payload.error || 'Branch creation failed.');
                await refreshAfterGitOperation({ keepStatus: true });
                setStatusLine(checkout ? `Created and checked out ${payload.branch}.` : `Created branch ${payload.branch}.`);
            });
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
    };

    const mergeBranchFromRepoRow = async (element) => {
        const repoPath = String(element?.dataset?.repoPath || '').trim();
        if (!repoPath) return;
        try {
            const branchPayload = await withPanelLoader(() => getBranchPayload(repoPath));
            const selected = await chooseBranch(branchPayload.branches, {
                title: `Merge into ${branchPayload.currentBranch || 'current branch'}`,
                excludeCurrent: true,
                currentBranch: branchPayload.currentBranch || ''
            });
            if (!selected) {
                setStatusLine('Merge canceled.');
                return;
            }
            setStatusLine(`Merging ${selected.name}...`);
            const result = await runWithOptionalStash(repoPath, 'merge', async () => {
                const text = await service.gitBranchMerge({ path: repoPath, sourceBranch: selected.name });
                const payload = parseJsonToolResult(text) || {};
                if (payload?.ok === false && !payload.conflicts) {
                    throw new Error(payload.error || payload.output || 'Merge failed.');
                }
                if (payload.conflicts) {
                    await handlePullConflicts(
                        `Merge completed with conflicts from ${selected.name}. Resolve them before continuing.`,
                        [repoPath],
                        'merge',
                        (payload.conflictPaths || []).map((filePath) => ({ repoPath, filePath }))
                    );
                }
                return payload;
            });
            if (!result) return;
            await withPanelLoader(() => refreshAfterGitOperation({ keepStatus: true }));
            if (result.conflicts) {
                setStatusLine(`Merge from ${selected.name} has conflicts.`, true);
            } else {
                setStatusLine(`Merged ${selected.name}.`);
            }
        } catch (error) {
            setStatusLine(normalizeErrorMessage(error), true);
        }
    };

    return {
        checkoutBranchFromRepoRow,
        createBranchFromRepoRow,
        mergeBranchFromRepoRow
    };
}
