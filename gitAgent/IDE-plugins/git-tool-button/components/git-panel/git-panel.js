import { createGitCommitActions } from "./git-panel-actions.js";
import { createGitCommitDiff } from "./git-panel-diff.js";
import { createGitCommitRepo } from "./git-panel-repo.js";
import { createGitCommitService } from "./git-panel-service.js";
import { createGitCommitState } from "./git-panel-state.js";
import { createGitCommitUI } from "./git-panel-ui.js";
import { callExplorerTool, callAgentTool } from "/explorer/services/infrastructure/explorerApi.js";
import { joinPath } from "/explorer/web-components/pages/file-exp/file-exp-utils.js";
import {
    normalizeErrorMessage,
    parseJsonToolResult,
    isReposRootPath,
    buildPrefilledGitIdentityState,
    getRememberedGitIdentity,
    getRememberedGitAuthMethod,
    getRememberedGithubConnection,
    setRememberedGithubConnection,
    clearRememberedGithubConnection,
    normalizeGitAuthMethod,
    setGitErrorFlag,
    setShowAgentReposSetting
} from "./git-panel-utils.js";
import { FILE_EXP_REFRESH_EVENT } from "/explorer/utils/appEvents.js";
import { GIT_PANEL_CLOSED_EVENT } from "../../git-tool-button-events.js";

export class GitPanel {
    constructor(element, invalidate, props = {}) {
        this.element = element;
        this.invalidate = invalidate;
        this.props = props || {};
        this.statusCache = { at: 0, payload: null };
        this.diffCache = new Map();
        this.repoOverviewCache = { at: 0, list: [] };
        this.unloaded = false;
        this.githubPollTimer = null;
        this.githubStartPromise = null;
        this.menuAbortController = null;
        this.commitMessageBusy = false;
        this.panelBusyMessages = [];
        this.stateStore = createGitCommitState(props);
        this.state = this.stateStore.state;
        this.service = createGitCommitService({
            callTool: this.callTool.bind(this),
            callAgentTool: this.callAgentTool.bind(this)
        });
        this.repo = createGitCommitRepo({
            element: this.element,
            state: this.state,
            service: this.service,
            statusCache: this.statusCache,
            repoOverviewCache: this.repoOverviewCache,
            setStatusLine: this.setStatusLine.bind(this),
            updateCommitButtons: this.updateCommitButtons.bind(this),
            clearSelectedDiff: this.clearSelectedDiff.bind(this),
            refreshSelectedDiff: this.refreshSelectedDiff.bind(this)
        });
        this.diff = createGitCommitDiff({
            element: this.element,
            state: this.state,
            service: this.service,
            diffCache: this.diffCache
        });
        this.ui = createGitCommitUI({
            element: this.element,
            state: this.state,
            setState: this.setState.bind(this),
            setStateIn: this.setStateIn.bind(this),
            setMenuAbortController: (controller) => {
                this.menuAbortController = controller;
            },
            runGitAction: this.runGitAction.bind(this),
            openDiff: this.openDiff.bind(this),
            applyRepoPathFromInput: this.applyRepoPathFromInput.bind(this),
            refreshAction: this.refreshAction.bind(this),
            generateCommitMessage: this.generateCommitMessage.bind(this),
            toggleRepoChanges: this.toggleRepoChanges.bind(this),
            toggleRepoFolderExpanded: this.toggleRepoFolderExpanded.bind(this),
            toggleTreeFolder: this.toggleTreeFolder.bind(this),
            toggleTreePrefixSelectionCheckbox: this.toggleTreePrefixSelectionCheckbox.bind(this),
            toggleTreeFileSelectionCheckbox: this.toggleTreeFileSelectionCheckbox.bind(this),
            toggleRepoAllChangesCheckbox: this.toggleRepoAllChangesCheckbox.bind(this),
            openIgnoreForFile: this.openIgnoreForFile.bind(this),
            openIgnoreForFolder: this.openIgnoreForFolder.bind(this),
            removeIgnoreForFile: this.removeIgnoreForFile.bind(this),
            rollbackFile: this.rollbackFile.bind(this),
            deleteFile: this.deleteFile.bind(this),
            saveGitCredentials: this.saveGitCredentials.bind(this),
            cancelGitCredentials: this.cancelGitCredentials.bind(this),
            openIgnoreForDiff: this.openIgnoreForDiff.bind(this),
            selectConflictFile: this.selectConflictFile.bind(this),
            applyConflictChoice: this.applyConflictChoice.bind(this),
            saveConflictResolution: this.saveConflictResolution.bind(this),
            openConflictHelper: this.openConflictHelper.bind(this),
            cancelConflictResolution: this.cancelConflictResolution.bind(this)
        });
        this.actions = createGitCommitActions({
            getState: () => this.state,
            setState: this.setState.bind(this),
            setStateIn: this.setStateIn.bind(this),
            service: this.service,
            setStatusLine: this.setStatusLine.bind(this),
            updateCommitButtons: this.updateCommitButtons.bind(this),
            syncStaticUI: this.syncStaticUI.bind(this),
            updateIdentityPrompt: this.updateIdentityPrompt.bind(this),
            updateAuthPrompt: this.updateAuthPrompt.bind(this),
            closeActionsMenu: this.closeActionsMenu.bind(this),
            getSelectedReposForBatch: () => this.getSelectedReposForBatch(),
            getExplicitActionRepoPaths: this.getExplicitActionRepoPaths.bind(this),
            getPrimaryExplicitActionRepoPath: this.getPrimaryExplicitActionRepoPath.bind(this),
            getPathsForCommitInRepo: this.getPathsForCommitInRepo.bind(this),
            setCommitMessage: this.setCommitMessage.bind(this),
            setCommitMessageBusy: this.setCommitMessageBusy.bind(this),
            withPanelLoader: this.withPanelLoader.bind(this),
            clearCommitMessageInput: this.clearCommitMessageInput.bind(this),
            clearDiffCache: () => this.diffCache.clear(),
            loadRepoInfo: this.loadRepoInfo.bind(this),
            loadRepoOverviews: this.loadRepoOverviews.bind(this),
            refreshAll: this.refreshAll.bind(this),
            refreshAfterGitOperation: this.refreshAfterGitOperation.bind(this)
        });
        this.invalidate();
    }

