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
    return (robot.repositories || []).some(repo => !repo.builtin && (sources.includes(normalizeRepositorySource(repo.source))
        || (recommendation.name && repo.source?.startsWith('/') && normalizeRepositorySource(repo.source).endsWith('/.ploinky/repos/' + recommendation.name))));
}

export async function loadSkillRecommendations(fetchImpl = globalThis.fetch) {
    const response = await fetchImpl('/api/marketplace/repos', { credentials: 'include', cache: 'no-store',
        headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load recommended repositories from Ploinky.');
    const payload = await response.json();
    return (payload.marketplace?.repositories || []).filter(repo => ['skills', 'mixed'].includes(repo.kind) && (repo.skillSource?.source || repo.url))
        .map(repo => ({ name: repo.name, description: repo.description || '', url: repo.url,
            warnings: Array.isArray(repo.warnings) ? repo.warnings : [],
            source: repo.skillSource?.source || repo.url, origin: repo.skillSource?.origin || 'remote' }));
}

export function openSkillsDialog(robot, { api, onChanged, canAdmin }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'skills-dialog';
    dialog.setAttribute('aria-labelledby', 'skills-dialog-title');
    dialog.innerHTML = `<header class="skills-dialog-heading"><h2 id="skills-dialog-title"></h2><button type="button" class="button secondary close-skills">Close</button></header>
        <section class="required-skills"><h3>Required skills</h3><p class="muted">Loading…</p></section><div class="repository-list"></div>
        <section class="skill-recommendations" aria-labelledby="skill-recommendations-title"><h3 id="skill-recommendations-title">Recommended repositories</h3><p class="muted">Detected in the workspace or registered in Ploinky. Workspace checkouts are preferred.</p><div class="recommendation-list" aria-live="polite"></div></section>
        <form class="repository-form"><label>Repository URL<input name="source" type="url" required maxlength="2048" placeholder="https://github.com/owner/skills.git"></label><button class="button primary" type="submit">Add repo</button></form>
        <p class="message" role="status" aria-live="polite"></p>`;
    dialog.querySelector('h2').textContent = `Manage skills · ${robot.name}`;
    const message = dialog.querySelector('.message');
    const form = dialog.querySelector('form');
    form.hidden = !canAdmin;
    let busy = false;
    let current = robot;
    let recommendations = [];
    let recommendationError = '';
    let loadingRecommendations = true;
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    function render() {
        const list = dialog.querySelector('.repository-list');
        list.replaceChildren();
        for (const repo of current.repositories || []) {
            const row = node('section', '', 'repository-row');
            const details = document.createElement('details');
            const preferred = recommendations.find(item => hasRecommendedRepository({ repositories: [repo] }, item));
            const summary = node('summary', repo.builtin ? 'Built-in copilot' : preferred?.source || repo.source || repo.id);
            details.append(summary);
            const content = node('div', '', 'repository-content');
            content.append(node('h3', `Skills (${repo.skills.length})`));
            const skills = document.createElement('ul');
            for (const skill of repo.skills) {
                const item = document.createElement('li');
                item.append(node('strong', skill.name));
                skills.append(item);
            }
            content.append(skills, node('h3', 'Skillsets'));
            if (!repo.skillsets.length) content.append(node('p', 'No skillsets defined in skillsets.md.', 'muted'));
            for (const set of repo.skillsets) {
                const item = node('article', '', 'skillset-item');
                item.append(node('strong', set.name || set.id), node('p', set.description));
                item.append(node('p', set.enabled === false ? 'Disabled' : 'Enabled', 'muted'));
                if (canAdmin) {
                    const toggle = node('button', set.enabled === false ? 'Enable' : 'Disable', 'button secondary');
                    toggle.type = 'button';
                    toggle.disabled = busy;
                    toggle.setAttribute('aria-label', `${set.enabled === false ? 'Enable' : 'Disable'} ${set.name || set.id}`);
                    toggle.addEventListener('click', () => mutate('PATCH', { id: set.id, enabled: set.enabled === false }));
                    item.append(toggle);
                }
                const members = node('ul', '', 'skill-members');
                for (const name of set.skills) members.append(node('li', name));
                item.append(members);
                content.append(item);
            }
            details.append(content);
            row.append(details);
            if (canAdmin && !repo.builtin) {
                const remove = node('button', 'Remove', 'button danger');
                remove.type = 'button';
                remove.disabled = busy;
                remove.setAttribute('aria-label', `Remove ${repo.source || repo.id}`);
                remove.addEventListener('click', () => mutate('DELETE', { name: repo.id }));
                row.append(remove);
            }
            list.append(row);
        }
        if (!current.repositories?.length) list.append(node('p', 'No repositories added yet.'));
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
                add.addEventListener('click', () => mutate('POST', { source: repo.source, description: repo.description }));
                row.append(add);
            }
            recommended.append(row);
        }
    }
    async function mutate(method, body) {
        if (busy) return;
        busy = true;
        const updating = method === 'PATCH';
        const expanded = new Set([...dialog.querySelectorAll('.repository-row details[open]')].map(element => element.querySelector('summary').textContent));
        message.textContent = updating ? 'Updating skillset…' : method === 'POST' ? 'Adding repository…' : 'Removing repository…';
        message.className = 'message';
        form.querySelector('button').disabled = true;
        render();
        try {
            const route = `api/robots/${robot.id}/skillsets`;
            await api(method === 'DELETE' ? `${route}?name=${encodeURIComponent(body.name)}` : route,
                method === 'DELETE' ? { method } : { method, body });
            const result = await api('api/robots');
            current = result.robots.find(item => item.id === robot.id);
            if (!current) throw new Error('Robot is no longer available.');
            if (method === 'POST') form.reset();
            message.textContent = updating ? `Skillset ${body.enabled ? 'enabled' : 'disabled'}.` : method === 'POST' ? 'Repository added.' : 'Repository removed. Removed skills will be omitted when tasks next start or resume.';
            await onChanged();
        } catch (error) {
            message.textContent = error.message;
            message.className = 'message error';
        } finally {
            busy = false;
            form.querySelector('button').disabled = false;
            if (current) render();
            for (const details of dialog.querySelectorAll('.repository-row details')) {
                details.open = expanded.has(details.querySelector('summary').textContent);
            }
        }
    }
    form.addEventListener('submit', event => {
        event.preventDefault();
        const source = new FormData(form).get('source').trim();
        if (!source.startsWith('https://')) {
            message.textContent = 'Enter an HTTPS Git repository URL.';
            message.className = 'message error';
            return;
        }
        const recommended = recommendations.find(repo => normalizeRepositorySource(repo.url) === normalizeRepositorySource(source));
        if (recommended && hasRecommendedRepository(current, recommended)) {
            message.textContent = 'This repository is already added to this robot.';
            message.className = 'message error';
            return;
        }
        void mutate('POST', { source: recommended?.source || source });
    });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('.close-skills').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    render();
    dialog.showModal();
    void api('api/required-skills').then(({ skills }) => {
        const section = dialog.querySelector('.required-skills');
        section.replaceChildren(node('h3', 'Required skills'));
        for (const skill of skills) {
            const details = document.createElement('details');
            details.append(node('summary', `${skill.name} · Required · View only`));
            const content = node('pre', skill.content);
            content.style.whiteSpace = 'pre-wrap';
            content.style.overflowWrap = 'anywhere';
            details.append(content);
            section.append(details);
        }
    }).catch(error => { dialog.querySelector('.required-skills p').textContent = error.message; });
    void loadSkillRecommendations().then(repos => { recommendations = repos; })
        .catch(error => { recommendationError = error.message; })
        .finally(() => { loadingRecommendations = false; if (dialog.isConnected) render(); });
    return dialog;
}

const CODING_AGENT_LABELS = { codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', claude: 'Claude Code' };

export function codingAgentLabel(names) {
    return names.map(name => CODING_AGENT_LABELS[name] || name).join(', ');
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
    const catalogs = new Map(), drafts = new Map();
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
        if (models) modelMessage.textContent = rows.length === 1 ? (models.length ? 'No matching models.' : 'No models available.') : '';
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
