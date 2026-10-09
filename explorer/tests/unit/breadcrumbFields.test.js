import test from 'node:test';
import assert from 'node:assert/strict';
import { relayBreadcrumbFieldEvent, hasFocusedBreadcrumbField } from '../../web-components/modals/expanded-modal/breadcrumbFields.js';

function fixture() {
    // Keep the native Event flags read-only while carrying keyboard properties.
    const keyboardEvent = class extends Event {
        constructor(type, options) {
            super(type, options);
            for (const key of ['key', 'code', 'ctrlKey', 'altKey', 'shiftKey', 'metaKey', 'repeat', 'isComposing']) this[key] = options[key];
        }
    };
    const fields = [];
    function field(value = 'Initial') {
        const attributes = new Map([['data-embed-field', 'workflow-name']]);
        return { value, type: 'text', maxLength: 120, disabled: false, readOnly: false, style: { cssText: '--field-length:22ch' },
            ownerDocument: { defaultView: { Event, KeyboardEvent: keyboardEvent } },
            getAttribute: key => attributes.get(key), hasAttribute: key => attributes.has(key),
            setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
            closest() { return this; }, matches() { return true; }, blur() { this.blurred = true; },
            dispatchEvent(event) { this.lastEvent = event; this.handler?.(event); return !event.defaultPrevented; } };
    }
    const original = field(), clone = field(); fields.push(original);
    const source = { querySelectorAll: () => fields };
    const event = (type, extra = {}) => ({ type, target: clone, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
    return { original, clone, source, event };
}

test('marked breadcrumb fields relay bounded input into the owning frame', () => {
    const f = fixture();
    f.clone.value = 'New workflow';
    f.original.handler = () => { f.original.style.cssText = '--field-length:18ch'; };
    assert.equal(relayBreadcrumbFieldEvent(f.event('input'), f.source), true);
    assert.equal(f.original.value, 'New workflow');
    assert.equal(f.original.lastEvent.type, 'input');
    assert.equal(f.clone.style.cssText, '--field-length:18ch');
    f.clone.value = 'a'.repeat(140);
    relayBreadcrumbFieldEvent(f.event('input'), f.source);
    assert.equal(f.original.value.length, 120);
    assert.equal(f.clone.value.length, 120);
});

test('readonly, disabled, unmarked and non-text fields cannot change source state', () => {
    for (const property of ['disabled', 'readOnly']) {
        const f = fixture(); f.original[property] = true; f.clone.value = 'Attempt';
        assert.equal(relayBreadcrumbFieldEvent(f.event('input'), f.source), false);
        assert.equal(f.original.value, 'Initial');
    }
    const f = fixture();
    f.clone.setAttribute('data-embed-field', 'unknown');
    assert.equal(relayBreadcrumbFieldEvent(f.event('input'), f.source), false);
    f.clone.type = 'password';
    assert.equal(relayBreadcrumbFieldEvent(f.event('input'), f.source), false);
    f.clone.closest = () => null;
    assert.equal(relayBreadcrumbFieldEvent(f.event('input'), f.source), false);
    assert.equal(f.original.value, 'Initial');
});

test('Escape and Enter retain owner handling and do not close or submit the host modal', () => {
    for (const key of ['Escape', 'Enter']) {
        const f = fixture();
        f.original.handler = event => { if (key === 'Escape') f.original.value = 'Initial'; event.preventDefault(); };
        f.clone.value = 'Draft';
        const event = f.event('keydown', { key });
        assert.equal(relayBreadcrumbFieldEvent(event, f.source), true);
        assert.equal(f.original.lastEvent.key, key);
        assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(f.clone.blurred, true);
        if (key === 'Escape') assert.equal(f.clone.value, 'Initial');
    }
    const f = fixture();
    assert.equal(relayBreadcrumbFieldEvent(f.event('click'), f.source), false);
});

test('focus events and active-edit detection preserve the mirrored input and caret', () => {
    const f = fixture();
    relayBreadcrumbFieldEvent(f.event('focusin'), f.source);
    assert.equal(f.original.lastEvent.type, 'focusin');
    f.clone.value = '  Trimmed  ';
    f.original.handler = () => { f.original.value = f.original.value.trim(); };
    relayBreadcrumbFieldEvent(f.event('focusout'), f.source);
    assert.equal(f.clone.value, 'Trimmed');
    const root = { ownerDocument: { activeElement: f.clone }, contains: value => value === f.clone };
    assert.equal(hasFocusedBreadcrumbField(root), true);
    root.contains = () => false;
    assert.equal(hasFocusedBreadcrumbField(root), false);
});
