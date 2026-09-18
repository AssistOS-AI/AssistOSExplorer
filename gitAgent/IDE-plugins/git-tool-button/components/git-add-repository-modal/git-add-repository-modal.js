import {
    callGitTool,
    escapeHtml,
    renderErrorState,
    renderLoadingState,
    setContainerHtml,
    GithubAuthController
} from "../git-repository-modal-shared/github-picker.js";
import { hideRepositoryLoader } from "../git-repository-modal-shared/repository-loader.js";

export class GitAddRepositoryModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.form = null;
        this.errorNode = null;
        this.submoduleMode = this.element.getAttribute('data-submoduleMode') === 'true';
        this.targets = [];
        this.selectedTarget = '';
        this.targetsLoaded = false;
        this.loadingGithub = false;
        this.auth = new GithubAuthController({
            getContainer: () => this.element.querySelector('[data-github-targets]'),
            onAuthorized: () => this.loadGithubData({ force: true }),
            onError: (message) => this.renderGithubError(message)
        });
        this.boundSubmit = (event) => {
            event.preventDefault();
            this.confirm();
        };
        this.boundInput = (event) => this.handleInput(event);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.form = this.element.querySelector('[data-git-add-repository-form]');
        this.errorNode = this.element.querySelector('[data-git-add-repository-error]');
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.form?.addEventListener('submit', this.boundSubmit);
        this.element.removeEventListener('input', this.boundInput);
        this.element.addEventListener('input', this.boundInput);
        this.syncContextUi();
        this.loadGithubData();
        hideRepositoryLoader();
    }

    afterUnload() {
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.element.removeEventListener('input', this.boundInput);
        this.auth.dispose();
    }

    closeModal() {
        assistOS.UI.closeModal(this.element);
    }

    setError(message) {
        if (!this.errorNode) return;
        this.errorNode.textContent = message;
        this.errorNode.hidden = !message;
    }

    readValue(name) {
        const input = this.form?.elements?.[name];
        return String(input?.value || '').trim();
    }

    handleInput(event) {
        const target = event.target;
        if (target?.matches?.('[name="githubName"]')) {
            this.syncAutoRemoteUrl();
        }
        if (target?.matches?.('[name="remoteUrl"]')) {
            target.dataset.auto = 'false';
        }
    }

    setRemoteUrl(value, { auto = false } = {}) {
        const input = this.form?.elements?.remoteUrl;
        if (!input) return;
        input.value = value;
        input.dataset.auto = auto ? 'true' : 'false';
    }

    syncAutoRemoteUrl() {
        const urlInput = this.form?.elements?.remoteUrl;
        if (!urlInput || urlInput.dataset.auto !== 'true') return;
        const owner = this.selectedTarget;
        const name = this.readValue('githubName');
        if (!owner || !name) return;
        urlInput.value = `https://github.com/${owner}/${name}.git`;
    }

    reloadGithubData() {
        this.loadGithubData({ force: true });
    }

    continueGithubAuth() {
        this.auth.continueGithubAuth();
    }

    syncContextUi() {
        const title = this.element.querySelector('[data-git-add-repository-title]');
        if (title) {
            title.textContent = this.submoduleMode ? 'Add Git submodule' : 'New repository';
        }
        const submit = this.element.querySelector('[data-git-add-repository-submit]');
        if (submit) {
            submit.textContent = this.submoduleMode ? 'Add submodule' : 'Create';
        }
        const visibilityField = this.element.querySelector('[data-git-add-visibility]');
        if (visibilityField) {
            visibilityField.hidden = this.submoduleMode;
        }
    }

    async loadGithubData({ force = false } = {}) {
        const node = this.element.querySelector('[data-github-targets]');
        if (this.auth.isPending()) {
            this.auth.renderPending();
            this.auth.schedulePoll(this.auth.pending?.interval);
            return;
        }
        if (this.loadingGithub || (!force && this.targetsLoaded)) {
            return;
        }
        this.loadingGithub = true;
        setContainerHtml(node, renderLoadingState('Loading GitHub organizations...'));
        try {
            const result = await callGitTool('git_github_repository_targets');
            if (result?.ok === false) {
                if (result?.code === 'github_auth_required') {
                    await this.auth.ensureAuthorized();
                    return;
                }
                throw new Error(String(result?.error || result?.message || 'GitHub request failed.').trim());
            }
            this.targets = Array.isArray(result?.targets) ? result.targets : [];
            this.targetsLoaded = true;
            this.renderTargets();
        } catch (error) {
            this.renderGithubError(error?.message || 'Unable to load GitHub organizations.');
        } finally {
            this.loadingGithub = false;
        }
    }

    renderGithubError(message) {
        const node = this.element.querySelector('[data-github-targets]');
        if (node) {
            setContainerHtml(node, renderErrorState(message));
        }
    }

    renderTargets() {
        const node = this.element.querySelector('[data-github-targets]');
        if (!node) return;
        if (!this.targets.length) {
            setContainerHtml(node, '<div class="git-new-repository-state">No GitHub organizations found.</div>');
            return;
        }
        setContainerHtml(node, this.targets.map((target) => {
            const active = target.login === this.selectedTarget ? ' active' : '';
            const organizationUrl = target.repositoryUrl || `https://github.com/${target.login}`;
            return `
                <button type="button" class="git-new-repository-target${active}" data-local-action="selectTarget ${escapeHtml(target.login)}">
                    <span class="git-new-repository-target-name">${escapeHtml(target.login)}</span>
                    <span class="git-new-repository-target-type">${escapeHtml(organizationUrl)}</span>
                </button>
            `.trim();
        }).join(''));
    }

    selectTarget(elementOrLogin, maybeLogin) {
        const login = String(maybeLogin || elementOrLogin || '').trim();
        this.selectedTarget = login;
        const target = this.targets.find((entry) => entry.login === login);
        if (target) {
            this.setRemoteUrl(target.repositoryUrl || `https://github.com/${login}`, { auto: true });
            this.syncAutoRemoteUrl();
        }
        this.renderTargets();
    }

    confirm() {
        const name = this.readValue('githubName');
        const remoteUrl = this.readValue('remoteUrl');
        if (!name) {
            this.setError('Repository name is required.');
            return;
        }
        if (!remoteUrl && !this.selectedTarget) {
            this.setError('Select an organization or enter a remote URL.');
            return;
        }
        this.setError('');
        assistOS.UI.closeModal(this.element, {
            owner: this.selectedTarget,
            name,
            localName: name,
            visibility: this.readValue('visibility') === 'public' ? 'public' : 'private',
            remoteUrl,
            remote: 'origin'
        });
    }
}
