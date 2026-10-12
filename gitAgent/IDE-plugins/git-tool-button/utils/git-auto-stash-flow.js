import {
    normalizeErrorMessage,
    humanizeGitError,
    isGitAuthError,
    isGitIdentityError,
    isGitConflictError,
    isGitPullBlockedError,
    extractGitPullBlockedFiles,
    parseJsonToolResult,
    normalizeGitStatusPayload
} from "../components/git-panel/git-panel-utils.js";

export async function restoreStashFlow({
    service,
    repoPath,
    stashRef = null,
    setStatusLine = () => {},
    onConflicts = null,
    onStateChange = null
} = {}) {
    try {
        const popStash = async (reinstateIndex) => {
            const request = { path: repoPath, reinstateIndex };
            if (stashRef) request.ref = stashRef;
            const text = await service.gitStashPop(request);
            return parseJsonToolResult(text) || {};
        };

        let payload = await popStash(true);
        let restoredWithoutIndex = false;
        if (payload.indexConflicts) {
            setStatusLine('Could not restore staged state. Retrying stash without index...');
            payload = await popStash(false);
            restoredWithoutIndex = payload.ok !== false && !payload.conflicts;
        }

        if (payload.noStash) {
            return { ok: false, conflicts: false, message: 'No stash entries found to restore.' };
        }
        if (payload.conflicts) {
            const seededConflicts = Array.isArray(payload.conflictPaths)
                ? payload.conflictPaths
                    .filter(Boolean)
                    .map((filePath) => ({ repoPath, filePath }))
                : [];
            if (typeof onConflicts === 'function') {
                const resolved = await onConflicts({ repoPath, seededConflicts, payload });
                if (typeof onStateChange === 'function') {
                    await onStateChange({ repoPath, payload, restored: resolved });
                }
                return {
                    ok: Boolean(resolved),
                    conflicts: !resolved,
                    message: resolved ? '' : 'Conflicts after restoring stashed changes.'
                };
            }
            if (typeof onStateChange === 'function') {
                await onStateChange({ repoPath, payload, restored: false });
            }
            return {
                ok: false,
                conflicts: true,
                message: 'Conflicts after restoring stashed changes.',
                conflictPaths: seededConflicts
            };
        }
        if (payload.ok === false) {
            if (typeof onStateChange === 'function') {
                await onStateChange({ repoPath, payload, restored: false });
            }
            return { ok: false, conflicts: false, message: payload.output || 'Failed to restore stash.' };
        }
        if (typeof onStateChange === 'function') {
            await onStateChange({ repoPath, payload, restored: true });
        }
        if (restoredWithoutIndex) {
            setStatusLine('Restored stashed changes without staged state.');
        }
        return { ok: true, conflicts: false };
    } catch (error) {
        if (typeof onStateChange === 'function') {
            await onStateChange({ repoPath, payload: null, restored: false });
        }
        return { ok: false, conflicts: false, message: normalizeErrorMessage(error) };
    }
}

