import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initCreateRobotDialog, initRobotMenu } from '../public/robot-controls.js';

function element() {
    const listeners = new Map();
    const attributes = new Map();
    return {
        listeners, attributes, disabled: false, focused: false,
        addEventListener: (name, handler) => listeners.set(name, handler),
        setAttribute: (name, value) => attributes.set(name, value),
        focus() { this.focused = true; },
        fire(name, event = {}) { listeners.get(name)?.(event); },
    };
}

function dialogFixture() {
    const dialog = element();
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300 });
    const trigger = element();
    const closeButton = element();
    const cancelButton = element();
    let openings = 0;
    const controller = initCreateRobotDialog({ dialog, trigger, closeButton, cancelButton, onOpen: () => { openings++; } });
    return { dialog, trigger, closeButton, cancelButton, controller, openings: () => openings };
}

test('creation dialog respects the disabled trigger, opens once and restores focus on Cancel', () => {
    const state = dialogFixture();
    state.trigger.disabled = true;
    state.trigger.fire('click');
    assert.equal(state.dialog.open, false);
    state.trigger.disabled = false;
    state.trigger.fire('click');
    state.trigger.fire('click');
    assert.equal(state.openings(), 1);
    state.cancelButton.fire('click');
    assert.equal(state.dialog.open, false);
    assert.equal(state.trigger.focused, true);
});

test('Logs toggle has link styling without a button background in hover or expanded states', async () => {
    const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
    const base = css.match(/\.view-logs \{([^}]+)\}/)?.[1];
    const active = css.match(/\.view-logs:hover, \.view-logs\[aria-expanded="true"\] \{([^}]+)\}/)?.[1];
    assert.match(base, /background: transparent;/);
    assert.match(base, /border: 0;/);
    assert.match(base, /text-decoration: underline;/);
    assert.match(active, /color: var\(--accent\);/);
    assert.doesNotMatch(active, /background|border/);
});

test('robot total is secondary text rather than a boxed count badge', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
    assert.match(html, /id="robotCount" class="robot-count"/);
    assert.match(html, /id="workflowCount"\s+class="robot-count"/);
    const countStyle = css.match(/\.robot-count \{([^}]+)\}/)?.[1];
    assert.match(countStyle, /color: var\(--text-soft\);/);
    assert.doesNotMatch(countStyle, /background|border|padding/);
});

test('creation dialog handles Escape and backdrop without dismissing a pending submission', () => {
    const state = dialogFixture();
    state.trigger.fire('click');
    state.dialog.fire('click', { target: state.dialog, clientX: 150, clientY: 150 });
    assert.equal(state.dialog.open, true);
    state.controller.setBusy(true);
    assert.equal(state.dialog.attributes.get('aria-busy'), 'true');
    assert.equal(state.closeButton.disabled, true);
    assert.equal(state.cancelButton.disabled, true);
    let prevented = false;
    state.dialog.fire('cancel', { preventDefault() { prevented = true; } });
    state.closeButton.fire('click');
    state.dialog.fire('click', { target: state.dialog, clientX: 50, clientY: 50 });
    assert.equal(prevented, true);
    assert.equal(state.dialog.open, true);
    state.controller.setBusy(false);
    assert.equal(state.dialog.attributes.get('aria-busy'), 'false');
    state.dialog.fire('cancel', { preventDefault() {} });
    assert.equal(state.dialog.open, false);
    state.trigger.fire('click');
    state.dialog.fire('click', { target: state.dialog, clientX: 50, clientY: 50 });
    assert.equal(state.dialog.open, false);
    state.trigger.fire('click');
    state.controller.complete();
    assert.equal(state.dialog.open, false);
});

