import { initCreateRobotDialog, initRobotMenu } from './robot-controls.js';

function normalizeRepositorySource(source) {
    const value = (source || '').trim().replace(/\/+$/, '');
    if (!value.startsWith('https://')) return value;
    try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
        return url.href;
    } catch {
        return value;
    }
}

export function hasRecommendedRepository(robot, recommendation) {
    const sources = [recommendation.source, recommendation.url].filter(Boolean).map(normalizeRepositorySource);
    // A mixed repository is registered by its skills/ folder.
    if (recommendation.kind === 'mixed' && recommendation.source?.startsWith('/')) sources.push(`${normalizeRepositorySource(recommendation.source)}/skills`);
    return (robot.repositories || []).some(repo => !repo.builtin && (sources.includes(normalizeRepositorySource(repo.source))
        || (recommendation.name && repo.source?.startsWith('/') && normalizeRepositorySource(repo.source).endsWith('/.ploinky/repos/' + recommendation.name))));
}

export async function loadSkillRecommendations(fetchImpl = globalThis.fetch) {
    const response = await fetchImpl('/api/marketplace/repos', { credentials: 'include', cache: 'no-store',
        headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load recommended repositories from Ploinky.');
    const payload = await response.json();
    return (payload.marketplace?.repositories || []).filter(repo => ['skills', 'mixed'].includes(repo.kind) && (repo.skillSource?.source || repo.url))
        .map(repo => ({ name: repo.name, kind: repo.kind, description: repo.description || '', url: repo.url,
            warnings: Array.isArray(repo.warnings) ? repo.warnings : [],
            source: repo.skillSource?.source || repo.url, origin: repo.skillSource?.origin || 'remote' }));
}

export function skillRepositoryLabel(repo, recommendations = []) {
    if (repo.builtin) return 'Built-in copilot';
    const preferred = recommendations.find(item => hasRecommendedRepository({ repositories: [repo] }, item));
    if (preferred?.name) return preferred.name;
    const source = normalizeRepositorySource(repo.source);
    if (!source) return repo.id;
    try { return new URL(source).pathname.split('/').filter(Boolean).at(-1) || repo.id; }
    catch { return source.split('/').filter(Boolean).at(-1) || repo.id; }
}

export function openSkillsDialog(robot, { api, onChanged, canAdmin }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'skills-dialog skills-manager-dialog';
    dialog.setAttribute('aria-labelledby', 'skills-dialog-title');
    dialog.innerHTML = `<header class="skills-dialog-heading"><div><h2 id="skills-dialog-title">Manage skills</h2><p class="muted skills-robot-context"></p></div><button type="button" class="button secondary close-skills">Close</button></header>
        <div class="skills-manager-layout">
            <nav class="skills-repository-nav" aria-label="Skill repositories">
                <div class="skills-repository-nav-heading"><h3>Repositories</h3><button type="button" class="skills-add-option" data-skills-focus="add" aria-label="Add repository" aria-haspopup="dialog" aria-controls="skills-add-dialog" aria-expanded="false"><span aria-hidden="true">+</span> Add repo</button></div><div class="skills-repository-list"></div>
                <button type="button" class="skills-repository-option skills-required-option" data-skills-view="required" data-skills-focus="required" aria-controls="skills-required-panel" aria-pressed="false">Required skills<span class="muted">Managed by RoboTeam · view only</span></button>
            </nav>
            <div class="skills-manager-content">
                <section class="skills-repository-panel" id="skills-repository-panel" aria-labelledby="skills-repository-title"></section>
                <section class="required-skills" id="skills-required-panel" aria-labelledby="skills-required-title" hidden><h3 id="skills-required-title">Required skills</h3><p class="muted">Managed by RoboTeam. These skills cannot be disabled.</p><div class="required-skills-list"><p class="muted">Loading…</p></div></section>
            </div>
        </div>
        <footer class="skills-manager-footer"><p class="muted">Enabled skillsets are offered for selection. Existing task selections and continuations are unchanged.</p><p class="message" role="status" aria-live="polite" hidden></p></footer>`;
    const addDialog = document.createElement('dialog');
    addDialog.id = 'skills-add-dialog';
    addDialog.className = 'skills-dialog skills-add-dialog';
    addDialog.setAttribute('aria-labelledby', 'skills-add-title');
    addDialog.innerHTML = `<header class="skills-dialog-heading"><h2 id="skills-add-title">Add repository</h2><button type="button" class="button secondary close-add-repository">Close</button></header>
        <div class="skills-add-content">
            <form class="repository-form"><label>Repository URL<input name="source" type="url" required maxlength="2048" placeholder="https://github.com/owner/skills.git" data-skills-focus="repository-url" autofocus></label><button class="button primary" type="submit">Add repo</button></form>
            <section class="skill-recommendations" aria-labelledby="skill-recommendations-title"><h3 id="skill-recommendations-title">Recommended repositories</h3><p class="muted">Detected in the workspace or registered in Ploinky. Workspace checkouts are preferred.</p><div class="recommendation-list"></div></section>
        </div>
        <footer class="skills-add-footer"><p class="message" role="status" aria-live="polite" hidden></p></footer>`;
    dialog.append(addDialog);
    dialog.querySelector('.skills-robot-context').textContent = `Robot · ${robot.name}`;
    const message = dialog.querySelector('.message');
    const form = dialog.querySelector('form');
    const contentPane = dialog.querySelector('.skills-manager-content');
    const repositoryPanel = dialog.querySelector('.skills-repository-panel');
    const requiredPanel = dialog.querySelector('.required-skills');
    const addTrigger = dialog.querySelector('.skills-add-option');
    const addMessage = addDialog.querySelector('.message');
    const lifetime = new AbortController();
    const opener = document.activeElement;
    form.hidden = !canAdmin;
    addTrigger.hidden = !canAdmin;
    let busy = false;
    let current = robot;
    let view = 'repository';
    let selectedId = robot.repositories?.[0]?.id ?? null;
    let recommendations = [];
    let recommendationError = '';
    let loadingRecommendations = true;
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const labelFor = repo => skillRepositoryLabel(repo, recommendations);
    function setMessage(text, error = false) {
        const target = addDialog.open ? addMessage : message;
        target.textContent = text;
        target.className = error ? 'message error' : 'message';
        target.hidden = !text;
    }
    function closeMenus() {
        const toggle = dialog.querySelector('[data-robot-menu-toggle]');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
        const options = dialog.querySelector('[data-robot-menu-options]');
        if (options) options.hidden = true;
    }
    function showView(next, id = selectedId) {
        if (busy) return;
        view = next;
        selectedId = id;
        render();
        contentPane.scrollTop = 0;
    }
    const addController = initCreateRobotDialog({
        dialog: addDialog, trigger: addTrigger,
        closeButton: addDialog.querySelector('.close-add-repository'),
        onOpen: () => {
            closeMenus();
            addMessage.textContent = '';
            addMessage.hidden = true;
            addTrigger.setAttribute('aria-expanded', 'true');
        },
    });
    addDialog.addEventListener('cancel', event => event.stopPropagation());
    addDialog.addEventListener('close', () => addTrigger.setAttribute('aria-expanded', 'false'));
    function skillList(names, label) {
        const list = node('ul', '', 'skill-members');
        list.setAttribute('aria-label', label);
        for (const name of names) list.append(node('li', name));
        return list;
    }
    function renderRepository(repo) {
        repositoryPanel.replaceChildren();
        const heading = node('div', '', 'skills-repository-heading');
        const info = node('div');
        const title = node('h3', repo ? labelFor(repo) : 'Repositories');
        title.id = 'skills-repository-title';
        info.append(title);
        heading.append(info);
        repositoryPanel.append(heading);
        if (!repo) {
            repositoryPanel.append(node('p', 'No repositories added yet. Choose Add repository to get started.', 'muted'));
            if (!canAdmin) repositoryPanel.lastChild.textContent = 'No repositories added to this robot.';
            return;
        }
        const preferred = recommendations.find(item => hasRecommendedRepository({ repositories: [repo] }, item));
        const source = repo.builtin ? 'Bundled with RoboTeam · read-only source' : preferred?.source || repo.source || repo.id;
        info.append(node('p', source, 'muted skills-repository-source'));
        if (canAdmin && !repo.builtin) {
            const menu = node('div', '', 'robot-manage');
            menu.innerHTML = `<button type="button" class="button secondary icon-button manage-toggle" data-robot-menu-toggle aria-expanded="false" data-skills-focus="repository-menu"><span aria-hidden="true">⋮</span></button><div class="manage-options" data-robot-menu-options hidden></div>`;
            menu.querySelector('button').disabled = busy;
            const remove = node('button', 'Remove repository', 'button danger');
            remove.type = 'button';
            remove.disabled = busy;
            remove.setAttribute('aria-label', `Remove ${repo.source || repo.id}`);
            remove.addEventListener('click', () => void mutate('DELETE', { name: repo.id }));
            menu.querySelector('.manage-options').append(remove);
            heading.append(menu);
            initRobotMenu({ menu, id: 'skills-repository-options', label: `More actions for ${labelFor(repo)}`, closeMenus });
        }
        const sets = repo.skillsets || [];
        if (sets.length) repositoryPanel.append(node('h4', 'Skillsets', 'skills-section-label'));
        for (const set of sets) {
            const item = node('article', '', 'skillset-item');
            item.classList.toggle('is-disabled', set.enabled === false);
            const head = node('div', '', 'skillset-heading');
            head.append(node('h5', set.name || set.id));
            const toggle = node('label', '', 'skillset-toggle');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.setAttribute('role', 'switch');
            input.checked = set.enabled !== false;
            input.disabled = busy || !canAdmin;
            input.setAttribute('aria-label', `${set.name || set.id}: available in robot catalog`);
            input.dataset.skillsFocus = `skillset:${set.id}`;
            input.addEventListener('change', () => void mutate('PATCH', { id: set.id, enabled: input.checked }));
            toggle.append(input, node('span', input.checked ? 'Enabled' : 'Disabled'));
            head.append(toggle);
            item.append(head);
            if (set.description) item.append(node('p', set.description, 'skillset-description'));
            item.append(skillList(set.skills, `Skills included in ${set.name || set.id}`));
            repositoryPanel.append(item);
        }
        const grouped = new Set(sets.flatMap(set => set.skills));
        const otherSkills = repo.skills.filter(skill => !grouped.has(skill.name)).map(skill => skill.name);
        if (otherSkills.length || !sets.length) {
            repositoryPanel.append(node('h4', sets.length ? 'Other skills' : 'Skills', 'skills-section-label'));
            if (sets.length) repositoryPanel.append(node('p', 'Not included in the declared skillsets.', 'muted'));
            if (otherSkills.length) repositoryPanel.append(skillList(otherSkills, 'Individual repository skills'));
            else repositoryPanel.append(node('p', 'No skills available.', 'muted'));
        }
    }
    function renderRecommendations() {
        const recommended = dialog.querySelector('.recommendation-list');
        recommended.replaceChildren();
        if (loadingRecommendations) recommended.append(node('p', 'Loading recommendations…', 'muted'));
        else if (recommendationError) recommended.append(node('p', recommendationError, 'message error'));
        else if (!recommendations.length) recommended.append(node('p', 'No skill repositories found in the workspace or registered in Ploinky.', 'muted'));
        for (const repo of recommendations) {
            const row = node('div', '', 'recommended-repository');
            const content = node('div', '', 'recommended-repository-info');
            content.append(node('strong', repo.name));
            if (repo.description) content.append(node('p', repo.description, 'muted'));
            for (const warning of repo.warnings || []) content.append(node('p', `Warning: ${warning}`, 'skill-repository-warning'));
            row.append(content);
            if (canAdmin) {
                const added = hasRecommendedRepository(current, repo);
                const add = node('button', added ? 'Added' : 'Add repo', 'button secondary');
                add.type = 'button';
                add.disabled = busy || added;
                add.setAttribute('aria-label', `Add ${repo.name}`);
                add.dataset.skillsFocus = `recommendation:${repo.source}`;
                add.addEventListener('click', () => void mutate('POST', { source: repo.source, description: repo.description }));
                row.append(add);
            }
            recommended.append(row);
        }
    }
    function render() {
        if (lifetime.signal.aborted) return;
        const focusKey = dialog.contains(document.activeElement) ? document.activeElement.dataset.skillsFocus : null;
        const scrollTop = contentPane.scrollTop;
        const repos = current.repositories || [];
        if (!repos.some(repo => repo.id === selectedId)) selectedId = repos[0]?.id ?? null;
        const list = dialog.querySelector('.skills-repository-list');
        list.replaceChildren();
        for (const repo of repos) {
            const button = node('button', '', 'skills-repository-option');
            button.type = 'button';
            button.disabled = busy;
            button.dataset.skillsFocus = `repository:${repo.id}`;
            button.setAttribute('aria-controls', 'skills-repository-panel');
            button.setAttribute('aria-pressed', String(view === 'repository' && selectedId === repo.id));
            const setCount = repo.skillsets.length, skillCount = repo.skills.length;
            button.append(node('span', labelFor(repo)), node('span', `${setCount} ${setCount === 1 ? 'skillset' : 'skillsets'} · ${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}`, 'muted'));
            button.addEventListener('click', () => showView('repository', repo.id));
            list.append(button);
        }
        if (!repos.length) list.append(node('p', 'No repositories added yet.', 'muted'));
        for (const button of dialog.querySelectorAll('[data-skills-view]')) {
            button.disabled = busy;
            button.setAttribute('aria-pressed', String(view === button.dataset.skillsView));
        }
        repositoryPanel.hidden = view !== 'repository';
        requiredPanel.hidden = view !== 'required';
        renderRepository(repos.find(repo => repo.id === selectedId));
        renderRecommendations();
        for (const control of form.querySelectorAll('input, button')) control.disabled = busy;
        addTrigger.disabled = busy || !canAdmin;
        addController.setBusy(busy);
        dialog.setAttribute('aria-busy', String(busy));
        if (focusKey) [...dialog.querySelectorAll('[data-skills-focus]')].find(element => element.dataset.skillsFocus === focusKey && !element.disabled)?.focus({ preventScroll: true });
        contentPane.scrollTop = scrollTop;
    }
    async function mutate(method, body) {
        if (busy || !canAdmin || lifetime.signal.aborted) return;
        busy = true;
        const updating = method === 'PATCH';
        const idsBefore = new Set((current.repositories || []).map(repo => repo.id));
        const focusKey = document.activeElement?.dataset.skillsFocus;
        setMessage(updating ? 'Updating skillset…' : method === 'POST' ? 'Adding repository…' : 'Removing repository…');
        render();
        try {
            const route = `api/robots/${robot.id}/skillsets`;
            await api(method === 'DELETE' ? `${route}?name=${encodeURIComponent(body.name)}` : route,
                method === 'DELETE' ? { method } : { method, body });
            const result = await api('api/robots');
            const updated = result.robots.find(item => item.id === robot.id);
            if (!updated) throw new Error('Robot is no longer available.');
            current = updated;
            if (method === 'POST') {
                form.reset();
                const added = current.repositories?.find(repo => !idsBefore.has(repo.id));
                if (added) { selectedId = added.id; view = 'repository'; contentPane.scrollTop = 0; }
                addController.complete();
            }
            setMessage(updating ? `Skillset ${body.enabled ? 'enabled' : 'disabled'}.` : method === 'POST' ? 'Repository added.' : 'Repository removed. Selected skills from this source will be unavailable when tasks next start or resume.');
            await onChanged();
        } catch (error) {
            setMessage(error.message, true);
        } finally {
            busy = false;
            if (current) render();
            if (!lifetime.signal.aborted) {
                const target = updating || addDialog.open ? [...dialog.querySelectorAll('[data-skills-focus]')].find(element => element.dataset.skillsFocus === focusKey)
                    : dialog.querySelector('.skills-repository-option[aria-pressed="true"]');
                target?.focus({ preventScroll: true });
            }
        }
    }
    form.addEventListener('submit', event => {
        event.preventDefault();
        const source = new FormData(form).get('source').trim();
        if (!source.startsWith('https://')) {
            setMessage('Enter an HTTPS Git repository URL.', true);
            return;
        }
        const recommended = recommendations.find(repo => normalizeRepositorySource(repo.url) === normalizeRepositorySource(source));
        if (recommended && hasRecommendedRepository(current, recommended)) {
            setMessage('This repository is already added to this robot.', true);
            return;
        }
        void mutate('POST', { source: recommended?.source || source });
    });
    for (const button of dialog.querySelectorAll('[data-skills-view]')) button.addEventListener('click', () => showView(button.dataset.skillsView));
    dialog.addEventListener('click', event => { if (!event.target.closest('.robot-manage')) closeMenus(); });
    dialog.addEventListener('keydown', event => {
        const toggle = dialog.querySelector('[data-robot-menu-toggle][aria-expanded="true"]');
        if (event.key === 'Escape' && toggle) { event.preventDefault(); event.stopPropagation(); closeMenus(); toggle.focus(); }
    });
    const cleanup = () => { lifetime.abort(); if (addDialog.open) addDialog.close(); dialog.remove(); };
    const close = () => { dialog.close(); cleanup(); if (opener?.isConnected) opener.focus(); };
    dialog.querySelector('.close-skills').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', cleanup, { once: true });
    document.body.append(dialog);
    render();
    dialog.showModal();
    void api('api/required-skills', { signal: lifetime.signal }).then(({ skills }) => {
        if (lifetime.signal.aborted) return;
        const section = dialog.querySelector('.required-skills-list');
        section.replaceChildren();
        if (!skills.length) section.append(node('p', 'No required skills.', 'muted'));
        for (const skill of skills) {
            const details = document.createElement('details');
            details.append(node('summary', `${skill.name} · Required · View only`));
            const content = node('pre', skill.content);
            details.append(content);
            section.append(details);
        }
    }).catch(error => {
        if (!lifetime.signal.aborted) dialog.querySelector('.required-skills-list').replaceChildren(node('p', error.message, 'message error'));
    });
    void loadSkillRecommendations().then(repos => { recommendations = repos; })
        .catch(error => { recommendationError = error.message; })
        .finally(() => { loadingRecommendations = false; if (dialog.isConnected) render(); });
    return dialog;
}

const CODING_AGENT_LABELS = { codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', claude: 'Claude Code' };

export function codingAgentLabel(names) {
    return names.map(name => CODING_AGENT_LABELS[name] || name).join(', ');
}

// The only model the picker can offer while the worker does not list models (the server answers 409 `model_listing_unavailable`):
// the robot's configured one. No error is shown for it.
export function configuredModelCatalog(configured) {
    return typeof configured === 'string' && configured ? [{ id: configured, label: configured, efforts: [] }] : [];
}

export function filterCodingModels(models, query) {
    const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return models.filter(model => words.every(word => `${model.id} ${model.label}`.toLocaleLowerCase().includes(word)));
}

export function openCodingAgentsDialog(robot, { api, onChanged }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'skills-dialog coding-agents-dialog';
    dialog.setAttribute('aria-labelledby', 'coding-agents-dialog-title');
    dialog.innerHTML = `<header class="skills-dialog-heading"><h2 id="coding-agents-dialog-title"></h2><button type="button" class="button secondary close-dialog">Close</button></header>
        <form class="coding-agent-form">
            <fieldset class="coding-agents"><legend>Coding agent</legend>
                <label><input type="radio" name="codingAgent" value="codex" required> Codex</label>
                <label><input type="radio" name="codingAgent" value="opencode"> OpenCode</label>
                <label><input type="radio" name="codingAgent" value="pi"> Pi</label>
                <label><input type="radio" name="codingAgent" value="claude"> Claude Code</label>
            </fieldset>
            <section class="coding-model-field" aria-label="Default model">
                <label id="coding-model-label">Default model</label>
                <button type="button" class="coding-model-trigger button secondary" aria-haspopup="listbox" aria-expanded="false" aria-controls="coding-model-options">Default model</button>
                <div class="coding-model-picker" hidden>
                    <button type="button" class="coding-model-back button secondary" hidden>Back to models</button>
                    <input type="search" class="coding-model-search" placeholder="Search models…" aria-label="Search models" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="coding-model-options" autocomplete="off">
                    <p class="coding-model-message" role="status" aria-live="polite"></p>
                    <button type="button" class="coding-model-retry button secondary" hidden>Retry</button>
                    <div id="coding-model-options" class="coding-model-options" role="listbox" tabindex="0" aria-labelledby="coding-model-label"></div>
                </div>
            </section>
            <p class="coding-agent-warning" role="status" hidden>Pi is not compatible with Browser and Desktop executions.</p>
            <p class="coding-agent-status"></p>
            <p class="message" role="status" aria-live="polite"></p>
            <button class="button primary coding-agent-save" type="submit">Save</button>
        </form>`;
    dialog.querySelector('h2').textContent = `Coding agent · ${robot.name}`;
    const form = dialog.querySelector('form'), message = dialog.querySelector('.message');
    const trigger = dialog.querySelector('.coding-model-trigger'), picker = dialog.querySelector('.coding-model-picker');
    const search = dialog.querySelector('.coding-model-search'), list = dialog.querySelector('.coding-model-options');
    const modelMessage = dialog.querySelector('.coding-model-message'), retry = dialog.querySelector('.coding-model-retry');
    const save = dialog.querySelector('.coding-agent-save'), back = dialog.querySelector('.coding-model-back');
    const lifetime = new AbortController();
    const catalogs = new Map(), drafts = new Map(), configuredOnly = new Set();
    let saved = {}, savedEfforts = {}, defaults = {}, pendingModel = null, stage = 'models', ready = false, saving = false, request = null, activeIndex = -1;
    const names = robot.codingAgents || ['codex', 'opencode', 'pi', 'claude'];
    const busy = robot.run.state !== 'stopped' || ['queued', 'starting', 'running', 'pausing'].includes(robot.run.task?.state);
    const agent = () => form.querySelector('input[name="codingAgent"]:checked')?.value;
    const selection = () => drafts.has(agent()) ? drafts.get(agent()) : { model: saved[agent()] || null, effort: savedEfforts[agent()] || null };
    const isDefault = value => !value || value === defaults[agent()];
    const closePicker = () => {
        stage = 'models'; pendingModel = null; search.hidden = false; back.hidden = true;
        list.setAttribute('aria-labelledby', 'coding-model-label'); list.removeAttribute('aria-label');
        picker.hidden = true; trigger.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
        search.removeAttribute('aria-activedescendant'); list.removeAttribute('aria-activedescendant'); update();
    };
    const close = () => { lifetime.abort(); request?.abort(); dialog.close(); dialog.remove(); };
    function update() {
        dialog.querySelector('.coding-agent-warning').hidden = agent() !== 'pi';
        const { model, effort } = selection();
        trigger.textContent = `${isDefault(model) ? 'Default model' : model} · ${effort || 'Default effort'}`;
        trigger.disabled = busy || saving || !ready || !agent();
        save.disabled = busy || saving || !ready || !agent() || stage === 'efforts';
        for (const radio of form.querySelectorAll('[name="codingAgent"]')) radio.disabled = busy || saving;
    }
    function highlight(index) {
        const options = [...list.children];
        activeIndex = options.length ? Math.max(0, Math.min(index, options.length - 1)) : -1;
        options.forEach((option, i) => option.classList.toggle('active', i === activeIndex));
        if (activeIndex >= 0) {
            (stage === 'efforts' ? list : search).setAttribute('aria-activedescendant', options[activeIndex].id);
            options[activeIndex].scrollIntoView({ block: 'nearest' });
        } else search.removeAttribute('aria-activedescendant');
    }
    function renderModels() {
        if (stage !== 'models') return;
        list.replaceChildren(); activeIndex = -1; search.removeAttribute('aria-activedescendant');
        const models = catalogs.get(agent());
        const rows = [{ id: '', label: 'Default model' }, ...filterCodingModels(models || [], search.value)];
        if (models) modelMessage.textContent = configuredOnly.has(agent()) ? 'Model list available after the worker update.'
            : rows.length === 1 ? (models.length ? 'No matching models.' : 'No models available.') : '';
        for (const [index, model] of rows.entries()) {
            const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
            option.className = 'coding-model-option'; option.id = `coding-model-option-${index}`; option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(model.id ? selection().model === model.id : isDefault(selection().model)));
            const name = document.createElement('strong'); name.textContent = model.label;
            option.append(name);
            if (model.id && model.id !== model.label) { const id = document.createElement('small'); id.textContent = model.id; option.append(id); }
            option.addEventListener('click', () => chooseModel(model));
            list.append(option);
        }
    }
    function chooseModel(model) {
        request?.abort();
        if (configuredOnly.has(agent())) {
            // No list means no effort choices: the configured model keeps its saved effort (sent as it is saved, which the server
            // accepts without a list), and the default model has none.
            const keep = model.id && model.id === saved[agent()];
            drafts.set(agent(), { model: model.id || null, effort: keep ? savedEfforts[agent()] ?? null : null });
            closePicker(); trigger.focus(); return;
        }
        stage = 'efforts'; pendingModel = model.id || null;
        const effectiveModel = model.id || defaults[agent()];
        const entry = catalogs.get(agent())?.find(item => item.id === effectiveModel);
        const efforts = [...new Set(entry?.efforts || [])];
        search.hidden = true; search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant');
        retry.hidden = true; back.hidden = false; list.removeAttribute('aria-busy');
        list.removeAttribute('aria-labelledby'); list.setAttribute('aria-label', `Effort for ${model.label}`);
        modelMessage.textContent = efforts.length ? `Choose effort for ${model.label}` : `${model.label} uses its default effort.`;
        list.replaceChildren(); activeIndex = -1;
        for (const [index, effort] of [null, ...efforts].entries()) {
            const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
            option.className = 'coding-model-option'; option.id = `coding-effort-option-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(selection().model === pendingModel ? selection().effort === effort : effort === null));
            option.textContent = effort || 'Default effort';
            option.addEventListener('click', () => {
                drafts.set(agent(), { model: pendingModel, effort }); closePicker(); trigger.focus();
            });
            list.append(option);
        }
        update(); list.focus(); highlight(0);
    }
    back.addEventListener('click', () => {
        stage = 'models'; pendingModel = null; search.hidden = false; back.hidden = true;
        list.removeAttribute('aria-label'); list.setAttribute('aria-labelledby', 'coding-model-label');
        search.setAttribute('aria-expanded', 'true'); update(); void loadModels(); search.focus();
    });
    async function loadModels() {
        const backend = agent();
        if (catalogs.has(backend)) { retry.hidden = true; list.removeAttribute('aria-busy'); renderModels(); return; }
        request?.abort();
        const controller = new AbortController(); request = controller;
        modelMessage.textContent = 'Loading models…'; retry.hidden = true; list.setAttribute('aria-busy', 'true'); renderModels();
        try {
            const result = await api(`api/robots/${robot.id}/models?agent=${encodeURIComponent(backend)}`, { signal: controller.signal });
            if (controller.signal.aborted || lifetime.signal.aborted || agent() !== backend) return;
            const entries = (result.models || []).map(model => typeof model === 'string' ? { id: model, label: model }
                : { id: model.id || model.name || model.key, label: model.label || model.name || model.id || model.key,
                    efforts: Array.isArray(model.efforts) ? model.efforts.filter(effort => typeof effort === 'string' && /^[a-zA-Z0-9_-]+$/u.test(effort)) : [] });
            catalogs.set(backend, [...new Map(entries.filter(model => typeof model.id === 'string' && model.id).map(model => [model.id, model])).values()]);
            renderModels();
        } catch (error) {
            if (controller.signal.aborted || lifetime.signal.aborted || agent() !== backend) return;
            if (error.status === 409 && error.code === 'model_listing_unavailable') {
                catalogs.set(backend, configuredModelCatalog(saved[backend])); configuredOnly.add(backend); renderModels();
                return;
            }
            modelMessage.textContent = error.message; retry.hidden = false;
        } finally { if (request === controller) { request = null; list.removeAttribute('aria-busy'); } }
    }
    for (const radio of form.querySelectorAll('[name="codingAgent"]')) {
        radio.checked = names.length === 1 && radio.value === names[0];
        radio.addEventListener('change', () => { request?.abort(); closePicker(); search.value = ''; update(); });
    }
    trigger.addEventListener('click', () => {
        if (!picker.hidden) { closePicker(); return; }
        picker.hidden = false; trigger.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
        search.value = ''; search.focus(); void loadModels();
    });
    search.addEventListener('input', renderModels);
    picker.addEventListener('keydown', event => {
        if (event.target !== search && event.target !== list) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(activeIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
        else if (event.key === 'Enter') { event.preventDefault(); if (activeIndex >= 0) list.children[activeIndex]?.click(); }
    });
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !picker.hidden) { event.preventDefault(); event.stopPropagation(); closePicker(); trigger.focus(); }
    });
    retry.addEventListener('click', () => void loadModels());
    dialog.querySelector('.coding-agent-status').textContent = busy
        ? 'Stop the workstation and tasks before changing the coding agent.'
        : 'Defaults apply to workflows and chats without a session model override. Existing conversations keep their coding agent.';
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const selected = agent();
        if (!selected || busy || saving || !ready || stage === 'efforts') return;
        saving = true; closePicker(); update(); message.textContent = ''; message.className = 'message';
        try {
            const body = { codingAgents: [selected], ...(drafts.has(selected) ? drafts.get(selected) : {}) };
            await api(`api/robots/${robot.id}/coding-agents`, { method: 'PATCH', body });
            close(); await onChanged();
        } catch (error) {
            if (lifetime.signal.aborted) return;
            message.textContent = error.message; message.className = 'message error'; saving = false; update();
        }
    });
    dialog.querySelector('.close-dialog').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { lifetime.abort(); request?.abort(); dialog.remove(); }, { once: true });
    document.body.append(dialog); dialog.showModal(); update();
    // Only local configuration is read now. The native catalog is fetched when
    // the user first opens the model selector for a particular agent.
    void api(`api/robots/${robot.id}/coding-agents`, { signal: lifetime.signal }).then(config => {
        if (lifetime.signal.aborted) return;
        saved = config.models || {}; savedEfforts = config.efforts || {}; defaults = config.defaultModels || {}; ready = true;
        if (!agent() && names.includes(config.codingAgent)) form.querySelector(`[value="${config.codingAgent}"]`).checked = true;
        update();
    }).catch(error => {
        if (lifetime.signal.aborted) return;
        message.textContent = `Could not load settings: ${error.message}. Close and reopen to retry.`; message.className = 'message error';
    });
    return dialog;
}