export async function pullWithAutoStashFlow({
    service,
    repoPath,
    token = null,
    repoPaths = [],
    gitPullWithToken,
    restoreStash,
    confirmStash = null,
    isActive = () => true,
    setStatusLine = () => {}
} = {}) {
    let stashPayload = null;
    let stashCreated = false;
    let stashRef = null;
    let hasLocalChanges = false;
    let branch = null;
    let upstream = null;
    let behind = null;
    let counts = null;
    const readStatus = async () => {
        const text = await service.gitStatus(repoPath, { includeAhead: true });
        const payload = parseJsonToolResult(text) || {};
        if (payload.ok === false) throw new Error(payload.error || 'Could not read repository status.');
        const normalized = normalizeGitStatusPayload(payload);
        if (payload.mergeInProgress || normalized.counts.conflicted > 0) {
            throw new Error('Complete the pending merge and resolve conflicts before pulling.');
        }
        return { payload, counts: normalized.counts };
    };
    try {
        const { payload: statusPayload } = await readStatus();
        branch = statusPayload.branch || null;
        upstream = statusPayload.upstream || null;
    } catch (error) {
        return { ok: false, reason: 'status_error', message: normalizeErrorMessage(error) };
    }

    if (!branch) {
        return { ok: true, reason: 'no_commits', message: 'No commits yet. Nothing to pull.' };
    }
    if (!upstream) {
        return { ok: true, reason: 'no_upstream', message: 'No upstream branch configured. Nothing to pull.' };
    }

    try {
        setStatusLine('Checking remote updates...');
        const fetched = parseJsonToolResult(await service.gitFetch({ path: repoPath }));
        if (fetched?.ok !== true || fetched.skipped) {
            throw new Error(fetched?.error || 'Remote updates could not be verified. Pull stopped.');
        }
        const fresh = await readStatus();
        if (fresh.payload.branch !== branch || fresh.payload.upstream !== upstream) {
            throw new Error('The branch changed while checking remote updates. Retry the operation.');
        }
        behind = fresh.payload.behind;
        if (!Number.isInteger(behind) || behind < 0) {
            throw new Error('Could not determine incoming remote commits. Pull stopped without changing local files.');
        }
        counts = fresh.counts;
        hasLocalChanges = counts.staged + counts.unstaged + counts.untracked > 0;
    } catch (error) {
        const message = normalizeErrorMessage(error);
        return { ok: false, reason: isGitAuthError(message) ? 'auth' : 'remote_check_failed', message };
    }
    if (!isActive()) return { ok: false, reason: 'aborted', message: 'Pull aborted.' };
    if (behind === 0) {
        return { ok: true, reason: 'up_to_date', message: 'No incoming remote commits. Local files left unchanged.' };
    }

    if (hasLocalChanges) {
        const approved = typeof confirmStash === 'function'
            && await confirmStash({ repoPath, branch, upstream, behind, counts });
        if (approved !== true || !isActive()) {
            return { ok: false, reason: 'aborted', message: 'Pull aborted. Local files and staging left unchanged.' };
        }
        // Consent is for this branch only, not a branch switched while the dialog was open.
        try {
            const fresh = await readStatus();
            if (fresh.payload.branch !== branch || fresh.payload.upstream !== upstream) {
                throw new Error('The branch changed while awaiting confirmation. Pull aborted.');
            }
            counts = fresh.counts;
            hasLocalChanges = counts.staged + counts.unstaged + counts.untracked > 0;
        } catch (error) {
            return { ok: false, reason: 'status_error', message: normalizeErrorMessage(error) };
        }
    }

    if (hasLocalChanges) {
        if (!isActive()) return { ok: false, reason: 'aborted', message: 'Pull aborted.' };
        setStatusLine('Stashing local changes with your permission before pull...');
        try {
            const text = await service.gitStash({
                path: repoPath,
                includeUntracked: true,
                message: 'webskel:auto-pull'
            });
            stashPayload = parseJsonToolResult(text) || {};
        } catch (error) {
            return { ok: false, reason: 'stash_failed', message: normalizeErrorMessage(error) };
        }

        stashCreated = Boolean(stashPayload.created);
        stashRef = stashPayload.ref || null;
        if (!stashCreated) {
            return {
                ok: false,
                reason: 'stash_failed',
                message: 'No stash was created. Pull stopped to preserve local changes.'
            };
        }
    }

    const rollbackAutoStash = async () => {
        if (!stashCreated) {
            return { ok: false, conflicts: false };
        }
        setStatusLine('Restoring stashed changes...');
        return restoreStash(repoPath, stashRef);
    };

    const failAfterRestoringStash = async ({ reason, message, ...details }) => {
        const rollback = stashCreated ? await rollbackAutoStash() : null;
        if (stashCreated && !rollback?.ok) {
            return {
                ok: false,
                reason: 'restore_failed',
                message: rollback?.message || 'Failed to restore stashed changes.',
                conflicts: Boolean(rollback?.conflicts),
                originalReason: reason,
                originalMessage: message,
                rollback,
                repoPath,
                repoPaths,
                stashCreated,
                stashRef,
                ...details
            };
        }
        return {
            ok: false,
            reason,
            message,
            rollback,
            repoPath,
            repoPaths,
            stashCreated,
            stashRef,
            ...details
        };
    };

    try {
        await gitPullWithToken(repoPath, token);
    } catch (error) {
        const msg = humanizeGitError(normalizeErrorMessage(error), { action: 'pull' });
        if (isGitIdentityError(msg)) {
            return failAfterRestoringStash({ reason: 'identity', message: msg });
        }
        if (isGitAuthError(msg)) {
            return failAfterRestoringStash({ reason: 'auth', message: msg });
        }
        if (isGitConflictError(msg)) {
            return {
                ok: false,
                reason: 'pull_conflicts',
                message: stashCreated
                    ? 'Pull completed with conflicts. Resolve them, then restore your stashed changes.'
                    : 'Pull completed with conflicts. Resolve them before continuing.',
                repoPath,
                repoPaths,
                stashCreated,
                stashRef
            };
        }
        if (isGitPullBlockedError(msg)) {
            return failAfterRestoringStash({
                reason: 'pull_blocked',
                message: 'Pull blocked: could not auto-stash your local changes.',
                detailedMessage: msg,
                blockedFiles: extractGitPullBlockedFiles(msg)
            });
        }
        return failAfterRestoringStash({ reason: 'pull_error', message: msg });
    }

    if (stashCreated) {
        const restored = await rollbackAutoStash();
        if (!restored.ok) {
            return {
                ok: false,
                reason: 'restore_failed',
                message: restored.message || 'Failed to restore stash.',
                conflicts: restored.conflicts,
                repoPath,
                repoPaths,
                stashCreated,
                stashRef
            };
        }
    }

    return { ok: true, repoPath, repoPaths };
}
