export function initCreateRobotDialog({ dialog, trigger, closeButton, cancelButton, onOpen = () => {} }) {
    let busy = false;
    const open = () => {
        if (trigger.disabled || dialog.open) return;
        onOpen();
        dialog.showModal();
    };
    const close = () => {
        if (busy || !dialog.open) return;
        dialog.close();
        trigger.focus();
    };
    trigger.addEventListener('click', open);
    closeButton.addEventListener('click', close);
    cancelButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
    });
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
    const setBusy = value => {
        busy = value;
        dialog.setAttribute('aria-busy', String(value));
        closeButton.disabled = value;
        cancelButton.disabled = value;
    };
    return {
        setBusy,
        complete() {
            setBusy(false);
            close();
        },
    };
}

export function initRobotMenu({ menu, id, label, closeMenus, windowRef = window }) {
    const toggle = menu.querySelector('[data-robot-menu-toggle]');
    const options = menu.querySelector('[data-robot-menu-options]');
    options.id = id;
    toggle.setAttribute('aria-controls', id);
    if (label) {
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
    }
    const availableButtons = () => Array.from(options.querySelectorAll('button')).filter(button => !button.hidden && !button.disabled && !button.closest('[hidden]'));
    const open = () => {
        closeMenus();
        options.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        const bounds = menu.getBoundingClientRect();
        const below = windowRef.innerHeight - bounds.bottom - 12;
        const above = bounds.top - 12;
        const opensAbove = below < options.scrollHeight && above > below;
        options.classList.toggle('opens-above', opensAbove);
        options.style.maxHeight = `${Math.max(0, opensAbove ? above : below)}px`;
    };
    toggle.addEventListener('click', () => {
        if (options.hidden) open();
        else closeMenus();
    });
    toggle.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        open();
        const buttons = availableButtons();
        (event.key === 'ArrowUp' ? buttons.at(-1) : buttons[0])?.focus();
    });
    options.addEventListener('keydown', event => {
        const buttons = availableButtons();
        const current = buttons.indexOf(event.target);
        if (current < 0) return;
        let next;
        switch (event.key) {
            case 'ArrowDown': next = (current + 1) % buttons.length; break;
            case 'ArrowUp': next = (current + buttons.length - 1) % buttons.length; break;
            case 'Home': next = 0; break;
            case 'End': next = buttons.length - 1; break;
            default: return;
        }
        event.preventDefault();
        buttons[next].focus();
    });
    options.addEventListener('click', event => {
        if (event.target.closest('button:not(:disabled)')) {
            const restoreFocus = menu.contains(menu.ownerDocument?.activeElement);
            closeMenus();
            // A dialog or logs opened by the action keeps its own focus.
            if (restoreFocus) toggle.focus();
        }
    });
    menu.addEventListener('focusout', event => {
        if (!menu.contains(event.relatedTarget)) closeMenus();
    });
}
