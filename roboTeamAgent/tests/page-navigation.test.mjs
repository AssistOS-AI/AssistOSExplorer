import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { initPageNavigation, restoreNavigationFocus } from '../public/page-navigation.js';

function link(href) {
    return { href, listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; } };
}

function fixture() {
    const stack = [{ url: 'https://example.test/rt/', state: { hostState: 'preserved' } }];
    let index = 0;
    const events = {};
    const calls = [];
    const control = link('./');
    const windowRef = {
        location: {
            get href() { return stack[index].url; }, origin: 'https://example.test',
            assign(url) { calls.push(['assign', url]); stack.splice(index + 1); stack.push({ state: null, url }); index++; },
        },
        history: {
            get state() { return stack[index].state; },
            replaceState(state, title, url) { stack[index].state = state; if (url) stack[index].url = url; },
            go(depth) { calls.push(['go', depth]); index += depth; },
        },
        addEventListener(name, listener) { events[name] = listener; },
    };
    const root = { querySelectorAll: () => [control] };
    const init = options => initPageNavigation({ windowRef, root, fallbackUrl: 'https://example.test/rt/?tab=workflow-types', ...options });
    return { init, windowRef, stack, calls, events, control };
}

function click(overrides = {}) {
    return { button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...overrides };
}

test('navigation saves source view on its own history entry and protects it during departure', () => {
    const f = fixture();
    const view = { tabId: 'workflowTypesTab', scrollY: 480, focusKey: 'workflow:default', robotName: 'Draft robot' };
    const navigation = f.init({ captureView: () => view });
    navigation.navigate('https://example.test/rt/flow-types?id=default');
    assert.equal(f.stack[0].state.hostState, 'preserved');
    assert.deepEqual(f.stack[0].state.roboteamNavigation.view, view);
    f.events.pagehide();
    assert.equal(f.stack[1].state, null);
    f.init();
    assert.deepEqual(f.stack[1].state.roboteamNavigation.returnTo, { url: 'https://example.test/rt/', depth: 1 });
    assert.equal(f.stack[1].state.roboteamNavigation.view, undefined);
    assert.equal(f.stack[1].url, 'https://example.test/rt/flow-types?id=default');
    assert.equal(f.calls[0][0], 'assign');
});

test('restoring mouse focus does not leave a selection ring and keyboard interaction restores the focus indicator', () => {
    const classes = new Set();
    const events = {};
    const target = {
        classList: {
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            remove(name) { classes.delete(name); },
        },
        addEventListener(name, listener) { events[name] = listener; },
        focus(options) { assert.equal(options.preventScroll, true); },
    };
    restoreNavigationFocus(target, false);
    assert.equal(classes.has('pointer-restored-focus'), true);
    events.keydown();
    assert.equal(classes.has('pointer-restored-focus'), false);
    restoreNavigationFocus(target, false);
    events.blur();
    assert.equal(classes.has('pointer-restored-focus'), false);
    restoreNavigationFocus(target, true);
    assert.equal(classes.has('pointer-restored-focus'), false);
});

test('creation through generation and editor returns to the original dashboard, not an intermediate page', () => {
    const f = fixture();
    f.init({ captureView: () => ({ tabId: 'workflowTypesTab', scrollY: 360 }) }).navigate('/rt/flow-types/generate-new');
    f.init().navigate('/rt/flow-types/new');
    const editor = f.init();
    assert.equal(f.control.href, 'https://example.test/rt/');
    editor.returnToOrigin();
    assert.deepEqual(f.calls.at(-1), ['go', -2]);
    assert.equal(f.windowRef.location.href, 'https://example.test/rt/');
    assert.equal(editor.view.scrollY, 360);
});

test('direct entry and invalid return contexts safely fall back to Workflow types', () => {
    for (const returnTo of [undefined, { url: 'https://other.test/', depth: 1 }, { url: 'https://example.test/rt/', depth: -1 }]) {
        const f = fixture();
        f.stack[0].state.roboteamNavigation = { returnTo };
        f.init().returnToOrigin();
        assert.deepEqual(f.calls.at(-1), ['assign', 'https://example.test/rt/?tab=workflow-types']);
    }
});

test('transferred return context is consumed from the URL and malformed metadata cannot set a return destination', () => {
    const f = fixture();
    f.stack[0].url = 'https://example.test/rt/flows?_rtReturn=%7Bbad&other=preserved';
    f.init().returnToOrigin();
    assert.equal(f.stack[0].url, 'https://example.test/rt/flows?other=preserved');
    assert.deepEqual(f.calls.at(-1), ['assign', 'https://example.test/rt/?tab=workflow-types']);
});

test('only normal same-frame link clicks are intercepted; modified clicks keep native browser behavior', () => {
    const f = fixture();
    const navigation = f.init();
    const destination = link('https://example.test/rt/flows');
    navigation.bindLink(destination);
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
        const event = click(options);
        destination.listeners.click(event);
        assert.equal(event.prevented, false);
    }
    destination.target = '_blank';
    destination.listeners.click(click());
    assert.equal(f.stack.length, 1);
    destination.target = '';
    const event = click();
    destination.listeners.click(event);
    assert.equal(event.prevented, true);
    f.init();
    assert.equal(f.stack[1].url, 'https://example.test/rt/flows');
});

test('return controls use tracked history and cross-origin forward navigation is rejected', () => {
    const f = fixture();
    f.init().navigate('/rt/flows');
    const navigation = f.init();
    const event = click();
    f.control.listeners.click(event);
    assert.equal(event.prevented, true);
    assert.deepEqual(f.calls.at(-1), ['go', -1]);
    assert.throws(() => navigation.navigate('https://other.test/'), /same origin/);
});

test('destination pages use one breadcrumb return control without a separate navigation row and read-only Close stays enabled', async () => {
    for (const file of ['editor.html', 'generate.html', 'flows.html', 'roboflow.html']) {
        const html = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
        const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
        assert.match(header, /<a href="\.\/\?tab=workflow-types" data-return-control title="Back to Workflow types">RoboTeam<\/a>/, file);
        assert.equal((html.match(/data-return-control/g) || []).length, 1, file);
        assert.doesNotMatch(html, /class="page-navigation"|class="page-return"/, file);
    }
    const editor = await readFile(new URL('../public/workflow-editor.js', import.meta.url), 'utf8');
    assert.match(editor, /querySelector\('#workflowCancelButton'\)\.disabled = false/);
    assert.match(editor, /querySelector\('#workflowCancelButton'\)\.onclick = async \(\) => \{ await descriptionRevision\.dispose\(\); onClose\(\); \}/);
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(app, /restoreDashboardView\(initialView\)/);
    assert.match(app, /if \(!event\.persisted\) return;[\s\S]*await loadRobots\(\);[\s\S]*restoreDashboardView\(navigation\.view\)/);
});
