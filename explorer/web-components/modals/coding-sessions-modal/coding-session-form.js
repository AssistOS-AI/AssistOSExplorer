// One-page creation form. Robot selection is an editable combobox; coding agents
// use a native select. Every robot offers the same provider catalog.
export function createSessionForm({ host, mode, robots, codingAgents, draft, submit, isBusy }) {
    const roles = mode === 'supervised' ? ['supervisor', 'worker'] : ['session'];
    const sections = [];
    const form = document.createElement('form'); form.className = 'coding-session-form';
    const grid = document.createElement('div'); grid.className = `coding-session-configs ${mode}`;
    const footer = document.createElement('div'); footer.className = 'coding-session-form-footer';
    const start = document.createElement('button'); start.type = 'submit'; start.className = 'general-button';
    start.textContent = mode === 'supervised' ? 'Start and open both sessions' : 'Start coding session';
    footer.append(start); form.append(grid, footer); host.append(form);
    const update = () => {
        for (const section of sections) section.fieldset.disabled = isBusy();
        start.disabled = isBusy() || sections.length !== roles.length || sections.some(section =>
            !draft[section.role]?.robotId || !draft[section.role]?.codingAgent);
    };
    for (const role of roles) {
        const title = role === 'session' ? 'Coding session' : role === 'worker' ? 'Worker' : 'Supervisor';
        const fieldset = document.createElement('fieldset'); fieldset.className = 'coding-session-config';
        const legend = document.createElement('legend'); legend.textContent = title;
        const note = document.createElement('p'); note.className = 'coding-session-role-note';
        note.textContent = role === 'supervisor' ? 'Talk to this agent. It assigns tasks and reviews the work.'
            : role === 'worker' ? 'This agent implements the tasks and reports back.' : 'Choose the robot and coding agent for your new conversation.';
        const picker = document.createElement('div'); picker.className = 'coding-robot-picker';
        const label = document.createElement('label'); label.textContent = 'Robot'; label.htmlFor = `coding-${role}-robot`;
        const input = document.createElement('input'); input.id = label.htmlFor; input.type = 'text';
        input.className = 'form-input'; input.placeholder = 'Search and select a robot…'; input.autocomplete = 'off';
        input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', `${title} robot`);
        input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
        const options = document.createElement('div'); options.id = `${input.id}-options`; options.className = 'coding-robot-options';
        options.setAttribute('role', 'listbox'); options.setAttribute('aria-label', `${title} robots`); options.hidden = true;
        input.setAttribute('aria-controls', options.id);
        picker.append(label, input, options);
        const agentLabel = document.createElement('label'); agentLabel.textContent = 'Coding agent'; agentLabel.htmlFor = `coding-${role}-agent`;
        const agent = document.createElement('select'); agent.id = agentLabel.htmlFor; agent.className = 'form-input';
        agent.setAttribute('aria-label', `${title} coding agent`);
        const error = document.createElement('p'); error.className = 'coding-session-field-error'; error.setAttribute('role', 'status');
        if (mode === 'supervised') fieldset.append(legend, note);
        fieldset.append(picker, agentLabel, agent, error); grid.append(fieldset);
        const section = { role, fieldset }; sections.push(section);
        let matches = [], active = -1;
        draft[role] ||= { robotId: '', codingAgent: '' };
        agent.replaceChildren(new Option('Select a coding agent…', ''), ...codingAgents.map(name => new Option(name, name)));
        if (!codingAgents.includes(draft[role].codingAgent)) draft[role].codingAgent = '';
        agent.value = draft[role].codingAgent;
        agent.disabled = codingAgents.length === 0;
        if (!codingAgents.length) error.textContent = 'No coding agents available. Refresh to try again.';
        const close = () => { options.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
        const highlight = () => {
            [...options.querySelectorAll('[role="option"]')].forEach((option, index) => option.setAttribute('aria-selected', String(index === active)));
            const current = options.querySelectorAll('[role="option"]')[active];
            if (current) { input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
        };
        const choose = robot => {
            if (isBusy()) return;
            draft[role].robotId = robot.id;
            input.value = robot.name || robot.id; close(); input.focus(); update();
        };
        const show = (query = '') => {
            if (isBusy()) return;
            matches = robots.filter(robot => `${robot.name || ''} ${robot.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
            active = -1; input.removeAttribute('aria-activedescendant'); options.replaceChildren();
            for (const [index, robot] of matches.entries()) {
                const option = document.createElement('div'); option.id = `${options.id}-${index}`; option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', 'false'); option.textContent = robot.name || robot.id;
                option.addEventListener('mousedown', event => event.preventDefault());
                option.addEventListener('click', () => choose(robot)); options.append(option);
            }
            if (!matches.length) { const empty = document.createElement('p'); empty.textContent = 'No robots found'; options.append(empty); }
            options.hidden = false; input.setAttribute('aria-expanded', 'true');
        };
        input.addEventListener('focus', () => show());
        input.addEventListener('click', () => { if (options.hidden) show(draft[role]?.robotId ? '' : input.value); });
        input.addEventListener('input', () => {
            draft[role].robotId = ''; show(input.value); update();
        });
        input.addEventListener('blur', () => { close(); const robot = robots.find(row => row.id === draft[role]?.robotId); input.value = robot ? robot.name || robot.id : ''; });
        input.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !options.hidden) { event.preventDefault(); event.stopPropagation(); close(); return; }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); if (options.hidden) show();
                active = Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); highlight();
            } else if (event.key === 'Enter') {
                event.preventDefault(); if (!options.hidden && matches[active]) choose(matches[active]);
            }
        });
        agent.addEventListener('change', () => { if (draft[role]) draft[role].codingAgent = agent.value; update(); });
        const savedRobot = robots.find(robot => robot.id === draft[role]?.robotId);
        if (savedRobot) input.value = savedRobot.name || savedRobot.id;
        else draft[role].robotId = '';
    }
    form.addEventListener('submit', event => {
        event.preventDefault(); update(); if (start.disabled) return;
        submit(Object.fromEntries(roles.map(role => [role, { ...draft[role] }])));
    });
    update();
    return { update };
}