    setState(patch = {}, options = {}) {
        this.stateStore.dispatch({ type: 'PATCH', payload: patch });
        if (!options.silent) {
            this.syncStaticUI();
        }
    }

    setStateIn(path, value, options = {}) {
        this.stateStore.dispatch({ type: 'SET_IN', payload: { path, value } });
        if (!options.silent) {
            this.syncStaticUI();
        }
    }

    beforeRender() {}

    getSelectedReposForBatch() {
        return this.stateStore.getSelectedReposForBatch();
    }

    getExplicitActionRepoPaths() {
        const selectedRepos = this.getSelectedReposForBatch();
        if (selectedRepos.length) {
            return selectedRepos;
        }
        const selectedRepoPath = this.state.selectedRepoPath || '';
        if (selectedRepoPath && !isReposRootPath(selectedRepoPath, this.state.reposRoot)) {
            return [selectedRepoPath];
        }
        const repoPath = this.state.repoPath || '';
        if (repoPath && !isReposRootPath(repoPath, this.state.reposRoot)) {
            return [repoPath];
        }
        return [];
    }

    getPrimaryExplicitActionRepoPath() {
        return this.getExplicitActionRepoPaths()[0] || '';
    }

    clearCommitMessageInput() {
        this.ui.updateCommitMessage('');
    }

    setCommitMessage(message) {
        const value = String(message || '').trim();
        this.ui.updateCommitMessage(value);
        this.ui.focusCommitMessage?.();
    }

    updateCommitMessageDraft(message) {
        const value = typeof message === 'string' ? message : String(message || '');
        this.ui.updateCommitMessage(value);
    }

    getEffectiveCredentialsAuthMethod() {
        const rawAuthMethod = normalizeGitAuthMethod(this.state.authPrompt?.authMethod ?? getRememberedGitAuthMethod());
        const currentToken = String(this.state.authPrompt?.token || '').trim();
        const githubConnected = Boolean(
            this.state.githubAuth?.connected
            && this.state.githubAuth?.connection?.source === 'github'
        );
        if (githubConnected && !currentToken && !this.state.credentialsDirty) {
            return 'github';
        }
        return rawAuthMethod;
    }

    handleCredentialsChange(detail = {}) {
        const prevName = String(this.state.identityPrompt?.name ?? '');
        const prevEmail = String(this.state.identityPrompt?.email ?? '');
        const prevToken = String(this.state.authPrompt?.token ?? '');
        const prevAuthMethod = this.getEffectiveCredentialsAuthMethod();
        const prevShowAgentRepos = Boolean(this.state.showAgentRepos);
        const authMethodChanged = Object.prototype.hasOwnProperty.call(detail, 'authMethod')
            && normalizeGitAuthMethod(detail.authMethod) !== prevAuthMethod;
        const nextName = String(detail.name ?? prevName);
        const nextEmail = String(detail.email ?? prevEmail);
        const nextToken = String(detail.token ?? prevToken);
        const nextAuthMethod = normalizeGitAuthMethod(detail.authMethod ?? prevAuthMethod);
        const nextShowAgentRepos = typeof detail.showAgentRepos === 'boolean' ? detail.showAgentRepos : prevShowAgentRepos;
        const patch = {};
        if (detail.autocommitDirty) {
            patch.autocommitDirty = true;
            patch.autocommitDraft = {
                intervalMinutes: detail.autocommitIntervalMinutes,
                repos: Array.isArray(detail.autocommitRepos) ? detail.autocommitRepos : null,
                showAgentRepos: typeof detail.showAgentRepos === 'boolean' ? detail.showAgentRepos : undefined
            };
        }
        if (typeof detail.showAgentRepos === 'boolean') {
            patch.showAgentRepos = detail.showAgentRepos;
        }
        if (detail.autoresolveDirty) {
            patch.autoresolveDirty = true;
            patch.autoresolveDraft = {
                enabled: Boolean(detail.autoresolveConflicts)
            };
        }
        if (detail.credentialsDirty) {
            const credentialsChanged = (
                prevName !== nextName
                || prevEmail !== nextEmail
                || prevToken !== nextToken
                || prevAuthMethod !== nextAuthMethod
            );
            if (credentialsChanged) {
                patch.credentialsValidated = false;
                patch.credentialsDirty = true;
            }
        }
        patch.identityPrompt = {
            ...this.state.identityPrompt,
            name: nextName,
            email: nextEmail
        };
        patch.authPrompt = {
            ...this.state.authPrompt,
            token: nextToken,
            authMethod: nextAuthMethod
        };
        this.setState(patch, { silent: true });
        if (typeof detail.showAgentRepos === 'boolean' && prevShowAgentRepos !== nextShowAgentRepos) {
            setShowAgentReposSetting(nextShowAgentRepos);
            this.applyDefaultRepoTreeExpansion();
            this.ui.updateCredentialsPrompt?.({ refreshAutocommitRepos: true });
            this.ui.updateRepoTree?.();
        }
        if (authMethodChanged) {
            this.updateIdentityPrompt();
        }
        if (authMethodChanged && nextAuthMethod === 'github') {
            queueMicrotask(() => {
                this.ensureGithubDeviceFlow({ silent: true }).catch(() => {});
            });
        }
    }

    afterUnload() {
        this.unloaded = true;
        this.clearGithubPollTimer();
        this.menuAbortController?.abort();
        this.menuAbortController = null;
        window.dispatchEvent(new CustomEvent(GIT_PANEL_CLOSED_EVENT));
    }

