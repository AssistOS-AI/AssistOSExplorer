export class GitCredentialsPrompt {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.state = {
            visible: false,
            name: '',
            email: '',
            authMethod: 'token',
            token: '',
            authRequired: false,
            credentialsDirty: false,
            autocommitDirty: false,
            tokenStored: false,
            githubConfigured: false,
            githubConnected: false,
            githubError: '',
            githubUserLabel: '',
            githubScope: '',
            githubHasRepoScope: false,
            githubPending: false,
            githubVerificationUri: '',
            githubUserCode: '',
            autocommitReposLoading: false,
            autocommitReposLoaded: false,
            autocommitIntervalMinutes: 15,
            autocommitRepos: [],
            autocommitSelected: null,
            showAgentRepos: false,
            autoresolveConflicts: false,
            autoresolveDirty: false,
            activeTab: 'authentication'
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.root = this.element.querySelector('#gitCredentialsPrompt') || this.element;
        this.tabButtons = Array.from(this.element.querySelectorAll('.git-credentials-tab'));
        this.tabPanels = Array.from(this.element.querySelectorAll('.git-credentials-tab-panel'));
        this.nameInput = this.element.querySelector('#gitCredentialsName');
        this.emailInput = this.element.querySelector('#gitCredentialsEmail');
        this.authMethodInputs = Array.from(this.element.querySelectorAll('input[name="gitCredentialsAuthMethod"]'));
        this.tokenInput = this.element.querySelector('#gitCredentialsToken');
        this.authAvailability = this.element.querySelector('#gitAuthAvailability');
        this.githubPanel = this.element.querySelector('#gitGithubPanel');
        this.tokenPanel = this.element.querySelector('#gitTokenPanel');
        this.tokenStoredNotice = this.element.querySelector('#gitTokenStoredNotice');
        this.tokenHint = this.element.querySelector('#gitTokenHint');
        this.githubAuth = this.element.querySelector('#gitGithubAuth');
        this.githubStatus = this.element.querySelector('#gitGithubStatus');
        this.githubScope = this.element.querySelector('#gitGithubScope');
        this.githubWarning = this.element.querySelector('#gitGithubWarning');
        this.githubPending = this.element.querySelector('#gitGithubPending');
        this.githubCode = this.element.querySelector('#gitGithubCode');
        this.githubContinueButton = this.element.querySelector('[data-local-action="continueGithubAuth"]');
        this.githubActions = this.element.querySelector('.git-github-actions');
        this.githubDisconnectButton = this.element.querySelector('[data-local-action="disconnectGithubAuth"]');
        this.autocommitIntervalInput = this.element.querySelector('#gitCredentialsAutocommitInterval');
        this.autocommitReposContainer = this.element.querySelector('#gitCredentialsAutocommitRepos');
        this.autocommitToggleAllInput = this.element.querySelector('#gitCredentialsAutocommitToggleAll');
        this.showAgentReposInput = this.element.querySelector('#gitCredentialsShowAgentRepos');
        this.autoresolveInput = this.element.querySelector('#gitCredentialsAutoresolve');
        this.saveButton = this.element.querySelector('[data-local-action="saveGitCredentials"]');
        this.attachDelegatedListeners();
        this.applyState(this.state);
    }

    afterUnload() {
        this.detachDelegatedListeners();
        if (this.validateTimer) {
            clearTimeout(this.validateTimer);
            this.validateTimer = null;
        }
    }

    onInput(event) {
        const target = event?.target;
        if (!target) return;
        if (target.id === 'gitCredentialsName' || target.id === 'gitCredentialsEmail') {
            this.handleIdentityInput();
            return;
        }
        if (target.id === 'gitCredentialsToken') {
            this.handleTokenInput();
            return;
        }
        if (target.id === 'gitCredentialsAutocommitInterval') {
            this.handleAutocommitChange();
        }
    }

    onChange(event) {
        const target = event?.target;
        if (!target) return;
        if (target.name === 'gitCredentialsAuthMethod') {
            this.handleAuthMethodChange();
            return;
        }
        if (target.dataset?.repoPath) {
            this.handleAutocommitReposChange(event);
            return;
        }
        if (target.id === 'gitCredentialsAutocommitToggleAll') {
            this.handleAutocommitToggleAllChange();
            return;
        }
        if (target.id === 'gitCredentialsShowAgentRepos') {
            this.handleShowAgentReposChange();
            return;
        }
        if (target.id === 'gitCredentialsAutoresolve') {
            this.handleAutoresolveChange();
        }
    }

    onKeydown(event) {
        const target = event?.target;
        if (target?.id === 'gitCredentialsToken') {
            this.handleTokenKeydown(event);
        }
    }

    onFocusout(event) {
        const target = event?.target;
        if (!target) return;
        if (target.id === 'gitCredentialsName' || target.id === 'gitCredentialsEmail' || target.id === 'gitCredentialsToken') {
            this.commitCredentialsDraft();
            return;
        }
        if (target.id === 'gitCredentialsAutocommitInterval') {
            this.commitAutocommitDraft();
        }
    }

    attachDelegatedListeners() {
        if (this.delegatedListenersAttached || !this.element) return;
        this.handleDelegatedInput = (event) => this.onInput(event);
        this.handleDelegatedChange = (event) => this.onChange(event);
        this.handleDelegatedKeydown = (event) => this.onKeydown(event);
        this.handleDelegatedFocusout = (event) => this.onFocusout(event);
        this.element.addEventListener('input', this.handleDelegatedInput);
        this.element.addEventListener('change', this.handleDelegatedChange);
        this.element.addEventListener('keydown', this.handleDelegatedKeydown);
        this.element.addEventListener('focusout', this.handleDelegatedFocusout);
        this.delegatedListenersAttached = true;
    }

    detachDelegatedListeners() {
        if (!this.delegatedListenersAttached || !this.element) return;
        this.element.removeEventListener('input', this.handleDelegatedInput);
        this.element.removeEventListener('change', this.handleDelegatedChange);
        this.element.removeEventListener('keydown', this.handleDelegatedKeydown);
        this.element.removeEventListener('focusout', this.handleDelegatedFocusout);
        this.handleDelegatedInput = null;
        this.handleDelegatedChange = null;
        this.handleDelegatedKeydown = null;
        this.handleDelegatedFocusout = null;
        this.delegatedListenersAttached = false;
    }

    saveGitCredentials() {
        const name = (this.nameInput?.value || '').trim();
        const email = (this.emailInput?.value || '').trim();
        const authMethod = this.getSelectedAuthMethod();
        const token = (this.tokenInput?.value || '').trim();
        const intervalRaw = this.autocommitIntervalInput?.value;
        const autocommitIntervalMinutes = Math.max(1, Math.floor(Number(intervalRaw || 15)));
        const autocommitRepos = this.getSelectedAutocommitRepos();
        const autoresolveConflicts = Boolean(this.autoresolveInput?.checked);
        this.state.name = name;
        this.state.email = email;
        this.state.authMethod = authMethod;
        this.state.token = token;
        this.state.autocommitIntervalMinutes = autocommitIntervalMinutes;
        this.state.autocommitSelected = autocommitRepos;
        this.state.autoresolveConflicts = autoresolveConflicts;
        this.getParentPresenter()?.saveGitCredentials?.({
            name,
            email,
            authMethod,
            token,
            autocommitIntervalMinutes,
            autocommitRepos,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts
        });
    }

    cancelGitCredentials() {
        this.getParentPresenter()?.cancelGitCredentials?.();
    }

    switchCredentialsTab(_target, tab) {
        this.state.activeTab = tab === 'preferences' ? 'preferences' : 'authentication';
        this.updateTabUi();
    }

    disconnectGithubAuth() {
        this.getParentPresenter()?.disconnectGithubAuth?.();
    }

    async copyGithubCode() {
        const code = String(this.state.githubUserCode || '').trim();
        if (!code) return false;
        try {
            if (globalThis.navigator?.clipboard?.writeText) {
                await globalThis.navigator.clipboard.writeText(code);
            } else {
                const textarea = document.createElement('textarea');
                textarea.value = code;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand('copy');
                textarea.remove();
            }
            return true;
        } catch {
            return false;
        }
    }

    openGithubVerification() {
        const url = String(this.state.githubVerificationUri || '').trim();
        if (!url) return false;
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
    }

    async continueGithubAuth() {
        const copied = await this.copyGithubCode();
        const opened = this.openGithubVerification();
        if (copied && opened) {
            await globalThis.assistOS?.showToast?.('Code copied. GitHub verification opened in a new tab.', 'success', 2500);
            return;
        }
        if (opened) {
            await globalThis.assistOS?.showToast?.('GitHub verification opened. Copy the code manually if needed.', 'info', 3000);
            return;
        }
        if (copied) {
            await globalThis.assistOS?.showToast?.('Code copied. Open GitHub verification to continue.', 'info', 3000);
            return;
        }
        await globalThis.assistOS?.showToast?.('Could not start GitHub verification. Please try again.', 'error', 3000);
    }

    setState(next = {}) {
        this.applyState(next);
    }

    handleIdentityInput() {
        const name = (this.nameInput?.value || '').trim();
        const email = (this.emailInput?.value || '').trim();
        this.state.name = name;
        this.state.email = email;
        this.state.credentialsDirty = true;
        this.updateValidationState();
    }

    handleAuthMethodChange() {
        const authMethod = this.getSelectedAuthMethod();
        this.state.authMethod = authMethod;
        this.state.credentialsDirty = true;
        this.updateAuthPanels();
        this.updateValidationState();
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos: this.state.autocommitSelected,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            credentialsDirty: true
        });
    }

    handleTokenInput() {
        const token = (this.tokenInput?.value || '').trim();
        this.state.token = token;
        this.state.credentialsDirty = true;
        this.updateValidationState();
    }

    handleAutocommitChange() {
        const intervalRaw = this.autocommitIntervalInput?.value;
        const autocommitIntervalMinutes = Math.max(1, Math.floor(Number(intervalRaw || 15)));
        this.state.autocommitIntervalMinutes = autocommitIntervalMinutes;
        this.state.autocommitDirty = true;
        this.updateValidationState();
    }

    commitCredentialsDraft() {
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos: this.state.autocommitSelected,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            credentialsDirty: true
        });
    }

    commitAutocommitDraft() {
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos: this.state.autocommitSelected,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            autocommitDirty: true
        });
    }

    handleAutocommitReposChange(event) {
        const target = event?.target;
        if (!target || target.type !== 'checkbox' || !target.dataset?.repoPath) return;
        const autocommitRepos = this.getSelectedAutocommitRepos();
        this.state.autocommitSelected = autocommitRepos;
        this.state.autocommitDirty = true;
        this.syncAutocommitToggleAllState();
        this.updateValidationState();
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            autocommitDirty: true
        });
    }

    handleAutocommitToggleAllChange() {
        const repos = this.getVisibleAutocommitRepos();
        const checked = Boolean(this.autocommitToggleAllInput?.checked);
        const autocommitRepos = checked
            ? repos.map((repo) => String(repo?.path || '').trim()).filter(Boolean)
            : [];
        this.state.autocommitSelected = autocommitRepos;
        this.state.autocommitDirty = true;
        this.renderAutocommitRepos();
        this.updateValidationState();
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos,
            showAgentRepos: this.state.showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            autocommitDirty: true
        });
    }

    handleShowAgentReposChange() {
        const showAgentRepos = Boolean(this.showAgentReposInput?.checked);
        this.state.showAgentRepos = showAgentRepos;
        this.state.autocommitDirty = true;
        this.renderAutocommitRepos();
        this.updateValidationState();
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos: this.state.autocommitSelected,
            showAgentRepos,
            autoresolveConflicts: this.state.autoresolveConflicts,
            autocommitDirty: true
        });
    }

    handleAutoresolveChange() {
        const autoresolveConflicts = Boolean(this.autoresolveInput?.checked);
        this.state.autoresolveConflicts = autoresolveConflicts;
        this.state.autoresolveDirty = true;
        this.updateValidationState();
        this.getParentPresenter()?.handleCredentialsChange?.({
            name: this.state.name,
            email: this.state.email,
            authMethod: this.state.authMethod,
            token: this.state.token,
            autocommitIntervalMinutes: this.state.autocommitIntervalMinutes,
            autocommitRepos: this.state.autocommitSelected,
            autoresolveConflicts,
            autoresolveDirty: true
        });
    }

    switchTab(tabName) {
        const nextTab = String(tabName || '').trim().toLowerCase();
        if (nextTab === 'preferences' || nextTab === 'authentication') {
            this.state.activeTab = nextTab;
            this.updateTabUi();
        }
    }

    handleTokenKeydown(event) {

        if (event.key === 'Enter') {
            event.preventDefault();
            this.saveGitCredentials();
        }
    }

    applyState(next) {
        if (!next || typeof next !== 'object') return;
        const refreshAutocommitRepos = Boolean(next.refreshAutocommitRepos);
        if (Object.prototype.hasOwnProperty.call(next, 'visible')) {
            this.state.visible = Boolean(next.visible);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'name')) {
            this.state.name = String(next.name || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'email')) {
            this.state.email = String(next.email || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'authMethod')) {
            this.state.authMethod = String(next.authMethod || '').trim().toLowerCase() === 'github' ? 'github' : 'token';
        }
        if (Object.prototype.hasOwnProperty.call(next, 'token')) {
            this.state.token = String(next.token || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'authRequired')) {
            this.state.authRequired = Boolean(next.authRequired);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'credentialsDirty')) {
            this.state.credentialsDirty = Boolean(next.credentialsDirty);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitDirty')) {
            this.state.autocommitDirty = Boolean(next.autocommitDirty);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'tokenStored')) {
            this.state.tokenStored = Boolean(next.tokenStored);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubConfigured')) {
            this.state.githubConfigured = Boolean(next.githubConfigured);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubConnected')) {
            this.state.githubConnected = Boolean(next.githubConnected);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubError')) {
            this.state.githubError = String(next.githubError || '').trim();
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubUserLabel')) {
            this.state.githubUserLabel = String(next.githubUserLabel || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubScope')) {
            this.state.githubScope = String(next.githubScope || '').trim();
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubHasRepoScope')) {
            this.state.githubHasRepoScope = Boolean(next.githubHasRepoScope);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubPending')) {
            this.state.githubPending = Boolean(next.githubPending);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubVerificationUri')) {
            this.state.githubVerificationUri = String(next.githubVerificationUri || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'githubUserCode')) {
            this.state.githubUserCode = String(next.githubUserCode || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitReposLoading')) {
            this.state.autocommitReposLoading = Boolean(next.autocommitReposLoading);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitReposLoaded')) {
            this.state.autocommitReposLoaded = Boolean(next.autocommitReposLoaded);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitIntervalMinutes')) {
            const parsed = Number(next.autocommitIntervalMinutes);
            if (Number.isFinite(parsed)) {
                this.state.autocommitIntervalMinutes = Math.max(1, Math.floor(parsed));
            }
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitRepos')) {
            this.state.autocommitRepos = this.normalizeRepoList(next.autocommitRepos);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autocommitSelected')) {
            this.state.autocommitSelected = this.normalizeRepoSelection(next.autocommitSelected);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'showAgentRepos')) {
            this.state.showAgentRepos = Boolean(next.showAgentRepos);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autoresolveConflicts')) {
            this.state.autoresolveConflicts = Boolean(next.autoresolveConflicts);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'autoresolveDirty')) {
            this.state.autoresolveDirty = Boolean(next.autoresolveDirty);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'activeTab')) {
            this.state.activeTab = next.activeTab === 'preferences' ? 'preferences' : 'authentication';
        }

        this.element.classList.toggle('is-visible', this.state.visible);
        this.updateTabUi();
        if (this.nameInput && this.nameInput.value !== this.state.name) {
            this.nameInput.value = this.state.name;
        }
        if (this.emailInput && this.emailInput.value !== this.state.email) {
            this.emailInput.value = this.state.email;
        }
        for (const input of this.authMethodInputs || []) {
            input.checked = input.value === this.state.authMethod;
        }
        if (this.tokenInput && this.tokenInput.value !== this.state.token) {
            this.tokenInput.value = this.state.token;
        }
        if (this.tokenInput) {
            this.tokenInput.placeholder = this.state.tokenStored && !this.state.token
                ? '********************'
                : 'Enter a new token to be stored';
        }
        if (this.tokenStoredNotice) {
            this.tokenStoredNotice.hidden = !(this.state.authMethod === 'token' && this.state.tokenStored);
        }
        if (this.tokenHint) {
            this.tokenHint.textContent = this.state.tokenStored
                ? 'A token is saved on backend. Leave input empty to keep it, or enter a new token to replace it.'
                : 'Use a personal access token for HTTPS remotes when you do not want to use GitHub sign-in.';
        }
        if (this.authAvailability) {
            const tokenStored = Boolean(this.state.tokenStored);
            if (tokenStored) {
                this.authAvailability.hidden = false;
                this.authAvailability.textContent = 'Token exists on backend and is used for Git operations.';
            } else {
                this.authAvailability.hidden = true;
                this.authAvailability.textContent = '';
            }
        }
        if (this.githubStatus) {
            if (this.state.githubConnected) {
                this.githubStatus.textContent = this.state.githubUserLabel
                    ? `Connected as ${this.state.githubUserLabel}.`
                    : 'Connected.';
            } else if (this.state.githubError) {
                this.githubStatus.textContent = this.state.githubError;
            } else if (!this.state.githubConfigured) {
                this.githubStatus.textContent = 'GitHub sign-in is unavailable.';
            } else if (this.state.githubPending) {
                this.githubStatus.textContent = 'Complete sign-in in GitHub.';
            } else {
                this.githubStatus.textContent = 'Connect GitHub to continue.';
            }
        }
        if (this.githubScope) {
            const hasScope = Boolean(this.state.githubConnected && this.state.githubScope);
            this.githubScope.hidden = !hasScope;
            if (hasScope) {
                this.githubScope.textContent = `Scopes: ${this.state.githubScope}`;
            } else {
                this.githubScope.textContent = '';
            }
        }
        if (this.githubWarning) {
            const showWarning = Boolean(this.state.githubConnected && this.state.githubScope && !this.state.githubHasRepoScope);
            this.githubWarning.hidden = !showWarning;
            if (showWarning) {
                this.githubWarning.textContent = 'This GitHub authorization does not include repo access. Push may fail with 403.';
            } else {
                this.githubWarning.textContent = '';
            }
        }
        if (this.githubAuth) {
            let githubState = 'idle';
            if (this.state.githubConnected) githubState = 'connected';
            else if (this.state.githubError) githubState = 'error';
            else if (!this.state.githubConfigured) githubState = 'unavailable';
            else if (this.state.githubPending) githubState = 'pending';
            this.githubAuth.dataset.state = githubState;
        }
        if (this.githubPending) {
            this.githubPending.hidden = !this.state.githubPending;
        }
        if (this.githubCode) {
            this.githubCode.textContent = this.state.githubUserCode || '';
        }
        if (this.githubContinueButton) {
            this.githubContinueButton.disabled = !this.state.githubUserCode || !this.state.githubVerificationUri;
        }
        if (this.githubDisconnectButton) {
            this.githubDisconnectButton.hidden = !this.state.githubConnected;
        }
        if (this.githubActions) {
            this.githubActions.hidden = !this.state.githubConnected;
        }
        this.updateAuthPanels();
        if (this.autoresolveInput) {
            this.autoresolveInput.checked = this.state.autoresolveConflicts;
        }
        if (this.autocommitIntervalInput) {
            const nextValue = String(this.state.autocommitIntervalMinutes || 15);
            if (this.autocommitIntervalInput.value !== nextValue) {
                this.autocommitIntervalInput.value = nextValue;
            }
        }
        if (this.showAgentReposInput) {
            this.showAgentReposInput.checked = Boolean(this.state.showAgentRepos);
        }
        this.updateValidationState();
        if (refreshAutocommitRepos) {
            this.renderAutocommitRepos();
        }

        if (next.focus === 'name') {
            setTimeout(() => this.nameInput?.focus?.(), 0);
        } else if (next.focus === 'email') {
            setTimeout(() => this.emailInput?.focus?.(), 0);
        } else if (next.focus === 'token') {
            setTimeout(() => this.tokenInput?.focus?.(), 0);
        }
    }

    getParentPresenter() {
        return this.element.closest('git-panel')?.webSkelPresenter || null;
    }

    normalizeRepoList(list) {
        const repos = Array.isArray(list) ? list : [];
        const seen = new Set();
        const normalized = [];
        for (const entry of repos) {
            if (!entry || typeof entry !== 'object') continue;
            const path = String(entry.path || '').trim();
            const name = String(entry.name || entry.path || '').trim();
            if (!path || !name || seen.has(path)) continue;
            seen.add(path);
            normalized.push({
                path,
                name,
                isAgentRepo: Boolean(entry.isAgentRepo),
                group: String(entry.group || (Boolean(entry.isAgentRepo) ? 'agents' : 'workspace'))
            });
        }
        return normalized;
    }

    normalizeRepoSelection(list) {
        if (list === null || list === undefined) return null;
        const selected = Array.isArray(list) ? list : [];
        return selected.map((entry) => String(entry || '').trim()).filter(Boolean);
    }

    getSelectedAutocommitRepos() {
        const selected = [];
        if (!this.autocommitReposContainer) return selected;
        const inputs = this.autocommitReposContainer.querySelectorAll('input[data-repo-path]');
        for (const input of inputs) {
            if (input.checked) {
                const path = String(input.dataset.repoPath || '').trim();
                if (path) selected.push(path);
            }
        }
        return selected;
    }

    getVisibleAutocommitRepos(showAgentRepos = this.state.showAgentRepos) {
        const repos = Array.isArray(this.state.autocommitRepos) ? this.state.autocommitRepos : [];
        return repos.filter((repo) => showAgentRepos || !repo?.isAgentRepo);
    }

    getSelectedAuthMethod() {
        const selected = (this.authMethodInputs || []).find((input) => input.checked);
        return selected?.value === 'github' ? 'github' : 'token';
    }

    updateAuthPanels() {
        const useGithub = this.state.authMethod === 'github';
        if (this.githubPanel) {
            this.githubPanel.hidden = !useGithub;
        }
        if (this.tokenPanel) {
            this.tokenPanel.hidden = useGithub;
        }
    }

    updateTabUi() {
        const activeTab = this.state.activeTab === 'preferences' ? 'preferences' : 'authentication';
        this.root?.setAttribute('data-active-tab', activeTab);
        for (const button of this.tabButtons || []) {
            const isActive = button.dataset.tab === activeTab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
        for (const panel of this.tabPanels || []) {
            panel.hidden = panel.dataset.tabPanel !== activeTab;
        }
    }

    hasValidIdentity() {
        const name = String(this.state.name || '').trim();
        const email = String(this.state.email || '').trim();
        if (!name || !email) return false;
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;
        return true;
    }

    canSaveCredentials() {
        if (this.state.authMethod === 'github' && !this.state.githubConnected) {
            return Boolean(this.state.githubConfigured);
        }
        if (this.state.authMethod === 'token'
            && !String(this.state.token || '').trim()
            && !this.state.tokenStored) {
            return false;
        }
        return true;
    }

    isCredentialsValid() {
        if (!this.hasValidIdentity()) return false;
        if (this.state.authMethod === 'github' && !this.state.githubConnected) {
            return false;
        }
        if (this.state.authMethod === 'token'
            && !String(this.state.token || '').trim()
            && !this.state.tokenStored) {
            return false;
        }
        return true;
    }

    getValidationMessage() {
        const name = String(this.state.name || '').trim();
        const email = String(this.state.email || '').trim();
        if (!name || !email) {
            return 'Enter name and email to continue.';
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return 'Enter a valid email address.';
        }
        if (this.state.authMethod === 'github' && !this.state.githubConnected) {
            if (!this.state.githubConfigured) {
                return 'GitHub sign-in is not available in this workspace.';
            }
            return '';
        }
        if (this.state.authMethod === 'token'
            && !String(this.state.token || '').trim()
            && !this.state.tokenStored) {
            return 'Enter a token to continue.';
        }
        return '';
    }
    updateValidationState() {
        const savable = this.canSaveCredentials();
        if (this.saveButton) {
            this.saveButton.disabled = !savable;
            const message = savable ? '' : this.getValidationMessage();
            if (message) {
                this.saveButton.title = message;
            } else {
                this.saveButton.removeAttribute('title');
            }
        }
    }

    syncAutocommitToggleAllState() {
        if (!this.autocommitToggleAllInput) return;
        const repos = this.getVisibleAutocommitRepos();
        const repoPaths = repos.map((repo) => String(repo?.path || '').trim()).filter(Boolean);
        if (!repoPaths.length) {
            this.autocommitToggleAllInput.checked = false;
            this.autocommitToggleAllInput.indeterminate = false;
            this.autocommitToggleAllInput.disabled = true;
            return;
        }
        const selectedList = Array.isArray(this.state.autocommitSelected) ? this.state.autocommitSelected : null;
        const selected = new Set(selectedList === null ? repoPaths : selectedList);
        const selectedCount = repoPaths.reduce((count, repoPath) => count + (selected.has(repoPath) ? 1 : 0), 0);
        this.autocommitToggleAllInput.disabled = false;
        this.autocommitToggleAllInput.checked = selectedCount === repoPaths.length;
        this.autocommitToggleAllInput.indeterminate = selectedCount > 0 && selectedCount < repoPaths.length;
    }

    renderAutocommitRepos() {
        const container = this.autocommitReposContainer;
        if (!container) return;
        const repos = this.getVisibleAutocommitRepos();
        if ((!this.state.autocommitReposLoaded || this.state.autocommitReposLoading) && repos.length === 0) {
            this.syncAutocommitToggleAllState();
            container.textContent = 'Loading repositories...';
            return;
        }
        container.innerHTML = '';
        if (!repos.length) {
            this.syncAutocommitToggleAllState();
            container.textContent = 'No repositories found.';
            return;
        }
        const selectedList = Array.isArray(this.state.autocommitSelected)
            ? this.state.autocommitSelected
            : null;
        const selected = new Set(
            selectedList === null ? repos.map((repo) => repo.path) : selectedList
        );
        this.state.autocommitSelected = selectedList === null ? null : Array.from(selected);
        const groups = [
            { title: 'Workspace Repositories', repos: repos.filter((repo) => repo.group !== 'agents') },
            { title: 'Agent Repositories', repos: repos.filter((repo) => repo.group === 'agents') }
        ].filter((group) => group.repos.length > 0);
        const fragment = document.createDocumentFragment();
        for (const group of groups) {
            const groupElement = document.createElement('div');
            groupElement.className = 'autocommit-repo-group';
            const title = document.createElement('div');
            title.className = 'autocommit-repo-group-title';
            title.textContent = group.title;
            groupElement.appendChild(title);
            for (const repo of group.repos) {
                const label = document.createElement('label');
                label.className = 'autocommit-repo';
                const row = document.createElement('div');
                row.className = 'autocommit-repo-row';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = selected.has(repo.path);
                checkbox.dataset.repoPath = repo.path;
                const nameSpan = document.createElement('span');
                nameSpan.textContent = repo.name || repo.path;
                row.appendChild(checkbox);
                row.appendChild(nameSpan);

                if (repo.path && repo.name && repo.name !== repo.path) {
                    const pathSpan = document.createElement('span');
                    pathSpan.className = 'autocommit-repo-path';
                    pathSpan.textContent = repo.path;
                    row.appendChild(pathSpan);
                }
                label.appendChild(row);
                groupElement.appendChild(label);
            }
            fragment.appendChild(groupElement);
        }
        container.appendChild(fragment);
        this.syncAutocommitToggleAllState();
    }
}