test('robot action menu links its trigger, excludes hidden or disabled actions and fits the viewport', () => {
    const toggle = element();
    const options = element();
    options.hidden = true;
    options.style = {};
    options.scrollHeight = 200;
    const classes = new Set();
    options.classList = { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) };
    const buttons = [element(), element(), element(), element(), element()];
    buttons[1].hidden = true;
    buttons[2].disabled = true;
    buttons[3].hiddenParent = true;
    buttons.forEach(button => { button.closest = () => button.hidden || button.hiddenParent ? button : null; });
    options.querySelectorAll = () => buttons;
    const menu = element();
    menu.querySelector = selector => selector.includes('toggle') ? toggle : options;
    menu.getBoundingClientRect = () => ({ top: 500, bottom: 540 });
    menu.contains = target => buttons.includes(target) || target === toggle;
    let closes = 0;
    const closeMenus = () => { closes++; options.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
    initRobotMenu({ menu, id: 'manage-test', label: 'More actions for test', closeMenus, windowRef: { innerHeight: 600 } });
    assert.equal(toggle.attributes.get('aria-controls'), 'manage-test');
    assert.equal(toggle.attributes.get('aria-label'), 'More actions for test');
    toggle.fire('click');
    assert.equal(options.hidden, false);
    assert.equal(toggle.attributes.get('aria-expanded'), 'true');
    assert.equal(classes.has('opens-above'), true);
    assert.equal(options.style.maxHeight, '488px');
    toggle.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
    assert.equal(buttons[0].focused, true);
    options.fire('keydown', { target: buttons[0], key: 'ArrowDown', preventDefault() {} });
    assert.equal(buttons[4].focused, true);
    options.fire('keydown', { target: buttons[4], key: 'Home', preventDefault() {} });
    assert.equal(buttons[0].focused, true);
    menu.fire('focusout', { relatedTarget: buttons[0] });
    assert.equal(options.hidden, false);
    menu.fire('focusout', { relatedTarget: null });
    assert.equal(options.hidden, true);
    toggle.fire('click');
    options.fire('click', { target: { closest: () => buttons[0] } });
    assert.equal(options.hidden, true);
    assert.ok(closes >= 4);
});

test('compact robot markup keeps Open and Stop outside grouped administration and dialog feedback separate', async () => {
    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(html, /id="createRobotButton"[^>]*aria-controls="createRobotDialog"[^>]*disabled/);
    assert.match(html, /<dialog id="createRobotDialog"[^>]*aria-labelledby="create-title"/);
    assert.match(html, /name="name"[^>]*required[^>]*autofocus/);
    assert.match(html, /id="createFormMessage"/);
    assert.ok(html.indexOf('id="formMessage"') < html.indexOf('<dialog id="createRobotDialog"'));
    assert.doesNotMatch(html, /<section class="panel" aria-labelledby="create-title"/);
    const actions = html.slice(html.indexOf('<div class="robot-actions"'), html.indexOf('<p class="robot-session"'));
    const main = html.slice(html.indexOf('<div class="robot-main"'), html.indexOf('<div class="robot-actions"'));
    const manage = actions.slice(actions.indexOf('<div class="robot-manage"'));
    for (const name of ['manage-skills', 'configure-coding-agent', 'delete-robot']) assert.ok(manage.includes(name));
    assert.doesNotMatch(manage, /stop-workstation|open-toggle|view-logs/);
    assert.doesNotMatch(actions, /view-logs/);
    assert.match(main, /class="robot-identity"[\s\S]*class="avatar"[\s\S]*class="run-state"/);
    assert.match(main, /class="robot-title-row"><h3><\/h3>[\s:]*<span class="robot-id"/);
    assert.match(main, /class="robot-meta"[\s\S]*class="view-logs"/);
    assert.match(source, /state\.textContent = robot\.run\.state;/);
    assert.match(source, /mode\.textContent = robot\.run\.mode \|\| '';/);
    assert.match(source, /logsButton\.setAttribute\('aria-label', `Hide logs for \$\{robot\.name\}`\)/);
    assert.match(source, /hideLogs\(\);\s*logsButton\.focus\(\)/);
    assert.match(source, /if \(creatingRobot \|\| !canCreateRobots\) return/);
    assert.match(source, /const data = new FormData\(createForm\);[\s\S]*updateCreateControls\(\);/);
    assert.match(source, /robot-danger-actions'\)\.hidden = !canAdmin/);
    assert.match(source, /createFormMessage\.textContent = error\.message/);
});
