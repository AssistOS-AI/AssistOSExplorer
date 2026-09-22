const pendingButtons = new WeakMap();

export function isToolbarPluginOpening(button) {
    return pendingButtons.has(button);
}

export function openToolbarPluginWithFeedback(button, open) {
    if (pendingButtons.has(button)) return pendingButtons.get(button);
    const previous = {
        disabled: button.disabled,
        busy: button.getAttribute('aria-busy'),
        ariaDisabled: button.getAttribute('aria-disabled')
    };
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    button.classList.add('toolbar-plugin-opening');
    const restore = () => {
        pendingButtons.delete(button);
        button.disabled = previous.disabled;
        for (const [name, value] of [['aria-busy', previous.busy], ['aria-disabled', previous.ariaDisabled]]) {
            if (value === null) button.removeAttribute(name);
            else button.setAttribute(name, value);
        }
        button.classList.remove('toolbar-plugin-opening');
    };
    try {
        const opening = open();
        pendingButtons.set(button, opening);
        Promise.resolve(opening?.opened || opening).then(restore, restore);
        return opening;
    } catch (error) {
        restore();
        throw error;
    }
}
