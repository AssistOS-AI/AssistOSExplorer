export function bindRobotCombobox({ input, list, robots, selected, choose, busy }) {
    const listeners = [];
    let matches = [], active = -1;
    const on = (element, event, callback) => { element.addEventListener(event, callback); listeners.push(() => element.removeEventListener(event, callback)); };
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const sync = () => { input.disabled = busy() || !robots().length; if (list.hidden) input.value = selected()?.display || ''; };
    const pick = robot => { if (busy()) return; close(); choose(robot.key); input.value = robot.display; };
    const highlight = () => {
        [...list.querySelectorAll('[role="option"]')].forEach((node, index) => {
            node.setAttribute('aria-selected', String(index === active));
            if (index === active) { input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); }
        });
    };
    const show = (query = '') => {
        if (busy()) return;
        matches = robots().filter(robot => robot.display.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
        active = -1; input.removeAttribute('aria-activedescendant'); list.replaceChildren();
        for (const [index, robot] of matches.entries()) {
            const node = document.createElement('div'); node.id = `${list.id}-${index}`;
            node.setAttribute('role', 'option'); node.setAttribute('aria-selected', 'false'); node.textContent = robot.display;
            node.addEventListener('mousedown', event => event.preventDefault());
            node.addEventListener('click', () => pick(robot)); list.append(node);
        }
        if (!matches.length) { const empty = document.createElement('p'); empty.textContent = 'No robots found'; list.append(empty); }
        list.hidden = false; input.setAttribute('aria-expanded', 'true');
    };
    on(input, 'focus', () => show());
    on(input, 'click', () => { if (list.hidden) show(); });
    on(input, 'input', () => show(input.value));
    on(input, 'blur', () => { close(); sync(); });
    on(input, 'keydown', event => {
        if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); sync(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); if (list.hidden) show();
            active = Math.max(0, Math.min(matches.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); highlight();
        } else if (event.key === 'Enter' && !list.hidden) {
            event.preventDefault(); event.stopPropagation(); if (matches[active]) pick(matches[active]);
        }
    });
    close(); sync();
    return { sync, dispose: () => { close(); listeners.forEach(remove => remove()); list.replaceChildren(); } };
}
