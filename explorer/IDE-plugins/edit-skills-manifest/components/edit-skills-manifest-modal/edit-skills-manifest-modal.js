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
    return String(value || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
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
            cacheError: String(repo.cacheError || ''),
            skillsets: Array.isArray(repo.skillsets) ? repo.skillsets : []
        }))
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
        this.selectedRepository = '';
        this.changed = false;
        this.busy = false;
        this.unloaded = false;
        this.boundSubmit = (event) => {
            event.preventDefault();
            void this.addRepository();
        };
        this.boundClick = this.handleClick.bind(this);
        this.boundChange = this.handleChange.bind(this);
        this.boundKeydown = this.handleKeydown.bind(this);
        this.boundAddCancel = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.closeAddRepository();
        };
        this.boundAddClose = (event) => {
            event.stopPropagation();
            this.addTrigger?.setAttribute('aria-expanded', 'false');
        };
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.unloaded = false;
        this.cacheElements();
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.form?.addEventListener('submit', this.boundSubmit);
        if (!this.element.dataset.editSkillsManifestBound) {
            this.element.addEventListener('click', this.boundClick);
            this.element.addEventListener('change', this.boundChange);
            this.element.addEventListener('keydown', this.boundKeydown);
            this.element.dataset.editSkillsManifestBound = 'true';
        }
        this.addDialog?.removeEventListener('cancel', this.boundAddCancel);
        this.addDialog?.addEventListener('cancel', this.boundAddCancel);
        this.addDialog?.removeEventListener('close', this.boundAddClose);
        this.addDialog?.addEventListener('close', this.boundAddClose);
        await this.loadState();
        if (!this.unloaded) this.listEl?.querySelector?.('[aria-pressed="true"]')?.focus();
    }

    afterUnload() {
        this.unloaded = true;
        if (this.addDialog?.open) this.addDialog.close();
        this.addDialog?.removeEventListener('cancel', this.boundAddCancel);
        this.addDialog?.removeEventListener('close', this.boundAddClose);
        this.form?.removeEventListener('submit', this.boundSubmit);
        this.element?.removeEventListener('click', this.boundClick);
        this.element?.removeEventListener('change', this.boundChange);
        this.element?.removeEventListener('keydown', this.boundKeydown);
        if (this.element?.dataset) {
            delete this.element.dataset.editSkillsManifestBound;
        }
    }

    cacheElements() {
        this.element.closest?.('dialog')?.setAttribute('aria-labelledby', 'explorer-skills-manager-title');
        this.pathEl = this.element.querySelector('[data-manifest-path]');
        this.form = this.element.querySelector('[data-add-form]');
        this.urlInput = this.element.querySelector('#editSkillsManifestRepoInput');
        this.nameInput = this.element.querySelector('#editSkillsManifestNameInput');
        this.branchInput = this.element.querySelector('#editSkillsManifestBranchInput');
        this.statusEl = this.element.querySelector('[data-status]');
        this.listEl = this.element.querySelector('[data-repository-list]');
        this.presetListEl = this.element.querySelector('[data-preset-list]');
        this.detailEl = this.element.querySelector('[data-repository-detail]');
        this.contentEl = this.element.querySelector('[data-skills-content]');
        this.folderContextEl = this.element.querySelector('[data-folder-context]');
        this.addTrigger = this.element.querySelector('[data-add-repository]');
        this.addDialog = this.element.querySelector('[data-add-dialog]');
        this.addStatusEl = this.element.querySelector('[data-add-status]');
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

    // The structured tool is the only state source. Its response is already
    // projected for the caller; a failure is reported and never replaced by a
    // raw manifest read, which would redisplay stored repository URLs.
    async readCurrentState() {
        const raw = await this.callJsonTool('read_skills_manifest_state', { folderPath: this.folderPath });
        return normalizeState(raw);
    }

    async refreshStateAfterMutation() {
        const nextState = await this.readCurrentState();
        this.state = mergeSkillRepositories(nextState, this.state);
        this.manifestPath = this.state.manifestPath || this.manifestPath;

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
            if (this.unloaded) return;
            if (!this.state.skillRepositories.length) {
                this.state.skillRepositories = await this.loadMarketplaceSkillRepositories();
            }
            this.manifestPath = this.state.manifestPath || this.manifestPath;
            this.showExportStatus(null, '');
        } catch (error) {
            this.setStatus(error?.message || 'Could not read skills manifest.', 'error');
        } finally {
            this.setBusy(false);
        }
    }

    async loadMarketplaceSkillRepositories() {
        const response = await fetch('/api/marketplace/repos', {
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
            // Repositories are selected by name; a blank (redacted or local)
            // display URL must not hide a known repository.
            .filter((repo) => /^[A-Za-z0-9_.-]+$/.test(String(repo?.name || '').trim()))
            .map((repo) => ({
                name: String(repo.name || ''),
                label: String(repo.description || repo.name || ''),
                url: String(repo.url || ''),
                branch: String(repo.branch || ''),
                installed: Boolean(repo.installed),
                kind: String(repo.kind || ''),
                warnings: Array.isArray(repo.warnings) ? repo.warnings : []
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    setBusy(value) {
        this.busy = Boolean(value);
        this.render();
    }

    setStatus(message, type = '') {
        if (this.unloaded) return;
        const target = this.addDialog?.open ? this.addStatusEl : this.statusEl;
        if (!target) return;
        target.textContent = message;
        target.hidden = !message;
        target.classList.toggle('is-error', type === 'error');
        target.classList.toggle('is-info', type === 'info');
    }

    showExportStatus(result, success) {
        const diagnostics = [...(result?.exportResult?.diagnostics || []), ...(this.state.diagnostics || [])];
        const messages = [...new Set(diagnostics.map((item) => `${item.name ? `${item.name}: ` : ''}${item.message || item.reason || 'Export conflict'}`))];
        this.setStatus([success, ...messages].filter(Boolean).join(' '), 'info');
    }

    render() {
        if (this.unloaded) return;
        const active = this.element.ownerDocument?.activeElement;
        const focusKey = this.element.contains?.(active) ? active.dataset.skillsFocus : '';
        const scrollTop = this.contentEl?.scrollTop || 0;
        const popupScroll = this.addDialog?.querySelector('.skills-add-content')?.scrollTop || 0;
        this.renderPresets();
        this.renderList();
        if (this.folderContextEl) this.folderContextEl.textContent = this.state.folderPath ? `Folder · ${this.state.folderPath}` : 'Folder skills';
        const disabled = this.busy;
        [this.urlInput, this.nameInput, this.branchInput].forEach((input) => {
            if (input) input.disabled = disabled;
        });
        const submit = this.form?.querySelector?.('button[type="submit"]');
        if (submit) submit.disabled = disabled;
        if (this.addTrigger) this.addTrigger.disabled = disabled;
        for (const button of this.element.querySelectorAll?.('[data-add-close], [data-close-manager]') || []) button.disabled = disabled;
        this.addDialog?.setAttribute('aria-busy', String(disabled));
        if (focusKey) [...(this.element.querySelectorAll?.('[data-skills-focus]') || [])].find(control => control.dataset.skillsFocus === focusKey && !control.disabled)?.focus({ preventScroll: true });
        if (this.contentEl) this.contentEl.scrollTop = scrollTop;
        const popupContent = this.addDialog?.querySelector('.skills-add-content');
        if (popupContent) popupContent.scrollTop = popupScroll;
    }

    renderPresets() {
        if (!this.presetListEl) return;
        const repositories = this.state.skillRepositories || [];
        if (!repositories.length) {
            this.presetListEl.innerHTML = '<div class="edit-skills-manifest-empty">No skill repositories found in the workspace or registered in Ploinky.</div>';
            return;
        }
        this.presetListEl.innerHTML = repositories.map((repository, index) => {
            const alreadyAdded = this.state.repositories.some((repo) => repoMatchesKnownRepository(repo, repository));
            return `
                <div class="recommended-repository ${alreadyAdded ? 'is-added' : ''}">
                    <div>
                        <div class="recommended-name">${escapeHtml(repository.name || repository.label || repository.url)}</div>
                        ${repository.label && repository.label !== repository.name ? `<div class="muted">${escapeHtml(repository.label)}</div>` : ''}
                        ${(repository.warnings || []).map(warning => `<div class="skill-repository-warning">Warning: ${escapeHtml(warning)}</div>`).join('')}
                    </div>
                    <button class="button secondary" type="button" data-preset-index="${index}" data-skills-focus="preset:${index}" ${alreadyAdded || this.busy ? 'disabled' : ''}>${alreadyAdded ? 'Added' : 'Add repo'}</button>
                </div>
            `;
        }).join('');
    }

    renderList() {
        if (!this.listEl) return;
        if (!this.state.repositories.some(repo => repo.name === this.selectedRepository)) this.selectedRepository = this.state.repositories[0]?.name || '';
        if (!this.state.repositories.length) {
            this.listEl.innerHTML = '<p>No repositories added yet.</p>';
            if (this.detailEl) this.detailEl.innerHTML = '<h3 id="explorer-skills-repository-title">Repositories</h3><p class="muted">No repositories added yet. Choose + Add repo to get started.</p>';
            return;
        }
        this.listEl.innerHTML = this.state.repositories.map(repo => {
            const skills = repo.availableSkills.length ? repo.availableSkills : repo.skills;
            const count = repo.skillsets.length;
            return `<button class="skills-repository-option" type="button" data-repo-select="${escapeHtml(repo.name)}" data-skills-focus="repository:${escapeHtml(repo.name)}" aria-controls="explorer-skills-repository-detail" aria-pressed="${repo.name === this.selectedRepository}" ${this.busy ? 'disabled' : ''}><span>${escapeHtml(repo.name)}</span><span class="muted">${count} ${count === 1 ? 'skillset' : 'skillsets'} · ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}</span></button>`;
        }).join('');
        this.renderRepository(this.state.repositories.find(repo => repo.name === this.selectedRepository));
    }

    renderRepository(repo) {
        if (!this.detailEl || !repo) return;
        const selected = new Set(repo.skills);
        const skills = repo.availableSkills.length ? repo.availableSkills : repo.skills;
        const sets = repo.skillsets || [];
        const members = names => '<ul class="skill-members">' + names.map(name => `<li>${escapeHtml(name)}</li>`).join('') + '</ul>';
        const toggle = (name, enabled, isSet, partial = false) => `<label class="skill-toggle"><input type="checkbox" data-repo-name="${escapeHtml(repo.name)}" ${isSet ? 'data-skillset-name' : 'data-skill-name'}="${escapeHtml(name)}" data-skills-focus="${isSet ? 'set' : 'skill'}:${escapeHtml(repo.name)}:${escapeHtml(name)}" aria-label="${escapeHtml(name)}: selected for folder export" aria-checked="${partial ? 'mixed' : Boolean(enabled)}" ${partial ? 'data-partial="true"' : ''} ${enabled ? 'checked' : ''} ${this.busy ? 'disabled' : ''}><span>${partial ? 'Partially enabled' : enabled ? 'Enabled' : 'Disabled'}</span></label>`;
        this.detailEl.id = 'explorer-skills-repository-detail';
        this.detailEl.innerHTML = `<div class="skills-repository-heading"><div><h3 id="explorer-skills-repository-title">${escapeHtml(repo.name)}</h3><p class="muted skills-repository-source">${escapeHtml(repo.cached && repo.repoPath ? repo.repoPath : repo.url || repo.name)}</p></div><details class="skills-repository-menu"><summary class="button secondary icon-button" aria-label="More actions for ${escapeHtml(repo.name)}"><span aria-hidden="true">⋮</span></summary><div class="skills-menu-options"><button class="button danger" type="button" data-remove-repo="${escapeHtml(repo.name)}" ${this.busy ? 'disabled' : ''}>Remove repository</button></div></details></div>`;
        if (sets.length) {
            this.detailEl.innerHTML += '<h4 class="skills-section-label">Skillsets</h4>' + sets.map(set => `<article class="skillset-item ${set.enabled ? '' : 'is-disabled'}"><div class="skillset-heading"><h5>${escapeHtml(set.name)}</h5>${toggle(set.name, set.enabled, true, set.partial)}</div><p class="skillset-description">${escapeHtml(set.description)}</p>${members(set.skills)}</article>`).join('');
            const grouped = new Set(sets.flatMap(set => set.skills));
            const ungrouped = skills.filter(name => !grouped.has(name));
            if (ungrouped.length) this.detailEl.innerHTML += '<h4 class="skills-section-label">Other skills</h4><p class="muted">Not included in the declared skillsets.</p>' + members(ungrouped);
        } else {
            this.detailEl.innerHTML += '<h4 class="skills-section-label">Skills</h4>' + (skills.map(name => `<div class="individual-skill"><span>${escapeHtml(name)}</span>${toggle(name, selected.has(name), false)}</div>`).join('') || '<p class="muted">No skills available.</p>');
        }
        if (repo.cacheError) this.detailEl.innerHTML += `<p class="message is-error">${escapeHtml(repo.cacheError)}</p>`;
        for (const input of this.detailEl.querySelectorAll?.('[data-partial]') || []) input.indeterminate = true;
    }

    selectRepository(repoName) {
        if (this.busy || !this.state.repositories.some(repo => repo.name === repoName)) return;
        this.selectedRepository = repoName;
        this.render();
        if (this.contentEl) this.contentEl.scrollTop = 0;
    }

    openAddRepository() {
        if (this.busy || this.unloaded || !this.addDialog || this.addDialog.open) return;
        const menu = this.detailEl?.querySelector?.('.skills-repository-menu[open]');
        if (menu) menu.open = false;
        if (this.addStatusEl) { this.addStatusEl.textContent = ''; this.addStatusEl.hidden = true; }
        this.addDialog.showModal();
        this.addTrigger?.setAttribute('aria-expanded', 'true');
        this.urlInput?.focus();
    }

    closeAddRepository(force = false) {
        if ((!force && this.busy) || !this.addDialog?.open) return;
        this.addDialog.close();
        this.addTrigger?.setAttribute('aria-expanded', 'false');
        this.addTrigger?.focus();
    }

    async addRepository(preset = null) {
        if (this.busy) return;
        const previousNames = new Set(this.state.repositories.map(repo => repo.name));
        // A known repository is submitted by its name, which the server resolves
        // to its internal source; display URLs are never clone inputs.
        const presetName = String(preset?.name || '').trim();
        const url = preset ? presetName : String(this.urlInput?.value || '').trim();
        const name = presetName || deriveRepoNameFromUrl(url);
        const branch = String(preset?.branch || '').trim();
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
            this.selectedRepository = this.state.repositories.find(repo => !previousNames.has(repo.name))?.name || this.selectedRepository;
            this.changed = true;
            if (this.urlInput) this.urlInput.value = '';
            if (this.nameInput) this.nameInput.value = '';
            if (this.branchInput) this.branchInput.value = '';
            this.closeAddRepository(true);
            this.showExportStatus(result, result?.message || `${name || url} added.`);
        } catch (error) {
            this.setStatus(error?.message || 'Could not add repository.', 'error');
        } finally {
            this.setBusy(false);
        }
    }

    async addPresetRepository(indexValue) {
        const index = Number.parseInt(String(indexValue), 10);
        const preset = this.state.skillRepositories?.[index];
        if (!preset) return;
        if (this.urlInput) this.urlInput.value = preset.name || '';
        if (this.nameInput) this.nameInput.value = preset.name || '';
        if (this.branchInput) this.branchInput.value = preset.branch || '';
        await this.addRepository(preset);
    }

    async setSkillEnabled(repoName, skill, enabled, isSkillset = false) {
        if (this.busy) return;
        const focusKey = this.element.ownerDocument?.activeElement?.dataset.skillsFocus;
        this.setBusy(true);
        this.setStatus(`${enabled ? 'Adding' : 'Removing'} ${skill}...`, 'info');
        try {
            const result = await this.callJsonTool('set_skills_manifest_skill_enabled', {
                folderPath: this.folderPath,
                repoName,
                ...(isSkillset ? { skillset: skill } : { skill }),
                enabled
            });
            this.state = mergeSkillRepositories(normalizeState(result), this.state);
            this.changed = true;
            this.showExportStatus(result, `${skill} ${enabled ? 'selected' : 'deselected'} for export.`);
        } catch (error) {
            this.setStatus(error?.message || 'Could not update skill.', 'error');
        } finally {
            this.setBusy(false);
            if (!this.unloaded && focusKey) [...(this.element.querySelectorAll?.('[data-skills-focus]') || [])].find(control => control.dataset.skillsFocus === focusKey)?.focus({ preventScroll: true });
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
        }
    }

    handleClick(event) {
        const add = event.target?.closest?.('[data-add-repository]');
        if (add && this.element.contains(add)) {
            event.preventDefault();
            this.openAddRepository();
            return;
        }
        const closeAdd = event.target?.closest?.('[data-add-close]');
        if (closeAdd && this.element.contains(closeAdd)) {
            event.preventDefault();
            this.closeAddRepository();
            return;
        }
        if (event.target === this.addDialog) {
            const bounds = this.addDialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.closeAddRepository();
            return;
        }
        if (!event.target?.closest?.('.skills-repository-menu')) {
            const menu = this.detailEl?.querySelector?.('.skills-repository-menu[open]');
            if (menu) menu.open = false;
        }
        const presetButton = event.target?.closest?.('[data-preset-index]');
        if (presetButton && this.element.contains(presetButton)) {
            event.preventDefault();
            if (!presetButton.disabled) void this.addPresetRepository(presetButton.dataset.presetIndex);
            return;
        }

        const selectRepoTarget = event.target?.closest?.('[data-repo-select]');
        if (selectRepoTarget && this.element.contains(selectRepoTarget)) {
            event.preventDefault();
            this.selectRepository(selectRepoTarget.dataset.repoSelect || '');
            return;
        }

        const removeRepoButton = event.target?.closest?.('[data-remove-repo]');
        if (removeRepoButton && this.element.contains(removeRepoButton)) {
            event.preventDefault();
            if (!removeRepoButton.disabled) void this.removeRepository(removeRepoButton.dataset.removeRepo || '');
            return;
        }

    }

    handleChange(event) {
        const input = event.target?.closest?.('input[data-skill-name], input[data-skillset-name]');
        if (input && this.element.contains(input) && !input.disabled) {
            void this.setSkillEnabled(input.dataset.repoName || '', input.dataset.skillsetName || input.dataset.skillName || '', input.checked, input.hasAttribute('data-skillset-name'));
        }
    }

    handleKeydown(event) {
        if (event.key !== 'Escape') return;
        if (this.addDialog?.open && this.addDialog.contains(event.target)) {
            // WebSkel suppresses Escape on the parent modal; the child owns it.
            event.stopPropagation();
            if (this.busy) event.preventDefault();
            return;
        }
        const menu = this.detailEl?.querySelector?.('.skills-repository-menu[open]');
        if (menu) {
            event.preventDefault();
            event.stopPropagation();
            menu.open = false;
            menu.querySelector('summary')?.focus();
        }
    }

    closeModal() {
        if (this.busy) return;
        this.closeAddRepository();
        assistOS.UI.closeModal(this.element, {
            changed: this.changed,
            count: this.state.installedSkills.length
        });
    }
}
