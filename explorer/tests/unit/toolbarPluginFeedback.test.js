import test from 'node:test';
import assert from 'node:assert/strict';
import { openToolbarPluginWithFeedback, isToolbarPluginOpening } from '../../shared/ui/toolbar-plugin-feedback.js';

function button() {
    const attrs = new Map();
    const classes = new Set();
    return { disabled: false, classes,
        getAttribute: key => attrs.get(key) ?? null,
        setAttribute: (key, value) => attrs.set(key, value),
        removeAttribute: key => attrs.delete(key),
        classList: { add: key => classes.add(key), remove: key => classes.delete(key) }
    };
}

test('feedback and click lock exist before modal opening begins', async () => {
    const b = button();
    let shown;
    const opening = new Promise(() => {});
    opening.opened = new Promise(resolve => { shown = resolve; });
    const result = openToolbarPluginWithFeedback(b, () => {
        assert.equal(b.disabled, true);
        assert.equal(b.getAttribute('aria-busy'), 'true');
        assert.equal(b.classes.has('toolbar-plugin-opening'), true);
        return opening;
    });
    assert.equal(result, opening);
    assert.equal(isToolbarPluginOpening(b), true);
    assert.equal(openToolbarPluginWithFeedback(b, () => assert.fail('duplicate activation')), opening);
    shown({}); await opening.opened;
    assert.equal(b.disabled, false);
    assert.equal(b.getAttribute('aria-busy'), null);
    assert.equal(isToolbarPluginOpening(b), false);
    assert.equal(b.classes.size, 0);
});

test('cancellation and failures restore the original button state', async () => {
    const b = button();
    b.setAttribute('aria-disabled', 'false');
    const cancelled = { opened: Promise.resolve(null) };
    openToolbarPluginWithFeedback(b, () => cancelled);
    await cancelled.opened;
    assert.equal(b.disabled, false);
    assert.equal(b.getAttribute('aria-disabled'), 'false');
    assert.throws(() => openToolbarPluginWithFeedback(b, () => { throw new Error('failed'); }), /failed/);
    assert.equal(b.disabled, false);
    assert.equal(b.classes.size, 0);
});
