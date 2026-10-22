// Only explicitly marked, same-origin text fields participate in header editing.
export function relayBreadcrumbFieldEvent(event, source) {
    const field = event.target?.closest?.('input[data-embed-field]');
    if (!field || field.type !== 'text' || !source || source.isConnected === false) return false;
    const key = field.getAttribute('data-embed-field');
    const original = [...source.querySelectorAll('input[data-embed-field]')]
        .find(input => input.getAttribute('data-embed-field') === key);
    if (!original || original.type !== 'text' || original.disabled || original.readOnly) return false;
    const view = original.ownerDocument.defaultView;
    if (!['input', 'focusin', 'focusout', 'keydown'].includes(event.type)) return false;
    if (event.type === 'input' || event.type === 'focusout') {
        original.value = original.maxLength >= 0 ? field.value.slice(0, original.maxLength) : field.value;
    }
    const forwarded = event.type === 'keydown'
        ? new view.KeyboardEvent('keydown', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey, repeat: event.repeat, isComposing: event.isComposing, bubbles: true, cancelable: true })
        : new view.Event(event.type, { bubbles: true });
    original.dispatchEvent(forwarded);
    field.value = original.value;
    field.style.cssText = original.style.cssText;
    if (original.hasAttribute('aria-invalid')) field.setAttribute('aria-invalid', original.getAttribute('aria-invalid'));
    else field.removeAttribute('aria-invalid');
    if (forwarded.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        if (['Enter', 'Escape'].includes(event.key)) field.blur();
    }
    return true;
}

// A marked <select> (for example a theme choice) replays its change on the owning page's select.
export function relayBreadcrumbSelectEvent(event, source) {
    const field = event.target?.closest?.('select[data-embed-field]');
    if (!field || event.type !== 'change' || !source || source.isConnected === false) return false;
    const key = field.getAttribute('data-embed-field');
    const original = [...source.querySelectorAll('select[data-embed-field]')]
        .find(select => select.getAttribute('data-embed-field') === key);
    if (!original || original.disabled) return false;
    original.value = field.value;
    original.dispatchEvent(new original.ownerDocument.defaultView.Event('change', { bubbles: true }));
    field.value = original.value;
    return true;
}

// Cloning copies a select's markup, not its current choice, so each mirrored select takes the owning page's value.
export function syncBreadcrumbSelects(breadcrumbs, source) {
    const originals = [...source.querySelectorAll('select[data-embed-field]')];
    for (const select of breadcrumbs.querySelectorAll('select[data-embed-field]')) {
        const original = originals.find(item => item.getAttribute('data-embed-field') === select.getAttribute('data-embed-field'));
        if (original) select.value = original.value;
    }
}

export function hasFocusedBreadcrumbField(breadcrumbs) {
    const active = breadcrumbs.ownerDocument.activeElement;
    return Boolean(active?.matches?.('input[data-embed-field], select[data-embed-field]') && breadcrumbs.contains(active));
}
