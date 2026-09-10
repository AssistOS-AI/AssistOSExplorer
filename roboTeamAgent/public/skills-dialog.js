export function openSkillsDialog(robot, { api, onChanged, canAdmin }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'skills-dialog';
    dialog.setAttribute('aria-labelledby', 'skills-dialog-title');
    dialog.innerHTML = `<header class="skills-dialog-heading"><h2 id="skills-dialog-title"></h2><button type="button" class="button secondary close-skills">Close</button></header>
        <p>Choose skillsets by what they help the robot do. Each skillset contains only the listed skills.</p>
        <div class="repository-list"></div>
        <form class="repository-form"><label>Repository URL<input name="source" type="url" required maxlength="2048" placeholder="https://github.com/owner/skills.git"></label><button class="button primary" type="submit">Add repo</button></form>
        <p class="message" role="status" aria-live="polite"></p>`;
    dialog.querySelector('h2').textContent = `Manage skills · ${robot.name}`;
    const message = dialog.querySelector('.message');
    const form = dialog.querySelector('form');
    form.hidden = !canAdmin;
    let busy = false;
    let current = robot;
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
    }
    async function mutate(method, body) {
        if (busy) return;
        busy = true;
        message.textContent = method === 'POST' ? 'Adding repository…' : 'Removing repository…';
        message.className = 'message';
        form.querySelector('button').disabled = true;
        render();
        try {
            await api(`api/robots/${robot.id}/skillsets`, { method, body });
            const result = await api('api/robots');
            current = result.robots.find(item => item.id === robot.id);
            if (!current) throw new Error('Robot is no longer available.');
            if (method === 'POST') form.reset();
            message.textContent = method === 'POST' ? 'Repository added.' : 'Repository removed. Removed skills will be omitted when tasks next start or resume.';
            await onChanged();
        } catch (error) {
            message.textContent = error.message;
            message.className = 'message error';
        } finally {
            busy = false;
            form.querySelector('button').disabled = false;
            if (current) render();
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
        void mutate('POST', { source });
    });
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('.close-skills').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    render();
    dialog.showModal();
    return dialog;
}
