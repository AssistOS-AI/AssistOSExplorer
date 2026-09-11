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
    return (robot.repositories || []).some(repo => !repo.builtin && sources.includes(normalizeRepositorySource(repo.source)));
}

export async function loadSkillRecommendations(fetchImpl = globalThis.fetch) {
    const response = await fetchImpl('/api/marketplace', { credentials: 'include', cache: 'no-store',
        headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('Could not load recommended repositories from Ploinky.');
    const payload = await response.json();
    return (payload.marketplace?.repositories || []).filter(repo => repo.kind === 'skills' && repo.url)
        .map(repo => ({ name: repo.name, description: repo.description || '', url: repo.url,
            source: repo.skillSource?.source || repo.url, origin: repo.skillSource?.origin || 'remote' }));
}

export function openSkillsDialog(robot, { api, onChanged, canAdmin }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'skills-dialog';
    dialog.setAttribute('aria-labelledby', 'skills-dialog-title');
    dialog.innerHTML = `<header class="skills-dialog-heading"><h2 id="skills-dialog-title"></h2><button type="button" class="button secondary close-skills">Close</button></header>
        <div class="repository-list"></div>
        <section class="skill-recommendations" aria-labelledby="skill-recommendations-title"><h3 id="skill-recommendations-title">Recommended repositories</h3><p class="muted">Registered in Ploinky. Workspace checkouts are preferred.</p><div class="recommendation-list" aria-live="polite"></div></section>
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
            const summary = node('summary', repo.builtin ? 'Built-in copilot' : repo.source);
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
                remove.setAttribute('aria-label', `Remove ${repo.source}`);
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
        else if (!recommendations.length) recommended.append(node('p', 'No skill repositories registered in Ploinky.', 'muted'));
        for (const repo of recommendations) {
            const row = node('div', '', 'recommended-repository');
            const content = node('div', '', 'recommended-repository-info');
            content.append(node('strong', repo.name));
            if (repo.description) content.append(node('p', repo.description, 'muted'));
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
    void loadSkillRecommendations().then(repos => { recommendations = repos; })
        .catch(error => { recommendationError = error.message; })
        .finally(() => { loadingRecommendations = false; if (dialog.isConnected) render(); });
    return dialog;
}
