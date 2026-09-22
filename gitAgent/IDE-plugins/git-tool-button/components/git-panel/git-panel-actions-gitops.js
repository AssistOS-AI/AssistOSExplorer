import {
    normalizeErrorMessage,
    humanizeGitError,
    parseJsonToolResult,
    isReposRootPath,
    isGitAuthError,
    isGitIdentityError,
    isGitConflictError,
    isGitPullBlockedError,
    getRememberedGitIdentity,
    getEffectiveGitIdentity,
    getRememberedGitAuthMethod,
    normalizeGitAuthMethod,
    normalizeGitStatusPayload
} from "./git-panel-utils.js";
import {
    getGithubRepositoryApiUrl,
    getGithubRepositoryCreateUrl,
    parseGithubRepositoryRemote
} from "./github-remote-utils.js";

export function createGitOpsActions(ctx) {
    const {
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
        withPanelLoader
    } = ctx;

    const formatCount = (count, singular, plural = `${singular}s`) => {
        const safe = Number.isFinite(Number(count)) ? Number(count) : 0;
        return `${safe} ${safe === 1 ? singular : plural}`;
    };

    const joinParts = (parts = []) => {
        const list = parts.filter(Boolean);
        if (!list.length) return '';
        if (list.length === 1) return list[0];
        if (list.length === 2) return `${list[0]} and ${list[1]}`;
        return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
    };

    const buildCompletionMessage = ({ intro, details = [], outro = '' }) => {
        const detailText = joinParts(details);
        if (detailText && outro) return `${intro} ${detailText}. ${outro}`;
        if (detailText) return `${intro} ${detailText}.`;
        if (outro) return `${intro} ${outro}`;
        return intro;
    };

    const hasPendingMergeForRepos = (repoPaths, state = getState()) => {
        const targets = new Set(Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : []);
        return (state.repoOverviews || []).some((repo) => targets.has(repo?.path) && repo?.mergeInProgress);
    };

    const getActionRepoPaths = (state = getState()) => {
        const selected = getSelectedReposForBatch();
        if (selected.length) return selected;
        if (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot) && state.repoInfoOk !== false) {
            return [state.repoPath];
        }
        return [];
    };

    const blockDuringPendingMerge = (repoPaths, action) => {
        if (!hasPendingMergeForRepos(repoPaths)) return false;
        setStatusLine(`Complete the pending merge before ${action}.`, true);
        return true;
    };

    const getAuthMethod = (state = getState()) => {
        return normalizeGitAuthMethod(state.authPrompt?.authMethod || getRememberedGitAuthMethod());
    };

    const getAuthContext = (state = getState(), tokenOverride = null) => {
        const authMethod = getAuthMethod(state);
        const githubConnected = Boolean(state.githubAuth?.connected && state.githubAuth?.connection?.source === 'github');
        const hasOverrideToken = Boolean(String(tokenOverride || '').trim());
        const tokenStored = Boolean(state.githubAuth?.tokenStored || hasOverrideToken);
        return {
            authMethod,
            githubConnected,
            usingGithub: authMethod === 'github',
            tokenStored
        };
    };

    const assertGithubTokenAvailableForRemoteCreate = async () => {
        const token = await service.getStoredGitToken?.();
        if (!token) {
            throw new Error('GitHub authentication is required to create the remote repository.');
        }
        return token;
    };

    const gitPushWithToken = async (repoPath, _token = null) => {
        const payload = { path: repoPath };
        await service.gitPush(payload);
    };

    const gitPushAfterEnsuringRemote = async (repoPath) => {
        await ensureRemoteExists(repoPath);
        await gitPushWithToken(repoPath);
    };

    const getRemoteUrl = async (repoPath) => {
        try {
            const infoText = await service.gitInfo(repoPath);
            const info = parseJsonToolResult(infoText) || {};
            return String(info.remoteUrl || info.remotes?.origin || '').trim();
        } catch {
            return '';
        }
    };

    const getRepoNameFromRemote = (remoteUrl) => {
        return parseGithubRepositoryRemote(remoteUrl)?.repo || '';
    };

    const getGithubOwnerAndRepo = (remoteUrl) => {
        return parseGithubRepositoryRemote(remoteUrl);
    };

    const githubRepoExists = async (owner, repo) => {
        const token = await service.getStoredGitToken?.();
        if (!token) return false;
        const response = await fetch(getGithubRepositoryApiUrl(owner, repo), {
            method: 'HEAD',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'ploinky-git-agent'
            }
        });
        return response.ok;
    };

    const getAuthenticatedGithubLogin = async (token) => {
        const response = await fetch('https://api.github.com/user', {
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'ploinky-git-agent'
            }
        });
        if (!response.ok) {
            throw new Error('GitHub authentication is required to create the remote repository.');
        }
        const payload = await response.json().catch(() => ({}));
        const login = String(payload?.login || '').trim();
        if (!login) {
            throw new Error('GitHub authentication did not return an account login.');
        }
        return login;
    };

    const readGithubErrorMessage = async (response) => {
        const text = await response.text().catch(() => '');
        if (!text) return '';
        try {
            const payload = JSON.parse(text);
            return String(payload?.message || text).trim();
        } catch {
            return text.trim();
        }
    };

    const createGithubRepository = async (owner, repoName) => {
        const token = await assertGithubTokenAvailableForRemoteCreate();
        const login = await getAuthenticatedGithubLogin(token);
        const createUrl = getGithubRepositoryCreateUrl(owner, login);
        const response = await fetch(createUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'ploinky-git-agent'
            },
            body: JSON.stringify({
                name: repoName,
                auto_init: false
            })
        });
        if (!response.ok) {
            const message = await readGithubErrorMessage(response);
            throw new Error(message || `Cannot create GitHub repository ${owner}/${repoName} (${response.status}).`);
        }
        const result = await response.json();
        return { ok: true, htmlUrl: result?.html_url || '', cloneUrl: result?.clone_url || '' };
    };

    const ensureRemoteExists = async (repoPath) => {
        const remoteUrl = await getRemoteUrl(repoPath);
        if (!remoteUrl) return;
        const parsed = getGithubOwnerAndRepo(remoteUrl);
        if (!parsed) return;
        if (parsed.canonicalUrl && remoteUrl !== parsed.canonicalUrl) {
            await service.gitRemoteSet?.({ path: repoPath, remote: 'origin', url: parsed.canonicalUrl });
        }
        const exists = await githubRepoExists(parsed.owner, parsed.repo);
        if (!exists) {
            await assertGithubTokenAvailableForRemoteCreate();
            setStatusLine(`Remote "${parsed.owner}/${parsed.repo}" not found on GitHub. Creating...`);
            await createGithubRepository(parsed.owner, parsed.repo);
            setStatusLine(`Created remote "${parsed.owner}/${parsed.repo}".`);
        }
    };

    const applyGitIdentityForRepo = async (repoPath) => {
        const state = getState();
        const { name, email } = getEffectiveGitIdentity({
            identityPrompt: state.identityPrompt,
            rememberedIdentity: getRememberedGitIdentity(),
            githubAuth: state.githubAuth
        });
        if (!name || !email) {
            return false;
        }
        try {
            await service.gitSetIdentity({ path: repoPath, name, email });
            return true;
        } catch {
            return false;
        }
    };

    const gitPullWithToken = async (repoPath, _token = null) => {
        const payload = { path: repoPath, rebase: false, ffOnly: false };
        await service.gitPull(payload);
    };

    const restoreStagedSnapshots = async (snapshots) => {
        if (!(snapshots instanceof Map) || snapshots.size === 0) return;
        for (const [repoPath, files] of snapshots.entries()) {
            await service.gitStageExact(repoPath, Array.isArray(files) ? files : []);
        }
    };

    const pushRepos = async (repoPaths, { token = null, allowNoop = false, showNoopStatus = true } = {}) => {
        const state = getState();
        const list = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        if (!list.length) {
            setStatusLine('Select at least one repository to push.', true);
            return { ok: false, pushedRepos: 0, pushedCommits: 0, skippedRepos: 0 };
        }
        const auth = getAuthContext(state, token);
        let pushedRepos = 0;
        let pushedCommits = 0;
        let skippedRepos = 0;
        for (const repoPath of list) {
            const ahead = await getAheadCountForRepo(repoPath);
            if (ahead === 0) {
                skippedRepos += 1;
                continue;
            }
            try {
                await gitPushAfterEnsuringRemote(repoPath);
                pushedRepos += 1;
                pushedCommits += Math.max(0, Number(ahead) || 0);
            } catch (error) {
                const msg = normalizeErrorMessage(error);
                const human = humanizeGitError(msg, { action: 'push' });
                if (isGitAuthError(msg)) {
                    if (auth.usingGithub && !auth.githubConnected) {
                        showGitAuthPrompt(repoPath, { type: 'push', mode: 'batch', repoPaths: list }, { message: human, authMethod: 'github' });
                        return { ok: false, pushedRepos, pushedCommits, skippedRepos };
                    }
                    if (!auth.usingGithub && !auth.tokenStored) {
                        showGitAuthPrompt(repoPath, { type: 'push', mode: 'batch', repoPaths: list }, { message: human, authMethod: 'token' });
                        return { ok: false, pushedRepos, pushedCommits, skippedRepos };
                    }
                    setStatusLine(
                        auth.usingGithub
                            ? `${human} (Reconnect GitHub or switch to Token.)`
                            : `${human} (Use Token to update credentials or switch to GitHub.)`,
                        true
                    );
                    return { ok: false, pushedRepos, pushedCommits, skippedRepos };
                }
                throw error;
            }
        }
        if (pushedRepos === 0 && list.length) {
            if (showNoopStatus) {
                setStatusLine('Nothing to push. Selected repositories are up to date.');
            }
            return { ok: Boolean(allowNoop), pushedRepos, pushedCommits, skippedRepos };
        }
        return { ok: true, pushedRepos, pushedCommits, skippedRepos };
    };

    const pullRepos = async (repoPaths, { token = null, pendingAction = null, completePendingMerges = true } = {}) => {
        const state = getState();
        applyState({
            pullBlocked: null,
            conflictSource: state.pullMode === 'rebase' ? 'rebase' : 'merge'
        });
        const list = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        const auth = getAuthContext(state, token);
        const conflictSource = state.pullMode === 'rebase' ? 'rebase' : 'merge';
        let pulledRepos = 0;
        const completedMergeRepos = [];
        const pendingMergeRepos = [];
        for (const repoPath of list) {
            if (state.pullMode !== 'ffOnly') {
                const identityOk = await applyGitIdentityForRepo(repoPath);
                if (!identityOk) {
                    setStatusLine(auth.githubConnected
                        ? 'Set name/email in Git settings to continue.'
                        : 'Set name/email and connect GitHub or add a token in Git settings to continue.', true);
                    await ensureGitIdentityOrPrompt(
                        repoPath,
                        pendingAction?.type ? pendingAction : { type: 'pull', mode: 'batch', repoPaths: list }
                    );
                    return { ok: false, pulledRepos };
                }
            }
            try {
                let statusPayload = parseJsonToolResult(await service.gitStatus(repoPath, { includeAhead: true })) || {};
                let normalized = normalizeGitStatusPayload(statusPayload);
                if (normalized.counts.conflicted > 0) {
                    const resolved = await handlePullConflicts('Resolve merge conflicts before pulling.', [repoPath], conflictSource);
                    if (!resolved) return { ok: false, pulledRepos };
                    statusPayload = parseJsonToolResult(await service.gitStatus(repoPath, { includeAhead: true })) || {};
                    normalized = normalizeGitStatusPayload(statusPayload);
                }
                if (statusPayload.mergeInProgress) {
                    if (normalized.counts.conflicted > 0) {
                        return { ok: false, pulledRepos, completedMergeRepos, pendingMergeRepos };
                    }
                    if (!completePendingMerges) {
                        pendingMergeRepos.push(repoPath);
                        continue;
                    }
                    setStatusLine('Completing resolved merge...');
                    await service.gitCommit({ path: repoPath, useExistingMessage: true });
                    completedMergeRepos.push(repoPath);
                    pulledRepos += 1;
                    continue;
                }
                if (!statusPayload.branch) {
                    pulledRepos += 1;
                    continue;
                }
                const hasLocalChanges = (normalized.counts.staged
                    + normalized.counts.unstaged
                    + normalized.counts.untracked) > 0;
                if (hasLocalChanges) {
                    const autoOk = await pullWithAutoStash(repoPath, auth.tokenStored ? '__backend__' : '', list);
                    if (!autoOk) return { ok: false, pulledRepos };
                    pulledRepos += 1;
                    continue;
                }
                if (!statusPayload.upstream) {
                    pulledRepos += 1;
                    continue;
                }
                await gitPullWithToken(repoPath);
                pulledRepos += 1;
            } catch (error) {
                const msg = humanizeGitError(normalizeErrorMessage(error), { action: 'pull' });
                if (isGitIdentityError(msg)) {
                    setStatusLine(auth.githubConnected
                        ? 'Set name/email in Git settings to continue.'
                        : 'Set name/email and connect GitHub or add a token in Git settings to continue.', true);
                    await ensureGitIdentityOrPrompt(
                        repoPath,
                        pendingAction?.type ? pendingAction : { type: 'pull', mode: 'batch', repoPaths: list }
                    );
                    return { ok: false, pulledRepos };
                }
                if (isGitAuthError(msg)) {
                    showGitAuthPrompt(
                        repoPath,
                        pendingAction?.type ? pendingAction : { type: 'pull', mode: 'batch', repoPaths: list },
                        { 
                            message: `${msg} (${auth.usingGithub ? 'Reconnect GitHub or switch to Token.' : 'Use Token to update credentials or switch to GitHub.'})`, 
                            authMethod: auth.authMethod 
                        }
                    );
                    return { ok: false, pulledRepos };
                }
                if (isGitConflictError(msg)) {
                    const resolved = await handlePullConflicts('Merge conflicts detected. Resolve them before continuing.', [repoPath], conflictSource);
                    if (resolved) {
                        const afterResolution = parseJsonToolResult(await service.gitStatus(repoPath, { includeAhead: true })) || {};
                        const normalizedAfterResolution = normalizeGitStatusPayload(afterResolution);
                        if (afterResolution.mergeInProgress && normalizedAfterResolution.counts.conflicted === 0) {
                            if (completePendingMerges) {
                                setStatusLine('Completing resolved merge...');
                                await service.gitCommit({ path: repoPath, useExistingMessage: true });
                                completedMergeRepos.push(repoPath);
                                pulledRepos += 1;
                            } else {
                                pendingMergeRepos.push(repoPath);
                            }
                        }
                        continue;
                    }
                    return { ok: false, pulledRepos };
                }
                if (isGitPullBlockedError(msg)) {
                    const autoOk = await pullWithAutoStash(repoPath, auth.tokenStored ? '__backend__' : '', list);
                    if (!autoOk) return { ok: false, pulledRepos };
                    pulledRepos += 1;
                    continue;
                }
                throw error;
            }
        }
        return { ok: true, pulledRepos, completedMergeRepos, pendingMergeRepos };
    };

    const commitSelectionForRepo = async ({
        repoPath,
        files,
        message,
        pendingAction,
        state
    }) => {
        const identityOk = await ensureGitIdentityOrPrompt(repoPath, pendingAction);
        if (!identityOk) {
            return { ok: false, blocked: true };
        }
        const list = Array.isArray(files) ? files.filter(Boolean) : [];
        if (!list.length) {
            return { ok: true, committed: false, fileCount: 0 };
        }
        await service.gitStageExact(repoPath, list);
        const after = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
        const normalizedAfter = normalizeGitStatusPayload(after);
        if (!normalizedAfter.paths.staged.length) {
            return { ok: true, committed: false, fileCount: 0 };
        }
        const { name: userName, email: userEmail } = getEffectiveGitIdentity({
            identityPrompt: state.identityPrompt,
            rememberedIdentity: getRememberedGitIdentity(),
            githubAuth: state.githubAuth
        });
        try {
            await service.gitCommit({
                path: repoPath,
                message,
                userName: userName || null,
                userEmail: userEmail || null
            });
        } catch (error) {
            const msg = normalizeErrorMessage(error);
            if (isGitIdentityError(msg)) {
                await ensureGitIdentityOrPrompt(repoPath, pendingAction);
                return { ok: false, blocked: true };
            }
            throw error;
        }
        return { ok: true, committed: true, fileCount: list.length };
    };

    const commitSelectedRepos = async () => {
        const state = getState();
        const selected = getSelectedReposForBatch();
        const message = (state.commitMessage || '').trim();
        if (!message && !hasPendingMergeForRepos(selected, state)) {
            setStatusLine('Enter a commit message.', true);
            return;
        }
        if (!selected.length) return;
        clearPullBlockedState();
        const shouldPush = (state.commitMode || 'commit') === 'commitPush';
        if (hasConflictsForRepos(selected)) {
            syncStaticUI();
            updateCommitButtons();
            await handlePullConflicts('Merge conflicts detected. Resolve them before continuing.', selected, 'merge');
            return;
        }
        setStatusLine('Pulling latest changes before commit...');
        return withPanelLoader(async () => {
            try {
                const pullResult = await pullRepos(selected, {
                    pendingAction: { type: 'sync', mode: 'batch', repoPaths: selected },
                    completePendingMerges: !message
                });
                if (!pullResult?.ok) return;
                await loadRepoOverviews({ force: true });
                syncStaticUI();
                updateCommitButtons();
                if (hasConflictsForRepos(selected)) {
                    await handlePullConflicts('Merge conflicts detected. Resolve them before continuing.', selected, 'merge');
                    return;
                }
                setStatusLine(shouldPush ? `Committing & pushing ${selected.length} repo(s)…` : `Committing ${selected.length} repo(s)…`);
                const completedMergeRepos = new Set(pullResult.completedMergeRepos || []);
                if (!message && completedMergeRepos.size === 0) {
                    setStatusLine('Enter a commit message.', true);
                    return;
                }
                let committedRepos = 0;
                let committedFiles = 0;
                let pushSummary = { ok: false, pushedRepos: 0, pushedCommits: 0, skippedRepos: 0 };
                for (const repoPath of selected) {
                    const list = getPathsForCommitInRepo(repoPath);
                    const commitResult = message
                        ? await commitSelectionForRepo({
                            repoPath,
                            files: list,
                            message,
                            pendingAction: { type: 'commit', mode: 'batch', repoPaths: selected },
                            state
                        })
                        : { ok: true, committed: false, fileCount: 0 };
                    if (!commitResult?.ok) return;
                    if (commitResult.committed) {
                        committedRepos += 1;
                        committedFiles += commitResult.fileCount;
                    }
                    if (shouldPush && (commitResult.committed || completedMergeRepos.has(repoPath))) {
                        const auth = getAuthContext(getState());
                        try {
                            await gitPushAfterEnsuringRemote(repoPath);
                            pushSummary.pushedRepos += 1;
                            pushSummary.pushedCommits += 1;
                        } catch (error) {
                            const msg = normalizeErrorMessage(error);
                            if (isGitAuthError(msg)) {
                                if (auth.usingGithub && !auth.githubConnected) {
                                    showGitAuthPrompt(repoPath, { type: 'push', mode: 'batch', repoPaths: [repoPath] }, { message: msg, authMethod: 'github' });
                                    return;
                                }
                                if (!auth.usingGithub && !auth.tokenStored) {
                                    showGitAuthPrompt(repoPath, { type: 'push', mode: 'batch', repoPaths: [repoPath] }, { message: msg, authMethod: 'token' });
                                    return;
                                }
                                setStatusLine(
                                    auth.usingGithub
                                        ? `${msg} (Reconnect GitHub or switch to Token.)`
                                        : `${msg} (Use Token to update credentials or switch to GitHub.)`,
                                    true
                                );
                                return;
                            }
                            throw error;
                        }
                    }
                }
                if (!message) {
                    await refreshAfterGitOperation();
                    setStatusLine(buildCompletionMessage({
                        intro: shouldPush ? 'Merge and push finished.' : 'Merge finished.',
                        details: [
                            completedMergeRepos.size > 0 ? `completed ${formatCount(completedMergeRepos.size, 'merge')}` : '',
                            shouldPush && pushSummary.pushedRepos > 0
                                ? `pushed ${formatCount(pushSummary.pushedCommits, 'commit')} from ${formatCount(pushSummary.pushedRepos, 'repository')}`
                                : ''
                        ]
                    }));
                    return;
                }
                applyState({ selectedFilesByRepo: {}, commitMessage: '' }, { silent: true });
                clearCommitMessageInput();
                await refreshAfterGitOperation();
                const details = [];
                if (pullResult.pulledRepos > 0) {
                    details.push(`pulled the latest changes for ${formatCount(pullResult.pulledRepos, 'repository')}`);
                }
                if (committedRepos > 0) {
                    details.push(`committed ${formatCount(committedFiles, 'file')} in ${formatCount(committedRepos, 'repository')}`);
                }
                if (completedMergeRepos.size > 0) {
                    details.push(`completed ${formatCount(completedMergeRepos.size, 'merge')}`);
                }
                if (shouldPush && pushSummary.pushedRepos > 0) {
                    details.push(`pushed ${formatCount(pushSummary.pushedCommits, 'commit')} from ${formatCount(pushSummary.pushedRepos, 'repository')}`);
                }
                const intro = shouldPush ? 'Commit and push finished.' : 'Commit finished.';
                setStatusLine(buildCompletionMessage({ intro, details }));
            } catch (error) {
                setStatusLine(humanizeGitError(normalizeErrorMessage(error)), true);
            }
        });
    };

    const syncSelectedRepos = async ({ token: tokenOverride = null, repoPaths = null } = {}) => {
        const state = getState();
        const selected = Array.isArray(repoPaths) && repoPaths.length
            ? repoPaths.filter(Boolean)
            : getSelectedReposForBatch();
        if (!selected.length) {
            setStatusLine('Select at least one repository to sync.', true);
            return;
        }
        applyState({ pendingAction: { type: 'sync', mode: 'batch', repoPaths: selected } }, { silent: true });
        clearPullBlockedState();
        setStatusLine(`Syncing ${selected.length} repo(s)…`);

        const finishSyncWithMessage = async ({ pullResult, stagedSelections, message }) => {
            if (!message) {
                setStatusLine('AI returned an empty commit message.', true);
                dispatchAutocommitStop();
                return;
            }
            setCommitMessage(message);
            updateCommitButtons();
            let committedRepos = 0;
            let committedFiles = 0;

            for (const selection of stagedSelections) {
                const repoPath = selection.repoPath;
                const commitResult = await commitSelectionForRepo({
                    repoPath,
                    files: selection.files,
                    message,
                    pendingAction: { type: 'sync', mode: 'batch', repoPaths: selected },
                    state
                });
                if (!commitResult?.ok) {
                    dispatchAutocommitStop();
                    return;
                }
                if (!commitResult.committed) continue;
                committedRepos += 1;
                committedFiles += commitResult.fileCount;
            }

            const auth = getAuthContext(getState(), tokenOverride);
            let pushedRepos = 0;
            let pushedCommits = 0;
            for (const repoPath of selected) {
                try {
                    const aheadCount = Math.max(0, Number(await getAheadCountForRepo(repoPath)) || 0);
                    await gitPushAfterEnsuringRemote(repoPath);
                    pushedRepos += 1;
                    pushedCommits += Math.max(1, aheadCount);
                } catch (error) {
                    const msg = normalizeErrorMessage(error);
                    const human = humanizeGitError(msg, { action: 'push' });
                    if (isGitAuthError(msg)) {
                        if (auth.usingGithub && !auth.githubConnected) {
                            showGitAuthPrompt(repoPath, { type: 'sync', mode: 'batch', repoPaths: selected }, { message: human, authMethod: 'github' });
                            dispatchAutocommitStop();
                            return;
                        }
                        if (!auth.usingGithub && !auth.tokenStored) {
                            showGitAuthPrompt(repoPath, { type: 'sync', mode: 'batch', repoPaths: selected }, { message: human, authMethod: 'token' });
                            dispatchAutocommitStop();
                            return;
                        }
                        setStatusLine(
                            auth.usingGithub
                                ? `${human} (Reconnect GitHub or switch to Token.)`
                                : `${human} (Use Token to update credentials or switch to GitHub.)`,
                            true
                        );
                        dispatchAutocommitStop();
                        return;
                    }
                    throw error;
                }
            }

            applyState({ selectedFilesByRepo: {}, commitMessage: '' }, { silent: true });
            clearCommitMessageInput();
            applyState({ pendingAction: null }, { silent: true });
            await refreshAfterGitOperation({ keepStatus: true });
            setStatusLine(buildCompletionMessage({
                intro: 'Sync finished.',
                details: [
                    pullResult.pulledRepos > 0 ? `pulled the latest changes for ${formatCount(pullResult.pulledRepos, 'repository')}` : '',
                    committedRepos > 0 ? `committed ${formatCount(committedFiles, 'file')} in ${formatCount(committedRepos, 'repository')}` : '',
                    pushedRepos > 0 ? `pushed ${formatCount(pushedCommits, 'commit')} from ${formatCount(pushedRepos, 'repository')}` : ''
                ]
            }));
            dispatchAutocommitReset();
        };

        const prepareResult = await withPanelLoader(async () => {
            try {
                const pullResult = await pullRepos(selected, {
                    pendingAction: { type: 'sync', mode: 'batch', repoPaths: selected },
                    token: tokenOverride
                });
                if (!pullResult?.ok) return;
                const stagedSelections = [];
                const initialStagedByRepo = new Map();
                for (const repoPath of selected) {
                    const statusPayload = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
                    updateRepoOverviewFromStatus(repoPath, statusPayload);
                    initialStagedByRepo.set(repoPath, normalizeGitStatusPayload(statusPayload).paths.staged);
                    const selectedPaths = getPathsForCommitInRepo(repoPath);
                    if (selectedPaths.length) {
                        await service.gitStageExact(repoPath, selectedPaths);
                        const afterStage = parseJsonToolResult(await service.gitStatus(repoPath)) || {};
                        const stagedPaths = normalizeGitStatusPayload(afterStage).paths.staged;
                        if (stagedPaths.length) {
                            stagedSelections.push({ repoPath, files: stagedPaths });
                        }
                    }
                }

                if (!stagedSelections.length) {
                    const pushSummary = await pushRepos(selected, { allowNoop: true, showNoopStatus: false });
                    if (!pushSummary?.ok) {
                        applyState({ pendingAction: null }, { silent: true });
                        dispatchAutocommitReset();
                        return;
                    }
                    applyState({ selectedFilesByRepo: {}, commitMessage: '' }, { silent: true });
                    clearCommitMessageInput();
                    applyState({ pendingAction: null }, { silent: true });
                    await refreshAfterGitOperation({ keepStatus: true });
                    setStatusLine(buildCompletionMessage({
                        intro: 'Sync finished.',
                        details: [
                            pullResult.pulledRepos > 0 ? `pulled the latest changes for ${formatCount(pullResult.pulledRepos, 'repository')}` : '',
                            pushSummary.pushedRepos > 0 ? `pushed ${formatCount(pushSummary.pushedCommits, 'commit')} from ${formatCount(pushSummary.pushedRepos, 'repository')}` : ''
                        ]
                    }));
                    return;
                }

                let message = '';
                try {
                    message = await generateCommitMessageForSelections(stagedSelections);
                } catch (error) {
                    return { needsFallback: true, pullResult, stagedSelections, initialStagedByRepo };
                }
                await finishSyncWithMessage({ pullResult, stagedSelections, message });
                return { done: true };
            } catch (error) {
                setStatusLine(humanizeGitError(normalizeErrorMessage(error), { action: 'push' }), true);
                dispatchAutocommitStop();
                return { done: true };
            }
        });

        if (!prepareResult?.needsFallback) return;

        const message = await promptForFallbackCommitMessage(prepareResult.stagedSelections);
        if (!message) {
            await withPanelLoader(async () => {
                await restoreStagedSnapshots(prepareResult.initialStagedByRepo);
                applyState({ pendingAction: null }, { silent: true });
                await refreshAfterGitOperation({ keepStatus: true });
            });
            setStatusLine('Commit message generation canceled. Sync stopped.');
            dispatchAutocommitReset();
            return;
        }

        return withPanelLoader(async () => {
            try {
                await finishSyncWithMessage({
                    pullResult: prepareResult.pullResult,
                    stagedSelections: prepareResult.stagedSelections,
                    message
                });
            } catch (error) {
                setStatusLine(humanizeGitError(normalizeErrorMessage(error), { action: 'push' }), true);
                dispatchAutocommitStop();
            }
        });
    };

    const commit = async () => {
        await commitSelectedRepos();
    };

    const push = async ({ silent = false, token = null } = {}) => {
        const state = getState();
        const identityOk = await ensureGitIdentityOrPrompt(state.repoPath, { type: 'push', mode: 'single' });
        if (!identityOk) {
            return;
        }
        setStatusLine('Pushing...');
        return withPanelLoader(async () => {
            try {
                const pushSummary = await pushRepos([state.repoPath], { token });
                if (!pushSummary?.ok) return;
                await refreshAfterGitOperation({ keepStatus: true });
                if (!silent) {
                    setStatusLine(buildCompletionMessage({
                        intro: 'Push finished.',
                        details: [
                            `pushed ${formatCount(pushSummary.pushedCommits, 'commit')} from ${formatCount(pushSummary.pushedRepos, 'repository')}`
                        ]
                    }));
                }
            } catch (error) {
                setStatusLine(humanizeGitError(normalizeErrorMessage(error), { action: 'push' }), true);
            }
        });
    };

    const pushSelectedRepos = async (repoPaths) => {
        const list = Array.isArray(repoPaths) ? repoPaths.filter(Boolean) : [];
        if (!list.length) {
            setStatusLine('Select at least one repository to push.', true);
            return;
        }
        const identityOk = await ensureGitIdentityOrPrompt(list[0], { type: 'push', mode: 'batch', repoPaths: list });
        if (!identityOk) {
            return;
        }
        setStatusLine(`Pushing ${list.length} repo(s)…`);
        return withPanelLoader(async () => {
            try {
                const pushSummary = await pushRepos(list);
                if (!pushSummary?.ok) return;
                await refreshAfterGitOperation({ keepStatus: true });
                setStatusLine(buildCompletionMessage({
                    intro: 'Push finished.',
                    details: [
                        `pushed ${formatCount(pushSummary.pushedCommits, 'commit')} from ${formatCount(pushSummary.pushedRepos, 'repository')}`
                    ]
                }));
            } catch (error) {
                setStatusLine(humanizeGitError(normalizeErrorMessage(error), { action: 'push' }), true);
            }
        });
    };

    const pullSelectedRepos = async (modeOverride = null) => {
        const state = getState();
        const selected = getSelectedReposForBatch();
        if (!selected.length) {
            setStatusLine('Select at least one file/repo to pull.', true);
            return;
        }
        clearPullBlockedState();
        const mode = modeOverride || state.pullMode || 'merge';
        applyState({ conflictSource: mode === 'rebase' ? 'rebase' : 'merge' }, { silent: true });
        if (mode !== 'ffOnly') {
            for (const repoPath of selected) {
                const ok = await ensureGitIdentityOrPrompt(repoPath, { type: 'pull', mode: 'batch', repoPaths: selected });
                if (!ok) return;
            }
        }
        setStatusLine(`Pulling ${selected.length} repo(s)…`);
        return withPanelLoader(async () => {
            try {
                const pullResult = await pullRepos(selected);
                if (!pullResult?.ok) return;
                await refreshAfterGitOperation();
                setStatusLine(buildCompletionMessage({
                    intro: 'Pull finished.',
                    details: [
                        `updated ${formatCount(pullResult.pulledRepos, 'repository')}`
                    ]
                }));
            } catch (error) {
                setStatusLine(normalizeErrorMessage(error), true);
            }
        });
    };

    const setPullMode = (element, mode) => {
        const state = getState();
        const next = (mode || element?.dataset?.mode || '').trim();
        if (next !== 'ffOnly' && next !== 'rebase' && next !== 'merge') return;
        applyState({ pullMode: next });
        if (state.identityPrompt?.visible) return;
        if (state.authPrompt?.visible) return;
        pullSelectedRepos();
    };

    const runGitAction = (element, mode) => {
        const state = getState();
        const next = (mode || element?.dataset?.mode || '').trim();
        if (!next) return;
        if (next === 'commit' || next === 'commitPush') {
            const messageOk = Boolean((state.commitMessage || '').trim());
            const selected = getSelectedReposForBatch();
            if (!selected.length) {
                setStatusLine('Select at least one file to commit.', true);
                return;
            }
            if (!messageOk && !hasPendingMergeForRepos(selected, state)) {
                setStatusLine('Enter a commit message.', true);
                return;
            }
            applyState({ commitMode: next }, { silent: true });
            closeActionsMenu();
            updateCommitButtons();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            commit();
            return;
        }
        if (next === 'push') {
            closeActionsMenu();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            const selected = getSelectedReposForBatch();
            if (blockDuringPendingMerge(getActionRepoPaths(state), 'pushing')) return;
            if (selected.length) {
                pushSelectedRepos(selected);
                return;
            }
            if (!state.repoPath || isReposRootPath(state.repoPath, state.reposRoot) || state.repoInfoOk === false) {
                setStatusLine('Select at least one repository to push.', true);
                return;
            }
            push({ silent: false });
            return;
        }
        if (next === 'pull') {
            closeActionsMenu();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            pullSelectedRepos('merge');
            return;
        }
        if (next === 'sync') {
            closeActionsMenu();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            syncSelectedRepos();
            return;
        }
        if (next === 'stash') {
            closeActionsMenu();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            if (blockDuringPendingMerge(getActionRepoPaths(state), 'stashing changes')) return;
            ctx.stashSelectedRepos();
            return;
        }
        if (next === 'unstash') {
            closeActionsMenu();
            if (state.identityPrompt?.visible || state.authPrompt?.visible) return;
            if (blockDuringPendingMerge(getActionRepoPaths(state), 'restoring a stash')) return;
            ctx.unstashSelectedRepos();
            return;
        }
        if (next === 'pullFfOnly' || next === 'pullRebase') {
            const modeMap = {
                pullFfOnly: 'ffOnly',
                pullRebase: 'rebase'
            };
            closeActionsMenu();
            setPullMode(null, modeMap[next]);
        }
    };

    return {
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
    };
}
