import {
    isReposRootPath,
    isAgentRepoPath,
    getVisibleRepoOverviews,
    getAutocommitSettings,
    getShowAgentReposSetting,
    getConflictAutoresolveSetting,
    getRememberedGitIdentity,
    getRememberedGitAuthMethod,
    getRememberedGithubConnection,
    normalizeGitAuthMethod
} from "./git-panel-utils.js";

export function createGitCommitUI(ctx) {
    const {
        element,
        state,
        setMenuAbortController,
        selectConflictFile,
    } = ctx;

    const bindEvents = () => {
        if (!element.dataset.boundCommitMenu) {
            const closeIfOutside = (event) => {
                const root = element.querySelector('#gitActionsSplit');
                const inside = root && (event.target === root || root.contains(event.target));
                if (!inside) closeActionsMenu();
                if (!event.target?.closest?.('.git-file-menu')) {
                    closeFileMenus();
                }
            };
            const controller = new AbortController();
            setMenuAbortController(controller);
            document.addEventListener('pointerdown', closeIfOutside, {
                capture: true,
                signal: controller.signal
            });
            element.dataset.boundCommitMenu = 'true';
        }

        const changesRoot = element.querySelector('.git-changes');
        if (changesRoot && !changesRoot.dataset.bound) {
            // Selection is handled via WebSkel `data-local-action` on checkboxes.
            changesRoot.dataset.bound = 'true';
        }

    };

    const syncStaticUI = () => {
        const subtitle = element.querySelector('#gitRepoSubtitle');
        if (subtitle) {
            subtitle.textContent = `Repository: ${state.repoPath}`;
        }

        const modalRoot = element.classList.contains('git-panel') ? element : element.querySelector('.git-panel');
        if (modalRoot) {
            const gateActive = Boolean(state.credentialsGate);
            const credentialsVisible = gateActive
                || Boolean(state.credentialsOpen)
                || Boolean(state.identityPrompt?.visible)
                || Boolean(state.authPrompt?.visible);
            modalRoot.classList.toggle('git-credentials-only', gateActive);
            modalRoot.classList.toggle('git-credentials-open', credentialsVisible);
        }

        updateConflictHelper();
        updateStatusBar();
        updateConflictBanner();
        updatePullBlockedPanel();
        updateCommitBody();
        updateRepoTree();
    };

    const getCredentialsPromptPresenter = () => element.querySelector('git-credentials-prompt')?.webSkelPresenter || null;
    const getConflictHelperPresenter = () => element.querySelector('git-conflict-helper')?.webSkelPresenter || null;
    const getConflictBannerPresenter = () => element.querySelector('git-conflict-banner')?.webSkelPresenter || null;
    const getCommitBodyPresenter = () => element.querySelector('git-commit-body')?.webSkelPresenter || null;
    const getCommitActionsPresenter = () => element.querySelector('git-commit-actions')?.webSkelPresenter || null;
    const getRepoTreePresenter = () => element.querySelector('git-repo-tree')?.webSkelPresenter || null;
    let credentialsPromptVisible = false;

    const getGithubIdentityFallback = () => {
        const githubUser = state.githubAuth?.connection?.user || {};
        return {
            name: String(githubUser?.login || githubUser?.name || '').trim(),
            email: String(githubUser?.email || '').trim()
        };
    };

    const updateCredentialsPrompt = (options = {}) => {
        const identityState = state.identityPrompt || {};
        const authState = state.authPrompt || {};
        const autocommit = getAutocommitSettings();
        const autoresolveSaved = getConflictAutoresolveSetting();
        const rememberedIdentity = getRememberedGitIdentity();
        const rememberedAuthMethod = getRememberedGitAuthMethod();
        const rememberedGithubConnection = getRememberedGithubConnection();
        const autocommitDraft = state.autocommitDraft || {};
        const autoresolveDraft = state.autoresolveDraft || {};
        const repoOverviews = Array.isArray(state.repoOverviews) ? state.repoOverviews : [];
        const autocommitRepos = repoOverviews
            .map((repo) => ({
                path: repo?.path || '',
                name: repo?.name || repo?.relativePath || repo?.path || '',
                isAgentRepo: isAgentRepoPath(repo?.path || ''),
                group: isAgentRepoPath(repo?.path || '') ? 'agents' : 'workspace'
            }))
            .filter((repo) => repo.path && repo.name);
        const savedRepos = Array.isArray(autocommit.repos) ? autocommit.repos : null;
        const draftRepos = Array.isArray(autocommitDraft.repos) ? autocommitDraft.repos : null;
        const draftInterval = Number(autocommitDraft.intervalMinutes);
        const useDraft = Boolean(state.autocommitDirty);
        const useAutoresolveDraft = Boolean(state.autoresolveDirty);
        const intervalMinutes = useDraft && Number.isFinite(draftInterval)
            ? draftInterval
            : Number(autocommit.intervalMinutes || 15);
        const autocommitSelected = savedRepos !== null ? savedRepos : null;
        const showAgentRepos = Boolean(state.showAgentRepos ?? getShowAgentReposSetting());
        const autoresolveConflicts = useAutoresolveDraft
            ? Boolean(autoresolveDraft.enabled)
            : Boolean(autoresolveSaved);
        const visible = Boolean(
            identityState.visible
            || authState.visible
            || state.credentialsGate
            || state.credentialsOpen
        );
        const refreshAutocommitRepos = Boolean(options.refreshAutocommitRepos || (visible && !credentialsPromptVisible));
        credentialsPromptVisible = visible;
        const githubAuth = state.githubAuth || {};
        const githubConnection = githubAuth.connection || rememberedGithubConnection || {};
        const githubPending = githubAuth.pending || {};
        const githubError = String(githubAuth.error || '').trim();
        const githubConnectionSource = String(githubConnection?.source || '').trim().toLowerCase();
        const githubScope = String(githubConnection?.scope || '').trim();
        const githubScopes = githubScope
            ? githubScope.split(',').map((value) => value.trim()).filter(Boolean)
            : [];
        const githubHasRepoScope = githubScopes.includes('repo') || githubScopes.includes('public_repo');
        const githubIdentity = getGithubIdentityFallback();
        const tokenValue = authState.token || '';
        const tokenStored = Boolean(githubAuth.tokenStored);
        const githubConnected = Boolean(githubAuth.connected && githubConnectionSource === 'github');
        const preferredGithub = Boolean(
            githubConnected
            && !authState.token
            && !state.credentialsDirty
        );
        const authMethod = preferredGithub
            ? 'github'
            : normalizeGitAuthMethod(authState.authMethod || rememberedAuthMethod);
        const fallbackToGithubIdentity = Boolean(
            githubConnected
            && authMethod === 'github'
            && !state.credentialsDirty
        );
        const resolvedName = identityState.name || rememberedIdentity.name || (fallbackToGithubIdentity ? githubIdentity.name : '');
        const resolvedEmail = identityState.email || rememberedIdentity.email || (fallbackToGithubIdentity ? githubIdentity.email : '');
        const detail = {
            visible,
            name: resolvedName,
            email: resolvedEmail,
            authMethod,
            token: tokenValue,
            authRequired: Boolean(authState.visible),
            credentialsDirty: Boolean(state.credentialsDirty),
            autocommitDirty: Boolean(state.autocommitDirty),
            autoresolveDirty: Boolean(state.autoresolveDirty),
            tokenStored,
            githubConfigured: Boolean(githubAuth.configured),
            githubConnected,
            githubError,
            githubUserLabel: githubConnection?.user?.login || githubConnection?.user?.name || '',
            githubScope,
            githubHasRepoScope,
            githubPending: Boolean(githubPending.userCode || githubPending.verificationUri),
            githubVerificationUri: githubPending.verificationUriComplete || githubPending.verificationUri || '',
            githubUserCode: githubPending.userCode || '',
            autocommitReposLoading: Boolean(state.repoOverviewsLoading),
            autocommitReposLoaded: Boolean(state.repoOverviewsLoaded),
            autocommitIntervalMinutes: intervalMinutes,
            autocommitRepos,
            autocommitSelected: useDraft ? draftRepos : autocommitSelected,
            showAgentRepos,
            refreshAutocommitRepos,
            autoresolveConflicts
        };
        const presenter = getCredentialsPromptPresenter();
        if (!presenter?.setState) return;
        if (options.focus) detail.focus = options.focus;
        if (options.activeTab) detail.activeTab = options.activeTab;
        presenter.setState(detail);
    };

    const updateIdentityPrompt = (options = {}) => {
        updateCredentialsPrompt(options);
    };

    const updateAuthPrompt = (options = {}) => {
        updateCredentialsPrompt(options);
    };

    const updateCommitBody = () => {
        const body = element.querySelector('git-commit-body');
        if (!body) return;
        const visible = !state.conflictFocus && !state.credentialsGate;
        const detail = {
            visible,
            repoPath: state.repoPath || ''
        };
        const presenter = getCommitBodyPresenter();
        presenter?.setState?.(detail);
    };

    const updateStatusBar = () => {
        const presenter = element.querySelector('git-status-bar')?.webSkelPresenter;
        if (!presenter?.setState) return;
        const message = state.lastStatusLine || '';
        presenter.setState({
            text: message,
            isError: Boolean(state.lastStatusIsError)
        });
    };

    const updateConflictBanner = () => {
        const presenter = getConflictBannerPresenter();
        if (!presenter?.setState) return;
        presenter.setState({
            visible: Boolean(state.hasConflicts) && !state.conflictFocus,
            count: Number(state.conflictCount || 0)
        });
    };

    const updateRepoTree = () => {
        const presenter = getRepoTreePresenter();
        if (!presenter?.setState) return;
        presenter.setState({
            reposRoot: state.reposRoot || '',
            repos: getVisibleRepoOverviews(state.repoOverviews, state.showAgentRepos),
            loading: Boolean(state.repoOverviewsLoading && !state.suppressInlineLoading),
            repoTreeExpanded: state.repoTreeExpanded || {},
            repoChangesExpanded: state.repoChangesExpanded || {},
            treeExpandedByRepo: state.treeExpandedByRepo || {},
            selectionState: state.selectedFilesByRepo || {},
            selectedPath: state.selectedPath || '',
            selectedRepoPath: state.selectedRepoPath || state.repoPath || ''
        });
    };

    const getSelectedReposForBatch = () => {
        return Array.from(new Set([
            ...Object.entries(state.selectedFilesByRepo || {})
                .filter(([, entry]) => (entry?.files && entry.files.size > 0) || (entry?.prefixes && entry.prefixes.size > 0))
                .map(([repoPath]) => repoPath)
        ]));
    };

    const collectConflictItems = (repoPaths) => {
        const repos = Array.isArray(state.repoOverviews) ? state.repoOverviews : [];
        const targetSet = Array.isArray(repoPaths) && repoPaths.length ? new Set(repoPaths) : null;
        const items = [];
        const manual = Array.isArray(state.manualConflicts) ? state.manualConflicts : [];
        if (!repos.length && !manual.length) return [];
        for (const repo of repos) {
            if (!repo?.path) continue;
            if (targetSet && !targetSet.has(repo.path)) continue;
            const conflicted = Array.isArray(repo?.changes?.conflicted) ? repo.changes.conflicted : [];
            for (const filePath of conflicted) {
                if (!filePath) continue;
                items.push({
                    repoPath: repo.path,
                    filePath,
                    repoLabel: repo.name || repo.path.split('/').filter(Boolean).slice(-1)[0] || repo.path
                });
            }
        }
        items.sort((a, b) => {
            const repoCompare = a.repoPath.localeCompare(b.repoPath);
            if (repoCompare !== 0) return repoCompare;
            return a.filePath.localeCompare(b.filePath);
        });
        if (manual.length) {
            const seen = new Set(items.map((item) => `${item.repoPath}::${item.filePath}`));
            for (const entry of manual) {
                if (!entry?.repoPath || !entry?.filePath) continue;
                if (targetSet && !targetSet.has(entry.repoPath)) continue;
                const key = `${entry.repoPath}::${entry.filePath}`;
                if (seen.has(key)) continue;
                items.push({
                    repoPath: entry.repoPath,
                    filePath: entry.filePath,
                    repoLabel: entry.repoPath.split('/').filter(Boolean).slice(-1)[0] || entry.repoPath
                });
                seen.add(key);
            }
        }
        return items;
    };

    const resolveConflictTargets = () => {
        const manual = Array.isArray(state.manualConflicts) ? state.manualConflicts : [];
        if (manual.length) {
            return Array.from(new Set(manual.map((entry) => entry?.repoPath).filter(Boolean)));
        }
        const selectedRepo = state.selectedRepoPath;
        if (selectedRepo && !isReposRootPath(selectedRepo, state.reposRoot)) {
            return [selectedRepo];
        }
        const selected = getSelectedReposForBatch();
        if (selected.length) return selected;
        if (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot)) {
            return [state.repoPath];
        }
        return null;
    };

    const updateConflictHelper = () => {
        const allItems = collectConflictItems(null);
        state.hasConflicts = allItems.length > 0;
        state.conflictCount = allItems.length;
        if (state.conflictSource === 'rebase' && state.pullMode !== 'rebase') {
            state.conflictSource = 'merge';
        }
        const helper = element.querySelector('git-conflict-helper');
        if (!helper) return;
        const targetRepos = resolveConflictTargets();
        const items = targetRepos ? collectConflictItems(targetRepos) : allItems;
        if (!items.length) {
            if (state.conflictFocus) {
                state.conflictFocus = false;
            }
            state.conflictSource = null;
            state.manualConflicts = [];
            state.conflictHelper = {
                selected: null,
                ours: '',
                theirs: '',
                oursConflictRanges: [],
                theirsConflictRanges: [],
                choice: '',
                status: '',
                loading: false,
                requestKey: null
            };
            const detail = {
                visible: false,
                files: [],
                selected: null,
                ours: '',
                theirs: '',
                oursConflictRanges: [],
                theirsConflictRanges: [],
                choice: '',
                status: '',
                loading: false
            };
            const presenter = getConflictHelperPresenter();
            presenter?.setState?.(detail);
            return;
        }
        const hasMultipleRepos = new Set(items.map((item) => item.repoPath)).size > 1;
        const files = items.map((item) => ({
            repoPath: item.repoPath,
            filePath: item.filePath,
            label: hasMultipleRepos ? `${item.repoLabel}: ${item.filePath}` : item.filePath
        }));

        let helperState = state.conflictHelper || {};
        let selected = helperState.selected;
        const selectedValid = selected && files.some((file) => file.repoPath === selected.repoPath && file.filePath === selected.filePath);
        if (!selectedValid) {
            selected = null;
        }
        let selectionChanged = false;
        if (!selected && files.length) {
            selected = { repoPath: files[0].repoPath, filePath: files[0].filePath };
            selectionChanged = true;
            helperState = {
                ...helperState,
                selected,
                ours: '',
                theirs: '',
                oursConflictRanges: [],
                theirsConflictRanges: [],
                choice: '',
                status: '',
                loading: false,
                requestKey: null
            };
            state.conflictHelper = helperState;
        }

        const detail = {
            visible: Boolean(state.conflictFocus),
            files,
            selected: helperState.selected || selected,
            ours: helperState.ours || '',
            theirs: helperState.theirs || '',
            oursConflictRanges: Array.isArray(helperState.oursConflictRanges) ? helperState.oursConflictRanges : [],
            theirsConflictRanges: Array.isArray(helperState.theirsConflictRanges) ? helperState.theirsConflictRanges : [],
            choice: helperState.choice || '',
            status: helperState.status || '',
            loading: Boolean(helperState.loading),
            source: state.conflictSource || ''
        };
        const presenter = getConflictHelperPresenter();
        presenter?.setState?.(detail);

        if (selectionChanged && typeof selectConflictFile === 'function') {
            selectConflictFile(selected);
        }
    };

    const getRepoLabel = (repoPath) => {
        if (!repoPath) return '';
        const repo = Array.isArray(state.repoOverviews)
            ? state.repoOverviews.find((entry) => entry?.path === repoPath)
            : null;
        return repo?.name || repoPath.split('/').filter(Boolean).slice(-1)[0] || repoPath;
    };

    const updatePullBlockedPanel = () => {
        const presenter = element.querySelector('git-pull-blocked-panel')?.webSkelPresenter;
        if (!presenter) return;
        const blocked = state.pullBlocked;
        const files = Array.isArray(blocked?.files) ? blocked.files : [];
        if (!blocked || !files.length) {
            presenter.setState({ visible: false, files: [] });
            return;
        }
        const repoLabel = getRepoLabel(blocked.repoPath);
        const showRepo = Boolean(repoLabel);
        const list = files.filter(Boolean).map((filePath) => ({
            repoPath: blocked.repoPath || '',
            filePath,
            label: showRepo ? `${repoLabel}: ${filePath}` : filePath
        }));
        presenter.setState({
            visible: true,
            repoLabel,
            files: list
        });
    };

    const hasConflictsForRepos = (repoPaths) => {
        return collectConflictItems(repoPaths).length > 0;
    };

    const hasPullBlockedForRepos = (repoPaths) => {
        const blocked = state.pullBlocked;
        if (!blocked?.files?.length) return false;
        const repoPath = blocked.repoPath;
        if (!repoPath) return true;
        const list = Array.isArray(repoPaths) ? repoPaths : [];
        return list.includes(repoPath);
    };

    const updateCommitButtons = () => {
        const actionsButton = element.querySelector('#gitActionsButton');
        const selectedRepos = Array.from(new Set([
            ...Object.entries(state.selectedFilesByRepo || {})
                .filter(([, entry]) => (entry?.files && entry.files.size > 0) || (entry?.prefixes && entry.prefixes.size > 0))
                .map(([repoPath]) => repoPath)
        ]));
        const repoOk = state.repoInfoOk !== false;
        const identityBlocking = Boolean(state.identityPrompt?.visible);
        const authBlocking = Boolean(state.authPrompt?.visible);
        const hasSelection = selectedRepos.length > 0;
        const selectedRepoSet = new Set(selectedRepos);
        const pendingMerge = (state.repoOverviews || [])
            .some((repo) => selectedRepoSet.has(repo?.path) && repo?.mergeInProgress);
        const actionRepoPaths = hasSelection
            ? selectedRepos
            : (state.repoPath && !isReposRootPath(state.repoPath, state.reposRoot) ? [state.repoPath] : []);
        const actionRepoSet = new Set(actionRepoPaths);
        const actionPendingMerges = (state.repoOverviews || [])
            .filter((repo) => actionRepoSet.has(repo?.path) && repo?.mergeInProgress);
        const actionHasPendingMerge = actionPendingMerges.length > 0;
        if (!actionHasPendingMerge) {
            state.mergeMessageSource = null;
        } else if (actionPendingMerges.length === 1) {
            const mergeRepo = actionPendingMerges[0];
            const mergeMessage = String(mergeRepo?.mergeMessage || '').trim();
            const source = mergeMessage ? `${mergeRepo.path}\u0000${mergeMessage}` : null;
            if (source && !String(state.commitMessage || '').trim() && state.mergeMessageSource !== source) {
                state.commitMessage = mergeMessage;
                state.mergeMessageSource = source;
            }
        }
        const messageOk = Boolean((state.commitMessage || '').trim());
        const conflictBlocking = hasConflictsForRepos(selectedRepos);
        const pullBlocked = hasPullBlockedForRepos(selectedRepos);
        const commitAllowed = !identityBlocking && !authBlocking && !conflictBlocking && !pullBlocked
            && hasSelection && (messageOk || pendingMerge);
        const pushAllowed = !identityBlocking && !authBlocking && (repoOk || hasSelection);
        const pullAllowed = !identityBlocking && !authBlocking && hasSelection;
        const disabled = !commitAllowed && !pushAllowed && !pullAllowed;
        const presenter = getCommitActionsPresenter();
        if (presenter?.setState) {
            presenter.setState({
                actionsDisabled: disabled,
                hiddenActions: actionHasPendingMerge ? ['push', 'stash', 'unstash'] : [],
                commitMessage: state.commitMessage || ''
            });
        } else if (actionsButton) {
            actionsButton.disabled = disabled;
        }
    };

    const updateCommitMessage = (input) => {
        const value = typeof input === 'string' ? input : (input?.value || '');
        state.commitMessage = value;
        const presenter = getCommitActionsPresenter();
        presenter?.setState?.({ commitMessage: value });
        updateCommitButtons();
    };

    const toggleActionsMenu = () => {
        const presenter = getCommitActionsPresenter();
        presenter?.toggleActionsMenu?.();
    };

    const closeActionsMenu = () => {
        const presenter = getCommitActionsPresenter();
        presenter?.closeActionsMenu?.();
    };

    const closeFileMenus = () => {
        const presenter = getRepoTreePresenter();
        presenter?.closeFileMenus?.();
    };

    const focusCommitMessage = () => {
        const presenter = getCommitActionsPresenter();
        presenter?.focusCommitMessage?.();
    };

    const toggleCredentials = () => {
        if (state.credentialsGate) {
            syncStaticUI();
            updateCredentialsPrompt();
            return;
        }
        state.credentialsOpen = !state.credentialsOpen;
        if (state.credentialsOpen) {
            closeActionsMenu();
        }
        syncStaticUI();
        updateCredentialsPrompt();
    };

    const closeCredentials = () => {
        state.credentialsOpen = false;
        state.identityPrompt = { visible: false, repoPath: null, pendingAction: null, name: '', email: '' };
        state.authPrompt = {
            visible: false,
            repoPath: null,
            pendingAction: null,
            token: '',
            authMethod: state.authPrompt?.authMethod || 'token'
        };
        syncStaticUI();
        updateCredentialsPrompt();
    };

    return {
        bindEvents,
        syncStaticUI,
        updateCredentialsPrompt,
        updateIdentityPrompt,
        updateAuthPrompt,
        updateCommitButtons,
        updateCommitMessage,
        toggleActionsMenu,
        closeActionsMenu,
        closeFileMenus,
        toggleCredentials,
        closeCredentials,
        focusCommitMessage,
        updateStatusBar,
        updateRepoTree
    };
}