    peekSelectedFilesEntry(repoPath) {
        return this.repo.peekSelectedFilesEntry(repoPath);
    }

    afterRender() {
        if (!this.element.isConnected) return;
        this.bindEvents();
        this.initialLoad = (async () => {
            await this.withPanelLoader(async () => {
                await this.refreshGithubAuthStatus({ silent: true }).catch(() => {});

                if (this.unloaded) return;
                this.syncStaticUI();
                const gateActive = await this.ensureCredentialsGate();
                if (this.unloaded) return;
                if (!gateActive) {
                    // On open: force-load repos overview so the user immediately sees changes across all repos.
                    this.setState({ suppressInlineLoading: true }, { silent: true });
                    this.syncStaticUI();
                    try {
                        await this.refreshAll({ force: true });
                        if (this.props?.openConflictHelper) {
                            if (this.props.selectedRepoPath) {
                                this.setState({ selectedRepoPath: this.props.selectedRepoPath }, { silent: true });
                            }
                            await this.openConflictHelper();
                        }
                    } finally {
                        this.setState({ suppressInlineLoading: false }, { silent: true });
                        this.syncStaticUI();
                    }
                } else {
                    await this.loadRepoOverviews({ force: true }).catch(() => {});
                    this.updateIdentityPrompt();
                }
            }, 'Loading Git repositories…');
        })().catch(() => {
            this.syncStaticUI();
        });
    }

    async updateModalProps(props) {
        await this.initialLoad;
        if (this.unloaded) return;
        this.props = { ...this.props, ...props };
        const patch = {};
        if (props.repoPath) patch.repoPath = props.repoPath;
        if (props.selectedRepoPath) patch.selectedRepoPath = props.selectedRepoPath;
        this.setState(patch);
        if (props.openConflictHelper) await this.openConflictHelper();
    }

    bindEvents() {
        return this.ui.bindEvents();
    }

    async resolveIdentityRepoPath() {
        return this.getPrimaryExplicitActionRepoPath();
    }

    async prefillCredentialsPanel() {
        const current = this.state.identityPrompt || {};
        const next = buildPrefilledGitIdentityState({
            identityPrompt: current,
            repoPath: this.getPrimaryExplicitActionRepoPath(),
            rememberedIdentity: getRememberedGitIdentity(),
            githubUser: this.state.githubAuth?.connection?.user || {},
            authMethod: this.state.authPrompt?.authMethod || getRememberedGitAuthMethod()
        });
        this.state.identityPrompt = next.identityPrompt;
        this.state.credentialsBaseline = next.credentialsBaseline;
    }

    async ensureCredentialsGate() {
        const remembered = getRememberedGitIdentity();
        const github = this.state.githubAuth || {};
        const githubUser = github.connection?.user || {};
        const githubName = String(githubUser?.login || githubUser?.name || '').trim();
        const githubEmail = String(githubUser?.email || '').trim();
        const name = remembered.name || githubName || '';
        const email = remembered.email || githubEmail || '';
        const hasIdentity = Boolean(name && email);

        const authMethod = normalizeGitAuthMethod(this.state.authPrompt?.authMethod || getRememberedGitAuthMethod());
        const githubConnected = Boolean(github.connected && github.connection?.source === 'github');
        const tokenStored = Boolean(github.tokenStored);
        const hasAuth = authMethod === 'github' ? githubConnected : tokenStored;

        if (hasIdentity && hasAuth) {
            if (this.state.credentialsGate) {
                this.state.credentialsGate = false;
                this.syncStaticUI();
            }
            return false;
        }

        const repoPath = await this.resolveIdentityRepoPath();
        this.state.credentialsGate = true;
        this.state.identityPrompt = {
            ...this.state.identityPrompt,
            visible: true,
            repoPath,
            pendingAction: null,
            name,
            email
        };
        this.state.authPrompt = {
            ...this.state.authPrompt,
            visible: !hasAuth,
            authMethod
        };
        
        this.syncStaticUI();
        
        // Ensure the credentials prompt shows the 'authentication' tab
        const presenter = this.ui.getCredentialsPromptPresenter?.();
        if (presenter && typeof presenter.switchTab === 'function') {
            presenter.switchTab('authentication');
        }

        this.updateIdentityPrompt({ 
            focus: !name ? 'name' : (!email ? 'email' : (authMethod === 'token' && !tokenStored ? 'token' : 'name')),
            activeTab: 'authentication'
        });
        this.updateCommitButtons();
        
        let statusMsg = 'Set name, email and authentication to continue.';
        if (!hasIdentity && hasAuth) statusMsg = 'Set name and email to continue.';
        if (hasIdentity && !hasAuth) statusMsg = authMethod === 'github' ? 'Connect GitHub to continue.' : 'Enter a token to continue.';
        
        this.setStatusLine(statusMsg, true);
        return true;
    }

    async refreshAction() {
        await this.withPanelLoader(() => this.refreshAfterGitOperation(), 'Refreshing Git status…');
    }

    clearGithubPollTimer() {
        if (this.githubPollTimer) {
            clearTimeout(this.githubPollTimer);
            this.githubPollTimer = null;
        }
    }

    scheduleGithubPoll(intervalSeconds = 5) {
        if (this.unloaded) return;
        this.clearGithubPollTimer();
        const delayMs = Math.max(3, Number(intervalSeconds || 5)) * 1000;
        this.githubPollTimer = setTimeout(() => {
            this.pollGithubAuth({ silent: true }).catch(() => {});
        }, delayMs);
    }

