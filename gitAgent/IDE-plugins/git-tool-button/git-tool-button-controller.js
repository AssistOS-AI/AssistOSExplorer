import {
    parseJsonToolResult,
    getRememberedGitIdentity,
    normalizeErrorMessage,
    humanizeGitError,
    isGitAuthError,
    isGitIdentityError,
    isGitConflictError,
    isGitPullBlockedError,
    getAutocommitSettings,
    getConflictAutoresolveSetting,
    getGitConflictFlag,
    setGitConflictFlag,
    getGitErrorFlag,
    setGitErrorFlag,
    normalizeGitStatusPayload,
    normalizeSlashes
} from "./components/git-panel/git-panel-utils.js";
import { callAgentTool } from "/explorer/services/infrastructure/explorerApi.js";
import { getReposRoot, getRepoScanPaths } from "/explorer/utils/reposRoot.js";
import { pullWithAutoStashFlow, restoreStashFlow } from "./utils/git-auto-stash-flow.js";
import { pushWithNonFastForwardRetry } from "./utils/git-autosync-push-flow.js";
import {
    AUTOCOMMIT_SETTINGS_CHANGED_EVENT,
    AUTOCOMMIT_RESET_EVENT,
    AUTOCOMMIT_STOP_EVENT,
    FILE_EXP_REFRESH_EVENT
} from "/explorer/utils/appEvents.js";
import { GIT_PANEL_CLOSED_EVENT } from "./git-tool-button-events.js";

