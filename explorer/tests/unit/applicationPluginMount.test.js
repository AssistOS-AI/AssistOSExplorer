import test from 'node:test';
import assert from 'node:assert/strict';

import { renderApplicationPluginSlots } from '../../web-components/pages/file-exp/file-exp-application-plugins.js';

// A DOM subset that covers what the application plugin host touches: attributes, class lists, child order,
// tag, id and [attribute] selectors, and a connected-to-root check.
class FakeNode {
    constructor(localName, { id = '', classes = [], isRoot = false } = {}) {
        this.localName = localName;
        this.attrs = new Map(id ? [['id', id]] : []);
        this.childNodes = [];
        this.parentNode = null;
        this.className = '';
        this.isRoot = isRoot;
        this.title = '';
        this.classes = new Set(classes);
        this.classList = {
            contains: (name) => this.classes.has(name),
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            toggle: (name, force) => {
                const next = force === undefined ? !this.classes.has(name) : Boolean(force);
                if (next) this.classes.add(name); else this.classes.delete(name);
                return next;
            }
        };
        this.style = { setProperty() {}, removeProperty() {} };
    }

    get isConnected() {
        let node = this;
        while (node) {
            if (node.isRoot) return true;
            node = node.parentNode;
        }
        return false;
    }

    get firstElementChild() { return this.childNodes[0] || null; }

    get nextElementSibling() {
        const siblings = this.parentNode?.childNodes || [];
        return siblings[siblings.indexOf(this) + 1] || null;
    }

    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    hasAttribute(name) { return this.attrs.has(name); }
    removeAttribute(name) { this.attrs.delete(name); }

    matches(selector) {
        if (selector.startsWith('#')) return this.attrs.get('id') === selector.slice(1);
        if (selector.startsWith('[')) return this.attrs.has(selector.slice(1, -1));
        return this.localName === selector;
    }