    updateGithubAuthState(github = {}, { silent = false } = {}) {
        const liveConnection = github?.connection || null;
        if (liveConnection) {
            setRememberedGithubConnection(liveConnection);
        }
        const rememberedConnection = getRememberedGithubConnection();
        const effectiveConnection = liveConnection || rememberedConnection || null;
        this.state.githubAuth = {
            configured: Boolean(github?.configured || github?.setup?.configured),
            connected: Boolean(github?.connected),
            tokenStored: Boolean(github?.tokenStored),
            connection: effectiveConnection,
            pending: github?.pending || null,
            setup: github?.setup || null,
            error: String(github?.error || github?.message || '').trim()
        };
        if (!silent) {
            this.syncStaticUI();
        }
    }

    applyGithubAuthError(error, { silent = false } = {}) {
        const message = normalizeErrorMessage(error);
        const prevGithubAuth = this.state.githubAuth || {};
        this.updateGithubAuthState({
            ...prevGithubAuth,
            connected: false,
            tokenStored: Boolean(prevGithubAuth.tokenStored),
            pending: null,
            error: message
        }, { silent });
        this.clearGithubPollTimer();
        this.updateAuthPrompt();
        this.updateCommitButtons();
        if (!silent) {
            this.setStatusLine(message, true);
        }
        return message;
    }

    async refreshGithubAuthStatus({ silent = false } = {}) {
        try {
            const payload = await this.service.githubAuthStatus();
            this.updateGithubAuthState(payload?.github || {}, { silent });
            const pending = payload?.github?.pending || null;
            if (pending?.interval) {
                this.scheduleGithubPoll(pending.interval);
            } else {
                this.clearGithubPollTimer();
            }
            this.ensureGithubDeviceFlow({ silent: true }).catch(() => {});
            return payload?.github || {};
        } catch (error) {
            this.applyGithubAuthError(error, { silent });
            throw error;
        }
    }

    isGithubAuthSelected() {
        return normalizeGitAuthMethod(this.state.authPrompt?.authMethod ?? getRememberedGitAuthMethod()) === 'github';
    }

    async ensureGithubDeviceFlow({ force = false, silent = false } = {}) {
        if (!this.isGithubAuthSelected()) {
            return this.state.githubAuth || {};
        }
        const github = this.state.githubAuth || {};
        const pending = github.pending || null;
        const connectionSource = String(github?.connection?.source || '').trim().toLowerCase();
        const githubSessionConnected = Boolean(github.connected && connectionSource === 'github');
        if (!github.configured || githubSessionConnected) {
            return github;
        }
        if (!force && (pending?.userCode || pending?.verificationUri)) {
            this.updateAuthPrompt();
            this.updateCommitButtons();
            return github;
        }
        if (this.githubStartPromise && !force) {
            return this.githubStartPromise;
        }
        this.githubStartPromise = (async () => {
            try {
                const payload = await this.service.startGithubDeviceFlow();
                const nextGithub = payload?.github || {};
                this.updateGithubAuthState(nextGithub, { silent });
                const nextPending = nextGithub.pending || null;
                if (nextPending?.interval) {
                    this.scheduleGithubPoll(nextPending.interval);
                } else {
                    this.clearGithubPollTimer();
                }
                this.updateAuthPrompt();
                this.updateCommitButtons();
                if (!silent) {
                    this.setStatusLine(
                        nextPending?.userCode
                            ? `Open GitHub and enter code ${nextPending.userCode}.`
                            : 'Continue GitHub sign-in in the browser.'
                    );
                }
                return nextGithub;
            } catch (error) {
                this.applyGithubAuthError(error, { silent });
                throw error;
            }
        })();
        try {
            return await this.githubStartPromise;
        } finally {
            this.githubStartPromise = null;
        }
    }

    async startGithubAuth() {
        return this.ensureGithubDeviceFlow({ force: true });
    }

    async pollGithubAuth({ silent = false } = {}) {
        try {
            const payload = await this.service.pollGithubDeviceFlow();
            const github = payload?.github || {};
            if (github?.connected && github?.connection) {
                setRememberedGithubConnection(github.connection);
            }
            this.updateGithubAuthState(github, { silent });
            const pending = github.pending || null;
            if (github.connected) {
                this.clearGithubPollTimer();
                await this.prefillCredentialsPanel();
                await this.ensureCredentialsGate();
                await this.refreshAll({ force: true });
                this.updateAuthPrompt();
                this.updateCommitButtons();
                if (!silent) {
                    const login = github?.connection?.user?.login || github?.connection?.user?.name || 'GitHub';
                    this.setStatusLine(`GitHub connected as ${login}.`);
                }
                return github;
            }
            if (pending?.interval) {
                this.scheduleGithubPoll(pending.interval);
            } else {
                this.clearGithubPollTimer();
                if (this.isGithubAuthSelected()) {
                    return this.ensureGithubDeviceFlow({ force: true, silent });
                }
            }
            this.updateAuthPrompt();
            this.updateCommitButtons();
            if (!silent && pending?.userCode) {
                this.setStatusLine(`Waiting for GitHub approval for code ${pending.userCode}.`);
            }
            return github;
        } catch (error) {
            this.applyGithubAuthError(error, { silent });
            throw error;
        }
    }

    async disconnectGithubAuth() {
        const payload = await this.service.disconnectGithubAuth();
        this.clearGithubPollTimer();
        clearRememberedGithubConnection();
        this.updateGithubAuthState(payload?.github || {});
        this.updateAuthPrompt();
        this.updateCommitButtons();
        this.setStatusLine('GitHub disconnected.');
        await this.ensureGithubDeviceFlow({ force: true, silent: true }).catch(() => {});
    }

    updateCommitMessage(element) {
        return this.ui.updateCommitMessage(element);
    }

    pushAction() {
        this.push({ silent: false });
    }

    pullAction() {
        this.pullSelectedRepos();
    }

    toggleTreePrefixSelectionCheckbox(element) {
        const repoPath = element?.dataset?.repoPath;
        const prefix = element?.dataset?.prefix || '';
        if (!repoPath) return;
        this.togglePrefixSelection(repoPath, prefix, Boolean(element.checked));
    }