export function attachGitController(fileExp) {
    const reposRoot = getReposRoot();
    const AUTOCOMMIT_MESSAGE = 'chore: autocommit';
    const setWindowListener = (key, eventName, handler, options) => {
        if (typeof fileExp.setWindowListener === 'function') {
            return fileExp.setWindowListener(key, eventName, handler, options);
        }
        if (typeof fileExp.addWindowListener === 'function') {
            return fileExp.addWindowListener(eventName, handler, options);
        }
        window.addEventListener(eventName, handler, options);
        return () => window.removeEventListener(eventName, handler, options);
    };

    const getConflictFlag = () => getGitConflictFlag();
    const setConflictFlag = (value) => setGitConflictFlag(Boolean(value));
    const getErrorFlag = () => getGitErrorFlag();
    const setErrorFlag = (value) => setGitErrorFlag(Boolean(value));
    let pushWarningMessage = '';

    const updateGitButtonIndicator = () => {
        const button = fileExp.element?.querySelector?.('#gitButton');
        if (!button) return;
        if (!button.dataset.defaultTitle) {
            button.dataset.defaultTitle = button.title || 'Commit and push with Git';
        }
        button.classList.toggle('has-conflicts', getConflictFlag());
        button.classList.toggle('has-git-error', getErrorFlag());
        button.classList.toggle('has-push-warning', Boolean(pushWarningMessage));
        button.title = pushWarningMessage || button.dataset.defaultTitle;
    };

    const setPushWarning = (message) => {
        pushWarningMessage = message ? String(message) : '';
        updateGitButtonIndicator();
    };

    const refreshOpenGitPanels = async () => {
        const modals = Array.from(document.querySelectorAll('git-panel'));
        if (!modals.length) return;
        for (const modal of modals) {
            const presenter = modal?.webSkelPresenter || modal?.presenter || modal;
            if (typeof presenter?.refreshAll === 'function') {
                try {
                    await presenter.refreshAll({ force: true });
                } catch {
                    // ignore refresh failures
                }
            }
        }
    };

    const refreshGitSurfaces = async () => {
        try {
            window.dispatchEvent(new CustomEvent(FILE_EXP_REFRESH_EVENT));
        } catch {
            // ignore dispatch failures
        }
        await refreshOpenGitPanels();
    };

    const autocommit = {
        timerId: null,
        running: false,
        scheduledIntervalMinutes: null,
        conflictRefreshPending: false
    };

    const clearAutocommitTimer = () => {
        if (autocommit.timerId) {
            clearInterval(autocommit.timerId);
            autocommit.timerId = null;
        }
        autocommit.running = false;
        autocommit.scheduledIntervalMinutes = null;
    };

    const ensureAutocommitTimer = () => {
        const { enabled, intervalMinutes, repos } = getAutocommitSettings();
        if (enabled === false) {
            clearAutocommitTimer();
            return;
        }
        if (!Array.isArray(repos) || repos.length === 0) {
            clearAutocommitTimer();
            return;
        }
        if (getConflictFlag() && !isAutoresolveEnabled()) {
            clearAutocommitTimer();
            return;
        }
        if (autocommit.timerId && autocommit.scheduledIntervalMinutes === intervalMinutes) {
            return;
        }
        clearAutocommitTimer();
        autocommit.scheduledIntervalMinutes = intervalMinutes;
        autocommit.timerId = setInterval(() => {
            runAutocommitTick();
        }, Math.max(1, intervalMinutes) * 60 * 1000);
    };

    const callGitTool = async (toolName, args, options = {}) => {
        const result = await callAgentTool('gitAgent', toolName, args, { raw: true, ...options });
        const parsed = parseJsonToolResult(result);
        if (parsed !== null && parsed !== undefined) {
            return parsed;
        }
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (text) {
            return parseJsonToolResult(text);
        }
        return null;
    };

    const autoStashService = {
        gitStatus: (repoPath) => callAgentTool('gitAgent', 'git_status', { path: repoPath }, { raw: true }),
        gitStash: (payload) => callAgentTool('gitAgent', 'git_stash', payload, { raw: true }),
        gitStashPop: (payload) => callAgentTool('gitAgent', 'git_stash_pop', payload, { raw: true })
    };

    const listRepos = async () => {
        const seen = new Set();
        const results = [];
        const scanPaths = getRepoScanPaths({ rootHint: reposRoot });
        for (const scanPath of scanPaths) {
            if (!scanPath) continue;
            try {
                const payload = await callGitTool('git_repos_overview', { path: scanPath }) || {};
                const repos = Array.isArray(payload?.repos) ? payload.repos : [];
                for (const repo of repos) {
                    const repoPath = String(repo?.path || '').trim();
                    if (!repoPath || seen.has(repoPath)) continue;
                    seen.add(repoPath);
                    results.push(repoPath);
                }
            } catch {
                // try next path
            }
        }
        return results;
    };

    const getRepoStatus = async (repoPath) => {
        const payload = await callGitTool('git_status', { path: repoPath }) || {};
        const status = payload?.status || payload || {};
        return {
            ...status,
            mergeInProgress: Boolean(payload?.mergeInProgress ?? status?.mergeInProgress)
        };
    };

    const repoHasConflicts = (status) => normalizeGitStatusPayload(status).counts.conflicted > 0;

    const buildStageList = (status) => {
        const { paths } = normalizeGitStatusPayload(status);
        const ignored = new Set((Array.isArray(paths.ignored) ? paths.ignored : []).map((value) => String(value || '').trim()));
        return Array.from(new Set([...paths.unstaged, ...paths.untracked]))
            .filter((value) => {
                const candidate = String(value || '').trim();
                if (!candidate) return false;
                if (ignored.has(candidate)) return false;
                for (const ignoredPath of ignored.values()) {
                    if (ignoredPath && candidate.startsWith(`${ignoredPath.replace(/\/+$/g, '')}/`)) {
                        return false;
                    }
                }
                return true;
            });
    };

    const hasAnyChanges = (status) => {
        const { counts } = normalizeGitStatusPayload(status);
        return counts.staged + counts.unstaged + counts.untracked > 0;
    };

    const showAutocommitStopped = (message) => {
        clearAutocommitTimer();
        setErrorFlag(true);
        updateGitButtonIndicator();
        fileExp.showStatus(`AutoSync stopped: ${message}`, true);
    };

    const setConflictAndStop = (message, repoPath = null) => {
        setConflictFlag(true);
        updateGitButtonIndicator();
        showAutocommitStopped(message || 'Merge conflicts detected.');
        void openGitPanel({
            openConflictHelper: true,
            selectedRepoPath: repoPath || null
        });
    };

    const isAutoresolveEnabled = () => getConflictAutoresolveSetting();

    const pullRepoWithToken = async (repoPath, token) => {
        const payload = { path: repoPath, ffOnly: false, rebase: false };
        const cleanToken = String(token || '').trim();
        if (cleanToken) payload.token = cleanToken;
        await callAgentTool('gitAgent', 'git_pull', payload);
    };

    const pushAutocommitRepo = async (repoPath, token) => {
        const push = () => callAgentTool('gitAgent', 'git_push', {
            path: repoPath,
            token: String(token || '').trim() || undefined
        });
        const pushResult = await pushWithNonFastForwardRetry({
            push,
            synchronize: () => pullRepoWithToken(repoPath, token)
        });
        if (pushResult.ok) {
            setPushWarning('');
            return true;
        }

        const isSynchronizationFailure = pushResult.phase === 'synchronize';
        const rawMessage = normalizeErrorMessage(pushResult.error);
        const msg = isSynchronizationFailure
            ? humanizeGitError(rawMessage, { action: 'pull' })
            : rawMessage;
        setPushWarning('Autocommit created commits but push failed. Please push manually.');
        if (isGitConflictError(msg)) {
            setConflictAndStop('Remote changes conflict with the AutoSync commit.', repoPath);
            return false;
        }
        if (isGitAuthError(msg)) {
            showAutocommitStopped(token ? `${msg} (A token is already saved. Use “Token” to update it.)` : msg);
            return false;
        }
        if (isGitIdentityError(msg)) {
            showAutocommitStopped('Set name, email, and token in Git settings to continue.');
            return false;
        }
        showAutocommitStopped(msg || (isSynchronizationFailure
            ? 'Could not integrate remote changes after the push was rejected.'
            : 'Push failed.'));
        return false;
    };

    const completePendingAutocommitMerge = async (repoPath, status, rememberedIdentity) => {
        if (!status?.mergeInProgress) return { ok: true, completed: false };
        if (repoHasConflicts(status)) {
            setConflictAndStop('Merge conflicts detected.', repoPath);
            return { ok: false, completed: false };
        }
        const userName = String(rememberedIdentity.name || '').trim();
        const userEmail = String(rememberedIdentity.email || '').trim();
        if (!userName || !userEmail) {
            showAutocommitStopped('Set name, email, and token in Git settings to continue.');
            return { ok: false, completed: false };
        }
        try {
            await callAgentTool('gitAgent', 'git_commit', {
                path: repoPath,
                useExistingMessage: true,
                userName,
                userEmail
            });
            return { ok: true, completed: true };
        } catch (error) {
            const msg = normalizeErrorMessage(error);
            if (isGitIdentityError(msg)) {
                showAutocommitStopped('Set name, email, and token in Git settings to continue.');
            } else {
                showAutocommitStopped(msg || 'Could not complete the resolved merge.');
            }
            return { ok: false, completed: false };
        }
    };

    const restoreStash = async (repoPath, stashRef) => {
        return restoreStashFlow({
            service: autoStashService,
            repoPath,
            stashRef,
            setStatusLine: (message, isError = false) => {
                if (message) {
                    fileExp.showStatus(message, isError);
                }
            }
        });
    };

    const rollbackAutoStash = async (repoPath, stashRef) => {
        fileExp.showStatus('Restoring stashed changes...');
        const restored = await restoreStash(repoPath, stashRef);
        await refreshGitSurfaces();
        return restored;
    };

    const pullWithAutoStash = async (repoPath, token) => {
        const result = await pullWithAutoStashFlow({
            service: autoStashService,
            repoPath,
            token,
            gitPullWithToken: pullRepoWithToken,
            restoreStash: (nextRepoPath, nextStashRef) => rollbackAutoStash(nextRepoPath, nextStashRef),
            setStatusLine: (message, isError = false) => {
                if (message) {
                    fileExp.showStatus(message, isError);
                }
            }
        });
        if (result.ok) {
            return { ok: true };
        }
        return {
            ok: false,
            conflicts: Boolean(result.conflicts || result.reason === 'pull_conflicts'),
            message: result.message || 'Pull failed.'
        };
    };

    const resolveConflictContent = (payload) => {
        if (!payload) return '';
        if (typeof payload === 'string') return payload;
        if (typeof payload.content === 'string') return payload.content;
        if (typeof payload.merged === 'string') return payload.merged;
        if (typeof payload.output === 'string') return payload.output;
        if (typeof payload.resolution === 'string') return payload.resolution;
        return '';
    };

    const joinPath = (base, file) => {
        const left = normalizeSlashes(base).replace(/\/+$/g, '');
        const right = normalizeSlashes(file).replace(/^\/+/g, '');
        return `${left}/${right}`;
    };

    const autoResolveConflicts = async (repoPath, source = 'merge') => {
        if (!isAutoresolveEnabled()) return { ok: false, message: '' };
        try {
            fileExp.showStatus('Auto-resolving conflicts...');
            const statusPayload = await getRepoStatus(repoPath);
            const normalized = normalizeGitStatusPayload(statusPayload);
            const conflictPaths = normalized.paths.conflicted;
            if (!conflictPaths.length) return { ok: true };
            for (const filePath of conflictPaths) {
                const versionsText = await callAgentTool('gitAgent', 'git_conflict_versions', {
                    path: repoPath,
                    file: filePath
                }, { raw: true });
                const versions = parseJsonToolResult(versionsText) || {};
                const localSide = (source === 'rebase' || source === 'stash') ? 'theirs' : 'ours';
                const oursContent = localSide === 'ours' ? (versions.ours || '') : (versions.theirs || '');
                const theirsContent = localSide === 'ours' ? (versions.theirs || '') : (versions.ours || '');
                const resolveText = await callAgentTool('gitAgent', 'git_resolve_conflict', {
                    base: versions.base || '',
                    ours: oursContent,
                    theirs: theirsContent,
                    source
                }, { raw: true });
                const resolvePayload = parseJsonToolResult(resolveText) || resolveText;
                const resolved = resolveConflictContent(resolvePayload);
                if (!resolved) {
                    return { ok: false, message: 'Autoresolve returned empty content.' };
                }
                const absolutePath = joinPath(repoPath, filePath);
                await fileExp.tooling.writeFile(absolutePath, resolved);
                fileExp.bumpWorkspaceVersion?.();
                await callAgentTool('gitAgent', 'git_stage', { path: repoPath, files: [filePath] });
            }
            const afterPayload = await getRepoStatus(repoPath);
            const afterNormalized = normalizeGitStatusPayload(afterPayload);
            if (afterNormalized.counts.conflicted > 0) {
                return { ok: false, message: '' };
            }
            setConflictFlag(false);
            updateGitButtonIndicator();
            fileExp.showStatus('Conflicts auto-resolved.');
            return { ok: true };
        } catch (error) {
            const msg = normalizeErrorMessage(error);
            if (msg.toLowerCase().includes('git_resolve_conflict') && msg.toLowerCase().includes('not found')) {
                return { ok: false, message: 'Autoresolve unavailable: git_resolve_conflict tool not found.' };
            }
            return { ok: false, message: msg };
        }
    };

    const runAutocommitTick = async () => {
        if (autocommit.running) return;
        const { repos } = getAutocommitSettings();
        if (getConflictFlag() && !isAutoresolveEnabled()) return;
        if (!Array.isArray(repos) || repos.length === 0) return;
        autocommit.running = true;
        try {
            const token = '';
            const rememberedIdentity = getRememberedGitIdentity();
            const repoList = repos.filter(Boolean);
            if (!repoList.length) return;
            let committedAny = false;

            for (const repoPath of repoList) {
                if (getConflictFlag()) return;
                let initialStatus = await getRepoStatus(repoPath);
                if (normalizeGitStatusPayload(initialStatus).counts.conflicted > 0) {
                    const resolved = await autoResolveConflicts(repoPath, 'merge');
                    if (!resolved.ok) {
                        setConflictAndStop(resolved.message || 'Merge conflicts detected.', repoPath);
                        return;
                    }
                    initialStatus = await getRepoStatus(repoPath);
                }
                const initialMerge = await completePendingAutocommitMerge(repoPath, initialStatus, rememberedIdentity);
                if (!initialMerge.ok) return;
                if (initialMerge.completed) {
                    committedAny = true;
                    if (!await pushAutocommitRepo(repoPath, token)) return;
                    continue;
                }
                if (!hasAnyChanges(initialStatus)) {
                    continue;
                }
                try {
                    await pullRepoWithToken(repoPath, token);
                } catch (error) {
                    const msg = humanizeGitError(normalizeErrorMessage(error), { action: 'pull' });
                    if (isGitIdentityError(msg)) {
                        showAutocommitStopped('Set name, email, and token in Git settings to continue.');
                        return;
                    }
                    if (isGitAuthError(msg)) {
                        showAutocommitStopped(token ? `${msg} (A token is already saved. Use “Token” to update it.)` : msg);
                        return;
                    }
                    if (isGitConflictError(msg)) {
                        const resolved = await autoResolveConflicts(repoPath, 'merge');
                        if (!resolved.ok) {
                            setConflictAndStop(resolved.message || 'Merge conflicts detected.', repoPath);
                            return;
                        }
                    } else if (isGitPullBlockedError(msg)) {
                        const stashed = await pullWithAutoStash(repoPath, token);
                        if (!stashed.ok) {
                            if (stashed.conflicts) {
                                const resolved = await autoResolveConflicts(repoPath, 'stash');
                                if (!resolved.ok) {
                                    setConflictAndStop(resolved.message || stashed.message || 'Conflicts after restoring stashed changes.', repoPath);
                                    return;
                                }
                            } else {
                                showAutocommitStopped(stashed.message || 'Pull blocked: could not auto-stash your local changes.');
                                return;
                            }
                        }
                    } else {
                        showAutocommitStopped(msg || 'Pull failed.');
                        return;
                    }
                }

                let status = await getRepoStatus(repoPath);
                if (repoHasConflicts(status)) {
                    const resolved = await autoResolveConflicts(repoPath, 'merge');
                    if (!resolved.ok) {
                        setConflictAndStop(resolved.message || 'Merge conflicts detected.', repoPath);
                        return;
                    }
                    status = await getRepoStatus(repoPath);
                }
                const recoveredMerge = await completePendingAutocommitMerge(repoPath, status, rememberedIdentity);
                if (!recoveredMerge.ok) return;
                if (recoveredMerge.completed) {
                    committedAny = true;
                    if (!await pushAutocommitRepo(repoPath, token)) return;
                    continue;
                }
                if (!hasAnyChanges(status)) {
                    continue;
                }
                const stageList = buildStageList(status);
                if (stageList.length) {
                    await callAgentTool('gitAgent', 'git_stage', { path: repoPath, files: stageList });
                }
                const after = await getRepoStatus(repoPath);
                const staged = normalizeGitStatusPayload(after).paths.staged;
                if (!staged.length) {
                    continue;
                }
                const userName = String(rememberedIdentity.name || '').trim();
                const userEmail = String(rememberedIdentity.email || '').trim();
                if (!userName || !userEmail) {
                    showAutocommitStopped('Set name, email, and token in Git settings to continue.');
                    return;
                }
                try {
                    await callAgentTool('gitAgent', 'git_commit', {
                        path: repoPath,
                        message: AUTOCOMMIT_MESSAGE,
                        userName: userName || null,
                        userEmail: userEmail || null
                    });
                    committedAny = true;
                } catch (error) {
                    const msg = normalizeErrorMessage(error);
                    if (isGitIdentityError(msg)) {
                        showAutocommitStopped('Set name, email, and token in Git settings to continue.');
                        return;
                    }
                    if (isGitConflictError(msg)) {
                        setConflictAndStop('Merge conflicts detected.', repoPath);
                        return;
                    }
                    showAutocommitStopped(msg || 'Commit failed.');
                    return;
                }

                if (!await pushAutocommitRepo(repoPath, token)) return;
            }

            if (committedAny) {
                setErrorFlag(false);
                updateGitButtonIndicator();
                if (typeof fileExp.refresh === 'function') {
                    await fileExp.refresh();
                }
                await refreshOpenGitPanels();
                fileExp.showStatus('AutoSync complete.');
            }
        } catch {
            // ignore autocommit failures to avoid spamming; next tick will retry
        } finally {
            autocommit.running = false;
        }
    };

    const syncConflictFlagFromRepos = async () => {
        try {
            const repos = await listRepos();
            for (const repoPath of repos) {
                const status = await getRepoStatus(repoPath);
                if (repoHasConflicts(status)) {
                    setConflictFlag(true);
                    updateGitButtonIndicator();
                    return true;
                }
            }
            setConflictFlag(false);
            updateGitButtonIndicator();
            return false;
        } catch {
            updateGitButtonIndicator();
            return getConflictFlag();
        }
    };

    async function openGitPanel(options = {}) {
        const repoPath = reposRoot;
        ensureAutocommitTimer();
        const conflictSyncPromise = syncConflictFlagFromRepos();
        const closed = assistOS.UI.openExpandedModal({
            title: 'Git',
            component: fileExp.toolbarModal?.component || 'git-panel',
            fullscreen: true,
            props: {
                repoPath,
                openConflictHelper: Boolean(options.openConflictHelper),
                selectedRepoPath: options.selectedRepoPath || null
            }
        });
        await conflictSyncPromise;
        await closed;
    }

    updateGitButtonIndicator();
    ensureAutocommitTimer();
    const handleStorageEvent = (event) => {
        if (!event?.key) return;
        if (event.key.startsWith('webskel.git.autocommit.')) {
            ensureAutocommitTimer();
            return;
        }
        if (event.key === 'webskel.git.conflicts') {
            updateGitButtonIndicator();
            ensureAutocommitTimer();
        }
        if (event.key === 'webskel.git.errors') {
            updateGitButtonIndicator();
        }
    };
    const handleAutocommitSettingsChanged = () => {
        ensureAutocommitTimer();
    };
    const handleAutocommitReset = () => {
        clearAutocommitTimer();
        ensureAutocommitTimer();
    };
    const handleAutocommitStop = (event) => {
        clearAutocommitTimer();
        setErrorFlag(true);
        updateGitButtonIndicator();
        const message = String(event?.detail?.message || '').trim();
        if (message) {
            fileExp.showStatus(`AutoSync stopped: ${message}`, true);
        }
    };
    const handleFileExpRefresh = async () => {
        if (typeof fileExp.refresh === 'function') {
            await fileExp.refresh();
        }
        await syncConflictFlagFromRepos();
        ensureAutocommitTimer();
    };
    const handleGitPanelClosed = () => {
        updateGitButtonIndicator();
        syncConflictFlagFromRepos()
            .catch(() => {})
            .finally(() => {
                ensureAutocommitTimer();
            });
    };

    setWindowListener('git-storage', 'storage', handleStorageEvent);
    setWindowListener('git-autocommit-settings-changed', AUTOCOMMIT_SETTINGS_CHANGED_EVENT, handleAutocommitSettingsChanged);
    setWindowListener('git-autocommit-reset', AUTOCOMMIT_RESET_EVENT, handleAutocommitReset);
    setWindowListener('git-autocommit-stop', AUTOCOMMIT_STOP_EVENT, handleAutocommitStop);
    setWindowListener('git-file-exp-refresh', FILE_EXP_REFRESH_EVENT, handleFileExpRefresh);
    setWindowListener('git-panel-closed', GIT_PANEL_CLOSED_EVENT, handleGitPanelClosed);
    fileExp.registerCleanup?.(() => {
        clearAutocommitTimer();
    });

    Object.assign(fileExp, {
        openGitPanel,
        updateGitButtonIndicator,
        ensureAutocommitTimer
    });
}
