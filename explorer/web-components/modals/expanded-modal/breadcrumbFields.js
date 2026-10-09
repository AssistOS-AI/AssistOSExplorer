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

export function hasFocusedBreadcrumbField(breadcrumbs) {
    const active = breadcrumbs.ownerDocument.activeElement;
    return Boolean(active?.matches?.('input[data-embed-field]') && breadcrumbs.contains(active));
}