    toggleTreeFileSelectionCheckbox(element) {
        const repoPath = element?.dataset?.repoPath;
        const filePath = element?.dataset?.filePath;
        if (!repoPath || !filePath) return;
        this.toggleFileSelection(repoPath, filePath, null, Boolean(element.checked));
    }

    toggleRepoAllChangesCheckbox(element) {
        const repoPath = element?.dataset?.repoPath;
        if (!repoPath) return;
        this.togglePrefixSelection(repoPath, '*', Boolean(element.checked));
    }

    openDiff(element) {
        const detail = element && !(element instanceof HTMLElement) ? element : null;
        const repoPath = detail?.repoPath || element?.dataset?.repoPath || null;
        const filePath = detail?.filePath || element?.dataset?.filePath;
        const section = detail?.section || element?.dataset?.section || null;
        if (!filePath) return;
        this.selectFile(filePath, section, repoPath);
    }

    openIgnoreForFile(element) {
        const repoPath = element?.dataset?.repoPath || null;
        const filePath = element?.dataset?.filePath;
        if (!repoPath || !filePath) return;
        this.closeFileMenus();
        void this.addIgnoreForPath(joinPath(repoPath, filePath));
    }

    openIgnoreForFolder(element) {
        const repoPath = element?.dataset?.repoPath || null;
        const folderPath = element?.dataset?.prefix || element?.dataset?.folderPath || '';
        if (!repoPath || !folderPath) return;
        this.closeFileMenus();
        const normalized = folderPath.endsWith('/') ? folderPath.slice(0, -1) : folderPath;
        void this.addIgnoreForPath(joinPath(repoPath, normalized));
    }

    async addIgnoreForPath(fullPath) {
        if (!fullPath) return { ok: false };
        try {
            this.setStatusLine('Adding to .gitignore...');
            const payloadText = await this.service.gitAddIgnore(fullPath);
            const payload = parseJsonToolResult(payloadText) || {};
            if (!payload.ok) {
                throw new Error(String(payload.error || 'Failed to update .gitignore.'));
            }
            await this.refreshAll({ force: true });
            const added = Array.isArray(payload.added) ? payload.added : [];
            const alreadyPresent = Array.isArray(payload.alreadyPresent) ? payload.alreadyPresent : [];
            if (added.length) {
                this.setStatusLine(`Added ${added[0]} to .gitignore.`);
            } else if (alreadyPresent.length) {
                this.setStatusLine(`${alreadyPresent[0]} is already in .gitignore.`);
            } else {
                this.setStatusLine('Updated .gitignore.');
            }
            return payload;
        } catch (error) {
            this.setStatusLine(normalizeErrorMessage(error), true);
            return { ok: false };
        }
    }

    async removeIgnoreRuleForFile(repoPath, filePath) {
        if (!repoPath || !filePath) return { ok: false };
        try {
            this.setStatusLine(`Removing ignore rule for ${filePath}...`);
            const payloadText = await this.service.gitRemoveIgnore(joinPath(repoPath, filePath));
            const payload = parseJsonToolResult(payloadText) || {};
            if (!payload.ok) {
                throw new Error(String(payload.error || 'Failed to update .gitignore.'));
            }
            await this.refreshAll({ force: true });
            if (payload.removed && payload.retracked) {
                this.setStatusLine(`Removed from .gitignore and restored tracking for ${filePath}.`);
            } else if (payload.removed) {
                this.setStatusLine(`Removed from .gitignore for ${filePath}.`);
            } else {
                this.setStatusLine(`No ignore rule found for ${filePath}.`, true);
            }
            return payload;
        } catch (error) {
            this.setStatusLine(normalizeErrorMessage(error), true);
            return { ok: false };
        }
    }

    async getLiveGitPathState(repoPath, filePath) {
        if (!repoPath || !filePath) return null;
        try {
            const statusText = await this.service.gitStatus(repoPath);
            const payload = parseJsonToolResult(statusText) || {};
            const status = payload?.status || payload || {};
            const groups = {
                staged: Array.isArray(status.staged) ? status.staged : [],
                unstaged: Array.isArray(status.unstaged) ? status.unstaged : [],
                untracked: Array.isArray(status.untracked) ? status.untracked : [],
                conflicted: Array.isArray(status.conflicted) ? status.conflicted : [],
                ignored: Array.isArray(status.ignored) ? status.ignored : []
            };
            const key = String(filePath || '').replace(/^\/+/, '');
            const state = {
                path: key,
                x: ' ',
                y: ' ',
                flags: {
                    staged: false,
                    unstaged: false,
                    untracked: false,
                    conflicted: false,
                    ignored: false
                }
            };
            const touch = (entry, flag) => {
                const pathValue = String(entry?.path || entry || '').replace(/^\/+/, '');
                if (pathValue !== key) return;
                state.flags[flag] = true;
                if (typeof entry?.x === 'string' && entry.x.length) state.x = entry.x;
                if (typeof entry?.y === 'string' && entry.y.length) state.y = entry.y;
            };
            for (const entry of groups.staged) touch(entry, 'staged');
            for (const entry of groups.unstaged) touch(entry, 'unstaged');
            for (const entry of groups.untracked) touch(entry, 'untracked');
            for (const entry of groups.conflicted) touch(entry, 'conflicted');
            for (const entry of groups.ignored) touch(entry, 'ignored');
            return state;
        } catch {
            return null;
        }
    }

    async isPathIgnoredByGit(repoPath, filePath) {
        if (!repoPath || !filePath) return false;
        try {
            const normalizedPath = String(filePath || '').replace(/^\/+/, '');
            const response = await this.service.gitCheckIgnore(repoPath, [normalizedPath]);
            const payload = parseJsonToolResult(response) || {};
            const matches = Array.isArray(payload?.matches) ? payload.matches : [];
            return matches.some((entry) => String(entry?.path || '').replace(/^\/+/, '') === normalizedPath);
        } catch {
            return false;
        }
    }

