import {
    callGitTool,
    escapeHtml,
    renderErrorState,
    renderLoadingState,
    setContainerHtml,
    GithubAuthController
} from "../git-repository-modal-shared/github-picker.js";
import { hideRepositoryLoader } from "../git-repository-modal-shared/repository-loader.js";

function deriveNameFromRemoteUrl(remoteUrl) {
    return String(remoteUrl || '')
        .trim()
        .replace(/\/+$/g, '')
        .replace(/\.git$/i, '')
        .split(/[/:]/)
        .filter(Boolean)
        .pop() || '';
}

export class GitCloneRepositoryModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.form = null;
        this.errorNode = null;
        this.submoduleMode = this.element.getAttribute('data-submoduleMode') === 'true';
        this.repositories = [];
        this.selectedRepository = null;
        this.repositoriesLoaded = false;
        this.loadingGithub = false;
        this.auth = new GithubAuthController({
            getContainer: () => this.element.querySelector('[data-github-repositories]'),
            onAuthorized: () => this.loadRepositories({ force: true }),
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
        this.form = this.element.querySelector('[data-git-clone-repository-form]');
        this.errorNode = this.element.querySelector('[data-git-clone-repository-error]');
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.form?.addEventListener('submit', this.boundSubmit);
        this.element.removeEventListener('input', this.boundInput);
        this.element.addEventListener('input', this.boundInput);
        this.syncContextUi();
        this.loadRepositories();
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

    setValue(name, value) {
        const input = this.form?.elements?.[name];
        if (input) input.value = value;
    }

    handleInput(event) {
        if (event.target?.matches?.('[name="repositorySearch"]')) {
            this.renderRepositories();
        }
        if (event.target?.matches?.('[name="remoteUrl"]')) {
            event.target.dataset.auto = 'false';
            if (this.selectedRepository) {
                this.selectedRepository = null;
                this.renderRepositories();
            }
        }
    }

    reloadGithubData() {
        this.loadRepositories({ force: true });
    }

    continueGithubAuth() {
        this.auth.continueGithubAuth();
    }

    syncContextUi() {
        const title = this.element.querySelector('[data-git-clone-repository-title]');
        if (title) {
            title.textContent = this.submoduleMode ? 'Add Git submodule' : 'Clone repository';
        }
        const submit = this.element.querySelector('[data-git-clone-repository-submit]');
        if (submit) {
            submit.textContent = this.submoduleMode ? 'Add submodule' : 'Clone';
        }
        const searchLabel = this.element.querySelector('[data-git-clone-repository-search-label]');
        if (searchLabel) {
            searchLabel.textContent = this.submoduleMode ? 'Select existing repository' : 'Find repository';
        }
    }

    async loadRepositories({ force = false } = {}) {
        const node = this.element.querySelector('[data-github-repositories]');
        if (this.auth.isPending()) {
            this.auth.renderPending();
            this.auth.schedulePoll(this.auth.pending?.interval);
            return;
        }
        if (this.loadingGithub || (!force && this.repositoriesLoaded)) {
            return;
        }
        this.loadingGithub = true;
        setContainerHtml(node, renderLoadingState('Loading repositories...'));
        try {
            const result = await callGitTool('git_github_repositories');
            if (result?.ok === false) {
                if (result?.code === 'github_auth_required') {
                    await this.auth.ensureAuthorized();
                    return;
                }
                throw new Error(String(result?.error || result?.message || 'GitHub request failed.').trim());
            }
            this.repositories = Array.isArray(result?.repositories) ? result.repositories : [];
            this.repositoriesLoaded = true;
            this.renderRepositories();
        } catch (error) {
            this.renderGithubError(error?.message || 'Unable to load GitHub repositories.');
        } finally {
            this.loadingGithub = false;
        }
    }

    renderGithubError(message) {
        const node = this.element.querySelector('[data-github-repositories]');
        if (node) {
            setContainerHtml(node, renderErrorState(message));
        }
    }

    renderRepositories() {
        const node = this.element.querySelector('[data-github-repositories]');
        if (!node) return;
        const query = this.readValue('repositorySearch').toLowerCase();
        const repositories = this.repositories.filter((repo) => {
            if (!query) return true;
            return String(repo.fullName || '').toLowerCase().includes(query)
                || String(repo.description || '').toLowerCase().includes(query);
        });
        if (!repositories.length) {
            setContainerHtml(node, '<div class="git-new-repository-state">No repositories match this search.</div>');
            return;
        }
        setContainerHtml(node, repositories.map((repo) => {
            const index = this.repositories.indexOf(repo);
            const selected = this.selectedRepository?.fullName === repo.fullName ? ' selected' : '';
            const visibility = repo.private ? 'Private' : 'Public';
            return `
                <button type="button" class="git-new-repository-repo${selected}" data-local-action="selectRepository ${index}">
                    <span class="git-new-repository-repo-main">
                        <span class="git-new-repository-repo-name">${escapeHtml(repo.fullName)}</span>
                        <span class="git-new-repository-repo-visibility">${visibility}</span>
                    </span>
                    <span class="git-new-repository-repo-description">${escapeHtml(repo.description || repo.defaultBranch || 'No description')}</span>
                </button>
            `.trim();
        }).join(''));
    }

    setRemoteUrl(value, { auto = false } = {}) {
        const input = this.form?.elements?.remoteUrl;
        if (!input) return;
        input.value = value;
        input.dataset.auto = auto ? 'true' : 'false';
    }

    selectRepository(elementOrIndex, maybeIndex) {
        const index = Number(maybeIndex ?? elementOrIndex);
        const repo = this.repositories[index];
        if (!repo) return;
        this.selectedRepository = repo;
        this.setValue('cloneLocalName', repo.name || '');
        this.setRemoteUrl(repo.cloneUrl || '', { auto: true });
        this.renderRepositories();
    }

    confirm() {
        const remoteUrl = this.readValue('remoteUrl');
        if (!remoteUrl) {
            this.setError(this.submoduleMode
                ? 'Select a GitHub repository or enter a remote URL to add as a submodule.'
                : 'Select a GitHub repository or enter a remote URL to clone.');
            return;
        }
        const localName = this.readValue('cloneLocalName')
            || this.selectedRepository?.name
            || deriveNameFromRemoteUrl(remoteUrl);
        if (!localName) {
            this.setError('Local folder name is required.');
            return;
        }
        this.setError('');
        assistOS.UI.closeModal(this.element, {
            name: localName,
            localName,
            remoteUrl,
            remote: 'origin',
            repository: this.selectedRepository
        });
    }
}