    querySelectorAll(selector) {
        const found = [];
        for (const child of this.childNodes) {
            if (child.matches(selector)) found.push(child);
            found.push(...child.querySelectorAll(selector));
        }
        return found;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

    detach(child) {
        child.parentNode?.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
        child.parentNode = null;
    }

    appendChild(child) {
        this.detach(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    insertBefore(child, reference) {
        this.detach(child);
        child.parentNode = this;
        const index = reference ? this.childNodes.indexOf(reference) : -1;
        if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child);
        return child;
    }

    replaceChildren(...nodes) {
        this.childNodes.forEach((child) => { child.parentNode = null; });
        this.childNodes = [];
        nodes.forEach((node) => this.appendChild(node));
    }

    remove() { this.detach(this); }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function createHarness({ plugins }) {
    const events = [];
    const registrationGates = new Map();
    const renderGates = new Map();
    let registrationsInFlight = 0;
    let maxRegistrationsInFlight = 0;
    let rendersInFlight = 0;
    let maxRendersInFlight = 0;
    const gate = (gates, name) => {
        if (!gates.has(name)) gates.set(name, deferred());
        return gates.get(name);
    };

    const root = new FakeNode('root', { isRoot: true });
    const barContainer = new FakeNode('div', { id: 'fileExpPluginBar', classes: ['app-plugin-bar'] });
    const accountContainer = new FakeNode('div', { id: 'fileExpAccountMenuPlugins', classes: ['app-plugin-account-slot'] });
    root.appendChild(barContainer);
    root.appendChild(accountContainer);

    const createElement = (tag) => {
        const element = new FakeNode(tag);
        if (tag.startsWith('plugin-')) {
            let waiting = false;
            // WebSkel exposes these once the presenter exists; reading them is the host starting to wait.
            const startWaiting = () => {
                if (!waiting) {
                    waiting = true;
                    events.push(`render-wait:${tag}`);
                    rendersInFlight += 1;
                    maxRendersInFlight = Math.max(maxRendersInFlight, rendersInFlight);
                    gate(renderGates, tag).promise.then(
                        () => { rendersInFlight -= 1; events.push(`render-done:${tag}`); },
                        () => { rendersInFlight -= 1; events.push(`render-failed:${tag}`); }
                    );
                }
            };
            Object.defineProperty(element, 'presenterReadyPromise', {
                get() { startWaiting(); return Promise.resolve(); }
            });
            Object.defineProperty(element, 'renderCompletePromise', {
                get() { startWaiting(); return gate(renderGates, tag).promise; }
            });
        }
        return element;
    };

    const previous = {
        window: globalThis.window,
        document: globalThis.document
    };
    globalThis.document = { createElement };
    globalThis.window = {
        assistOS: {
            user: { id: 'u', roles: ['user'] },
            pluginSettings: {},
            workspace: { appPlugins: plugins },
            webSkel: {
                async ensureComponentRegistered(name) {
                    events.push(`register-start:${name}`);
                    registrationsInFlight += 1;
                    maxRegistrationsInFlight = Math.max(maxRegistrationsInFlight, registrationsInFlight);
                    try {
                        await gate(registrationGates, name).promise;
                    } finally {
                        registrationsInFlight -= 1;
                        events.push(`register-end:${name}`);
                    }
                }
            }
        }
    };

    const fileExp = {
        element: root,
        state: { path: '/', selectedPath: '', workspaceVersion: 0 },
        normalizePath: (value) => value
    };
    return {
        fileExp,
        events,
        barContainer,
        accountContainer,
        gate: (kind, name) => gate(kind === 'register' ? registrationGates : renderGates, name),
        max: () => ({ registrations: maxRegistrationsInFlight, renders: maxRendersInFlight }),
        restore() {
            if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
            if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
        }
    };
}

const plugin = (id, component, order, extra = {}) => ({ agent: 'agent', id, component, order, ...extra });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const keysIn = (container) => container.querySelectorAll('[data-app-plugin-key]').map((node) => node.getAttribute('data-app-plugin-key'));

test('T2: a slot registers and renders its plugins together and keeps plugin order', async () => {
    const harness = createHarness({
        plugins: { 'file-exp:right-bar': [plugin('a', 'plugin-a', 1), plugin('b', 'plugin-b', 2)] }
    });
    try {
        const rendering = renderApplicationPluginSlots(harness.fileExp);
        await tick();
        // Both registrations are in flight before either resolves.
        assert.deepEqual(harness.events.filter((event) => event.startsWith('register-')), [
            'register-start:plugin-a',
            'register-start:plugin-b'
        ]);

        // B finishes first: it must not move ahead of A, and A's render must not gate B's.
        harness.gate('register', 'plugin-b').resolve();
        harness.gate('register', 'plugin-a').resolve();
        await tick();
        harness.gate('render', 'plugin-b').resolve();
        await tick();
        assert.ok(harness.events.includes('render-wait:plugin-a'), 'A render wait started before B finished');
        assert.ok(harness.events.includes('render-wait:plugin-b'));
        assert.equal(harness.max().renders, 2, 'both renders overlap');
        assert.deepEqual(keysIn(harness.barContainer), ['agent/a', 'agent/b']);
        harness.gate('render', 'plugin-a').resolve();
        await rendering;

        assert.deepEqual(keysIn(harness.barContainer), ['agent/a', 'agent/b']);
        for (const mount of harness.barContainer.querySelectorAll('[data-app-plugin-key]')) {
            assert.equal(mount.querySelector('[data-app-plugin-loading]'), null, 'loading state finalized');
        }
    } finally {
        harness.restore();
    }
});

test('T2: a rejecting plugin is marked failed and its siblings still finalize', async () => {
    const harness = createHarness({
        plugins: { 'file-exp:right-bar': [plugin('a', 'plugin-a', 1), plugin('b', 'plugin-b', 2)] }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        harness.gate('register', 'plugin-a').reject(new Error('plugin-a is unavailable'));
        harness.gate('register', 'plugin-b').resolve();
        harness.gate('render', 'plugin-b').resolve();
        await renderApplicationPluginSlots(harness.fileExp);

        const [mountA, mountB] = harness.barContainer.querySelectorAll('[data-app-plugin-key]');
        const elementA = mountA.querySelector('plugin-a');
        const elementB = mountB.querySelector('plugin-b');
        assert.ok(elementA.hasAttribute('data-app-plugin-loading'));
        assert.ok(elementA.classes.has('is-error'));
        assert.equal(elementA.getAttribute('aria-disabled'), 'true');
        assert.equal(elementA.title, 'plugin-a is unavailable');
        assert.equal(elementB.hasAttribute('data-app-plugin-loading'), false);
        assert.equal(elementB.classes.has('is-error'), false);
    } finally {
        console.error = originalError;
        harness.restore();
    }
});

test('T2: a plugin whose render rejects is marked failed without affecting its sibling', async () => {
    const harness = createHarness({
        plugins: { 'file-exp:right-bar': [plugin('a', 'plugin-a', 1), plugin('b', 'plugin-b', 2)] }
    });
    const originalError = console.error;
    console.error = () => {};
    try {
        harness.gate('register', 'plugin-a').resolve();
        harness.gate('register', 'plugin-b').resolve();
        harness.gate('render', 'plugin-a').reject(new Error('render of plugin-a failed'));
        harness.gate('render', 'plugin-b').resolve();
        await renderApplicationPluginSlots(harness.fileExp);

        const [mountA, mountB] = harness.barContainer.querySelectorAll('[data-app-plugin-key]');
        assert.ok(mountA.querySelector('plugin-a').classes.has('is-error'));
        assert.equal(mountB.querySelector('plugin-b').hasAttribute('data-app-plugin-loading'), false);
    } finally {
        console.error = originalError;
        harness.restore();
    }
});

test('T2: slots mount concurrently, so one slow slot does not delay another', async () => {
    const harness = createHarness({
        plugins: {
            'file-exp:right-bar': [plugin('a', 'plugin-a', 1)],
            'file-exp:account-menu': [plugin('c', 'plugin-c', 1)]
        }
    });
    try {
        const rendering = renderApplicationPluginSlots(harness.fileExp);
        await tick();
        // plugin-a has not resolved yet; the account menu slot must already be registering.
        assert.deepEqual(harness.events.filter((event) => event.startsWith('register-start:')).sort(), [
            'register-start:plugin-a',
            'register-start:plugin-c'
        ]);
        assert.equal(harness.max().registrations, 2);
        harness.gate('register', 'plugin-a').resolve();
        harness.gate('register', 'plugin-c').resolve();
        harness.gate('render', 'plugin-a').resolve();
        harness.gate('render', 'plugin-c').resolve();
        await rendering;
        assert.deepEqual(keysIn(harness.accountContainer), ['agent/c']);
    } finally {
        harness.restore();
    }
});

test('T2: a finished plugin is finalized while a slower sibling is still rendering', async () => {
    const harness = createHarness({
        plugins: { 'file-exp:right-bar': [plugin('a', 'plugin-a', 1), plugin('b', 'plugin-b', 2)] }
    });
    try {
        harness.gate('register', 'plugin-a').resolve();
        harness.gate('register', 'plugin-b').resolve();
        const rendering = renderApplicationPluginSlots(harness.fileExp);
        await tick();
        harness.gate('render', 'plugin-a').resolve();
        await tick();

        const [mountA, mountB] = harness.barContainer.querySelectorAll('[data-app-plugin-key]');
        assert.equal(mountA.querySelector('plugin-a').hasAttribute('data-app-plugin-loading'), false,
            'A is finalized while B is pending');
        assert.equal(mountB.querySelector('plugin-b').hasAttribute('data-app-plugin-loading'), true, 'B still loading');

        harness.gate('render', 'plugin-b').resolve();
        await rendering;
        assert.equal(mountB.querySelector('plugin-b').hasAttribute('data-app-plugin-loading'), false);
        assert.deepEqual(keysIn(harness.barContainer), ['agent/a', 'agent/b']);
    } finally {
        harness.restore();
    }
});