    async shouldRollbackByRetracking(repoPath, filePath) {
        if (!repoPath || !filePath) return false;
        const normalizedPath = String(filePath || '').replace(/^\/+/, '');
        const row = await this.getLiveGitPathState(repoPath, normalizedPath);
        const ignoredByGit = await this.isPathIgnoredByGit(repoPath, normalizedPath);
        const x = String(row?.x || '');
        const y = String(row?.y || '');
        const flags = row?.flags || {};
        const isTrackedRemoval = Boolean(
            x === 'D'
            || y === 'D'
            || (flags.staged && !flags.untracked)
            || (flags.unstaged && !flags.untracked)
        );
        if (!isTrackedRemoval || !(flags.ignored || ignoredByGit)) return false;
        return true;
    }

    async removeIgnoreForFile(element) {
        const repoPath = element?.dataset?.repoPath || null;
        const filePath = element?.dataset?.filePath;
        if (!repoPath || !filePath) return;
        this.closeFileMenus();
        await this.removeIgnoreRuleForFile(repoPath, filePath);
    }

    async deleteFile(element) {
        const repoPath = element?.dataset?.repoPath || null;
        const filePath = element?.dataset?.filePath;
        if (!repoPath || !filePath) return;
        this.closeFileMenus();
        const row = element?.closest?.('.git-tree-file-row');
        const isDeleted = Boolean(row?.classList?.contains('is-deleted'));
        const fullPath = joinPath(repoPath, filePath);
        try {
            this.setStatusLine(isDeleted ? `Staging deletion for ${filePath}...` : `Deleting ${filePath}...`);
            if (!isDeleted) {
                await this.service.deleteFile(fullPath);
            }
            this.toggleFileSelection(repoPath, filePath, null, true);
            await this.service.gitStage(repoPath, [filePath]);
            await this.refreshAll({ force: true });
            this.setStatusLine(isDeleted ? `Deletion staged: ${filePath}` : `Deleted ${filePath}.`);
            window.dispatchEvent(new CustomEvent(FILE_EXP_REFRESH_EVENT, { detail: { path: fullPath } }));
        } catch (error) {
            this.setStatusLine(normalizeErrorMessage(error), true);
        }
    }

    async rollbackFile(element) {
        const repoPath = element?.dataset?.repoPath || null;
        const filePath = String(element?.dataset?.filePath || '').replace(/^\/+/, '');
        if (!repoPath || !filePath) return;
        this.closeFileMenus();
        const row = element?.closest?.('.git-tree-file-row');
        const isUntracked = Boolean(row?.classList?.contains('is-untracked'));
        const isIgnored = Boolean(row?.classList?.contains('is-ignored'));
        if (await this.shouldRollbackByRetracking(repoPath, filePath)) {
            await this.removeIgnoreRuleForFile(repoPath, filePath);
            return;
        }
        if (isUntracked) {
            await this.deleteFile(element);
            return;
        }
        if (isIgnored) {
            await this.removeIgnoreRuleForFile(repoPath, filePath);
            return;
        }
        try {
            this.setStatusLine(`Rolling back ${filePath}...`);
            await this.service.gitRestore(repoPath, [filePath]);
            await this.refreshAll({ force: true });
            this.setStatusLine(`Rolled back ${filePath}.`);
            const fullPath = joinPath(repoPath, filePath);
            window.dispatchEvent(new CustomEvent(FILE_EXP_REFRESH_EVENT, { detail: { path: fullPath } }));
        } catch (error) {
            this.setStatusLine(normalizeErrorMessage(error), true);
        }
    }

    openIgnoreForDiff(payload = {}) {
        const repoPath = payload.repoPath || null;
        const filePath = payload.filePath;
        if (!repoPath || !filePath) return;
        void this.addIgnoreForPath(joinPath(repoPath, filePath));
    }

    closeFileMenus() {
        this.ui.closeFileMenus();
    }

    toggleRepoFolderExpanded(element) {
        const folderId = element?.dataset?.folderId;
        if (!folderId) return;
        this.toggleFolderExpanded(folderId);
    }

    syncStaticUI() {
        return this.ui.syncStaticUI();
    }

    updateIdentityPrompt(options = {}) {
        return this.ui.updateIdentityPrompt(options);
    }

    updateAuthPrompt(options = {}) {
        return this.ui.updateAuthPrompt(options);
    }

    async applyRepoPathFromInput(value) {
        const next = String(value || '').trim();
        if (!next) {
            this.setStatusLine('Enter a repository path.', true);
            return;
        }
        this.state.repoPath = next;
        this.state.selectedRepoPath = null;
        this.statusCache.at = 0;
        this.statusCache.payload = null;
        this.diffCache.clear();
        this.state.selectedPath = null;
        this.state.selectedSection = null;
        this.state.identityPrompt = { visible: false, repoPath: null, pendingAction: null, name: '', email: '' };
        this.state.authPrompt = {
            visible: false,
            repoPath: null,
            pendingAction: null,
            token: '',
            authMethod: getRememberedGitAuthMethod()
        };
        this.closeActionsMenu();
        this.syncStaticUI();
        await this.refreshAll({ force: true });
    }

    toggleActionsMenu() {
        return this.ui.toggleActionsMenu();
    }

    closeActionsMenu() {
        return this.ui.closeActionsMenu();
    }

    async toggleCredentials() {
        const opening = !this.state.credentialsOpen;
        if (opening && !this.state.credentialsGate) {
            await this.refreshGithubAuthStatus({ silent: true }).catch(() => {});
            await this.prefillCredentialsPanel();
        }
        return this.ui.toggleCredentials();
    }

    closeCredentials() {
        return this.ui.closeCredentials();
    }

    runGitAction(element, mode) {
        return this.actions.runGitAction(element, mode);
    }

