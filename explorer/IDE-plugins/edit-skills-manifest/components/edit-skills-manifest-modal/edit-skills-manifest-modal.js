import { callExplorerTool, ensureSuccess } from '/explorer/services/infrastructure/explorerApi.js';
import {
    buildSkillsManifestPath,
    deriveRepoNameFromUrl,
    parseToolResult
} from '../../skills-manifest-utils.mjs';

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeRepoKey(value = '') {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function repoMatchesKnownRepository(repo, repository) {
    const repoName = normalizeRepoKey(repo?.name);
    const knownName = normalizeRepoKey(repository?.name);
    const repoUrl = normalizeRepoKey(repo?.url);
    const knownUrl = normalizeRepoKey(repository?.url);
    return Boolean(
        (knownName && repoName === knownName)
        || (knownUrl && repoUrl === knownUrl)
        || (knownName && repoUrl === knownName)
        || (knownUrl && repoName === knownUrl)
    );
}

function normalizeState(raw = {}) {
    const repositories = Array.isArray(raw.repositories) ? raw.repositories : [];
    return {
        manifestPath: raw.manifestPath || '',
        folderPath: raw.folderPath || '',
        installedSkills: Array.isArray(raw.installedSkills) ? raw.installedSkills : [],
        skillOutputs: Array.isArray(raw.skillOutputs) ? raw.skillOutputs : [],
        diagnostics: Array.isArray(raw.diagnostics) ? raw.diagnostics : [],
        skillRepositories: Array.isArray(raw.skillRepositories) ? raw.skillRepositories : [],
        repositories: repositories.map((repo) => ({
            url: String(repo.url || ''),
            name: String(repo.name || ''),
            branch: repo.branch || null,
            cached: Boolean(repo.cached),
            repoPath: String(repo.repoPath || ''),
            skills: Array.isArray(repo.skills) ? repo.skills : [],
            availableSkills: Array.isArray(repo.availableSkills) ? repo.availableSkills : [],
            cacheError: String(repo.cacheError || '')
        }))
    };
}

function normalizeManifestEntry(entry = {}) {
    if (typeof entry === 'string') {
        const url = String(entry || '').trim();
        return {
            url,
            name: deriveRepoNameFromUrl(url),
            branch: null,
            cached: false,
            repoPath: '',
            skills: [],
            availableSkills: [],
            cacheError: ''
        };
    }
    const skills = Array.isArray(entry.skills) ? entry.skills.map((skill) => String(skill || '').trim()).filter(Boolean) : [];
    return {
        url: String(entry.url || '').trim(),
        name: String(entry.name || '').trim() || deriveRepoNameFromUrl(entry.url || ''),
        branch: entry.branch || null,
        cached: false,
        repoPath: '',
        skills,
        availableSkills: skills,
        cacheError: ''
    };
}

function mergeSkillRepositories(nextState, previousState) {
    if (nextState.skillRepositories.length) return nextState;
    return {
        ...nextState,
        skillRepositories: Array.isArray(previousState?.skillRepositories) ? previousState.skillRepositories : []
    };
}

export class EditSkillsManifestModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.folderPath = String(element.dataset.folderPath || element.getAttribute('data-folder-path') || '').trim();
        this.manifestPath = String(element.dataset.manifestPath || element.getAttribute('data-manifest-path') || '').trim() || buildSkillsManifestPath(this.folderPath);
        this.state = normalizeState({ manifestPath: this.manifestPath, folderPath: this.folderPath });
        this.expandedRepos = new Set();
        this.seenRepos = new Set();
        this.changed = false;
        this.busy = false;
        this.boundSubmit = (event) => {
            event.preventDefault();
            void this.addRepository();
        };
        this.boundClick = this.handleClick.bind(this);
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.cacheElements();
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.form?.addEventListener('submit', this.boundSubmit);
        if (!this.element.dataset.editSkillsManifestBound) {
            this.element.addEventListener('click', this.boundClick);
            this.element.dataset.editSkillsManifestBound = 'true';
        }
        await this.loadState();
        this.urlInput?.focus();
    }

    afterUnload() {
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.element?.removeEventListener('click', this.boundClick);
        if (this.element?.dataset) {
            delete this.element.dataset.editSkillsManifestBound;
        }
    }

    cacheElements() {
        this.pathEl = this.element.querySelector('[data-manifest-path]');
        this.form = this.element.querySelector('[data-add-form]');
        this.urlInput = this.element.querySelector('#editSkillsManifestRepoInput');
        this.nameInput = this.element.querySelector('#editSkillsManifestNameInput');
        this.branchInput = this.element.querySelector('#editSkillsManifestBranchInput');
        this.statusEl = this.element.querySelector('[data-status]');
        this.listEl = this.element.querySelector('[data-repository-list]');
        this.presetListEl = this.element.querySelector('[data-preset-list]');
        if (this.pathEl) {
            this.pathEl.textContent = this.manifestPath || 'ploinky-skills-manifest.json';
        }
        this.render();
    }

    async callJsonTool(name, args) {
        const payload = await callExplorerTool(name, args, { raw: true, withLoader: false });
        ensureSuccess(payload);
        return parseToolResult(payload);
    }

    async loadStateFromManifestFile() {
        const manifestPath = this.manifestPath || buildSkillsManifestPath(this.folderPath);
        const text = await callExplorerTool('read_text_file', { path: manifestPath }, { withLoader: false });
        const parsed = JSON.parse(text || '[]');
        const entries = Array.isArray(parsed) ? parsed : [];
        const repositories = entries.map(normalizeManifestEntry).filter((repo) => repo.url || repo.name);
        return {
            manifestPath,
            folderPath: this.folderPath,
            repositories,
            installedSkills: [],
            diagnostics: [{ reason: 'Only manifest selections are available; installed output has not been verified.' }],
            skillRepositories: []
        };
    }

    async readCurrentState() {
        try {
            const raw = await this.callJsonTool('read_skills_manifest_state', { folderPath: this.folderPath });
            return normalizeState(raw);
        } catch (error) {
            return normalizeState(await this.loadStateFromManifestFile());
        }
    }

    async refreshStateAfterMutation() {
        const nextState = await this.readCurrentState();
        this.state = mergeSkillRepositories(nextState, this.state);
        this.manifestPath = this.state.manifestPath || this.manifestPath;

        const currentRepoNames = new Set(this.state.repositories.map((repo) => repo.name).filter(Boolean));
        for (const repoName of Array.from(this.expandedRepos)) {
            if (!currentRepoNames.has(repoName)) this.expandedRepos.delete(repoName);
        }
        for (const repoName of Array.from(this.seenRepos)) {
            if (!currentRepoNames.has(repoName)) this.seenRepos.delete(repoName);
        }
    }

    async loadState() {
        if (!this.folderPath) {
            this.setStatus('Missing target folder for skills manifest.', 'error');
            return;
        }
        this.setBusy(true);
        this.setStatus('Loading skills manifest...', 'info');
        try {
            this.state = mergeSkillRepositories(await this.readCurrentState(), this.state);
            if (!this.state.skillRepositories.length) {
                this.state.skillRepositories = await this.loadMarketplaceSkillRepositories();
            }
            this.manifestPath = this.state.manifestPath || this.manifestPath;
            this.showExportStatus(null, '');
        } catch (error) {
            try {
                const raw = await this.loadStateFromManifestFile();
                this.state = mergeSkillRepositories(normalizeState(raw), this.state);
                if (!this.state.skillRepositories.length) {
                    this.state.skillRepositories = await this.loadMarketplaceSkillRepositories();
                }
                this.manifestPath = this.state.manifestPath || this.manifestPath;
                this.setStatus('Loaded manifest directly. Repository cache details are unavailable until the skills manifest tools reload.', 'info');
            } catch (fallbackError) {
                this.setStatus(fallbackError?.message || error?.message || 'Could not read skills manifest.', 'error');
            }
        } finally {
            this.setBusy(false);
            this.render();
        }
    }

    async loadMarketplaceSkillRepositories() {
        const response = await fetch('/api/marketplace', {
            credentials: 'include',
            headers: { Accept: 'application/json' }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
            return [];
        }
        const repositories = Array.isArray(data?.marketplace?.repositories)
            ? data.marketplace.repositories
            : (Array.isArray(data?.repositories) ? data.repositories : []);
        return repositories
            .filter((repo) => {
                const kind = String(repo?.kind || '').trim().toLowerCase();
                return kind === 'skills' || kind === 'mixed';
            })
            .filter((repo) => String(repo?.url || '').trim())
            .map((repo) => ({
                name: String(repo.name || ''),
                label: String(repo.description || repo.name || ''),
                url: String(repo.url || ''),
                branch: String(repo.branch || ''),
                installed: Boolean(repo.installed),
                kind: String(repo.kind || '')
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    setBusy(value) {
        this.busy = Boolean(value);
        this.render();
    }

    setStatus(message, type = '') {
        if (!this.statusEl) return;
        this.statusEl.textContent = message;
        this.statusEl.hidden = !message;
        this.statusEl.classList.toggle('is-error', type === 'error');
        this.statusEl.classList.toggle('is-info', type === 'info');
    }

    showExportStatus(result, success) {
        const diagnostics = [...(result?.exportResult?.diagnostics || []), ...(this.state.diagnostics || [])];
        const messages = [...new Set(diagnostics.map((item) => `${item.name ? `${item.name}: ` : ''}${item.message || item.reason || 'Export conflict'}`))];
        this.setStatus([success, ...messages].filter(Boolean).join(' '), 'info');
    }

    render() {
        for (const repo of this.state.repositories) {
            if (repo.name && !this.seenRepos.has(repo.name)) {
                this.seenRepos.add(repo.name);
                this.expandedRepos.add(repo.name);
            }
        }
        this.renderPresets();
        this.renderList();
        const disabled = this.busy;
        [this.urlInput, this.nameInput, this.branchInput].forEach((input) => {
            if (input) input.disabled = disabled;
        });
        const submit = this.form?.querySelector?.('button[type="submit"]');
        if (submit) submit.disabled = disabled;
    }

    renderPresets() {
        if (!this.presetListEl) return;
        const repositories = this.state.skillRepositories || [];
        if (!repositories.length) {
            this.presetListEl.innerHTML = '<div class="edit-skills-manifest-empty">No predefined skills repositories found.</div>';
            return;
        }
        this.presetListEl.innerHTML = repositories.map((repository, index) => {
            const alreadyAdded = this.state.repositories.some((repo) => repoMatchesKnownRepository(repo, repository));
            return `
                <div class="edit-skills-manifest-preset-row ${alreadyAdded ? 'is-added' : ''}">
                    <div>
                        <div class="edit-skills-manifest-preset-name">${escapeHtml(repository.name || repository.label || repository.url)}</div>
                        <div class="edit-skills-manifest-preset-url">${escapeHtml(repository.url)}</div>
                    </div>
                    <button class="general-button edit-skills-manifest-preset-add" type="button" data-preset-index="${index}" ${alreadyAdded || this.busy ? 'disabled' : ''}>${alreadyAdded ? 'Added' : 'Add'}</button>
                </div>
            `;
        }).join('');
    }

    renderList() {
        if (!this.listEl) return;
        if (!this.state.repositories.length) {
            this.listEl.innerHTML = '<div class="edit-skills-manifest-empty">No skill repositories configured.</div>';
            return;
        }

        this.listEl.innerHTML = this.state.repositories.map((repo) => {
            const repoExpanded = this.expandedRepos.has(repo.name);
            const selected = new Set(repo.skills);
            const skills = repo.availableSkills.length
                ? repo.availableSkills
                : repo.skills;
            const skillsHtml = skills.length
                ? skills.map((skill) => {
                    const installed = selected.has(skill);
                    return `
                        <div class="edit-skills-manifest-skill-row ${installed ? 'is-enabled' : 'is-disabled'}">
                            <div>
                                <span class="edit-skills-manifest-skill-name">${escapeHtml(skill)}</span>
                                <span>${escapeHtml(this.state.skillOutputs.find((item) => item.name === skill)?.state || 'not exported')} · ${installed ? 'selected for export' : 'not selected'}</span>
                            </div>
                            <button class="edit-skills-manifest-skill-action ${installed ? 'gray-button danger' : 'is-add'}" type="button" data-repo-name="${escapeHtml(repo.name)}" data-skill-name="${escapeHtml(skill)}" data-skill-enabled="${installed ? 'false' : 'true'}" ${this.busy ? 'disabled' : ''}>${installed ? 'Remove' : 'Add'}</button>
                        </div>
                    `;
                }).join('')
                : `<div class="edit-skills-manifest-empty">${escapeHtml(repo.cacheError || 'No cached skills found for this repository.')}</div>`;
            return `
                <section class="edit-skills-manifest-repo-card ${repoExpanded ? 'is-expanded' : 'is-collapsed'}">
                    <div class="edit-skills-manifest-repo-header" data-repo-toggle="${escapeHtml(repo.name)}" aria-expanded="${repoExpanded ? 'true' : 'false'}">
                        <button class="edit-skills-manifest-repo-toggle" type="button" tabindex="-1" ${this.busy ? 'disabled' : ''}>
                            <span class="edit-skills-manifest-repo-arrow" aria-hidden="true"></span>
                            <span class="edit-skills-manifest-repo-meta">
                                <span class="edit-skills-manifest-repo-name">${escapeHtml(repo.name)}</span>
                                <span class="edit-skills-manifest-url">${escapeHtml(repo.url)}</span>
                                ${repo.branch ? `<span class="edit-skills-manifest-branch">branch: ${escapeHtml(repo.branch)}</span>` : ''}
                            </span>
                        </button>
                        <button class="gray-button danger edit-skills-manifest-remove-repo" type="button" title="Remove repository" aria-label="Remove repository" data-remove-repo="${escapeHtml(repo.name)}" ${this.busy ? 'disabled' : ''}>Remove Repo</button>
                    </div>
                    <div class="edit-skills-manifest-skill-list" aria-hidden="${repoExpanded ? 'false' : 'true'}" style="${repoExpanded ? '' : 'display: none;'}">${skillsHtml}</div>
                </section>
            `;
        }).join('');
    }

    toggleRepository(repoName) {
        if (!repoName) return;
        if (this.expandedRepos.has(repoName)) {
            this.expandedRepos.delete(repoName);
        } else {
            this.expandedRepos.add(repoName);
        }
        this.renderList();
    }

    async addRepository() {
        if (this.busy) return;
        const url = String(this.urlInput?.value || '').trim();
        const name = String(this.nameInput?.value || '').trim() || deriveRepoNameFromUrl(url);
        const branch = String(this.branchInput?.value || '').trim();
        if (!url) {
            this.setStatus('Repository URL or known repo name is required.', 'error');
            return;
        }
        this.setBusy(true);
        this.setStatus(`Adding ${name || url}...`, 'info');
        try {
            const result = await this.callJsonTool('add_skills_manifest_repo', {
                folderPath: this.folderPath,
                url,
                ...(name ? { name } : {}),
                ...(branch ? { branch } : {})
            });
            if (result?.added === false) {
                this.setStatus(result.message || 'The repository was cached but no skills were added.', 'info');
                return;
            }
            await this.refreshStateAfterMutation();
            this.changed = true;
            if (this.urlInput) this.urlInput.value = '';
            if (this.nameInput) this.nameInput.value = '';
            if (this.branchInput) this.branchInput.value = '';
            this.showExportStatus(result, result?.message || `${name || url} added.`);
        } catch (error) {
            this.setStatus(error?.message || 'Could not add repository.', 'error');
        } finally {
            this.setBusy(false);
            this.render();
        }
    }

    async addPresetRepository(indexValue) {
        const index = Number.parseInt(String(indexValue), 10);
        const preset = this.state.skillRepositories?.[index];
        if (!preset) return;
        if (this.urlInput) this.urlInput.value = preset.url;
        if (this.nameInput) this.nameInput.value = preset.name || deriveRepoNameFromUrl(preset.url);
        if (this.branchInput) this.branchInput.value = preset.branch || '';
        await this.addRepository();
    }

    async setSkillEnabled(repoName, skill, enabled) {
        if (this.busy) return;
        this.setBusy(true);
        this.setStatus(`${enabled ? 'Adding' : 'Removing'} ${skill}...`, 'info');
        try {
            const result = await this.callJsonTool('set_skills_manifest_skill_enabled', {
                folderPath: this.folderPath,
                repoName,
                skill,
                enabled
            });
            await this.refreshStateAfterMutation();
            this.changed = true;
            this.showExportStatus(result, `${skill} ${enabled ? 'selected' : 'deselected'} for export.`);
        } catch (error) {
            this.setStatus(error?.message || 'Could not update skill.', 'error');
        } finally {
            this.setBusy(false);
            this.render();
        }
    }

    async removeRepository(repoName) {
        if (this.busy) return;
        this.setBusy(true);
        this.setStatus(`Removing ${repoName}...`, 'info');
        try {
            const result = await this.callJsonTool('remove_skills_manifest_repo', {
                folderPath: this.folderPath,
                repoName
            });
            await this.refreshStateAfterMutation();
            this.changed = true;
            this.showExportStatus(result, `${repoName} removed from manifest.`);
        } catch (error) {
            this.setStatus(error?.message || 'Could not remove repository.', 'error');
        } finally {
            this.setBusy(false);
            this.render();
        }
    }

    handleClick(event) {
        const presetButton = event.target?.closest?.('[data-preset-index]');
        if (presetButton && this.element.contains(presetButton)) {
            event.preventDefault();
            if (!presetButton.disabled) void this.addPresetRepository(presetButton.dataset.presetIndex);
            return;
        }

        const toggleRepoTarget = event.target?.closest?.('[data-repo-toggle]');
        const isRemoveRepoClick = Boolean(event.target?.closest?.('[data-remove-repo]'));
        if (toggleRepoTarget && this.element.contains(toggleRepoTarget) && !isRemoveRepoClick) {
            event.preventDefault();
            if (!this.busy) this.toggleRepository(toggleRepoTarget.dataset.repoToggle || '');
            return;
        }

        const removeRepoButton = event.target?.closest?.('[data-remove-repo]');
        if (removeRepoButton && this.element.contains(removeRepoButton)) {
            event.preventDefault();
            if (!removeRepoButton.disabled) void this.removeRepository(removeRepoButton.dataset.removeRepo || '');
            return;
        }

        const skillButton = event.target?.closest?.('[data-skill-name]');
        if (skillButton && this.element.contains(skillButton)) {
            event.preventDefault();
            if (!skillButton.disabled) {
                void this.setSkillEnabled(
                    skillButton.dataset.repoName || '',
                    skillButton.dataset.skillName || '',
                    skillButton.dataset.skillEnabled === 'true'
                );
            }
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, {
            changed: this.changed,
            count: this.state.installedSkills.length
        });
    }
}
