import assert from 'node:assert/strict';
import test from 'node:test';

import { CustomSelect } from '../../web-components/components/custom-select/custom-select.js';

test('custom select handles clicks locally once after repeated render binding', () => {
    const select = Object.create(CustomSelect.prototype);
    select.trigger = new EventTarget();
    let opened = 0;
    select.openSelect = (event) => {
        event.preventDefault();
        event.stopPropagation();
        opened += 1;
    };
    select.bindTriggerEvents();
    select.bindTriggerEvents();
    const click = new Event('click', { bubbles: true, cancelable: true });
    select.trigger.dispatchEvent(click);
    assert.equal(opened, 1);
    assert.equal(click.defaultPrevented, true);
    select.closeSelect = () => {};
    select.afterUnload();
    select.trigger.dispatchEvent(new Event('click'));
    assert.equal(opened, 1);
});

test('custom select keyboard opens once and respects disabled state', () => {
    const select = Object.create(CustomSelect.prototype);
    select.trigger = new EventTarget();
    let disabled = false;
    let opened = 0;
    select.isDisabled = () => disabled;
    select.openSelect = () => { opened += 1; };
    select.bindTriggerEvents();
    const key = () => {
        const event = new Event('keydown', { cancelable: true });
        event.key = 'Enter';
        return event;
    };
    select.trigger.dispatchEvent(key());
    assert.equal(opened, 1);
    disabled = true;
    select.trigger.dispatchEvent(key());
    assert.equal(opened, 1);
    select.triggerController.abort();
});

test('custom select portals its options list to the containing dialog and restores it', () => {
    const origin = {
        append(node) {
            node.parentElement = this;
        }
    };
    const dialog = {
        append(node) {
            node.parentElement = this;
        }
    };
    const optionsList = { parentElement: origin };
    const select = Object.create(CustomSelect.prototype);
    select.element = {
        closest: () => dialog,
        getAttribute: () => null,
        hasAttribute: () => false
    };
    select.optionsList = optionsList;

    select.portalOptionsListToDialog();

    assert.equal(optionsList.parentElement, dialog);
    assert.equal(select.optionsListPortalRoot, dialog);

    select.restoreOptionsList();

    assert.equal(optionsList.parentElement, origin);
    assert.equal(select.optionsListPortalRoot, null);
});

test('opening a custom select portals its options list before positioning it', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const origin = {
        append(node) {
            node.parentElement = this;
        }
    };
    const dialog = {
        append(node) {
            node.parentElement = this;
        }
    };
    const classes = new Set(['hidden']);
    const optionsList = {
        parentElement: origin,
        hidden: true,
        classList: {
            add: (name) => classes.add(name),
            contains: (name) => classes.has(name),
            remove: (name) => classes.delete(name)
        },
        addEventListener() {},
        querySelector: () => null
    };
    const select = Object.create(CustomSelect.prototype);
    select.element = {
        closest: () => dialog,
        getAttribute: () => null,
        hasAttribute: () => false
    };
    select.optionsList = optionsList;
    select.trigger = {
        classList: { add() {} },
        setAttribute() {}
    };
    select.positionOptionsList = () => {
        assert.equal(optionsList.parentElement, dialog);
    };
    globalThis.document = { addEventListener() {} };
    globalThis.window = { addEventListener() {} };

    try {
        select.openSelect();
        assert.equal(optionsList.parentElement, dialog);
        assert.equal(optionsList.hidden, false);
    } finally {
        select.controller?.abort();
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});

test('custom select positions a dialog dropdown inside the dialog bounds', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    globalThis.document = { documentElement: { clientWidth: 1200, clientHeight: 800 } };
    globalThis.window = {
        innerWidth: 1200,
        innerHeight: 800,
        matchMedia: () => ({ matches: false })
    };

    try {
        const style = {};
        const select = Object.create(CustomSelect.prototype);
        select.element = { getAttribute: () => null };
        select.trigger = {
            getBoundingClientRect: () => ({ left: 750, top: 500, right: 890, bottom: 536, width: 140, height: 36 })
        };
        select.optionsList = { scrollHeight: 80, style };
        select.optionsListPortalRoot = {
            getBoundingClientRect: () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 })
        };

        select.positionOptionsList();

        assert.equal(style.left, '712px');
        assert.equal(style.top, '416px');
        assert.equal(style.width, '180px');
        assert.equal(style.maxHeight, '330px');
    } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});