    normalizeConflictDetail(detailOrElement, sourceOverride = null) {
        if (detailOrElement instanceof HTMLElement) {
            const repoPath = detailOrElement.dataset.repoPath || '';
            const filePath = detailOrElement.dataset.filePath || '';
            const source = sourceOverride || detailOrElement.dataset.source || '';
            return { repoPath, filePath, source };
        }
        if (detailOrElement && typeof detailOrElement === 'object') {
            if (sourceOverride) {
                return { ...detailOrElement, source: sourceOverride };
            }
            return detailOrElement;
        }
        return sourceOverride ? { source: sourceOverride } : {};
    }

    selectConflictFile(detailOrElement) {
        const detail = this.normalizeConflictDetail(detailOrElement);
        return this.actions.selectConflictFile(detail);
    }

    applyConflictChoice(detailOrElement, sourceOverride) {
        const detail = this.normalizeConflictDetail(detailOrElement, sourceOverride);
        return this.actions.applyConflictChoice(detail);
    }

    saveConflictResolution(detailOrElement) {
        const detail = this.normalizeConflictDetail(detailOrElement);
        return this.actions.saveConflictResolution(detail);
    }

    cancelConflictResolution() {
        this.state.conflictFocus = false;
        this.syncStaticUI();
    }

    hasAnyConflicts() {
        const manual = Array.isArray(this.state.manualConflicts) ? this.state.manualConflicts : [];
        if (manual.length) return true;
        const repos = Array.isArray(this.state.repoOverviews) ? this.state.repoOverviews : [];
        return repos.some((repo) => {
            const changes = repo?.changes || {};
            const counts = repo?.counts || {};
            const conflicted = Array.isArray(changes.conflicted) ? changes.conflicted.length : 0;
            return conflicted > 0 || Boolean(counts.conflicted);
        });
    }

    async openConflictHelper() {
        const priorStatus = {
            text: this.state.lastStatusLine,
            isError: this.state.lastStatusIsError
        };
        this.state.conflictFocus = true;
        if (typeof this.actions.refreshConflicts === 'function') {
            try {
                await this.actions.refreshConflicts();
            } finally {
                this.state.lastStatusLine = priorStatus.text;
                this.state.lastStatusIsError = priorStatus.isError;
                this.ui.updateStatusBar?.();
            }
        }
        this.syncStaticUI();
    }

    setStatusLine(text, isError = false) {
        this.state.lastStatusLine = text || '';
        this.state.lastStatusIsError = Boolean(isError);
        setGitErrorFlag(Boolean(isError));
        this.ui.updateStatusBar?.();
    }

    async callTool(name, args) {
        if (this.unloaded) throw new DOMException('Panel closed', 'AbortError');
        const result = await callExplorerTool(name, args);
        if (this.unloaded) throw new DOMException('Panel closed', 'AbortError');
        return result;
    }

    async callAgentTool(agentName, name, args) {
        if (this.unloaded) throw new DOMException('Panel closed', 'AbortError');
        const result = await callAgentTool(agentName, name, args);
        if (this.unloaded) throw new DOMException('Panel closed', 'AbortError');
        return result;
    }

    async generateCommitMessage() {
        if (this.commitMessageBusy) return;
        return this.actions.generateCommitMessage();
    }

    setCommitMessageBusy(isBusy) {
        const busy = Boolean(isBusy);
        this.commitMessageBusy = busy;

        this.renderModalBusyState({
            busy: busy || this.panelBusyMessages.length > 0,
            message: busy ? 'Generating commit message…' : this.panelBusyMessages.at(-1)
        });
    }

    renderModalBusyState({ busy, message = '' }) {
        const active = Boolean(busy);

        const modal = this.element.querySelector('.git-panel');
        modal?.classList.toggle('git-panel-busy', active);
        if (active) {
            modal?.setAttribute('aria-busy', 'true');
        } else {
            modal?.removeAttribute('aria-busy');
        }

        const overlay = this.element.querySelector('[data-role="git-panel-loader"]');
        if (overlay) {
            overlay.hidden = !active;
            overlay.setAttribute('aria-hidden', active ? 'false' : 'true');
            const label = overlay.querySelector('[data-role="git-panel-loader-label"]');
            if (label) label.textContent = String(message || 'Working…');
        }

        const generateButton = this.element.querySelector('[data-local-action="generateCommitMessage"]');
        if (generateButton) {
            generateButton.disabled = active;
            generateButton.setAttribute('aria-disabled', active ? 'true' : 'false');
        }
    }

    async withPanelLoader(operation, message = '') {
        const busyMessage = String(message || this.state.lastStatusLine || 'Working…');
        this.panelBusyMessages.push(busyMessage);
        this.renderModalBusyState({ busy: true, message: busyMessage });
        try {
            return await operation();
        } finally {
            this.panelBusyMessages.pop();
            this.renderModalBusyState({
                busy: this.commitMessageBusy || this.panelBusyMessages.length > 0,
                message: this.commitMessageBusy ? 'Generating commit message…' : this.panelBusyMessages.at(-1)
            });
        }
    }

    async refreshAll({ force = false, keepStatus = false } = {}) {
        const result = await this.repo.refreshAll({ force, keepStatus });
        this.syncStaticUI();
        return result;
    }

    async refreshAfterGitOperation({ keepStatus = false } = {}) {
        this.diffCache.clear();
        const result = await this.refreshAll({ force: true, keepStatus });
        window.dispatchEvent(new CustomEvent(FILE_EXP_REFRESH_EVENT));
        return result;
    }

    async loadRepoInfo({ force = false } = {}) {
        return this.repo.loadRepoInfo({ force });
    }

    applyRepoInfo(info) {
        return this.repo.applyRepoInfo(info);
    }

    getSelectedFilesEntry(repoPath) {
        return this.repo.getSelectedFilesEntry(repoPath);
    }

    isFileSelected(repoPath, filePath) {
        return this.repo.isFileSelected(repoPath, filePath);
    }

    toggleFileSelection(repoPath, filePath, section, isSelected) {
        return this.repo.toggleFileSelection(repoPath, filePath, section, isSelected);
    }

    getCoveringPrefix(repoPath, relativePath) {
        return this.repo.getCoveringPrefix(repoPath, relativePath);
    }

    getAncestorCoveringPrefix(repoPath, prefix) {
        return this.repo.getAncestorCoveringPrefix(repoPath, prefix);
    }

    togglePrefixSelection(repoPath, prefix, isSelected) {
        return this.repo.togglePrefixSelection(repoPath, prefix, isSelected);
    }

    toggleMultipleReposAllChanges(repoPaths, isSelected) {
        return this.repo.toggleMultipleReposAllChanges(repoPaths, isSelected);
    }

    toggleFolderExpanded(folderId) {
        return this.repo.toggleFolderExpanded(folderId);
    }

    toggleRepoChanges(element) {
        return this.repo.toggleRepoChanges(element);
    }

    checkoutBranchFromRepoRow(element) {
        return this.actions.checkoutBranchFromRepoRow(element);
    }

    createBranchFromRepoRow(element) {
        return this.actions.createBranchFromRepoRow(element);
    }

    mergeBranchFromRepoRow(element) {
        return this.actions.mergeBranchFromRepoRow(element);
    }

    isRepoChangesExpanded(repoPath) {
        return this.repo.isRepoChangesExpanded(repoPath);
    }

    toggleTreeFolder(element) {
        return this.repo.toggleTreeFolder(element);
    }

    isTreeFolderExpanded(repoPath, prefix) {
        return this.repo.isTreeFolderExpanded(repoPath, prefix);
    }

    getDisplayedRepoOverviews() {
        return this.repo.getDisplayedRepoOverviews();
    }

    buildRepoTree() {
        return this.repo.buildRepoTree();
    }

    async loadRepoOverviews({ force = false } = {}) {
        const result = await this.repo.loadRepoOverviews({ force });
        this.ui.updateCredentialsPrompt?.({ refreshAutocommitRepos: true });
        return result;
    }

    applyDefaultRepoTreeExpansion() {
        return this.repo.applyDefaultRepoTreeExpansion();
    }

    renderRepoOverviews(overviews) {
        return this.repo.renderRepoOverviews(overviews);
    }

    formatRepoSummary(repo) {
        return this.repo.formatRepoSummary(repo);
    }

    renderRepoChangesTree(repo) {
        return this.repo.renderRepoChangesTree(repo);
    }

    updateCommitButtons() {
        return this.ui.updateCommitButtons();
    }

    getAllChangedPathsForRepo(repoPath) {
        return this.repo.getAllChangedPathsForRepo(repoPath);
    }

    reconcileSelectedDiffWithChanges() {
        return this.repo.reconcileSelectedDiffWithChanges();
    }

    clearSelectedDiff() {
        this.diff.clearSelectedDiff();
        this.ui.updateRepoTree?.();
    }

    async refreshSelectedDiff() {
        await this.diff.refreshSelectedDiff?.();
        this.ui.updateRepoTree?.();
    }

    getPathsForCommitInRepo(repoPath) {
        return this.repo.getPathsForCommitInRepo(repoPath);
    }

    showGitAuthPrompt(repoPath, pendingAction, { message = '' } = {}) {
        return this.actions.showGitAuthPrompt(repoPath, pendingAction, { message });
    }

    openGitTokenPrompt() {
        return this.actions.openGitTokenPrompt();
    }

    openGitIdentityPrompt() {
        return this.actions.openGitIdentityPrompt();
    }

    cancelGitToken() {
        return this.actions.cancelGitToken();
    }

    cancelGitIdentity() {
        return this.actions.cancelGitIdentity();
    }

    async saveGitToken(payload = {}) {
        return this.actions.saveGitToken(payload);
    }

    async saveGitCredentials(payload = {}) {
        try {
            const shouldClose = await this.actions.saveGitCredentials(payload);
            if (shouldClose) {
                this.closeCredentials();
            }
            return shouldClose;
        } catch (error) {
            this.setStatusLine(normalizeErrorMessage(error) || 'Unable to save credentials.', true);
            return false;
        }
    }

    cancelGitCredentials() {
        const shouldClose = this.actions.cancelGitCredentials();
        if (shouldClose) this.closeCredentials();
        return shouldClose;
    }

    async gitPushWithToken(repoPath, token) {
        return this.actions.gitPushWithToken(repoPath, token);
    }

    async gitPullWithToken(repoPath, token) {
        return this.actions.gitPullWithToken(repoPath, token);
    }

    async pushRepos(repoPaths, { token = null } = {}) {
        return this.actions.pushRepos(repoPaths, { token });
    }

    async pullRepos(repoPaths, { token = null } = {}) {
        return this.actions.pullRepos(repoPaths, { token });
    }

    async ensureGitIdentityOrPrompt(repoPath, pendingAction) {
        return this.actions.ensureGitIdentityOrPrompt(repoPath, pendingAction);
    }

    async saveGitIdentity(payload = {}) {
        return this.actions.saveGitIdentity(payload);
    }

    async commitSelectedRepos() {
        return this.actions.commitSelectedRepos();
    }

    async selectFile(filePath, section, repoPath = null) {
        await this.diff.selectFile(filePath, section, repoPath);
        this.ui.updateRepoTree?.();
    }

    async commit() {
        return this.actions.commit();
    }

    async push({ silent = false, token = null } = {}) {
        return this.actions.push({ silent, token });
    }

    async pushSelectedRepos(repoPaths) {
        return this.actions.pushSelectedRepos(repoPaths);
    }

    async pullSelectedRepos() {
        return this.actions.pullSelectedRepos();
    }

}
